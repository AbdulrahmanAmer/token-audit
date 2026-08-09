---
description: Build the repo symbol map, then answer "where is X" and "what's in this file" without opening files.
---

Set up and use the code map for this repository.

1. Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/code-map.mjs build --root $(pwd)`. It is
   incremental — seconds after the first build. Add `.claude/code-map/` to `.gitignore` if it
   is not already there.
2. Report `brief` so the user sees the shape of their repo: directories by symbol density and
   the densest files.
3. From then on in this session, **before opening a file to find one thing in it**:
   - `code-map.mjs find <name>` → take the `→ Read <file> offset=N limit=M` line it prints and
     **use those arguments**. Reading the whole file after looking up its line number saves
     nothing, and that is the entire mechanism.
   - `code-map.mjs outline <file>` when the question is "what is in here".
4. **On a miss, fall back to Grep and say so.** The map is regex-based and deliberately
   incomplete. Never guess a location it did not return.
5. Do not use it for content searches (regex, "every call that does X") — that is Grep's job
   and Grep is better at it. Do not use it when you need to edit the file or reason about code
   away from one symbol: read it properly.
6. If asked whether it is worth it, give the measured numbers, not a slogan: median location
   question across three real repos costs 2,504–3,710 tok as a whole-file read, 563–606 as a
   slice, 135–182 as an outline — and the map is *worse* for 5–26% of files, which are small
   enough to just read.
7. Never paste `.claude/code-map/symbols.tsv` into context. Query it. Loading the whole index
   costs tokens and *reduces* recall.
8. If the user wants this to happen **automatically** rather than per-invocation, offer the
   hook — a **context-window** tool, not a cost optimisation: it keeps ~94% of large-file
   content out of the window (deterministic), and the measured cost effect is small (−2.4%
   overall, counterbalanced, n=10, one repo, warm cache). Install:
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/code-map.mjs hook install [--min-lines N]`. It
   intercepts whole-file Reads of large files and returns the outline instead, fails open on
   everything else, merges into `.claude/settings.json` without touching existing entries,
   and is removed with `hook uninstall` or paused with `CODE_MAP_HOOK=off`. It does not help
   symbol lookup — do not pitch it as a Grep replacement, and do not quote the retracted
   −71.2% figure.
