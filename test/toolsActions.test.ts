/**
 * github.actions — list_workflow_runs, dispatch_workflow, rerun_workflow_run.
 *
 * Two fences, both deny-by-default and both asserted here: a workflow outside
 * GITHUB_WORKFLOW_ALLOW is never dispatched or re-run, and a dispatch only
 * ever runs on a base branch. Everything runs against FakeGitHubApi.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { actionsToolModule } from '../src/tools-actions.js';
import {
  ACTIONS_FEATURE_SET,
  silentLogger,
  type StateStore,
  type ToolContext,
  type ToolResult,
} from '../src/types.js';
import { FakeGitHubApi, TEST_BOT, TEST_REPO } from './harness.js';

function ctx(api: FakeGitHubApi, over: Partial<ToolContext> = {}): ToolContext {
  return {
    api,
    state: undefined as unknown as StateStore,
    botLogin: TEST_BOT.login,
    repos: [TEST_REPO],
    prBaseAllow: ['dev'],
    mergeBaseAllow: [],
    workflowAllow: ['review.yml'],
    logger: silentLogger(),
    ...over,
  };
}

function text(result: ToolResult): string {
  assert.equal(result.content.length, 1);
  return (result.content[0] as { type: 'text'; text: string }).text;
}

function ok(result: ToolResult): string {
  assert.equal(result.isError, undefined, `expected success, got: ${text(result)}`);
  return text(result);
}

function failure(result: ToolResult): string {
  assert.equal(result.isError, true, `expected an error result, got: ${text(result)}`);
  return text(result);
}

const HEAD = 'head8'.padEnd(40, '0');

function seeded(): FakeGitHubApi {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 8 });
  api.seedWorkflowRuns(TEST_REPO, [
    { id: 301, name: 'Review', path: '.github/workflows/review.yml', event: 'workflow_dispatch', headBranch: 'dev', headSha: 'd'.repeat(40) },
    { id: 302, name: 'CI', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'failure', headSha: HEAD, headBranch: 'feature-8' },
    { id: 303, name: 'Publish', path: '.github/workflows/publish.yml', event: 'push', headBranch: 'dev' },
  ]);
  return api;
}

test('the module declares github.actions and its three tools', () => {
  assert.equal(actionsToolModule.featureSet, ACTIONS_FEATURE_SET);
  assert.deepEqual(
    actionsToolModule.tools.map((t) => t.name),
    ['list_workflow_runs', 'dispatch_workflow', 'rerun_workflow_run'],
  );
});

test('list_workflow_runs by pull request reads its head and lists the runs on it', async () => {
  const api = seeded();
  const out = ok(await actionsToolModule.call('list_workflow_runs', { number: 8 }, ctx(api)));
  assert.match(out, /^1 workflow run on anima-research\/rayforce#8 head head80+, newest first\n/);
  assert.match(out, /run 302 CI \(ci\.yml\) \[completed\/failure\] pull_request on feature-8 head80000000/);
  assert.deepEqual(api.callsTo('listWorkflowRuns')[0].args[1], {
    workflow: undefined,
    headSha: HEAD,
    branch: undefined,
    event: undefined,
    limit: 20,
  });
});

test('list_workflow_runs filters by workflow file, and is not fenced by the allow-list', async () => {
  const api = seeded();
  const out = ok(
    await actionsToolModule.call('list_workflow_runs', { workflow: 'publish.yml', limit: 500 }, ctx(api, { workflowAllow: [] })),
  );
  assert.match(out, /run 303 Publish \(publish\.yml\)/);
  assert.equal((api.callsTo('listWorkflowRuns')[0].args[1] as { limit: number }).limit, 50, 'capped at the list bound');
});

test('list_workflow_runs refuses number and sha together, and a workflow path', async () => {
  const api = seeded();
  assert.match(failure(await actionsToolModule.call('list_workflow_runs', { number: 8, sha: HEAD }, ctx(api))), /give "number" or "sha", not both/);
  assert.match(
    failure(await actionsToolModule.call('list_workflow_runs', { workflow: '.github/workflows/ci.yml' }, ctx(api))),
    /"workflow" must be a workflow file name/,
  );
  assert.equal(
    ok(await actionsToolModule.call('list_workflow_runs', { sha: 'nothing' }, ctx(api))),
    'no workflow runs on anima-research/rayforce at nothing',
  );
});

test('dispatch_workflow runs an allowed workflow on the only base branch, with string inputs', async () => {
  const api = seeded();
  const out = ok(
    await actionsToolModule.call('dispatch_workflow', { workflow: 'review.yml', inputs: { 'pr-number': 8, verbose: true } }, ctx(api)),
  );
  assert.match(out, /^dispatched review\.yml on dev of anima-research\/rayforce with pr-number="8", verbose="true"/);
  assert.deepEqual(api.dispatches, [
    { repo: TEST_REPO, input: { workflow: 'review.yml', ref: 'dev', inputs: { 'pr-number': '8', verbose: 'true' } } },
  ]);
});

test('dispatch_workflow refuses a workflow outside GITHUB_WORKFLOW_ALLOW', async () => {
  const api = seeded();
  const out = failure(await actionsToolModule.call('dispatch_workflow', { workflow: 'publish.yml' }, ctx(api)));
  assert.match(out, /dispatch_workflow refused: workflow "publish\.yml" is not in GITHUB_WORKFLOW_ALLOW \(allowed on anima-research\/rayforce: review\.yml\)/);
  const none = failure(await actionsToolModule.call('dispatch_workflow', { workflow: 'review.yml' }, ctx(api, { workflowAllow: [] })));
  assert.match(none, /GITHUB_WORKFLOW_ALLOW allows no workflow on anima-research\/rayforce/);
  assert.deepEqual(api.dispatches, []);
});

test('dispatch_workflow runs only on a base branch, and asks when there are several', async () => {
  const api = seeded();
  const feature = failure(await actionsToolModule.call('dispatch_workflow', { workflow: 'review.yml', ref: 'feature-8' }, ctx(api)));
  assert.match(feature, /ref "feature-8" is not a base branch on anima-research\/rayforce \(allowed: dev\)/);

  const several = ctx(api, { prBaseAllow: ['dev'], mergeBaseAllow: ['main'] });
  assert.match(failure(await actionsToolModule.call('dispatch_workflow', { workflow: 'review.yml' }, several)), /"ref" is required: several base branches .*\(dev, main\)/);
  ok(await actionsToolModule.call('dispatch_workflow', { workflow: 'review.yml', ref: 'main' }, several));
  assert.deepEqual(api.dispatches.map((d) => d.input.ref), ['main']);

  const noBase = failure(await actionsToolModule.call('dispatch_workflow', { workflow: 'review.yml' }, ctx(api, { prBaseAllow: [] })));
  assert.match(noBase, /no base branch is allowed on anima-research\/rayforce/);
});

test('dispatch_workflow validates its inputs', async () => {
  const api = seeded();
  const call = (inputs: unknown) => actionsToolModule.call('dispatch_workflow', { workflow: 'review.yml', inputs }, ctx(api));
  assert.match(failure(await call(['8'])), /"inputs" must be an object/);
  assert.match(failure(await call({ nested: { a: 1 } })), /"inputs\.nested" must be a string, number or boolean/);
  assert.match(failure(await call(Object.fromEntries(Array.from({ length: 26 }, (_, i) => [`k${i}`, 'v'])))), /at most 25/);
  assert.match(failure(await call({ big: 'x'.repeat(1001) })), /"inputs\.big" is 1001 characters/);
  assert.deepEqual(api.dispatches, []);
});

test('rerun_workflow_run re-runs a run of an allowed workflow, all jobs or only the failed ones', async () => {
  const api = seeded();
  const all = ok(await actionsToolModule.call('rerun_workflow_run', { run_id: 301 }, ctx(api)));
  assert.match(all, /^re-run of run 301 \(Review, review\.yml\) on anima-research\/rayforce requested/);
  const failed = ok(
    await actionsToolModule.call('rerun_workflow_run', { run_id: 302, failed_only: true }, ctx(api, { workflowAllow: ['review.yml', 'ci.yml'] })),
  );
  assert.match(failed, /^re-run of the failed jobs of run 302 \(CI, ci\.yml\)/);
  assert.deepEqual(api.reruns, [
    { repo: TEST_REPO, runId: 301, failedOnly: false },
    { repo: TEST_REPO, runId: 302, failedOnly: true },
  ]);
});

test('rerun_workflow_run refuses a run of a workflow outside the allow-list', async () => {
  const api = seeded();
  const out = failure(await actionsToolModule.call('rerun_workflow_run', { run_id: 303 }, ctx(api)));
  assert.match(out, /workflow "publish\.yml" is not in GITHUB_WORKFLOW_ALLOW/);
  assert.deepEqual(api.reruns, []);
  const missing = failure(await actionsToolModule.call('rerun_workflow_run', { run_id: 999 }, ctx(api)));
  assert.match(missing, /rerun_workflow_run failed: GitHub error 404/);
});

test('a scoped allow-list entry applies to its repository only', async () => {
  const api = seeded();
  const other = { owner: 'anima-research', name: 'chronicle' };
  const scoped = ctx(api, { repos: [TEST_REPO, other], workflowAllow: ['anima-research/chronicle:review.yml'] });
  const out = failure(
    await actionsToolModule.call('dispatch_workflow', { repo: 'anima-research/rayforce', workflow: 'review.yml' }, scoped),
  );
  assert.match(out, /GITHUB_WORKFLOW_ALLOW allows no workflow on anima-research\/rayforce/);
  ok(await actionsToolModule.call('dispatch_workflow', { repo: 'anima-research/chronicle', workflow: 'review.yml' }, scoped));
  assert.deepEqual(api.dispatches.map((d) => d.repo), [other]);
});
