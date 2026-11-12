- Incoming-only contributor polling requires channel registration as well as
  incoming permission. Losing egress mid-pass pauses pending work without
  spending its retry budget; a refused row holds later thread events in order.
- Terminal notification retry records retain the newest 200 updates, including
  across restart, without evicting active retries. Older evicted updates no
  longer have the one-drop-notice guarantee.
- Empty review-page traversal that exhausts its read budget retries as an
  inconsistent listing instead of skipping a supposed 2,000-row backlog.
