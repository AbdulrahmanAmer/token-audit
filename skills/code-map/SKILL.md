---
name: code-map
description: Keeps large files out of the context window with a verified per-repo symbol map, delivered three ways — a PreToolUse hook that automatically intercepts whole-file Reads of large files and returns the outline (−94% context on large files, deterministic; cost effect −2.4% overall on a warm cache, counterbalanced n=10), the /code-map command, and find/outline/brief as manual tools. A context-window tool, not a cost optimisation. Use when asked to install, tune or disable the read hook, when a large file needs slicing or outlining, when orienting in an unfamiliar repository, or when asked where a symbol is defined. Not a Grep replacement — for symbol lookup agents correctly prefer Grep (0/30 measured) and the hook does not target that; it targets whole-file reads. Every answer re-verified against disk: a stale cache misses, never lies. Regex-based; fall back to Grep on a miss.
license: MIT
metadata:
  version: "0.9.1"
  author: token-audit contributors
---

# Code Map — three ways in, in order of measured value

**1. The hook** — automatic, `PreToolUse` on `Read`. Keeps **94% of large-file content out
of the context window** (deterministic measurement); the cost effect is small (**−2.4%
overall, −4.6% on big-file tasks**, counterbalanced, n=10, one repo, warm cache). It is the
delivery mechanism that works because it fires on the call the model was already making.
**2. The `/code-map` command** — explicit setup and lookups; you invoke it.
**3. `find` / `outline` / `brief`** — manual tools for one-off questions.

**Adoption, measured and corrected (v0.9.0):** v0.7.x reported "0 invocations in 30
advertised runs" as *the skill never fires*. That conclusion was too broad — all 30 of those
runs were symbol-lookup and pattern tasks, which Grep answers correctly in one call. The
corrected finding: `code-map` is **not** adopted for symbol lookup, *correctly*, because Grep
answers that better — and it **is** adopted unprompted for large-file comprehension, where
the alternative is reading the whole file (5 invocations across the six-task set). The hook
exists so the saving does not depend on that choice at all.

## The hook — a context-window tool, not a cost optimisation

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

**What it verifiably does** — deterministic, no agent, no cache, no ordering: fed a real
event per file, it kept **87,890 → 5,247 tokens (−94%)** of whole-file content out of the
context window across six large files, and passed the two small files through untouched at
exactly 0% change. **That is a context-window claim, not a cost claim.** The tokens kept out
would mostly have been cheap cache *reads* at $0.50/MTok, which is why 94% less context is
only a few percent less money on a warm cache.

Measured cost, counterbalanced (half the tasks ran hook-on first) — **n=10, one repo, one
model, warm cache**:

| group | off | on | delta |
|---|---|---|---|
| big-file (n=6) | $1.4349 | $1.3697 | **−4.6%** |
| symbol (n=2) | $0.1492 | $0.1504 | +0.8% |
| small-file (n=2) | $0.1176 | $0.1412 | +20.1% (noise; absolutes are cents) |
| **total (n=10)** | **$1.7017** | **$1.6612** | **−2.4%** |

A first-runs-only comparison (unpaired, zero order effect) agrees: −5.7%. The saving is
small, and that is what was measured. **v0.9.0's −71.2% is retracted**: every earlier A/B
ran off-then-on back to back, so the treatment always ran second on a warm prompt cache —
and the null control (same task twice, hook off both times) measured **−79.7%** by itself.
Why install it, then: what it buys is **room and recall** — the window is not filled with
whole files — with a small cost saving as a side effect. **The hook does not help symbol
lookup and must not be pitched as doing so** — it targets whole-file reads, nothing else.

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

These figures are arithmetic over files — the saving *available* per question, in context
terms. The hook's realised numbers are above: −94% context on large files, −2.4% cost
overall. The map is **worse** for 5–26% of files — ones
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
- The hook's cost figures are **counterbalanced, n=10, one repo, one model, warm cache** —
  and small. The −94% figure is deterministic and is about **context, not money**. The 12.5×
  write/read price asymmetry is from the published rate card, not measured. An earlier
  −71.2% claim was an artifact of running off-then-on back to back (null control: −79.7%)
  and is retracted.
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
