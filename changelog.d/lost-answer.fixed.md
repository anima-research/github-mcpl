- A write tool that got no answer from GitHub, or a 5xx, no longer says it
  failed: it says whether the write took effect is unknown, and to look on
  GitHub before trying again, since a retry may do it twice. The comment
  tools, which answered such a failure with a JSON-RPC error, now answer with
  an error result saying so, and add that rollback has no record of the write
  if it took effect. A read, and a write GitHub refused with a 4xx, still say
  they failed.
