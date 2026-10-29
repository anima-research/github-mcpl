/**
 * github.merge — merging a pull request, and bringing its branch up to date.
 *
 *   merge_pull_request — merge, squash or rebase a pull request into its base,
 *                        at the head sha the caller read; optionally delete
 *                        the merged head branch.
 *   update_branch      — merge the base into the head branch (GitHub's
 *                        "Update branch" button).
 *
 * A separate feature set, so a host grants merging on purpose and never by
 * granting github.pr: opening a pull request and landing one are different
 * decisions. Not rollback-capable — a merge cannot be unmerged.
 *
 * The refusals are the point of this file, and all of them are taken before
 * GitHub is asked:
 *
 *   - the base must be in GITHUB_MERGE_BASE_ALLOW, which is empty by default:
 *     a deployment that never set it cannot merge anything, whatever the host
 *     grants;
 *   - a draft, a closed or an already-merged pull request is refused by name;
 *   - with `sha` (full, or a prefix of 7 or more hex digits), a head that has
 *     moved since the caller read it is refused — a merge only ever lands the
 *     commit somebody looked at (GitHub enforces the full sha again, with a
 *     409, in case it moves in between);
 *   - `delete_branch` deletes only a head branch in the base repository
 *     itself, and never one that is a base anywhere: named by an allow-list,
 *     protected on GitHub, the default branch, or the base of another open
 *     pull request;
 *   - `update_branch` writes a merge commit onto the head branch, so it takes
 *     the same fences as a merge — an open pull request into an allowed base —
 *     and refuses a head that is itself a base branch.
 *
 * Branch protection — required checks, required approvals, linear history —
 * is GitHub's to enforce, and its refusal (405) comes back as it is.
 */

import {
  MERGE_FEATURE_SET,
  type BranchFacts,
  TOOL_MERGE_PULL_REQUEST,
  TOOL_UPDATE_BRANCH,
  allowedBases,
  repoSlug,
  sameRepo,
  type MergeMethod,
  type PullRequest,
  type RepoRef,
  type ToolContext,
  type ToolDefinition,
  type ToolModule,
  type ToolResult,
} from './types.js';
import {
  FIELD,
  REPO_PROPERTY,
  ToolArgumentError,
  boundedInline,
  describeFailure,
  echo,
  field,
  oneOf,
  optionalBoolean,
  optionalString,
  refuse,
  resolveThread,
  runTool,
  toolResult,
} from './tool-support.js';

const MERGE_METHODS: readonly MergeMethod[] = ['merge', 'squash', 'rebase'];

/**
 * GITHUB_MERGE_BASE_ALLOW, enforced for one repository. Like
 * `requireAllowedBase`, the refusal names the branch and the branches allowed,
 * so the caller can tell a misconfiguration from a wrong pull request.
 */
export function requireMergeBase(base: string, repo: RepoRef, ctx: ToolContext): string {
  const bases = allowedBases(repo, ctx.mergeBaseAllow ?? []);
  if (bases.includes(base)) return base;
  const allowed =
    bases.length === 0
      ? `GITHUB_MERGE_BASE_ALLOW allows no branch on ${repoSlug(repo)}, so nothing there may be merged`
      : `allowed on ${repoSlug(repo)}: ${boundedInline(bases)}`;
  refuse(`base branch ${echo(base)} is not in GITHUB_MERGE_BASE_ALLOW (${allowed})`);
}

/** Why a pull request cannot be merged (or updated) as it stands, or null when it can be tried. */
function notMergeable(pr: PullRequest, action: 'merging' | 'updating'): string | null {
  const at = `${repoSlug(pr.repo)}#${pr.number}`;
  if (pr.merged) return `${at} is already merged`;
  if (pr.state === 'closed') return `${at} is closed; reopen it before ${action}`;
  if (action === 'merging' && pr.draft) {
    return `${at} is a draft; mark it ready for review (edit_pull_request draft: false) before merging`;
  }
  return null;
}

/** A sha as a caller may pass one: 7 to 40 hex digits, any case. */
const SHA_PREFIX = /^[0-9a-f]{7,40}$/;

/**
 * The caller's `sha` against the head GitHub reports. A prefix of seven or
 * more hex digits is accepted, in either case — the tools print 12-character
 * shas — and the full head sha is what goes to GitHub. Anything else that does
 * not match is a head that moved, and the refusal says which head it is now.
 */
