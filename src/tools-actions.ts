/**
 * github.actions — GitHub Actions workflow runs: read them, dispatch one,
 * re-run one.
 *
 *   list_workflow_runs — the newest runs, by pull request, sha, branch,
 *                        workflow or event.
 *   dispatch_workflow  — a `workflow_dispatch` of an allowed workflow file, on
 *                        an allowed base branch, with inputs.
 *   rerun_workflow_run — re-run every job of a run, or only the failed ones.
 *
 * Why it exists: a review workflow that ignores comments from bots (they are
 * not OWNER, MEMBER or COLLABORATOR) still takes a `workflow_dispatch`, and a
 * flaky job is re-run rather than re-pushed.
 *
 * The fences, both deny-by-default:
 *
 *   - only the workflow files GITHUB_WORKFLOW_ALLOW names may be dispatched or
 *     re-run. A workflow is code that runs with the repository's secrets; a
 *     release or publish workflow must not become reachable because a review
 *     workflow is. Listing runs is a read and is not fenced.
 *   - a dispatch runs the workflow file as it is on `ref`, so `ref` must be a
 *     base branch (GITHUB_PR_BASE_ALLOW or GITHUB_MERGE_BASE_ALLOW): the copy
 *     of the workflow that runs is one that was reviewed and merged, not
 *     whatever a feature branch says.
 *
 * Not rollback-capable: a run that has started cannot be un-started.
 */

import {
  ACTIONS_FEATURE_SET,
  LIMITS,
  TOOL_DISPATCH_WORKFLOW,
  TOOL_LIST_WORKFLOW_RUNS,
  TOOL_RERUN_WORKFLOW_RUN,
  allowedBases,
  isWorkflowFileName,
  repoSlug,
  type RepoRef,
  type ToolContext,
  type ToolDefinition,
  type ToolModule,
  type ToolResult,
  type WorkflowRun,
} from './types.js';
import {
  FIELD,
  REPO_PROPERTY,
  ToolArgumentError,
  boundedInline,
  echo,
  field,
  optionalBoolean,
  optionalNumber,
  optionalString,
  refuse,
  requireNumber,
  requireString,
  resolveRepo,
  resolveThread,
  runTool,
  toolResult,
} from './tool-support.js';

/** GitHub accepts at most this many inputs on one dispatch. */
const MAX_DISPATCH_INPUTS = 25;
/** A dispatch input value, bounded: GitHub's own limit is far above any real use. */
const MAX_INPUT_CHARS = 1000;
const DEFAULT_RUNS = 20;

/** The file part of a workflow path: `.github/workflows/review.yml` → `review.yml`. */
function workflowFile(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

/** A workflow file name argument, or a refusal saying what one looks like. */
function requireWorkflowName(raw: string): string {
  const name = raw.trim();
  if (!isWorkflowFileName(name)) {
    throw new ToolArgumentError(
      `"workflow" must be a workflow file name as .github/workflows/ holds it (e.g. review.yml), got ${echo(raw)}`,
    );
  }
  return name;
}

/** GITHUB_WORKFLOW_ALLOW, enforced for one repository; the refusal names what is allowed. */
export function requireAllowedWorkflow(file: string, repo: RepoRef, ctx: ToolContext): string {
  const allowed = allowedBases(repo, ctx.workflowAllow ?? []);
  if (allowed.includes(file)) return file;
  const detail =
    allowed.length === 0
      ? `GITHUB_WORKFLOW_ALLOW allows no workflow on ${repoSlug(repo)}`
      : `allowed on ${repoSlug(repo)}: ${boundedInline(allowed)}`;
  refuse(`workflow ${echo(file)} is not in GITHUB_WORKFLOW_ALLOW (${detail})`);
}

/**
 * The branch a dispatch runs on: `ref` when given, which must be a base branch
 * here; otherwise the one base branch, when there is exactly one.
 */
function dispatchRef(raw: string | undefined, repo: RepoRef, ctx: ToolContext): string {
  const bases = [
    ...new Set([...allowedBases(repo, ctx.prBaseAllow), ...allowedBases(repo, ctx.mergeBaseAllow ?? [])]),
  ];
  if (raw === undefined || raw.trim() === '') {
    if (bases.length === 1) return bases[0];
    if (bases.length === 0) {
      refuse(`no base branch is allowed on ${repoSlug(repo)} (GITHUB_PR_BASE_ALLOW, GITHUB_MERGE_BASE_ALLOW), so there is nothing to dispatch on`);
    }
    throw new ToolArgumentError(`"ref" is required: several base branches are allowed on ${repoSlug(repo)} (${boundedInline(bases)})`);
  }
  const ref = raw.trim();
  if (!bases.includes(ref)) {
    refuse(
      `ref ${echo(ref)} is not a base branch on ${repoSlug(repo)} (${
        bases.length === 0 ? 'none is allowed' : `allowed: ${boundedInline(bases)}`
      }); a dispatch runs the workflow as that branch has it, so only a reviewed branch may be named`,
    );
  }
  return ref;
}

/** `inputs`, as GitHub takes them: string values, at most {@link MAX_DISPATCH_INPUTS}. */
function parseInputs(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolArgumentError('"inputs" must be an object of input names to values');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_DISPATCH_INPUTS) {
    throw new ToolArgumentError(`"inputs" has ${entries.length} entries; GitHub accepts at most ${MAX_DISPATCH_INPUTS}`);
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (key.trim() === '') throw new ToolArgumentError('"inputs" has an empty input name');
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
      throw new ToolArgumentError(`"inputs.${field(key)}" must be a string, number or boolean`);
    }
    const text = String(raw);
    if (text.length > MAX_INPUT_CHARS) {
      throw new ToolArgumentError(`"inputs.${field(key)}" is ${text.length} characters; the bound is ${MAX_INPUT_CHARS}`);
    }
    out[key] = text;
  }
  return out;
}

