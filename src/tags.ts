/**
 * MCPL RFC-001 §4.1: hosts expand `chat:mention` and `chat:reply` to
 * `chat:addressed`, and a producer should not emit `chat:ambient` beside a tag
 * that implies `chat:addressed`, so this module never does.
 */

import type { TagOntology } from '@animalabs/mcpl-core';
import {
  CORE_TAGS,
  GITHUB_TAGS,
  TAG_PRODUCER,
  bounded,
  repoSlug,
  type CheckConclusion,
  type EventMetadata,
  type NormalizedEvent,
  type TagContext,
  type TagResult,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Bounds and context
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "Every string field is bounded" (contract). `LIMITS` bounds what reaches the
 * model; these bound the much smaller scalars of metadata, which a host keeps
 * per event and matches rules against.
 */
export const METADATA_LIMITS = {
  /** `repo`, `actor`, `sha`. */
  scalarChars: 120,
  /** `htmlUrl`. GitHub's own links are far below this; a hostile one is cut. */
  urlChars: 512,
} as const;

/**
 * What `tagsFor` needs beyond {@link TagContext}, which the frozen contract
 * fixed before these two facts were known to be underivable from a
 * `NormalizedEvent`. Both are optional, so a `TagContext` is still accepted.
 *
 * - `merged`: `pull.closed` carries no merged/unmerged discriminator (the
 *   payload's `pull_request.merged` lives in `raw`, which never reaches this
 *   module), yet `github:pr=merged` is in the contract's vocabulary. The
 *   ingress (.3) or the caller passes it; absent means "not known to be
 *   merged" and only `github:pr=closed` is emitted.
 * - `reviewRequestedForSelf`: `pull.review_requested` carries no requested
 *   reviewer, so the event alone cannot say whether *this* bot was asked.
 *   Absent means "assume the request concerns the bot" — the conservative
 *   choice for a wake signal; `false` suppresses `isReviewRequested`.
 */
export interface GitHubTagContext extends TagContext {
  merged?: boolean;
  reviewRequestedForSelf?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Detection helpers
// ─────────────────────────────────────────────────────────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A GitHub App's login is `name[bot]`, but GitHub writes its mention as
 * `@name`, so both spellings count.
 */
export function mentionsBot(body: string | undefined, botLogin: string): boolean {
  if (!body || !botLogin) return false;
  const handle = botLogin.endsWith('[bot]') ? botLogin.slice(0, -'[bot]'.length) : botLogin;
  if (!handle) return false;
  const re = new RegExp(`(?<![\\w/-])@${escapeRegExp(handle)}(\\[bot\\])?(?![\\w-])`, 'i');
  return re.test(body);
}

/** Does `body` carry a URL? Drives `chat:has-link`. */
export function hasLink(body: string | undefined): boolean {
  return !!body && /\bhttps?:\/\/[^\s<>()]+/i.test(body);
}

/**
 * Which check conclusions count as a CI failure. `null` is "still running",
 * and `neutral`/`cancelled`/`skipped`/`stale` are not failures — they must not
 * wake a recipe that watches for broken builds.
 */
const FAILING_CONCLUSIONS: readonly CheckConclusion[] = ['failure', 'timed_out', 'action_required'];

function isFailure(event: NormalizedEvent): boolean {
  const checks = event.checks;
  if (!checks) return false;
  if (checks.conclusion && FAILING_CONCLUSIONS.includes(checks.conclusion)) return true;
  return checks.failed.length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// tagsFor
// ─────────────────────────────────────────────────────────────────────────────

/** The kinds whose body is new text, and so the only ones a mention can address. */
const MENTION_KINDS: ReadonlySet<NormalizedEvent['kind']> = new Set([
  'issue.opened',
  'issue.edited',
  'pull.opened',
  'comment.created',
  'comment.edited',
  'review.submitted',
  'review_comment.created',
  'review_comment.edited',
]);

/**
 * The tag set and wake metadata for one event.
 *
 * `ctx.isOwnThread` and `ctx.isReplyToSelf` are facts only the caller can
 * know (the channel registry in .5 tracks the threads the bot authored or
 * commented in, and the ids of its own comments); they arrive as booleans.
 */
export function tagsFor(event: NormalizedEvent, ctx: GitHubTagContext): TagResult {
  const tags = new Set<string>();

  // ── Sender: exactly one of the three, from-self only for the bot login ──
  const fromSelf = !!ctx.botLogin && event.actor.login === ctx.botLogin;
  if (fromSelf) tags.add('chat:from-self');
  else if (event.actor.isBot) tags.add('chat:from-bot');
  else tags.add('chat:from-human');

  // ── Addressing: mention, reply, or ambient — never ambient beside either ──
  // Only an event that brings its text counts a mention: a close, a reopen or
  // new commits re-carry a body the bot already saw when it was written.
  const mentioned = MENTION_KINDS.has(event.kind) && mentionsBot(event.body, ctx.botLogin);
  const isOwnThread = ctx.isOwnThread === true;
  const isReplyToSelf = ctx.isReplyToSelf === true;
  // The contract: "chat:reply when the event is on a thread the bot authored
  // or has commented in, or replies to the bot's comment".
  const isReply = isOwnThread || isReplyToSelf;
  if (mentioned) tags.add('chat:mention');
  if (isReply) tags.add('chat:reply');
  if (!mentioned && !isReply) tags.add('chat:ambient');
  // `chat:dm` never: GitHub has no one-to-one channel.

  // ── Locus, lifecycle, content ──
  if (event.kind === 'review_comment.created' || event.kind === 'review_comment.edited') {
    tags.add('chat:thread');
  }
  if (
    event.kind === 'issue.edited' ||
    event.kind === 'comment.edited' ||
    event.kind === 'review_comment.edited'
  ) {
    tags.add('chat:edited');
  }
  if (event.kind === 'comment.deleted') tags.add('chat:deleted');
  if (hasLink(event.body)) tags.add('chat:has-link');

  // ── The github: namespace ──
  const isReviewRequested =
    event.kind === 'pull.review_requested' && ctx.reviewRequestedForSelf !== false;
  const ciFailure = isFailure(event);
  switch (event.kind) {
    case 'issue.opened':
    case 'issue.edited':
    case 'issue.closed':
    case 'issue.reopened':
      tags.add(`github:issue=${event.kind.slice('issue.'.length)}`);
      break;
    case 'pull.opened':
    case 'pull.synchronize':
    case 'pull.ready_for_review':
    case 'pull.review_requested':
      tags.add(`github:pr=${event.kind.slice('pull.'.length)}`);
      break;
    case 'pull.closed':
      // A merge is also a close, and both values are in the vocabulary, so a
      // rule written on either fires. Tags are a set, not a state machine.
      tags.add('github:pr=closed');
      if (ctx.merged === true) tags.add('github:pr=merged');
      break;
    case 'review.submitted':
      if (event.review) tags.add(`github:review=${event.review.state}`);
      break;
    case 'review_comment.created':
    case 'review_comment.edited':
      tags.add('github:review-comment');
      break;
    case 'checks.completed':
      // Only the two values the contract enumerates. A neutral or cancelled
      // suite is neither, and stays untagged rather than being called a pass.
      if (ciFailure) tags.add('github:ci=failure');
      else if (event.checks?.conclusion === 'success') tags.add('github:ci=success');
      break;
    case 'push':
      tags.add('github:push');
      break;
    case 'comment.created':
    case 'comment.edited':
    case 'comment.deleted':
      // Issue and PR conversation comments carry no `github:` tag of their
      // own: the core vocabulary already says everything a recipe routes on.
      break;
  }

  const isMaintainer = ctx.maintainers.includes(event.actor.login);
  if (isMaintainer) tags.add('github:actor=maintainer');

  const metadata: EventMetadata = {
    mentioned,
    isOwnThread,
    isReplyToSelf,
    isReviewRequested,
    isCiFailure: ciFailure,
    fromSelf,
    isMaintainer,
    repo: bounded(repoSlug(event.repo), METADATA_LIMITS.scalarChars),
    number: event.thread ? event.thread.number : null,
    kind: event.thread ? event.thread.kind : null,
    actor: bounded(event.actor.login, METADATA_LIMITS.scalarChars),
    sha: event.sha ? bounded(event.sha, METADATA_LIMITS.scalarChars) : null,
    htmlUrl: bounded(event.html_url, METADATA_LIMITS.urlChars),
  };

  return { tags: [...tags], metadata };
}

/**
 * Every tag `tagsFor` can emit. It is exactly the frozen contract's two lists:
 * `CORE_TAGS` already omits `chat:dm` (GitHub has no 1:1 channel this server
 * speaks on) and `chat:addressed` (the host's closure, see the file header).
 */
export const EMITTED_TAGS: readonly string[] = [...CORE_TAGS, ...GITHUB_TAGS];

// ─────────────────────────────────────────────────────────────────────────────
// The producer ontology (RFC-001 §5), for the feature-set declaration in .6
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MCPL RFC-001 §4.1: a producer's `implies` edge into `chat:*` would promote
 * its own traffic into the band reserved for being addressed, so there is none.
 * Suggested treatments are advisory (§5.2).
 */
export const GITHUB_TAG_ONTOLOGY: TagOntology = {
  coreTags: [...CORE_TAGS],
  tags: {
    'github:issue=opened': { desc: 'An issue was opened', facet: 'lifecycle' },
    'github:issue=edited': { desc: "An issue's title or body was edited", facet: 'lifecycle' },
    'github:issue=closed': { desc: 'An issue was closed', facet: 'lifecycle' },
    'github:issue=reopened': { desc: 'A closed issue was reopened', facet: 'lifecycle' },
    'github:pr=opened': { desc: 'A pull request was opened', facet: 'lifecycle' },
    'github:pr=synchronize': {
      desc: "New commits were pushed to a pull request's head",
      facet: 'lifecycle',
    },
    'github:pr=ready_for_review': {
      desc: 'A draft pull request was marked ready for review',
      facet: 'lifecycle',
    },
    'github:pr=review_requested': {
      desc: 'A review was requested on a pull request',
      facet: 'addressing',
    },
    'github:pr=closed': { desc: 'A pull request was closed', facet: 'lifecycle' },
    'github:pr=merged': {
      desc: 'A pull request was merged (emitted beside github:pr=closed)',
      facet: 'lifecycle',
    },
    'github:review=approved': { desc: 'A review was submitted approving', facet: 'lifecycle' },
    'github:review=changes_requested': {
      desc: 'A review was submitted requesting changes',
      facet: 'lifecycle',
    },
    'github:review=commented': {
      desc: 'A review was submitted without a verdict',
      facet: 'lifecycle',
    },
    'github:review-comment': {
      desc: 'A comment on a line of a diff, inside a review conversation',
      facet: 'locus',
    },
    'github:ci=success': { desc: 'Checks on a head sha concluded successfully', facet: 'content' },
    'github:ci=failure': {
      desc: 'Checks on a head sha failed, timed out, or require action',
      facet: 'content',
    },
    'github:push': { desc: 'Commits were pushed to a branch', facet: 'lifecycle' },
    'github:actor=maintainer': {
      desc: 'The actor is in GITHUB_MAINTAINERS',
      facet: 'sender',
    },
  },
  keyed: {
    issue: {
      desc: 'Issue lifecycle transition',
      values: ['opened', 'edited', 'closed', 'reopened'],
    },
    pr: {
      desc: 'Pull request lifecycle transition',
      values: ['opened', 'synchronize', 'ready_for_review', 'review_requested', 'closed', 'merged'],
    },
    review: {
      desc: 'Verdict of a submitted review',
      values: ['approved', 'changes_requested', 'commented'],
    },
    ci: { desc: 'Rolled-up conclusion of the checks on a head sha', values: ['success', 'failure'] },
    actor: { desc: 'Standing of the actor in this deployment', values: ['maintainer'] },
  },
  // Advisory, and only ever quieter than the host's own default for traffic
  // nobody addressed. First match wins, so the `mute`/`throttle` rules below
  // can never be reached by an event that is also addressed.
  defaultTreatment: [
    { tagsAny: ['chat:from-self'], behavior: 'mute' },
    { tagsAny: ['chat:deleted'], behavior: 'mute' },
    { tagsAll: ['github:ci=failure', 'chat:reply'], behavior: 'immediate' },
    { tagsAny: ['github:ci=success'], behavior: 'mute' },
    { tagsAll: ['chat:ambient', 'chat:from-bot'], behavior: 'mute' },
    { tagsAny: ['chat:ambient'], behavior: { debounce: 180_000 } },
  ],
  open: false,
};

/** The producer name every tag set this server emits is attributed to. */
export const TAG_ONTOLOGY_PRODUCER = TAG_PRODUCER;