function requireHeadSha(expected: string, pr: PullRequest): void {
  const asked = expected.trim().toLowerCase();
  if (!SHA_PREFIX.test(asked)) {
    throw new ToolArgumentError(`"sha" must be a commit sha (7 to 40 hex digits), got ${echo(expected, FIELD.sha)}`);
  }
  if (!pr.head.sha.toLowerCase().startsWith(asked)) {
    refuse(
      `the head of ${repoSlug(pr.repo)}#${pr.number} is ${field(pr.head.sha, FIELD.sha)}, not ` +
        `${echo(expected, FIELD.sha)}: it moved since it was read. Read it again (and its reviews and ` +
        `checks) before acting on it.`,
    );
  }
}

/**
 * The branches no tool here writes to or deletes: the pull request's own base
 * and every branch an allow-list names as a base.
 */
function baseBranches(pr: PullRequest, ctx: ToolContext): Set<string> {
  return new Set([
    pr.base.ref,
    ...allowedBases(pr.repo, ctx.prBaseAllow),
    ...allowedBases(pr.repo, ctx.mergeBaseAllow ?? []),
  ]);
}

/**
 * Whether the merged head branch may be deleted, as far as the pull request
 * itself can tell, and if not, why not. Only a branch of the base repository
 * itself — a fork's branch is its owner's — and never a branch an allow-list
 * names as a base. {@link deletionBlockedOnGitHub} asks GitHub the rest.
 */
function branchDeletionBlocked(pr: PullRequest, ctx: ToolContext): string | null {
  const branch = pr.head.ref;
  if (!branch) return 'the pull request names no head branch';
  if (!pr.headRepo) return 'GitHub no longer knows the head repository (a deleted fork?)';
  if (!sameRepo(pr.headRepo, pr.repo)) {
    return `the head branch lives in ${field(repoSlug(pr.headRepo), FIELD.slug)}, not in ${repoSlug(pr.repo)}`;
  }
  if (baseBranches(pr, ctx).has(branch)) {
    return `${echo(branch)} is a base branch here (GITHUB_PR_BASE_ALLOW / GITHUB_MERGE_BASE_ALLOW) and is never deleted`;
  }
  return null;
}

/**
 * The part of "is this somebody's base?" only GitHub knows. A release branch
 * kept *out* of the allow-lists — so that nothing here can target it — is
 * still a base: a back-merge `release → dev` must not delete `release`. So a
 * protected branch, the default branch, and a branch other open pull requests
 * target are all kept.
 */
function deletionBlockedOnGitHub(branch: string, facts: BranchFacts): string | null {
  if (facts.isDefault) return `${echo(branch)} is the repository's default branch`;
  if (facts.protected) return `${echo(branch)} is protected on GitHub`;
  if (facts.openPullsBasedOn > 0) return `${echo(branch)} is the base of another open pull request`;
  return null;
}

export const mergeTools: ToolDefinition[] = [
  {
    name: TOOL_MERGE_PULL_REQUEST,
    description:
      'Merge a pull request into its base branch, which must be one GITHUB_MERGE_BASE_ALLOW names. ' +
      'Pass `sha` — the head sha you reviewed (get_pull_request prints it) — and the merge is refused ' +
      'if the head has moved since. Drafts, closed and merged pull requests are refused; branch ' +
      'protection (required checks, approvals) is enforced by GitHub. A merge cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_PROPERTY,
        number: { type: 'integer', minimum: 1, description: 'Pull-request number' },
        sha: {
          type: 'string',
          description:
            'The head sha this merge is for (full, or 7+ hex digits); refused if the head has moved (recommended)',
        },
        method: {
          type: 'string',
          enum: [...MERGE_METHODS],
          description: 'merge (a merge commit, the default), squash, or rebase',
        },
        title: { type: 'string', description: 'Commit title (merge and squash only)' },
        message: { type: 'string', description: 'Commit message (merge and squash only)' },
        delete_branch: {
          type: 'boolean',
          description:
            'Delete the head branch once merged (default false). Only a branch of this repository that is nobody’s ' +
            'base: not allow-listed, not protected, not the default branch, not the base of another open pull request.',
        },
      },
      required: ['number'],
    },
  },
  {
    name: TOOL_UPDATE_BRANCH,
    description:
      'Bring a pull request’s head branch up to date by merging its base into it (GitHub’s ' +
      '"Update branch"). Only an open pull request into a base GITHUB_MERGE_BASE_ALLOW names, and never ' +
      'when the head is itself a base branch. GitHub does the merge in the background; the head sha ' +
      'changes when it lands. With `sha`, a head that has moved is refused.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_PROPERTY,
        number: { type: 'integer', minimum: 1, description: 'Pull-request number' },
        sha: { type: 'string', description: 'The head sha you expect the branch to be at (full, or 7+ hex digits)' },
      },
      required: ['number'],
    },
  },
];