function renderRun(run: WorkflowRun): string {
  const state = run.status === 'completed' ? `completed/${field(run.conclusion ?? 'unknown')}` : field(run.status);
  return (
    `run ${run.id} ${field(run.name)} (${field(workflowFile(run.path), FIELD.path)}) [${state}] ${field(run.event)} ` +
    `on ${field(run.headBranch)} ${field(run.headSha.slice(0, 12), FIELD.sha)}` +
    `${run.runAttempt > 1 ? ` attempt ${run.runAttempt}` : ''}  ${field(run.createdAt)}  ${field(run.html_url, FIELD.url)}`
  );
}

export const actionsTools: ToolDefinition[] = [
  {
    name: TOOL_LIST_WORKFLOW_RUNS,
    description:
      'List GitHub Actions workflow runs, newest first: id, workflow, status and conclusion, event, ' +
      'branch, sha and URL. Narrow by pull request (its head sha), sha, branch, workflow file or event.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_PROPERTY,
        number: { type: 'integer', minimum: 1, description: 'Pull request: runs on its current head sha' },
        sha: { type: 'string', description: 'Runs on this head sha' },
        branch: { type: 'string', description: 'Runs on this branch' },
        workflow: { type: 'string', description: 'Workflow file name, e.g. review.yml' },
        event: { type: 'string', description: 'Triggering event, e.g. pull_request, workflow_dispatch' },
        limit: {
          type: 'integer',
          minimum: 1,
          description: `Max runs (default ${DEFAULT_RUNS}, cap ${LIMITS.listEntries})`,
        },
      },
    },
  },
  {
    name: TOOL_DISPATCH_WORKFLOW,
    description:
      'Start a workflow that has a workflow_dispatch trigger. The workflow file must be in ' +
      'GITHUB_WORKFLOW_ALLOW and `ref` a base branch (default: the only one allowed); the run uses the ' +
      'workflow as that branch has it. E.g. workflow review.yml with inputs {"pr-number": "12"} asks for a review.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_PROPERTY,
        workflow: { type: 'string', description: 'Workflow file name, e.g. review.yml' },
        ref: { type: 'string', description: 'Branch to run on; must be a base branch. Optional when only one is allowed' },
        inputs: {
          type: 'object',
          description: 'The workflow_dispatch inputs, name to value (values are sent as strings)',
          additionalProperties: { type: ['string', 'number', 'boolean'] },
        },
      },
      required: ['workflow'],
    },
  },
  {
    name: TOOL_RERUN_WORKFLOW_RUN,
    description:
      'Re-run a workflow run — every job, or with failed_only only the failed ones. The run’s workflow ' +
      'file must be in GITHUB_WORKFLOW_ALLOW. list_workflow_runs prints run ids.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_PROPERTY,
        run_id: { type: 'integer', minimum: 1, description: 'Workflow run id' },
        failed_only: { type: 'boolean', description: 'Re-run only the failed jobs (default false)' },
      },
      required: ['run_id'],
    },
  },
];

