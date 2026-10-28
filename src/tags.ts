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

export const METADATA_LIMITS = {
  scalarChars: 120,
  urlChars: 512,
} as const;

export interface GitHubTagContext extends TagContext {
  merged?: boolean;
  reviewRequestedForSelf?: boolean;
}

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

export function hasLink(body: string | undefined): boolean {
  return !!body && /\bhttps?:\/\/[^\s<>()]+/i.test(body);
}

const FAILING_CONCLUSIONS: readonly CheckConclusion[] = ['failure', 'timed_out', 'action_required'];

function isFailure(event: NormalizedEvent): boolean {
  const checks = event.checks;
  if (!checks) return false;
  if (checks.conclusion && FAILING_CONCLUSIONS.includes(checks.conclusion)) return true;
  return checks.failed.length > 0;
}

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

export function tagsFor(event: NormalizedEvent, ctx: GitHubTagContext): TagResult {
  const tags = new Set<string>();

  const fromSelf = !!ctx.botLogin && event.actor.login === ctx.botLogin;
  if (fromSelf) tags.add('chat:from-self');
  else if (event.actor.isBot) tags.add('chat:from-bot');
  else tags.add('chat:from-human');

  const mentioned = MENTION_KINDS.has(event.kind) && mentionsBot(event.body, ctx.botLogin);
  const isOwnThread = ctx.isOwnThread === true;
  const isReplyToSelf = ctx.isReplyToSelf === true;
  const isReply = isOwnThread || isReplyToSelf;
  if (mentioned) tags.add('chat:mention');
  if (isReply) tags.add('chat:reply');
  if (!mentioned && !isReply) tags.add('chat:ambient');
  // `chat:dm` never: GitHub has no one-to-one channel.

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
      if (ciFailure) tags.add('github:ci=failure');
      else if (event.checks?.conclusion === 'success') tags.add('github:ci=success');
      break;
    case 'push':
      tags.add('github:push');
      break;
    case 'comment.created':
    case 'comment.edited':
    case 'comment.deleted':
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

export const EMITTED_TAGS: readonly string[] = [...CORE_TAGS, ...GITHUB_TAGS];

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

export const TAG_ONTOLOGY_PRODUCER = TAG_PRODUCER;