async function callMerge(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  switch (name) {
    case TOOL_MERGE_PULL_REQUEST: {
      const pull = resolveThread(args, ctx, 'pull');
      const method = oneOf<MergeMethod>(args, 'method', MERGE_METHODS, 'merge');
      const expected = optionalString(args, 'sha');
      const title = optionalString(args, 'title');
      const message = optionalString(args, 'message');
      const deleteBranch = optionalBoolean(args, 'delete_branch') ?? false;
      if (method === 'rebase' && (title !== undefined || message !== undefined)) {
        throw new ToolArgumentError('"title" and "message" apply to merge and squash; a rebase writes no commit of its own');
      }

      const pr = await ctx.api.getPullRequest(pull);
      const blocked = notMergeable(pr, 'merging');
      if (blocked) refuse(blocked);
      requireMergeBase(pr.base.ref, pull.repo, ctx);
      if (expected !== undefined) requireHeadSha(expected, pr);

      const result = await ctx.api.mergePullRequest(pull, { method, sha: pr.head.sha, title, message });
      if (!result.merged) {
        refuse(`GitHub did not merge ${repoSlug(pull.repo)}#${pull.number}: ${field(result.message, FIELD.url)}`);
      }

      const out = [
        `merged ${repoSlug(pull.repo)}#${pull.number} (${field(pr.head.ref)} at ${field(pr.head.sha, FIELD.sha)}) ` +
          `into ${field(pr.base.ref)} by ${method}: ${field(result.sha, FIELD.sha)}`,
      ];
      if (deleteBranch) {
        // The merge has happened whatever this does next, so a failed check
        // or deletion is reported beside it rather than turning a successful
        // merge into an error result. A repository that deletes merged
        // branches itself answers 404 or 422 here, which is the same end state.
        const why = branchDeletionBlocked(pr, ctx);
        if (why) {
          out.push(`head branch kept: ${why}`);
        } else {
          try {
            const onGitHub = deletionBlockedOnGitHub(pr.head.ref, await ctx.api.branchFacts(pull.repo, pr.head.ref));
            if (onGitHub) {
              out.push(`head branch kept: ${onGitHub}`);
            } else {
              await ctx.api.deleteBranch(pull.repo, pr.head.ref);
              out.push(`deleted branch ${field(pr.head.ref)}`);
            }
          } catch (err) {
            out.push(`head branch not deleted: ${describeFailure('deleteBranch', err)}`);
          }
        }
      }
      return toolResult(out.join('\n'));
    }
    case TOOL_UPDATE_BRANCH: {
      const pull = resolveThread(args, ctx, 'pull');
      const expected = optionalString(args, 'sha');
      // A merge commit onto the head branch is a write, so it takes a merge's
      // fences: an open pull request into an allowed base, and a head that is
      // not itself a base (on `dev → main`, this would merge main into dev).
      const pr = await ctx.api.getPullRequest(pull);
      const blocked = notMergeable(pr, 'updating');
      if (blocked) refuse(blocked);
      requireMergeBase(pr.base.ref, pull.repo, ctx);
      if (baseBranches(pr, ctx).has(pr.head.ref)) {
        refuse(
          `the head of ${repoSlug(pull.repo)}#${pull.number}, ${echo(pr.head.ref)}, is a base branch here ` +
            `(GITHUB_PR_BASE_ALLOW / GITHUB_MERGE_BASE_ALLOW); update_branch never writes to one`,
        );
      }
      if (expected !== undefined) requireHeadSha(expected, pr);
      await ctx.api.updatePullRequestBranch(pull, pr.head.sha);
      return toolResult(
        `asked GitHub to merge ${field(pr.base.ref)} into ${field(pr.head.ref)} ` +
          `(${repoSlug(pull.repo)}#${pull.number}, head ${field(pr.head.sha, FIELD.sha)}); it runs in the background, ` +
          `and get_pull_request shows the new head sha once it lands`,
      );
    }
    default:
      throw new ToolArgumentError(`unknown tool for ${MERGE_FEATURE_SET}: ${field(name)}`);
  }
}

/** The github.merge ToolModule the server registers. */
export const mergeToolModule: ToolModule = {
  featureSet: MERGE_FEATURE_SET,
  tools: mergeTools,
  call: (name, args, ctx) => runTool(name, ctx, () => callMerge(name, args, ctx)),
};
