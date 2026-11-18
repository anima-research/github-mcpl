- **Operators:** `app-manifest.json` asks for `contents: write` instead of
  `contents: read`. GitHub refuses `resolveReviewThread` to an App that cannot
  write contents, so `resolve_thread` and `unresolve_thread` failed with
  "Resource not accessible by integration" on an App made from the old
  manifest. Raise the permission on the App's **Permissions** page and accept
  it on the installation; add `actions: write` and `workflows: write` there
  too if you enable `github.actions` or `github.merge`.
