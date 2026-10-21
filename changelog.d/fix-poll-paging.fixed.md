- The polling fallback no longer loses rows in three ways it did. A page
  shorter than 100 no longer ends a list while `Link: rel="next"` says more
  follow. A read stopped at the three-request bound keeps that list's cursor
  where it stopped, and a later pass reads on from there, instead of moving
  past the rows it never read. And each list is read by `updated_at` rather
  than by page offset, so a row updated mid-read can't push an unread one onto
  a page already read, except among rows that share one `updated_at` second,
  which are still paged by offset.
- Cursors are whole seconds. GitHub's `since` part way through a second leaves
  out every row stamped in that second, so a cursor at the pass's start made
  the next pass miss rows changed later in the second the pass started in.
- Each repository's three lists keep a cursor of their own in the state file
  (`pollCursors`), starting from `lastPollAt` until they have one.
  `lastPollAt` never passes where a list stopped.
- A row announced as opened isn't announced as opened again when it's read
  again inside its window, after a stopped read or a refused delivery
  (`pollNew` in the state file). A first pass that a delivery refused keeps
  the window it read.
- `getCheckRuns` reads on past a short page that isn't empty while
  `total_count` says more runs follow, so such a head is no longer left
  undecided. A response
  without a `total_count` reads on past a full page instead of stopping at
  the first.
