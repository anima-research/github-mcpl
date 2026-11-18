/**
 * github.merge — merge_pull_request and update_branch.
 *
 * The refusals carry the weight: GITHUB_MERGE_BASE_ALLOW is deny-by-default,
 * a moved head is refused before GitHub is asked, a draft, closed or merged
 * pull request is refused by name, and `delete_branch` never deletes a fork's
 * branch or a base branch. Everything runs against FakeGitHubApi.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mergeToolModule } from '../src/tools-merge.js';
import {
  MERGE_FEATURE_SET,
  silentLogger,
  type StateStore,
  type ThreadRef,
  type ToolContext,
  type ToolResult,
} from '../src/types.js';
import { FakeGitHubApi, TEST_BOT, TEST_REPO } from './harness.js';

function ctx(api: FakeGitHubApi, over: Partial<ToolContext> = {}): ToolContext {
  return {
    api,
    // github.merge is not rollback-capable and never touches the store.
    state: undefined as unknown as StateStore,
    botLogin: TEST_BOT.login,
    repos: [TEST_REPO],
    prBaseAllow: ['dev'],
    mergeBaseAllow: ['dev'],
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

const PULL: ThreadRef = { repo: TEST_REPO, number: 8, kind: 'pull' };
const HEAD = 'abc8'.padEnd(40, '0');

function seeded(): FakeGitHubApi {
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 8, headRepo: TEST_REPO, head: { ref: 'feature-8', sha: HEAD } });
  return api;
}

test('the module declares github.merge and its two tools', () => {
  assert.equal(mergeToolModule.featureSet, MERGE_FEATURE_SET);
  assert.deepEqual(
    mergeToolModule.tools.map((t) => t.name),
    ['merge_pull_request', 'update_branch'],
  );
});

test('merge_pull_request merges at the head sha it read, by merge commit by default', async () => {
  const api = seeded();
  const out = ok(await mergeToolModule.call('merge_pull_request', { number: 8, sha: HEAD }, ctx(api)));
  assert.match(out, /^merged anima-research\/rayforce#8 \(feature-8 at abc80+\) into dev by merge: merge0+$/);
  assert.deepEqual(api.callsTo('mergePullRequest')[0].args, [
    PULL,
    { method: 'merge', sha: HEAD, title: undefined, message: undefined },
  ]);
  assert.deepEqual(api.deletedBranches, [], 'no branch deleted unless asked');
});

test('merge_pull_request passes squash with a title and message', async () => {
  const api = seeded();
  ok(
    await mergeToolModule.call(
      'merge_pull_request',
      { number: 8, method: 'squash', title: 'Fix it (#8)', message: 'body' },
      ctx(api),
    ),
  );
  assert.deepEqual(api.callsTo('mergePullRequest')[0].args[1], {
    method: 'squash',
    sha: HEAD,
    title: 'Fix it (#8)',
    message: 'body',
  });
});

test('a rebase takes no commit title or message', async () => {
  const api = seeded();
  const out = failure(await mergeToolModule.call('merge_pull_request', { number: 8, method: 'rebase', title: 'x' }, ctx(api)));
  assert.match(out, /"title" and "message" apply to merge and squash/);
  assert.equal(api.callsTo('mergePullRequest').length, 0);
});

test('an empty GITHUB_MERGE_BASE_ALLOW means nothing may be merged', async () => {
  for (const over of [{ mergeBaseAllow: [] }, { mergeBaseAllow: undefined }]) {
    const api = seeded();
    const out = failure(await mergeToolModule.call('merge_pull_request', { number: 8 }, ctx(api, over)));
    assert.match(
      out,
      /merge_pull_request refused: base branch "dev" is not in GITHUB_MERGE_BASE_ALLOW \(GITHUB_MERGE_BASE_ALLOW allows no branch on anima-research\/rayforce, so nothing there may be merged\)/,
    );
    assert.equal(api.callsTo('mergePullRequest').length, 0);
  }
});

test('a base GITHUB_PR_BASE_ALLOW names is not thereby mergeable', async () => {
  const api = seeded();
  const out = failure(
    await mergeToolModule.call('merge_pull_request', { number: 8 }, ctx(api, { prBaseAllow: ['dev'], mergeBaseAllow: ['main'] })),
  );
  assert.match(out, /base branch "dev" is not in GITHUB_MERGE_BASE_ALLOW \(allowed on anima-research\/rayforce: main\)/);
});

test('a head that moved since it was read is refused before GitHub is asked', async () => {
  const api = seeded();
  const out = failure(await mergeToolModule.call('merge_pull_request', { number: 8, sha: 'def4567' }, ctx(api)));
  assert.match(out, /the head of anima-research\/rayforce#8 is abc80+, not "def4567": it moved since it was read/);
  assert.equal(api.callsTo('mergePullRequest').length, 0);
});

test('a short or upper-case sha of the head is the head, and the full sha goes to GitHub', async () => {
  for (const sha of [HEAD.slice(0, 7), HEAD.slice(0, 12), HEAD.toUpperCase(), ` ${HEAD} `]) {
    const api = seeded();
    ok(await mergeToolModule.call('merge_pull_request', { number: 8, sha }, ctx(api)));
    assert.equal((api.callsTo('mergePullRequest')[0].args[1] as { sha: string }).sha, HEAD, sha);
  }
});

test('a sha that is not 7 to 40 hex digits is a malformed call, not a moved head', async () => {
  for (const sha of ['abc12', 'not-a-sha', 'g'.repeat(40), 'a'.repeat(41)]) {
    const api = seeded();
    const out = failure(await mergeToolModule.call('merge_pull_request', { number: 8, sha }, ctx(api)));
    assert.match(out, /"sha" must be a commit sha \(7 to 40 hex digits\)/, sha);
    assert.doesNotMatch(out, /moved/);
  }
});

test('a head that moves between the read and the merge is GitHub’s 409, and no branch is deleted', async () => {
  const api = seeded();
  api.moveHeadBeforeMerge = 'f'.repeat(40);
  const out = failure(await mergeToolModule.call('merge_pull_request', { number: 8, sha: HEAD, delete_branch: true }, ctx(api)));
  assert.match(out, /merge_pull_request failed: GitHub error 409: Head branch was modified/);
  assert.equal(api.callsTo('deleteBranch').length, 0);
  assert.equal(api.callsTo('branchFacts').length, 0);
});

test('draft, closed and merged pull requests are refused by name', async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ draft: true }, /#9 is a draft; mark it ready for review/],
    [{ state: 'closed' }, /#9 is closed; reopen it before merging/],
    [{ state: 'closed', merged: true }, /#9 is already merged/],
  ];
  for (const [partial, expected] of cases) {
    const api = new FakeGitHubApi();
    api.seedPullRequest({ number: 9, ...partial });
    const out = failure(await mergeToolModule.call('merge_pull_request', { number: 9 }, ctx(api)));
    assert.match(out, expected);
    assert.equal(api.callsTo('mergePullRequest').length, 0);
  }
});

test('GitHub answering merged: false is an error result with its message', async () => {
  const api = seeded();
  api.mergeRefusal = 'Pull Request is not mergeable';
  const out = failure(await mergeToolModule.call('merge_pull_request', { number: 8 }, ctx(api)));
  assert.match(out, /GitHub did not merge anima-research\/rayforce#8: Pull Request is not mergeable/);
});

test('a repository outside GITHUB_REPOS is refused before anything is read', async () => {
  const api = seeded();
  const out = failure(await mergeToolModule.call('merge_pull_request', { repo: 'anima-research/gate', number: 8 }, ctx(api)));
  assert.match(out, /repository anima-research\/gate is not in GITHUB_REPOS/);
  assert.deepEqual(api.callLog(), []);
});

test('delete_branch deletes the merged head branch of this repository', async () => {
  const api = seeded();
  const out = ok(await mergeToolModule.call('merge_pull_request', { number: 8, delete_branch: true }, ctx(api)));
  assert.match(out, /\ndeleted branch feature-8$/);
  assert.deepEqual(api.deletedBranches, ['anima-research/rayforce:feature-8']);
  // Deleted only after the merge answered, and after GitHub said it is nobody's base.
  assert.deepEqual(api.callLog().slice(-3), ['mergePullRequest', 'branchFacts', 'deleteBranch']);
});

test('delete_branch keeps a branch GitHub says is a base: protected, default, or targeted by an open PR', async () => {
  const cases: Array<[{ protected: boolean; isDefault: boolean; openPullsBasedOn: number }, RegExp]> = [
    // The back-merge case: `release` kept out of every allow-list, protected on GitHub.
    [{ protected: true, isDefault: false, openPullsBasedOn: 0 }, /head branch kept: "feature-8" is protected on GitHub/],
    [{ protected: false, isDefault: true, openPullsBasedOn: 0 }, /head branch kept: "feature-8" is the repository's default branch/],
    [{ protected: false, isDefault: false, openPullsBasedOn: 1 }, /head branch kept: "feature-8" is the base of another open pull request/],
  ];
  for (const [facts, expected] of cases) {
    const api = seeded();
    api.branchFactsByName.set('feature-8', facts);
    const out = ok(await mergeToolModule.call('merge_pull_request', { number: 8, delete_branch: true }, ctx(api)));
    assert.match(out, /^merged /);
    assert.match(out, expected);
    assert.equal(api.callsTo('deleteBranch').length, 0);
  }
});

test('delete_branch keeps a fork’s branch, an unknown head repository, and any base branch', async () => {
  const cases: Array<[Record<string, unknown>, Partial<ToolContext>, RegExp]> = [
    [{ headRepo: { owner: 'a-fork', name: 'rayforce' } }, {}, /head branch kept: the head branch lives in a-fork\/rayforce/],
    [{ headRepo: null }, {}, /head branch kept: GitHub no longer knows the head repository/],
    [{ headRepo: undefined }, {}, /head branch kept: GitHub no longer knows the head repository/],
    // A pull request from one base branch into another: `main` → `dev`.
    [
      { headRepo: TEST_REPO, head: { ref: 'main', sha: HEAD } },
      { prBaseAllow: ['dev', 'main'] },
      /head branch kept: "main" is a base branch here/,
    ],
    [
      { headRepo: TEST_REPO, head: { ref: 'release', sha: HEAD } },
      { mergeBaseAllow: ['dev', 'anima-research/rayforce:release'] },
      /head branch kept: "release" is a base branch here/,
    ],
  ];
  for (const [partial, over, expected] of cases) {
    const api = new FakeGitHubApi();
    api.seedPullRequest({ number: 8, ...partial });
    const out = ok(await mergeToolModule.call('merge_pull_request', { number: 8, delete_branch: true }, ctx(api, over)));
    assert.match(out, /^merged /, 'the merge itself still happened');
    assert.match(out, expected);
    assert.deepEqual(api.deletedBranches, []);
    assert.equal(api.callsTo('deleteBranch').length, 0);
  }
});

test('a failed branch deletion is reported beside a merge that happened, not as an error', async () => {
  const api = seeded();
  api.deleteBranchError = Object.assign(new Error('Reference does not exist'), { status: 422 });
  const out = ok(await mergeToolModule.call('merge_pull_request', { number: 8, delete_branch: true }, ctx(api)));
  assert.match(out, /^merged anima-research\/rayforce#8/);
  assert.match(out, /head branch not deleted: deleteBranch failed: GitHub error 422: Reference does not exist/);
});

test('update_branch merges the base in, guarded by the head it read', async () => {
  const api = seeded();
  const out = ok(await mergeToolModule.call('update_branch', { number: 8, sha: HEAD.slice(0, 12) }, ctx(api)));
  assert.match(out, /asked GitHub to merge dev into feature-8 \(anima-research\/rayforce#8, head abc80+\)/);
  // The full head sha, whatever form the caller gave, and also when it gave none.
  assert.deepEqual(api.callsTo('updatePullRequestBranch')[0].args, [PULL, HEAD]);
  ok(await mergeToolModule.call('update_branch', { number: 8 }, ctx(api)));
  assert.deepEqual(api.callsTo('updatePullRequestBranch')[1].args, [PULL, HEAD]);

  const moved = failure(await mergeToolModule.call('update_branch', { number: 8, sha: 'def4567' }, ctx(api)));
  assert.match(moved, /update_branch refused: the head of anima-research\/rayforce#8 is abc80+, not "def4567"/);
});

test('update_branch takes a merge’s fences: allowed base, open pull request, head not a base', async () => {
  const cases: Array<[Record<string, unknown>, Partial<ToolContext>, RegExp]> = [
    // GITHUB_MERGE_BASE_ALLOW unset: granting github.merge alone writes nothing.
    [{}, { mergeBaseAllow: [] }, /base branch "dev" is not in GITHUB_MERGE_BASE_ALLOW/],
    [{ state: 'closed' }, {}, /#8 is closed; reopen it before updating/],
    [{ state: 'closed', merged: true }, {}, /#8 is already merged/],
    // `main → dev` would merge dev into main.
    [{ head: { ref: 'main', sha: HEAD } }, { prBaseAllow: ['dev', 'main'] }, /the head of anima-research\/rayforce#8, "main", is a base branch here/],
  ];
  for (const [partial, over, expected] of cases) {
    const api = new FakeGitHubApi();
    api.seedPullRequest({ number: 8, headRepo: TEST_REPO, head: { ref: 'feature-8', sha: HEAD }, ...partial });
    const out = failure(await mergeToolModule.call('update_branch', { number: 8 }, ctx(api, over)));
    assert.match(out, expected);
    assert.equal(api.callsTo('updatePullRequestBranch').length, 0);
  }
  // A draft may be brought up to date; it just may not be merged.
  const api = new FakeGitHubApi();
  api.seedPullRequest({ number: 8, draft: true, head: { ref: 'feature-8', sha: HEAD } });
  ok(await mergeToolModule.call('update_branch', { number: 8 }, ctx(api)));
});

test('an unknown tool name is refused by the module', async () => {
  const out = failure(await mergeToolModule.call('force_push', {}, ctx(seeded())));
  assert.match(out, /unknown tool for github\.merge: force_push/);
});
