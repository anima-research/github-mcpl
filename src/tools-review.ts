/**
 * GitHub has no API to withdraw a submitted review, so these tools aren't
 * rollback-capable. GitHub refuses a verdict on one's own pull request with a
 * 422, so the author is checked against GITHUB_BOT_LOGIN first and the refusal
 * names the login.
 */

import {
  REVIEW_FEATURE_SET,
  TOOL_CREATE_REVIEW,
  TOOL_RESOLVE_THREAD,
  TOOL_UNRESOLVE_THREAD,
  parseThreadId,
  repoSlug,
  type DiffSide,
  type ReviewCommentInput,
  type ReviewEvent,
  type SubmittedReview,
  type ThreadRef,
  type ToolContext,
  type ToolDefinition,
  type ToolModule,
  type ToolResult,
} from './types.js';
import {
  FIELD,
  REPO_PROPERTY,
  ToolArgumentError,
  echo,
  field,
  optionalString,
  oneOf,
  refuse,
  requireString,
  resolveThread,
  runTool,
  toolResult,
} from './tool-support.js';

const REVIEW_EVENTS: readonly ReviewEvent[] = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'];
const DIFF_SIDES: readonly DiffSide[] = ['LEFT', 'RIGHT'];

const VERDICT_EVENTS: readonly ReviewEvent[] = ['APPROVE', 'REQUEST_CHANGES'];

/** GitHub logins are case-insensitive. */
function sameLogin(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function parseReviewComments(value: unknown): ReviewCommentInput[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ToolArgumentError('"comments" must be an array of inline comments');
  return value.map((entry, i) => {
    const at = `comments[${i}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ToolArgumentError(`"${at}" must be an object { path, line, side?, body }`);
    }
    const row = entry as Record<string, unknown>;
    const path = row.path;
    if (typeof path !== 'string' || path.trim() === '') {
      throw new ToolArgumentError(`"${at}.path" must be a non-empty file path`);
    }
    const line = row.line;
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
      throw new ToolArgumentError(
        `"${at}.line" must be a positive integer line number in the diff, got ${echo(line)}`,
      );
    }
    const side = row.side ?? 'RIGHT';
    if (typeof side !== 'string' || !(DIFF_SIDES as readonly string[]).includes(side)) {
      throw new ToolArgumentError(
        `"${at}.side" must be one of ${DIFF_SIDES.join(' | ')}, got ${echo(row.side)}`,
      );
    }
    const body = row.body;
    if (typeof body !== 'string' || body.trim() === '') {
      throw new ToolArgumentError(`"${at}.body" must be a non-empty string`);
    }
    return { path, line, side: side as DiffSide, body };
  });
}

/**
 * `resolve_thread` takes the GraphQL node id `list_review_threads` prints, not
 * the channel's `rt:<comment id>`, so that form is refused with the
 * difference named.
 */
export function requireReviewThreadId(args: Record<string, unknown>): string {
  const threadId = requireString(args, 'threadId');
  const channelForm = parseThreadId(threadId);
  if (channelForm) {
    throw new ToolArgumentError(
      `"threadId" is the review thread id from list_review_threads (a GraphQL node id), not the ` +
        `channel thread id ${echo(threadId, FIELD.nodeId)}`,
    );
  }
  return threadId;
}

/**
 * A GraphQL node id names a thread without its repository, so the pull request
 * is named too and the thread has to be one of its threads.
 */
async function requireThreadOnPull(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ pull: ThreadRef; threadId: string }> {
  const pull = resolveThread(args, ctx, 'pull');
  const threadId = requireReviewThreadId(args);
  const threads = await ctx.api.listReviewThreads(pull);
  if (!threads.some((t) => t.id === threadId)) {
    refuse(
      `review thread ${echo(threadId, FIELD.nodeId)} is not one of the ${threads.length} review ` +
        `thread${threads.length === 1 ? '' : 's'} on ${repoSlug(pull.repo)}#${pull.number}; a thread is ` +
        `only acted on where list_review_threads found it`,
    );
  }
  return { pull, threadId };
}

function renderSubmittedReview(pull: ThreadRef, review: SubmittedReview, inline: number): string {
  return (
    `submitted ${review.state} review ${review.id} on ${repoSlug(pull.repo)}#${pull.number} with ` +
    `${inline} inline comment${inline === 1 ? '' : 's'}\n${field(review.html_url, FIELD.url)}`
  );
}

export const reviewTools: ToolDefinition[] = [
  {
    name: TOOL_CREATE_REVIEW,
    description:
      'Submit a review on a pull request: COMMENT (remarks only), APPROVE or REQUEST_CHANGES. ' +
      'Inline comments attach to diff lines by path, line and side. APPROVE and REQUEST_CHANGES ' +
      'are refused on this bot’s own pull request. A submitted review cannot be withdrawn.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_PROPERTY,
        number: { type: 'integer', minimum: 1, description: 'Pull-request number' },
        event: {
          type: 'string',
          enum: [...REVIEW_EVENTS],
          description: 'COMMENT, APPROVE or REQUEST_CHANGES',
        },
        body: {
          type: 'string',
          description: 'Review summary (required for COMMENT and REQUEST_CHANGES, optional for APPROVE)',
        },
        comments: {
          type: 'array',
          description: 'Inline comments on diff lines',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path as the diff names it' },
              line: {
                type: 'integer',
                minimum: 1,
                description: 'Line number in the diff (a positive integer; a string is refused)',
              },
              side: {
                type: 'string',
                enum: [...DIFF_SIDES],
                description: 'RIGHT for the new version (default), LEFT for a removed line',
              },
              body: { type: 'string', description: 'Comment text' },
            },
            required: ['path', 'line', 'body'],
          },
        },
      },
      required: ['number', 'event'],
    },
  },
  {
    name: TOOL_RESOLVE_THREAD,
    description:
      'Mark a review thread resolved. Takes the pull request it is on and the thread id ' +
      'list_review_threads prints for that pull request; a thread id from anywhere else is refused.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_PROPERTY,
        number: { type: 'integer', minimum: 1, description: 'Pull-request number the thread is on' },
        threadId: { type: 'string', description: 'Review thread id from list_review_threads' },
      },
      required: ['number', 'threadId'],
    },
  },
  {
    name: TOOL_UNRESOLVE_THREAD,
    description:
      'Reopen a resolved review thread. Takes the pull request it is on and the thread id ' +
      'list_review_threads prints for that pull request; a thread id from anywhere else is refused.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_PROPERTY,
        number: { type: 'integer', minimum: 1, description: 'Pull-request number the thread is on' },
        threadId: { type: 'string', description: 'Review thread id from list_review_threads' },
      },
      required: ['number', 'threadId'],
    },
  },
];

