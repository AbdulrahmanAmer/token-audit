---
description: Generate or refresh the deterministic per-file fact table, and wire its --check into CI.
---

Generate or refresh this repository's code index.

1. If `code-index.config.json` does not exist, **read the repo's conventions first** — how
   file headers are written, how the argv dispatch looks, where the checks live, how the
   codebase writes emphasis in comments — and fit the config to them before generating
   anything. A default-config run produces a plausible table full of near misses.
2. Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/code-index.mjs --root $(pwd)`.
3. Show the user a sample of the output and **spot-check three facts against the source**.
   Every fact is derived by heuristic; the ones that are wrong are wrong confidently.
4. Wire `--check` into CI **in the same change**. Derived-but-unverified drifts, and a stale
   fact table is worse than none.
5. State the honest number if asked whether it is worth it: 1–3.4k tokens per fix, n=1, with
   a real confound. It is not the headline; `/token-audit` is.
6. If asked to add a generation date, a file count, or anything else volatile to the header,
   refuse and explain: this file is meant for a cached prompt prefix, and one volatile byte
   at the top invalidates every token after it.
