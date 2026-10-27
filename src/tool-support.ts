import {
  LIMITS,
  bounded,
  parseRepoSlug,
  repoAllowed,
  repoSlug,
  type RepoRef,
  type ThreadKind,
  type ThreadRef,
  type ToolContext,
  type ToolResult,
} from './types.js';

export const FIELD = {
  name: LIMITS.titleChars,
  slug: 160,
  sha: 64,
  nodeId: 128,
  path: 200,
  query: 200,
  url: 300,
} as const;

export function echo(value: unknown, max: number = FIELD.name): string {
  if (typeof value !== 'string') return bounded(JSON.stringify(value) ?? String(value), max);
  return JSON.stringify(bounded(value, Math.max(0, max - 2)));
}

export function field(value: string, max: number = FIELD.name): string {
  return bounded(value, max);
}

export function boundedInline(items: readonly string[], max: number = FIELD.name): string {
  const shown = items.slice(0, LIMITS.listEntries).map((item) => field(item, max));
  if (items.length > shown.length) {
    shown.push(`… ${items.length - shown.length} more not shown (list bound ${LIMITS.listEntries})`);
  }
  return shown.join(', ');
}

export class ToolRefusal extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ToolRefusal';
  }
}

export function refuse(reason: string): never {
  throw new ToolRefusal(reason);
}

export class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolArgumentError';
  }
}

export function toolResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

export function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

export function describeFailure(toolName: string, err: unknown): string {
  const tool = field(toolName);
  if (err instanceof ToolRefusal) return `${tool} refused: ${err.message}`;
  if (err instanceof ToolArgumentError) return `${tool}: ${err.message}`;
  const message = err instanceof Error ? err.message : String(err);
  const status = statusOf(err);
  return status === undefined
    ? `${tool} failed: ${bounded(message, LIMITS.commentChars)}`
    : `${tool} failed: GitHub error ${status}: ${bounded(message, LIMITS.commentChars)}`;
}

/**
 * A refusal, a malformed call or a GitHub error comes back as an error result
 * the model can read, not as a JSON-RPC error.
 */
export async function runTool(
  tool: string,
  ctx: ToolContext,
  body: () => Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    return await body();
  } catch (err) {
    const text = describeFailure(tool, err);
    ctx.logger.warn('tool call failed', { tool: field(tool), detail: text });
    return errorResult(text);
  }
}

export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolArgumentError(`"${key}" is required and must be a non-empty string`);
  }
  return value;
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ToolArgumentError(`"${key}" must be a string`);
  return value;
}

export function requireNumber(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
    throw new ToolArgumentError(`"${key}" must be a positive integer, got ${echo(value)}`);
  }
  return n;
}

export function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  if (args[key] === undefined || args[key] === null) return undefined;
  return requireNumber(args, key);
}

export function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new ToolArgumentError(`"${key}" must be a boolean`);
  return value;
}

export function requireStringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new ToolArgumentError(`"${key}" must be a non-empty array of strings`);
  }
  return value.map((entry, i) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new ToolArgumentError(`"${key}[${i}]" must be a non-empty string`);
    }
    return entry;
  });
}

export function oneOf<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback?: T,
): T {
  const value = args[key];
  if ((value === undefined || value === null) && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ToolArgumentError(`"${key}" must be one of ${allowed.join(' | ')}, got ${echo(value)}`);
  }
  return value as T;
}

export function resolveRepo(args: Record<string, unknown>, ctx: ToolContext): RepoRef {
  const allowed = ctx.repos;
  if (allowed.length === 0) {
    throw new ToolArgumentError('GITHUB_REPOS names no repository, so there is nothing to act on');
  }
  const raw = optionalString(args, 'repo');
  if (raw === undefined || raw.trim() === '') {
    if (allowed.length === 1) return allowed[0];
    throw new ToolArgumentError(
      `"repo" is required: GITHUB_REPOS names several repositories (${boundedInline(allowed.map(repoSlug), FIELD.slug)})`,
    );
  }
  const repo = parseRepoSlug(raw);
  if (!repo) throw new ToolArgumentError(`"repo" must be owner/name, got ${echo(raw, FIELD.slug)}`);
  return requireAllowedRepo(repo, allowed);
}

