import { createHash } from 'node:crypto';
import {
  parseRepoSlug,
  type CheckConclusion,
  type ChecksSummary,
  type DiffSide,
  type EventActor,
  type FailedCheck,
  type GitHubApi,
  type Logger,
  type NormalizedEvent,
  type NormalizedEventKind,
  type PolledComment,
  type PolledIssue,
  type RepoRef,
  type ReviewState,
  type ThreadKind,
  type ThreadRef,
} from './types.js';

export interface WebhookDelivery {
  id: string;
  event: string;
  payload: unknown;
  receivedAt: string;
}

export type PollRowKind = 'issue' | 'issue_comment' | 'review_comment' | 'checks';

export function pollKey(kind: PollRowKind, id: number | string, updatedAt: string): string {
  return `${kind}:${id}:${updatedAt}`;
}

export function pollEventId(key: string): string {
  return `poll:${key}`;
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function at(value: unknown, ...path: string[]): unknown {
  let cursor: unknown = value;
  for (const key of path) {
    const o = asObject(cursor);
    if (!o) return undefined;
    cursor = o[key];
  }
  return cursor;
}

export function actorFrom(user: unknown): EventActor | undefined {
  const login = asString(at(user, 'login'));
  if (!login) return undefined;
  const type = asString(at(user, 'type'));
  return { login, isBot: type === 'Bot' || login.endsWith('[bot]') };
}

export function repoFrom(payload: unknown): RepoRef | undefined {
  const full = asString(at(payload, 'repository', 'full_name'));
  if (full) {
    const parsed = parseRepoSlug(full);
    if (parsed) return parsed;
  }
  const owner = asString(at(payload, 'repository', 'owner', 'login'));
  const name = asString(at(payload, 'repository', 'name'));
  return owner && name ? { owner, name } : undefined;
}

const CHECK_CONCLUSIONS: readonly CheckConclusion[] = [
  'success',
  'failure',
  'neutral',
  'cancelled',
  'timed_out',
  'action_required',
  'skipped',
  'stale',
];

function conclusionFrom(value: unknown): CheckConclusion | null {
  const raw = asString(value);
  return raw && (CHECK_CONCLUSIONS as readonly string[]).includes(raw) ? (raw as CheckConclusion) : null;
}

function reviewStateFrom(value: unknown): ReviewState {
  switch (asString(value)?.toLowerCase()) {
    case 'approved':
      return 'approved';
    case 'changes_requested':
      return 'changes_requested';
    default:
      return 'commented';
  }
}

function sideFrom(value: unknown): DiffSide {
  return asString(value)?.toUpperCase() === 'LEFT' ? 'LEFT' : 'RIGHT';
}

/**
 * An issue and a pull request share one number space, and a comment row names
 * only the number — but its `html_url` says which: `/pull/7` or `/issues/7`.
 */
export function threadKindFromUrl(url: string | undefined): ThreadKind {
  return url !== undefined && /\/pull\/\d+/.test(url) ? 'pull' : 'issue';
}

function thread(repo: RepoRef, number: number | undefined, kind: ThreadKind): ThreadRef | undefined {
  return number === undefined ? undefined : { repo, number, kind };
}

function eventId(deliveryId: string, index: number, total: number): string {
  return total > 1 ? `${deliveryId}#${index}` : deliveryId;
}

const ISSUE_ACTIONS: Record<string, NormalizedEventKind> = {
  opened: 'issue.opened',
  edited: 'issue.edited',
  closed: 'issue.closed',
  reopened: 'issue.reopened',
};

const COMMENT_ACTIONS: Record<string, NormalizedEventKind> = {
  created: 'comment.created',
  edited: 'comment.edited',
  deleted: 'comment.deleted',
};

const PULL_ACTIONS: Record<string, NormalizedEventKind> = {
  opened: 'pull.opened',
  synchronize: 'pull.synchronize',
  ready_for_review: 'pull.ready_for_review',
  review_requested: 'pull.review_requested',
  closed: 'pull.closed',
};

const REVIEW_COMMENT_ACTIONS: Record<string, NormalizedEventKind> = {
  created: 'review_comment.created',
  edited: 'review_comment.edited',
  deleted: 'comment.deleted',
};

export const HANDLED_WEBHOOK_EVENTS: readonly string[] = [
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'check_suite',
  'check_run',
  'push',
];

export function normalizeWebhook(delivery: WebhookDelivery): NormalizedEvent[] {
  const { payload } = delivery;
  const repo = repoFrom(payload);
  if (!repo) return [];
  const action = asString(at(payload, 'action')) ?? '';
  const actor = actorFrom(at(payload, 'sender'));
  const base = { id: delivery.id, receivedAt: delivery.receivedAt, repo, raw: payload };

  switch (delivery.event) {
    case 'issues': {
      const kind = ISSUE_ACTIONS[action];
      const issue = asObject(at(payload, 'issue'));
      if (!kind || !issue || !actor) return [];
      const html_url = asString(issue.html_url);
      if (!html_url) return [];
      return [
        {
          ...base,
          kind,
          thread: thread(repo, asNumber(issue.number), 'issue'),
          actor,
          title: asString(issue.title),
          body: asString(issue.body),
          html_url,
        },
      ];
    }

    case 'issue_comment': {
      const kind = COMMENT_ACTIONS[action];
      const comment = asObject(at(payload, 'comment'));
      const issue = asObject(at(payload, 'issue'));
      if (!kind || !comment || !issue || !actor) return [];
      const html_url = asString(comment.html_url);
      if (!html_url) return [];
      return [
        {
          ...base,
          kind,
          // `issue.pull_request` is present iff the thread is a pull request.
          thread: thread(repo, asNumber(issue.number), asObject(issue.pull_request) ? 'pull' : 'issue'),
          actor,
          title: asString(issue.title),
          body: asString(comment.body),
          html_url,
          ...(asNumber(comment.id) === undefined ? {} : { comment: { id: asNumber(comment.id) as number } }),
        },
      ];
    }

    case 'pull_request': {
      const kind = PULL_ACTIONS[action];
      const pull = asObject(at(payload, 'pull_request'));
      if (!kind || !pull || !actor) return [];
      const html_url = asString(pull.html_url);
      if (!html_url) return [];
      return [
        {
          ...base,
          kind,
          thread: thread(repo, asNumber(pull.number), 'pull'),
          actor,
          title: asString(pull.title),
          body: asString(pull.body),
          html_url,
          sha: asString(at(pull, 'head', 'sha')),
        },
      ];
    }

    case 'pull_request_review': {
      const review = asObject(at(payload, 'review'));
      const pull = asObject(at(payload, 'pull_request'));
      if (action !== 'submitted' || !review || !pull || !actor) return [];
      const id = asNumber(review.id);
      const html_url = asString(review.html_url);
      if (id === undefined || !html_url) return [];
      return [
        {
          ...base,
          kind: 'review.submitted',
          thread: thread(repo, asNumber(pull.number), 'pull'),
          actor,
          title: asString(pull.title),
          body: asString(review.body),
          html_url,
          // The commit the review was written against, which is not the PR's
          // current head once the branch moved under the reviewer.
          sha: asString(review.commit_id) ?? asString(at(pull, 'head', 'sha')),
          review: { id, state: reviewStateFrom(review.state) },
        },
      ];
    }

    case 'pull_request_review_comment': {
      const kind = REVIEW_COMMENT_ACTIONS[action];
      const comment = asObject(at(payload, 'comment'));
      const pull = asObject(at(payload, 'pull_request'));
      if (!kind || !comment || !pull || !actor) return [];
      const id = asNumber(comment.id);
      const path = asString(comment.path);
      const html_url = asString(comment.html_url);
      if (id === undefined || !path || !html_url) return [];
      return [
        {
          ...base,
          kind,
          thread: thread(repo, asNumber(pull.number), 'pull'),
          actor,
          title: asString(pull.title),
          body: asString(comment.body),
          html_url,
          sha: asString(comment.commit_id) ?? asString(at(pull, 'head', 'sha')),
          reviewComment: {
            id,
            path,
            line: asNumber(comment.line) ?? asNumber(comment.original_line) ?? null,
            side: sideFrom(comment.side),
            diffHunk: asString(comment.diff_hunk) ?? '',
            ...(asNumber(comment.in_reply_to_id) === undefined
              ? {}
              : { inReplyTo: asNumber(comment.in_reply_to_id) as number }),
          },
        },
      ];
    }

    case 'check_suite':
      return action === 'completed' ? normalizeCheckSuite(base, payload, actor) : [];

    case 'check_run':
      return action === 'completed' ? normalizeCheckRun(base, payload, actor) : [];

    case 'push': {
      const after = asString(at(payload, 'after'));
      const html_url = asString(at(payload, 'compare'));
      const pusher = actor ?? actorFrom({ login: asString(at(payload, 'pusher', 'name')) });
      if (!after || !html_url || !pusher) return [];
      return [{ ...base, kind: 'push', actor: pusher, html_url, sha: after }];
    }

    default:
      return [];
  }
}

type EventBase = Pick<NormalizedEvent, 'id' | 'receivedAt' | 'repo' | 'raw'>;

function normalizeCheckSuite(base: EventBase, payload: unknown, actor: EventActor | undefined): NormalizedEvent[] {
  const suite = asObject(at(payload, 'check_suite'));
  if (!suite) return [];
  const sha = asString(suite.head_sha);
  if (!sha) return [];
  const pulls = asArray(suite.pull_requests);
  const match = pulls.find((p) => asString(at(p, 'head', 'sha')) === sha) ?? pulls[0];
  const number = asNumber(at(match, 'number'));
  const html_url =
    asString(at(match, 'html_url')) ??
    asString(suite.html_url) ??
    `https://github.com/${base.repo.owner}/${base.repo.name}/commit/${sha}`;
  return [
    {
      ...base,
      kind: 'checks.completed',
      thread: thread(base.repo, number, 'pull'),
      actor: actor ?? { login: asString(at(suite, 'app', 'slug')) ?? 'github', isBot: true },
      html_url,
      sha,
      checks: { conclusion: conclusionFrom(suite.conclusion), failed: [] },
    },
  ];
}

/**
 * GitHub delivers `check_suite` and `check_run` separately, each with its own
 * delivery id, so a deployment subscribed to both sees two deliveries for one
 * sha.
 */
function normalizeCheckRun(base: EventBase, payload: unknown, actor: EventActor | undefined): NormalizedEvent[] {
  const run = asObject(at(payload, 'check_run'));
  if (!run) return [];
  const sha = asString(run.head_sha) ?? asString(at(run, 'check_suite', 'head_sha'));
  if (!sha) return [];
  const conclusion = conclusionFrom(run.conclusion);
  const name = asString(run.name);
  const url = asString(run.html_url);
  const failed: FailedCheck[] =
    conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'action_required'
      ? [{ name: name ?? 'check', url: url ?? '' }]
      : [];
  const pulls = asArray(run.pull_requests);
  const match = pulls.find((p) => asString(at(p, 'head', 'sha')) === sha) ?? pulls[0];
  return [
    {
      ...base,
      kind: 'checks.completed',
      thread: thread(base.repo, asNumber(at(match, 'number')), 'pull'),
      actor: actor ?? { login: asString(at(run, 'app', 'slug')) ?? 'github', isBot: true },
      html_url: url ?? `https://github.com/${base.repo.owner}/${base.repo.name}/commit/${sha}`,
      sha,
      checks: { conclusion, failed },
    },
  ];
}

/**
 * GitHub stamps a row without milliseconds while a cursor carries them, and
 * `'Z'` sorts after `'.'`, so these compare as instants, not as strings.
 */
export function atOrAfter(at: string, since: string): boolean {
  const a = Date.parse(at);
  const b = Date.parse(since);
  return Number.isFinite(a) && Number.isFinite(b) && a >= b;
}

/**
 * GitHub's `since` list says that a row changed, not how: it carries no
 * action. A comment bumps its issue's or pull request's `updated_at` without
 * changing the thread itself.
 */
export function normalizePolledIssue(
  repo: RepoRef,
  row: PolledIssue,
  receivedAt: string,
  since: string,
  previousMarker?: string,
  announced = false,
): NormalizedEvent | null {
  const key = pollKey('issue', row.id, row.updatedAt);
  const isNew = !announced && atOrAfter(row.createdAt, since);
  const closed = row.state === 'closed';
  const changed = previousMarker === undefined || polledMarker(row) !== previousMarker;
  let kind: NormalizedEventKind;
  if (row.isPullRequest) {
    if (closed) {
      if (!isNew && !changed) return null;
      kind = 'pull.closed';
    } else if (isNew) kind = 'pull.opened';
    else if (row.headSha !== undefined && row.headSha !== '' && row.headSha !== previousMarker) {
      kind = 'pull.synchronize';
    } else return null;
  } else {
    if (!isNew && !changed) return null;
    kind = closed ? 'issue.closed' : isNew ? 'issue.opened' : 'issue.edited';
  }
  return {
    id: pollEventId(key),
    receivedAt,
    repo,
    kind,
    thread: { repo, number: row.number, kind: row.isPullRequest ? 'pull' : 'issue' },
    actor: closed && row.closedBy ? row.closedBy : row.author,
    title: row.title,
    body: row.body,
    html_url: row.html_url,
    ...(row.headSha === undefined ? {} : { sha: row.headSha }),
    raw: row,
  };
}

export function polledMarker(row: PolledIssue): string | undefined {
  if (row.isPullRequest) return row.state === 'closed' ? 'closed' : row.headSha || undefined;
  const text = createHash('sha256').update(`${row.title}\0${row.body}`).digest('hex').slice(0, 16);
  return `issue:${row.state}:${text}`;
}

export function normalizePolledComment(
  repo: RepoRef,
  row: PolledComment,
  rowKind: 'issue_comment' | 'review_comment',
  receivedAt: string,
): NormalizedEvent {
  const key = pollKey(rowKind, row.id, row.updatedAt);
  const review = rowKind === 'review_comment';
  return {
    id: pollEventId(key),
    receivedAt,
    repo,
    kind: review ? 'review_comment.created' : 'comment.created',
    thread: { repo, number: row.number, kind: review ? 'pull' : threadKindFromUrl(row.html_url) },
    actor: row.author,
    body: row.body,
    html_url: row.html_url,
    ...(review ? {} : { comment: { id: row.id } }),
    ...(review
      ? {
          reviewComment: {
            id: row.id,
            path: row.path ?? '',
            line: null,
            side: 'RIGHT' as DiffSide,
            diffHunk: '',
            ...(row.inReplyTo === undefined ? {} : { inReplyTo: row.inReplyTo }),
          },
        }
      : {}),
    raw: row,
  };
}

export type CompletedChecksSummary = ChecksSummary & { conclusion: CheckConclusion };

export function isCompletedSummary(summary: ChecksSummary): summary is CompletedChecksSummary {
  return summary.total > 0 && summary.conclusion !== null;
}

export function checksPollKey(summary: CompletedChecksSummary): string {
  const names = summary.failed.map((f) => f.name).sort();
  const fingerprint = createHash('sha1').update(names.join('\n')).digest('hex').slice(0, 12);
  return pollKey('checks', summary.sha, `${summary.conclusion}:${summary.failed.length}:${fingerprint}`);
}

export function normalizePolledChecks(
  repo: RepoRef,
  pull: ThreadRef,
  summary: CompletedChecksSummary,
  html_url: string,
  receivedAt: string,
): NormalizedEvent {
  const key = checksPollKey(summary);
  return {
    id: pollEventId(key),
    receivedAt,
    repo,
    kind: 'checks.completed',
    thread: pull,
    actor: { login: 'github', isBot: true },
    html_url,
    sha: summary.sha,
    checks: { conclusion: summary.conclusion, failed: summary.failed },
    raw: summary,
  };
}


/**
 * A check delivery names only the suite or job that just finished, so the
 * whole sha's runs are read here.
 */
export async function resolveCheckEvents(
  events: readonly NormalizedEvent[],
  api: Pick<GitHubApi, 'getCheckRuns'>,
  logger?: Logger,
): Promise<NormalizedEvent[]> {
  const out: NormalizedEvent[] = [];
  for (const event of events) {
    if (event.kind !== 'checks.completed' || !event.sha) {
      out.push(event);
      continue;
    }
    let summary: ChecksSummary;
    try {
      summary = await api.getCheckRuns(event.repo, event.sha);
    } catch (err) {
      logger?.warn('check runs lookup failed; forwarding the event without job names', {
        sha: event.sha,
        error: err instanceof Error ? err.message : String(err),
      });
      out.push(event);
      continue;
    }
    if (isCompletedSummary(summary)) {
      out.push({ ...event, checks: { conclusion: summary.conclusion, failed: summary.failed } });
    } else if (summary.total === 0) {
      out.push(event);
    } else {
      logger?.info('checks event held back: another suite is still running on this head', {
        sha: event.sha,
        runs: summary.total,
      });
    }
  }
  return out;
}

export const CHECK_MARK_RING = 2000;

const CONCLUSION_SEVERITY: Record<CheckConclusion, number> = {
  success: 0,
  skipped: 1,
  neutral: 2,
  stale: 3,
  cancelled: 4,
  action_required: 5,
  timed_out: 6,
  failure: 7,
};

function severity(conclusion: CheckConclusion | null): number {
  return conclusion === null ? -1 : CONCLUSION_SEVERITY[conclusion];
}

export interface CheckMark {
  rank: number;
  failed: readonly string[];
}

export function checkMarkOf(event: NormalizedEvent): CheckMark | null {
  if (event.kind !== 'checks.completed' || !event.sha) return null;
  const names = [...new Set((event.checks?.failed ?? []).map((f) => f.name))].sort();
  return { rank: severity(event.checks?.conclusion ?? null), failed: names };
}

export function coversMark(committed: CheckMark, mark: CheckMark): boolean {
  return committed.rank >= mark.rank && mark.failed.every((name) => committed.failed.includes(name));
}

function mergeMarks(a: CheckMark, b: CheckMark): CheckMark {
  return {
    rank: Math.max(a.rank, b.rank),
    failed: [...new Set([...a.failed, ...b.failed])].sort(),
  };
}

export class CheckGate {
  private readonly committed = new Map<string, CheckMark>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly capacity: number = CHECK_MARK_RING) {}

  static key(repo: RepoRef, sha: string): string {
    return `${repo.owner}/${repo.name}@${sha}`;
  }

  committedMark(repo: RepoRef, sha: string): CheckMark | undefined {
    return this.committed.get(CheckGate.key(repo, sha));
  }

  async emit(repo: RepoRef, sha: string, mark: CheckMark, deliver: () => Promise<void>): Promise<boolean> {
    const key = CheckGate.key(repo, sha);

    const run = async (): Promise<boolean> => {
      const seen = this.committed.get(key);
      if (seen !== undefined && coversMark(seen, mark)) return false;
      await deliver();
      this.commit(key, mark);
      return true;
    };

    const ahead = this.queues.get(key);
    const mine: Promise<boolean> = ahead === undefined ? run() : ahead.then(run, run);
    this.queues.set(key, mine);
    try {
      return await mine;
    } finally {
      if (this.queues.get(key) === mine) this.queues.delete(key);
    }
  }

  private commit(key: string, mark: CheckMark): void {
    const current = this.committed.get(key);
    this.committed.set(key, current === undefined ? mark : mergeMarks(current, mark));
    if (this.committed.size > this.capacity) {
      const oldest = this.committed.keys().next();
      if (!oldest.done) this.committed.delete(oldest.value);
    }
  }

  get size(): number {
    return this.committed.size;
  }

  get inFlight(): number {
    return this.queues.size;
  }
}
