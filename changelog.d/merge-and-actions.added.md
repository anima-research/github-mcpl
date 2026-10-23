- `github.merge` feature set: `merge_pull_request` (merge, squash or rebase,
  at the head sha the caller read, optionally deleting the merged head branch)
  and `update_branch`. It merges only into the bases `GITHUB_MERGE_BASE_ALLOW`
  names, which is empty by default: granting the feature set alone merges
  nothing. Drafts, closed and merged pull requests and a moved head are
  refused before GitHub is asked; branch protection stays GitHub's.
- `github.actions` feature set: `list_workflow_runs`, `dispatch_workflow` and
  `rerun_workflow_run`. Dispatch and re-run act only on the workflow files
  `GITHUB_WORKFLOW_ALLOW` names (empty by default), and a dispatch runs only
  on a base branch. Built for re-requesting a review from a workflow that
  ignores comments from bots.
- `list_reviews` (`github.read`): every submitted review on a pull request,
  read to the last page, ending on the newest verdict.