async function callReview(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  switch (name) {
    case TOOL_CREATE_REVIEW: {
      const pull = resolveThread(args, ctx, 'pull');
      const event = oneOf<ReviewEvent>(args, 'event', REVIEW_EVENTS);
      const body = optionalString(args, 'body');
      const comments = parseReviewComments(args.comments);
      if (event !== 'APPROVE' && (body === undefined || body.trim() === '')) {
        throw new ToolArgumentError(`"body" is required for a ${event} review`);
      }
      if (VERDICT_EVENTS.includes(event)) {
        const pr = await ctx.api.getPullRequest(pull);
        if (sameLogin(pr.author.login, ctx.botLogin)) {
          refuse(
            `${event} on ${repoSlug(pull.repo)}#${pull.number} is this bot's own pull request ` +
              `(author ${field(pr.author.login)}); a verdict on one's own work is not a review. Use event ` +
              `COMMENT instead.`,
          );
        }
      }
      const review = await ctx.api.createReview(pull, {
        event,
        body,
        comments: comments.length > 0 ? comments : undefined,
      });
      return toolResult(renderSubmittedReview(pull, review, comments.length));
    }
    case TOOL_RESOLVE_THREAD: {
      const { pull, threadId } = await requireThreadOnPull(args, ctx);
      await ctx.api.resolveReviewThread(threadId);
      return toolResult(
        `resolved review thread ${field(threadId, FIELD.nodeId)} on ${repoSlug(pull.repo)}#${pull.number}`,
      );
    }
    case TOOL_UNRESOLVE_THREAD: {
      const { pull, threadId } = await requireThreadOnPull(args, ctx);
      await ctx.api.unresolveReviewThread(threadId);
      return toolResult(
        `unresolved review thread ${field(threadId, FIELD.nodeId)} on ${repoSlug(pull.repo)}#${pull.number}`,
      );
    }
    default:
      throw new ToolArgumentError(`unknown tool for ${REVIEW_FEATURE_SET}: ${field(name)}`);
  }
}

export const reviewToolModule: ToolModule = {
  featureSet: REVIEW_FEATURE_SET,
  tools: reviewTools,
  call: (name, args, ctx) => runTool(name, ctx, () => callReview(name, args, ctx)),
};