export function requireAllowedRepo(repo: RepoRef, allowed: readonly RepoRef[]): RepoRef {
  if (!repoAllowed(repo, allowed)) {
    refuse(
      `repository ${field(repoSlug(repo), FIELD.slug)} is not in GITHUB_REPOS (allowed: ${boundedInline(
        allowed.map(repoSlug),
        FIELD.slug,
      )})`,
    );
  }
  return repo;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The `thread` forms the tools accept: `12`, `"12"` or `"#12"` in the one
 * repository GITHUB_REPOS names; `"owner/name#12"` or `"github:owner/name#12"`,
 * the channel id's spelling; `{ owner, name, number, kind }` and
 * `{ repo: "owner/name", number }`; and `{ repo: "name", number }`, which
 * takes its owner from the one repository GITHUB_REPOS names. Without a
 * `kind`, `kindDefault` applies; issue comments on a pull request take the
 * `issue` path in GitHub's REST API.
 */
export function parseThread(
  raw: unknown,
  ctx: Pick<ToolContext, 'repos'>,
  kindDefault: ThreadKind = 'issue',
): Parsed<ThreadRef> {
  const fallback = ctx.repos.length === 1 ? ctx.repos[0] : null;
  let owner: string | undefined;
  let name: string | undefined;
  let number: number | undefined;
  let kind: ThreadKind | undefined;

  if (typeof raw === 'number') {
    number = raw;
  } else if (typeof raw === 'string') {
    const m = /^(?:github:)?(?:([^/\s#]+)\/([^/\s#]+))?#?(\d+)$/.exec(raw.trim());
    if (!m) {
      return { ok: false, error: `thread: expected owner/name#number or a number, got ${echo(raw, FIELD.slug)}` };
    }
    owner = m[1];
    name = m[2];
    number = Number(m[3]);
  } else if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const repoField = typeof obj.repo === 'string' ? obj.repo : undefined;
    if (repoField?.includes('/')) {
      [owner, name] = repoField.split('/', 2);
    } else if (repoField) {
      name = repoField;
    }
    if (typeof obj.owner === 'string') owner = obj.owner;
    if (typeof obj.name === 'string') name = obj.name;
    if (typeof obj.number === 'number') number = obj.number;
    if (typeof obj.number === 'string' && /^\d+$/.test(obj.number)) number = Number(obj.number);
    if (obj.kind === 'issue' || obj.kind === 'pull') kind = obj.kind;
  } else {
    return { ok: false, error: 'thread: required (owner/name#number, a number, or { owner, name, number, kind })' };
  }

  if (!Number.isInteger(number) || (number as number) <= 0) {
    return { ok: false, error: `thread: number must be a positive integer, got ${echo(raw, FIELD.slug)}` };
  }
  owner = owner ?? fallback?.owner;
  name = name ?? fallback?.name;
  if (!owner || !name) {
    return {
      ok: false,
      error: `thread: name the repository as owner/name#${number} (GITHUB_REPOS holds ${
        boundedInline(ctx.repos.map(repoSlug), FIELD.slug) || 'nothing'
      })`,
    };
  }
  return { ok: true, value: { repo: { owner, name }, number: number as number, kind: kind ?? kindDefault } };
}

export function resolveThread(args: Record<string, unknown>, ctx: ToolContext, kind: ThreadKind): ThreadRef {
  if (args.thread !== undefined && args.thread !== null) {
    const parsed = parseThread(args.thread, ctx, kind);
    if (!parsed.ok) throw new ToolArgumentError(parsed.error);
    requireAllowedRepo(parsed.value.repo, ctx.repos);
    return { ...parsed.value, kind };
  }
  return { repo: resolveRepo(args, ctx), number: requireNumber(args, 'number'), kind };
}

export const REPO_PROPERTY = {
  type: 'string',
  description:
    'Repository as owner/name. Optional when GITHUB_REPOS names one repository (it is then the default); ' +
    'required when it names several. Any repository outside GITHUB_REPOS is refused by name.',
} as const;

export const NUMBER_PROPERTY = {
  type: 'integer',
  minimum: 1,
  description: 'Issue or pull-request number',
} as const;

export const THREAD_PROPERTY = {
  description: 'The issue or pull request: "owner/name#12", "#12", 12, or { owner, name, number, kind }.',
  anyOf: [
    { type: 'string' },
    { type: 'integer' },
    {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        name: { type: 'string' },
        number: { type: 'integer' },
        kind: { type: 'string', enum: ['issue', 'pull'] },
      },
      required: ['number'],
    },
  ],
} as const;