async function callActions(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  switch (name) {
    case TOOL_LIST_WORKFLOW_RUNS: {
      const limit = Math.min(optionalNumber(args, 'limit') ?? DEFAULT_RUNS, LIMITS.listEntries);
      const workflowRaw = optionalString(args, 'workflow');
      const workflow = workflowRaw === undefined ? undefined : requireWorkflowName(workflowRaw);
      let repo: RepoRef;
      let headSha = optionalString(args, 'sha')?.trim() || undefined;
      let scope: string;
      if (args.number !== undefined && args.number !== null) {
        if (headSha !== undefined) throw new ToolArgumentError('give "number" or "sha", not both');
        const pull = resolveThread(args, ctx, 'pull');
        const pr = await ctx.api.getPullRequest(pull);
        repo = pull.repo;
        headSha = pr.head.sha;
        scope = `${repoSlug(repo)}#${pull.number} head ${field(headSha, FIELD.sha)}`;
      } else {
        repo = resolveRepo(args, ctx);
        scope = headSha === undefined ? repoSlug(repo) : `${repoSlug(repo)} at ${field(headSha, FIELD.sha)}`;
      }
      const runs = await ctx.api.listWorkflowRuns(repo, {
        workflow,
        headSha,
        branch: optionalString(args, 'branch')?.trim() || undefined,
        event: optionalString(args, 'event')?.trim() || undefined,
        limit,
      });
      if (runs.length === 0) return toolResult(`no workflow runs on ${scope}`);
      return toolResult(
        [`${runs.length} workflow run${runs.length === 1 ? '' : 's'} on ${scope}, newest first`, ...runs.map(renderRun)].join(
          '\n',
        ),
      );
    }
    case TOOL_DISPATCH_WORKFLOW: {
      const repo = resolveRepo(args, ctx);
      const workflow = requireAllowedWorkflow(requireWorkflowName(requireString(args, 'workflow')), repo, ctx);
      const ref = dispatchRef(optionalString(args, 'ref'), repo, ctx);
      const inputs = parseInputs(args.inputs);
      await ctx.api.dispatchWorkflow(repo, { workflow, ref, inputs });
      const shown = Object.entries(inputs).map(([k, v]) => `${field(k)}=${echo(v)}`);
      return toolResult(
        `dispatched ${field(workflow)} on ${field(ref)} of ${repoSlug(repo)}` +
          `${shown.length > 0 ? ` with ${boundedInline(shown)}` : ''}; ` +
          `list_workflow_runs workflow=${field(workflow)} shows the run once GitHub queues it`,
      );
    }
    case TOOL_RERUN_WORKFLOW_RUN: {
      const repo = resolveRepo(args, ctx);
      const runId = requireNumber(args, 'run_id');
      const failedOnly = optionalBoolean(args, 'failed_only') ?? false;
      // The run is read first: the allow-list is on workflow files, and only
      // the run knows which file it came from.
      const run = await ctx.api.getWorkflowRun(repo, runId);
      requireAllowedWorkflow(workflowFile(run.path), repo, ctx);
      await ctx.api.rerunWorkflowRun(repo, runId, failedOnly);
      return toolResult(
        `re-run of ${failedOnly ? 'the failed jobs of ' : ''}run ${runId} (${field(run.name)}, ` +
          `${field(workflowFile(run.path), FIELD.path)}) on ${repoSlug(repo)} requested\n${field(run.html_url, FIELD.url)}`,
      );
    }
    default:
      throw new ToolArgumentError(`unknown tool for ${ACTIONS_FEATURE_SET}: ${field(name)}`);
  }
}

/** The github.actions ToolModule the server registers. */
export const actionsToolModule: ToolModule = {
  featureSet: ACTIONS_FEATURE_SET,
  tools: actionsTools,
  call: (name, args, ctx) => runTool(name, ctx, () => callActions(name, args, ctx)),
};
