- `github.merge` feature set: `merge_pull_request` (merge, squash or rebase,
  at the head sha the caller read, optionally deleting the merged head branch
  when it is nobody's base) and `update_branch`. Both act only on pull
  requests into the bases `GITHUB_MERGE_BASE_ALLOW` names, which is empty by
  default: granting the feature set alone writes nothing. `merge_pull_request`
  refuses a draft. Both refuse a closed or merged pull request, and, given
  the `sha` the caller read, a head that has moved since, before GitHub is
  asked to write; `update_branch` writes only to a head branch of the pull
  request's own repository that is nobody's base.
  Branch protection stays GitHub's.
- `github.actions` feature set: `list_workflow_runs`, `dispatch_workflow` and
  `rerun_workflow_run`. Dispatch and re-run act only on the workflow files
  `GITHUB_WORKFLOW_ALLOW` names (empty by default), and a dispatch runs only
  on a base branch. Built for re-requesting a review from a workflow that
  ignores comments from bots.
- `list_reviews` (`github.read`): the newest 50 reviews on a pull request and
  how many there are in all, ending on the newest verdict.
