---
name: code-map
description: Cuts the cost of large-file reads with a verified per-repo symbol map, delivered three ways in order of measured value — a PreToolUse hook that automatically intercepts whole-file Reads of large files and returns the outline (−71.2% cost across six paired tasks, n=6), the /code-map command, and find/outline/brief as manual tools. Use when asked to install, tune or disable the read hook, when a large file needs slicing or outlining, when orienting in an unfamiliar repository, or when asked where a symbol is defined. Not a Grep replacement — for symbol lookup agents correctly prefer Grep (0/30 measured) and the hook does not target that; it targets whole-file reads. Every answer re-verified against disk: a stale cache misses, never lies. Regex-based; fall back to Grep on a miss.
license: MIT
metadata:
  version: "0.9.0"
  author: token-audit contributors
---

# Code Map — three ways in, in order of measured value

**1. The hook** — automatic, `PreToolUse` on `Read`. Measured across six paired large-file
tasks: **−71.2% cost**. This is the delivery mechanism that works, because it fires on the
call the model was already making.
**2. The `/code-map` command** — explicit setup and lookups; you invoke it.
**3. `find` / `outline` / `brief`** — manual tools for one-off questions.

**Adoption, measured and corrected (v0.9.0):** v0.7.x reported "0 invocations in 30
advertised runs" as *the skill never fires*. That conclusion was too broad — all 30 of those
runs were symbol-lookup and pattern tasks, which Grep answers correctly in one call. The
corrected finding: `code-map` is **not** adopted for symbol lookup, *correctly*, because Grep
answers that better — and it **is** adopted unprompted for large-file comprehension, where
the alternative is reading the whole file (5 invocations across the six-task set). The hook
exists so the saving does not depend on that choice at all.

## The hook — automatic, −71.2% measured

When the model asks for a whole large file — over `CODE_MAP_HOOK_MIN_LINES` lines (default
300), no `offset`/`limit` — the hook denies that one call and returns the file's outline:
every symbol with its line number, plus instructions to come back with a slice, or with an
explicit full-file range if the whole thing is genuinely needed.

Install, check, remove — one command each; no hand-edited JSON:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/code-map.mjs hook install [--min-lines 500] [--root <repo>]
node ${CLAUDE_PLUGIN_ROOT}/scripts/code-map.mjs hook status
node ${CLAUDE_PLUGIN_ROOT}/scripts/code-map.mjs hook uninstall
```

`install` merges into `.claude/settings.json` non-destructively and idempotently — existing
hooks and settings are preserved, installing twice does not duplicate, an unparseable
settings file is refused rather than overwritten, and `uninstall` removes only its own entry.
Per-session kill switch: `CODE_MAP_HOOK=off`. Per-session threshold override:
`CODE_MAP_HOOK_MIN_LINES=500` (outranks the installed `--min-lines` flag).

Six paired large-file tasks, same clone, same model, hook off vs on — **n=6, one repo**:

| task | off | on | delta |
|---|---|---|---|
| H1 | $0.7415 | $0.1366 | −81.6% |
| H2 | $0.3500 | $0.1082 | −69.1% |
| H3 | $0.5272 | $0.1770 | −66.4% |
| H4 | $0.4982 | $0.1543 | −69.0% |
| H5 | $0.5082 | $0.1103 | −78.3% |
| H6 | $0.3626 | $0.1748 | −51.8% |
| **total** | **$2.9877** | **$0.8612** | **−71.2%** |

Every task negative; cache writes fell 10–20× on every one. *Caveat, stated rather than
buried:* **H3 is contaminated** — one arm invoked the skill twice, the other zero. Excluding
it: $2.4605 → $0.6842, **−72.2%**, so the headline does not depend on it.

**The mechanism is cheaper tokens, not fewer tokens.** A large file entering context is a
cache *write* at $6.25/MTok; the conversation re-sent on the extra turn is a cache *read* at
$0.50/MTok — 12.5× cheaper (published rates). Billed token counts stayed flat (+0.4% on the
paired single-task run) while cost fell ~71%, which is why count-based measurement looked
flat. **The hook does not help symbol lookup and must not be pitched as doing so** — it
targets whole-file reads, nothing else.

**It fails open, always.** Every path the hook does not positively understand allows the
read: explicit slice, small file, unsupported language, unreadable file, fewer than 3
symbols, malformed stdin, a garbage threshold value (degrades to the default, never to
deny-happy NaN), `CODE_MAP_HOOK=off`, any thrown error. Each allow path is pinned by its own
test, and mutants that deny small files, deny slices, or deny on parse failure each turn the
suite red. It reads only the file the model asked for, writes nothing, and has no network
access.

## The command and manual tools — explicit; use in this order

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/code-map.mjs build --root <repo>   # once per session
node ${CLAUDE_PLUGIN_ROOT}/scripts/code-map.mjs find <name>           # where is it
node ${CLAUDE_PLUGIN_ROOT}/scripts/code-map.mjs outline <file>        # what is in it
node ${CLAUDE_PLUGIN_ROOT}/scripts/code-map.mjs brief                 # orient in a new repo
```

