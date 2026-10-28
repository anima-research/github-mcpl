/**
 * The webhook endpoint answers 405 or 404 for another method or path, 413 past
 * a 1 MiB body (destroying the socket), 401 for a bad `X-Hub-Signature-256`,
 * 400 without `X-GitHub-Delivery` or `X-GitHub-Event`, 200 for a delivery id
 * among the last 2,000 or a `ping`, and 202 before it handles anything else.
 * Nothing parses the body or touches the delivery ring before the signature
 * is checked.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  CheckGate,
  checkMarkOf,
  normalizeWebhook,
  resolveCheckEvents,
  type WebhookDelivery,
} from './normalize.js';
import {
  DEFAULT_WEBHOOK_PATH,
  repoAllowed,
  repoSlug,
  silentLogger,
  type Config,
  type GitHubApi,
  type Logger,
  type NormalizedEvent,
  type RepoRef,
} from './types.js';

export const MAX_BODY_BYTES = 1024 * 1024;

export const DELIVERY_DEDUP_RING = 2000;

const SIGNATURE_HEADER = 'x-hub-signature-256';
const SIGNATURE_PREFIX = 'sha256=';
const DELIVERY_HEADER = 'x-github-delivery';
const EVENT_HEADER = 'x-github-event';

export type EventListener = (event: NormalizedEvent) => void | Promise<void>;

export interface WebhookListenerOptions {
  secret: string;
  path?: string;
  repos: readonly RepoRef[];
  onEvent: EventListener;
  api?: Pick<GitHubApi, 'getCheckRuns'>;
  checkGate?: CheckGate;
  logger?: Logger;
  now?: () => Date;
  maxBodyBytes?: number;
}

export class DeliveryRing {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(readonly capacity: number) {}

  add(id: string): boolean {
    if (this.seen.has(id)) return true;
    this.seen.add(id);
    this.order.push(id);
    if (this.order.length > this.capacity) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.seen.delete(evicted);
    }
    return false;
  }

  get size(): number {
    return this.seen.size;
  }
}

export class WebhookListener {
  private readonly secret: string;
  private readonly path: string;
  private readonly repos: readonly RepoRef[];
  private readonly onEvent: EventListener;
  private readonly api: Pick<GitHubApi, 'getCheckRuns'> | undefined;
  private readonly checkGate: CheckGate;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly maxBodyBytes: number;
  private readonly ring = new DeliveryRing(DELIVERY_DEDUP_RING);
  private readonly inFlight = new Set<Promise<void>>();
  private server: Server | undefined;

  constructor(opts: WebhookListenerOptions) {
    this.secret = opts.secret;
    this.path = opts.path ?? DEFAULT_WEBHOOK_PATH;
    this.repos = opts.repos;
    this.onEvent = opts.onEvent;
    this.api = opts.api;
    this.checkGate = opts.checkGate ?? new CheckGate();
    this.logger = opts.logger ?? silentLogger();
    this.now = opts.now ?? (() => new Date());
    this.maxBodyBytes = opts.maxBodyBytes ?? MAX_BODY_BYTES;
  }

  async listen(port: number, host = '127.0.0.1'): Promise<number> {
    if (this.server) throw new Error('webhook listener is already listening');
    const server = createServer((req, res) => {
      this.handle(req, res);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address();
    const bound = typeof address === 'object' && address !== null ? address.port : port;
    this.logger.info('webhook listener bound', { port: bound, path: this.path });
    return bound;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await this.whenIdle();
  }

  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
  }

  get rememberedDeliveries(): number {
    return this.ring.size;
  }

  get dedupCapacity(): number {
    return this.ring.capacity;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'POST') {
      respond(res, 405, 'method not allowed');
      req.resume();
      return;
    }
    const url = req.url ?? '/';
    if (url.split('?', 1)[0] !== this.path) {
      respond(res, 404, 'not found');
      req.resume();
      return;
    }

    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > this.maxBodyBytes) {
      this.logger.warn('webhook delivery refused: body over the cap', {
        declaredBytes: declared,
        capBytes: this.maxBodyBytes,
      });
      respond(res, 413, 'payload too large');
      req.destroy();
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;

    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > this.maxBodyBytes) {
        aborted = true;
        this.logger.warn('webhook delivery refused: body over the cap', {
          readBytes: size,
          capBytes: this.maxBodyBytes,
        });
        respond(res, 413, 'payload too large');
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('error', () => {
      if (!aborted) {
        aborted = true;
        this.logger.warn('webhook delivery aborted while reading the body');
      }
    });

    req.on('end', () => {
      if (aborted) return;
      this.afterBody(req, res, Buffer.concat(chunks));
    });
  }

  private afterBody(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
    if (!this.signatureValid(header(req, SIGNATURE_HEADER), body)) {
      this.logger.warn('webhook delivery rejected: X-Hub-Signature-256 did not verify', {
        delivery: header(req, DELIVERY_HEADER) ?? '(none)',
        bytes: body.length,
      });
      respond(res, 401, 'signature mismatch');
      return;
    }

    const delivery = header(req, DELIVERY_HEADER);
    const event = header(req, EVENT_HEADER);
    if (!delivery || !event) {
      respond(res, 400, 'missing X-GitHub-Delivery or X-GitHub-Event');
      return;
    }

    if (this.ring.add(delivery)) {
      this.logger.info('webhook delivery dropped: replay of a delivery id already seen', { delivery, event });
      respond(res, 200, 'duplicate delivery');
      return;
    }

    // GitHub's `ping` checks that the endpoint is reachable; it carries no
    // event.
    if (event === 'ping') {
      this.logger.info('webhook ping answered', { delivery });
      respond(res, 200, 'pong');
      return;
    }

    respond(res, 202, 'accepted');
    const receivedAt = this.now().toISOString();
    const task = this.process({ id: delivery, event, body, receivedAt }).catch((err: unknown) => {
      this.logger.error('webhook delivery processing failed', {
        delivery,
        event,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
  }

  /**
   * GitHub signs the raw body with HMAC-SHA256 as `sha256=<hex>`. A header of
   * the wrong form or length is refused before the constant-time compare, since
   * a signature's length isn't secret.
   */
  private signatureValid(provided: string | undefined, body: Buffer): boolean {
    if (!provided || !provided.startsWith(SIGNATURE_PREFIX)) return false;
    const hex = provided.slice(SIGNATURE_PREFIX.length);
    if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
    const expected = createHmac('sha256', this.secret).update(body).digest();
    const actual = Buffer.from(hex, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private async process(raw: {
    id: string;
    event: string;
    body: Buffer;
    receivedAt: string;
  }): Promise<void> {
    let payload: unknown;
    try {
      payload = JSON.parse(raw.body.toString('utf8'));
    } catch {
      this.logger.warn('webhook delivery dropped: body is not JSON', { delivery: raw.id, event: raw.event });
      return;
    }

    const delivery: WebhookDelivery = {
      id: raw.id,
      event: raw.event,
      payload,
      receivedAt: raw.receivedAt,
    };

    const events = normalizeWebhook(delivery);
    if (events.length === 0) {
      this.logger.debug('webhook delivery carries no event this ingress maps', {
        delivery: raw.id,
        event: raw.event,
      });
      return;
    }

    const repo = events[0].repo;
    if (!repoAllowed(repo, this.repos)) {
      this.logger.warn('webhook delivery dropped: repository outside GITHUB_REPOS', {
        delivery: raw.id,
        event: raw.event,
        repo: repoSlug(repo),
      });
      return;
    }

    const resolved = this.api ? await resolveCheckEvents(events, this.api, this.logger) : events;

    for (const normalized of resolved) {
      const mark = checkMarkOf(normalized);
      if (mark === null) {
        await this.onEvent(normalized);
        continue;
      }
      const delivered = await this.checkGate.emit(normalized.repo, normalized.sha as string, mark, async () => {
        await this.onEvent(normalized);
      });
      if (!delivered) {
        this.logger.info('checks event dropped: this head sha already reported this result or a stronger one', {
          delivery: raw.id,
          sha: normalized.sha,
          conclusion: normalized.checks?.conclusion ?? null,
        });
      }
    }
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined;
}

function respond(res: ServerResponse, status: number, message: string): void {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`${message}\n`);
}

export function webhookListenerFromConfig(
  config: Config,
  deps: Pick<WebhookListenerOptions, 'onEvent' | 'api' | 'logger' | 'checkGate'>,
): WebhookListener | null {
  if (config.webhookPort === null || config.webhookSecret === null) return null;
  return new WebhookListener({
    secret: config.webhookSecret,
    path: config.webhookPath,
    repos: config.repos,
    ...deps,
  });
}
