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
 *   - with `sha`, a head that has moved since the caller read it is refused —
 *     a merge only ever lands the commit somebody looked at (GitHub enforces
 *     the same sha again, with a 409, in case it moves in between);
 *   - `delete_branch` deletes only a head branch in the base repository
 *     itself, never one a base allow-list names.
 *
 * Branch protection — required checks, required approvals, linear history —
 * is GitHub's to enforce, and its refusal (405) comes back as it is.
 */

import {
  MERGE_FEATURE_SET,
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

/** Why a pull request cannot be merged as it stands, or null when it can be tried. */
function notMergeable(pr: PullRequest): string | null {
  const at = `${repoSlug(pr.repo)}#${pr.number}`;
  if (pr.merged) return `${at} is already merged`;
  if (pr.state === 'closed') return `${at} is closed; reopen it before merging`;
  if (pr.draft) return `${at} is a draft; mark it ready for review (edit_pull_request draft: false) before merging`;
  return null;
}

/**
 * Whether the merged head branch may be deleted, and if not, why not. Only a
 * branch of the base repository itself — a fork's branch is its owner's — and
 * never a branch that any allow-list names as a base: deleting `main` because
 * someone opened `main → release` would be the worst outcome this tool has.
 */
function branchDeletionBlocked(pr: PullRequest, ctx: ToolContext): string | null {
  const branch = pr.head.ref;
  if (!branch) return 'the pull request names no head branch';
  if (!pr.headRepo) return 'GitHub no longer knows the head repository (a deleted fork?)';
  if (!sameRepo(pr.headRepo, pr.repo)) {
    return `the head branch lives in ${field(repoSlug(pr.headRepo), FIELD.slug)}, not in ${repoSlug(pr.repo)}`;
  }
  const protectedBranches = new Set([
    pr.base.ref,
    ...allowedBases(pr.repo, ctx.prBaseAllow),
    ...allowedBases(pr.repo, ctx.mergeBaseAllow ?? []),
  ]);
  if (protectedBranches.has(branch)) {
    return `${echo(branch)} is a base branch here (GITHUB_PR_BASE_ALLOW / GITHUB_MERGE_BASE_ALLOW) and is never deleted`;
  }
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
          description: 'The head sha this merge is for; refused if the head has moved (recommended)',
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
            'Delete the head branch once merged (default false). Only a branch of this repository, never a base branch.',
        },
      },
      required: ['number'],
    },
  },
  {
    name: TOOL_UPDATE_BRANCH,
    description:
      'Bring a pull request’s head branch up to date by merging its base into it (GitHub’s ' +
      '"Update branch"). GitHub does the merge in the background; the head sha changes when it lands. ' +
      'With `sha`, GitHub refuses if the head is no longer that commit.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_PROPERTY,
        number: { type: 'integer', minimum: 1, description: 'Pull-request number' },
        sha: { type: 'string', description: 'The head sha you expect the branch to be at' },
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
      const blocked = notMergeable(pr);
      if (blocked) refuse(blocked);
      requireMergeBase(pr.base.ref, pull.repo, ctx);
      if (expected !== undefined && expected.trim() !== pr.head.sha) {
        refuse(
          `the head of ${repoSlug(pull.repo)}#${pull.number} is ${field(pr.head.sha, FIELD.sha)}, not ` +
            `${echo(expected, FIELD.sha)}: it moved since it was read. Read it again (and its reviews and ` +
            `checks) before merging.`,
        );
      }

      const result = await ctx.api.mergePullRequest(pull, { method, sha: pr.head.sha, title, message });
      if (!result.merged) {
        refuse(`GitHub did not merge ${repoSlug(pull.repo)}#${pull.number}: ${field(result.message, FIELD.url)}`);
      }

      const out = [
        `merged ${repoSlug(pull.repo)}#${pull.number} (${field(pr.head.ref)} at ${field(pr.head.sha, FIELD.sha)}) ` +
          `into ${field(pr.base.ref)} by ${method}: ${field(result.sha, FIELD.sha)}`,
      ];
      if (deleteBranch) {
        const why = branchDeletionBlocked(pr, ctx);
        if (why) {
          out.push(`head branch kept: ${why}`);
        } else {
          // The merge has happened whatever this does next, so a failed
          // deletion is reported beside it rather than turning a successful
          // merge into an error result. A repository that deletes merged
          // branches itself answers 422 here, which is the same end state.
          try {
            await ctx.api.deleteBranch(pull.repo, pr.head.ref);
            out.push(`deleted branch ${field(pr.head.ref)}`);
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
      await ctx.api.updatePullRequestBranch(pull, expected?.trim());
      return toolResult(
        `asked GitHub to merge the base of ${repoSlug(pull.repo)}#${pull.number} into its head branch; ` +
          `it runs in the background, and get_pull_request shows the new head sha once it lands`,
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