**The saving is not `find` — it is what you do next.** `find` prints the exact `Read` command:

```
scripts/audit.mjs:122	export	analyze
→ Read scripts/audit.mjs offset=110 limit=60
```

Use that offset and limit. Getting a line number and then opening the whole file anyway saves
nothing.

**Benchmarked on three real repositories** (16,979 / 849 / 451 files), median cost of one
location question:

| | whole file | find + slice | outline |
|---|---|---|---|
| median tokens | 2,504–3,710 | 563–606 (**−76% to −85%**) | 135–182 (**−95%**) |

These figures are arithmetic over files — the saving *available* per question. The hook's
−71.2% (n=6 above) is the *realised* number. The map is **worse** for 5–26% of files — ones
small enough that reading them costs less than slicing them. Below ~40 lines, just read the
file.

## Reach for the manual tools when

- You are about to open a file to look at **one** function, class, route, SQL table or heading.
- A file you need is large. **Outline first**, then slice.
- You are new to a repo — `brief` gives the directory shape and the densest files for ~200 tokens.

## Do not reach for them when

- The question is symbol lookup or a content search and Grep is one call away — **Grep wins
  those, measured**. Anthropic tested embedding-based retrieval for Claude Code against plain
  agentic search and kept agentic search; this does not replace it.
- You need to **edit** the file, or reason about code far from one symbol. Read it properly.
- The file is small.

## Why it can be trusted without checking

> **The index is a cache. The file is always the source of truth.**

Before any location is returned, the file's size and mtime are compared with what was
indexed. If they moved, that one file is re-scanned in-process and the answer comes from the
fresh scan. So **a stale cache produces a miss, never a wrong location** — there is no
`--check` mode and no staleness to manage. Answers from a changed file are marked
`(file changed since indexing; line re-verified)`. The hook goes one step further: it never
consults the store at all — it outlines the live file it just intercepted.

Build is incremental: a 16,000-file repo is ~46s cold and **~6s warm**; an 850-file repo is
0.3s warm.

## Nothing is injected into context

Anthropic's context-engineering guidance is explicit that recall **degrades** as context
grows — *"as the number of tokens in the context window increases, the model's ability to
accurately recall information from that context decreases."* Nothing here is loaded up front —
the hook responds only to a Read the model already made, and the command returns a few lines
when asked. **If you are tempted to cat `.claude/code-map/symbols.tsv` into context, do
not** — query it.

## Honest limits — say these rather than let someone discover them

- **Regex-based, not a parser.** It misses things. A miss is a miss, not a wrong answer; fall
  back to Grep, and say you did. The hook inherits this: a file whose symbols it cannot see
  is simply served whole.
- Skips files over 1 MB and minified/bundled files (long-line shape).
- `find` matches names, not usages. "Who calls this" is `code-index`'s `IMPORTEDBY`, or Grep.
- The cache lives in `.claude/code-map/` in the repo. Add it to `.gitignore`.
- The hook figures are **n=6, one repo, and H3 is contaminated** (excluded total −72.2%). The
  12.5× write/read price asymmetry is from the published rate card, not measured.
- The adoption finding is one repo and 36 runs total across both trials. It licenses "Grep
  wins symbol lookup" and "large-file comprehension gets unprompted use", nothing broader.

## The measurement half

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/code-map-learn.mjs tax    # what re-reading costs you
node ${CLAUDE_PLUGIN_ROOT}/scripts/code-map-learn.mjs hot    # files re-read every session
```

`tax` prints **no paths and no search text** — counts and byte totals only. `hot` prints file
paths, the same documented exception `token-audit` makes. Neither prints any result body,
command or search pattern, in any mode. `code-map.mjs` itself never opens a transcript at
all, and a test asserts it cannot.

Image reads cost real vision tokens that this cannot see — it measures text and says so.
