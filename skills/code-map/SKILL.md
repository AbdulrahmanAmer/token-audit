---
name: code-map
description: A verified per-repo symbol map with two delivery mechanisms — a PreToolUse hook that automatically intercepts whole-file Reads of large files and returns the outline instead, and the /code-map command for explicit lookups (find a symbol's definition, outline a large file, brief an unfamiliar repo). Use this skill when asked to set up, tune or disable the read hook, when asked where a symbol is defined, or when orienting in a new repository. Do not expect it to fire on its own — measured across 30 advertised runs, a model never chose it; invoke it, or install the hook. Every answer is re-verified against the file on disk, so a stale cache produces a miss and never a wrong location. Regex-based and deliberately incomplete — fall back to Grep on a miss.
license: MIT
metadata:
  version: "0.8.0"
  author: token-audit contributors
---

# Code Map — the version that works is the one that isn't optional

**Measured reality, stated before anything else:** as an auto-firing skill, this is dead.
**0 invocations across 30 runs** in which it was installed and advertised in the model's own
skills listing, under two descriptions — one of which said outright *"Run this BEFORE reaching
for Grep."* That is not a wording problem: a skill needs the model to *choose* it, and the
model already has a tool that answers the question correctly, in one call, with no setup — it
reads the file, or greps, and gets the right answer. The full trial is in the README.

So `code-map` ships as two mechanisms, neither of which depends on being chosen:

1. **The hook** — automatic. It fires on the wasteful call the model was already making.
2. **The `/code-map` command** — explicit. You invoke it; it answers.

Why the read side is the target at all — measured on 589 real sessions (1.27 GB of
transcript, ~8.3M tokens shown to the model):

| | tokens | share of everything shown |
|---|---|---|
| file reads | 4,082,513 | **49%** |
| — of which whole-file (72% of reads) | 2,860,089 | 34% |
| **re-read in a later session** | **1,532,261** | **18%** |
| re-read within one session | 1,014,644 | 12% |
| search (grep/glob) | 616,119 | 7% |
| **repeated searches** | 36,715 | **0.4%** |

## The hook — automatic, and the part that measurably works

`scripts/code-map-hook.mjs` is a `PreToolUse` hook on `Read`. When the model asks for a whole
large file — over `CODE_MAP_HOOK_MIN_LINES` lines (default 300), no `offset`/`limit` — the
hook denies that one call and returns the file's outline instead: every symbol with its line
number, plus instructions to come back with a slice, or with an explicit full-file range if
the whole thing is genuinely needed.

Measured on one large-file task, same clone, same model — **n=1, one task; a wider paired
A/B across six tasks is running and its totals will be published when they exist, not
extrapolated now**:

| | hook off | hook on | |
|---|---|---|---|
| cost | $0.4082 | **$0.1855** | **−54.6%** |
| cache write | 29,281 | 5,655 | **−80.7%** |
| billed tokens | 190,061 | 190,759 | +0.4% |
| turns | 5 | 5 | unchanged |

**The mechanism is cheaper tokens, not fewer tokens.** A large file entering context is a
cache *write* at $6.25/MTok. The conversation re-sent on a later turn is a cache *read* at
$0.50/MTok — 12.5× cheaper. Swapping an expensive write for a slice plus cheap reads is why
cost halves while token counts barely move, and why every count-based measurement in this
project looked flat.

**It fails open, always.** Every path the hook does not positively understand allows the
read: explicit slice, small file, unsupported language, unreadable file, fewer than 3
symbols, malformed stdin, `CODE_MAP_HOOK=off`, any thrown error. Each of those allows is
pinned by its own test, and three mutants — deny small files, deny slices, deny on parse
failure — each turn the suite red. It never blocks a read it did not understand.

Install: a `PreToolUse` entry with matcher `Read` running
`node ${CLAUDE_PLUGIN_ROOT}/scripts/code-map-hook.mjs` — the exact `.claude/settings.json`
block is in the README. Kill switch: `CODE_MAP_HOOK=off`. Threshold:
`CODE_MAP_HOOK_MIN_LINES=500` (default 300). The hook reads only the file the model asked
for; it writes nothing, and it has no network access.

## The command — explicit; use it in this order

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

These figures are arithmetic over files — the saving *available* per question, not one
measured as realised by an agent choosing this on its own; measured, agents do not choose it.
The hook exists precisely to close that gap, and its n=1 result above is the first *realised*
measurement in this project. The map is **worse** for 5–26% of files — ones small enough that
reading them costs less than slicing them. Below ~40 lines, just read the file.

## Reach for the command when

- You are about to open a file to look at **one** function, class, route, SQL table or heading.
- You are asked where something is defined.
- You are new to a repo — `brief` gives the directory shape and the densest files for ~200 tokens.
- A file you need is large. **Outline first**, then slice.

## Do not reach for it when

- You need to **edit** the file, or reason about code far from one symbol. Read it properly.
- The file is small.
- The question is a **content** search — "every call that passes null", anything regex-shaped.
  That is what Grep is for, and Grep is genuinely good at it. Anthropic tested embedding-based
  retrieval for Claude Code against plain agentic search and **kept agentic search**; this does
  not replace it and must not be described as doing so.

## Why it can be trusted without checking

> **The index is a cache. The file is always the source of truth.**

Before any location is returned, the file's size and mtime are compared with what was
indexed. If they moved, that one file is re-scanned in-process and the answer comes from the
fresh scan. So **a stale cache produces a miss, never a wrong location** — there is no
`--check` mode and no staleness to manage. Answers from a changed file are marked
`(file changed since indexing; line re-verified)`. The hook goes one step further: it never
consults the store at all — it outlines the live file it just intercepted.

Build is incremental: a 16,000-file repo is ~46s cold and **~6s warm**; an 850-file repo is
0.3s warm. Run `build` once at the start of a session.

## Nothing is injected into context

Anthropic's context-engineering guidance is explicit that recall **degrades** as context
grows — *"as the number of tokens in the context window increases, the model's ability to
accurately recall information from that context decreases."* An always-on index would trade
tokens for accuracy and lose twice. So nothing here is loaded up front — the hook responds
only to a Read the model already made, and the command returns a few lines when asked. That
is also why the cache file is never pasted into a prompt: **if you are tempted to cat
`.claude/code-map/symbols.tsv` into context, do not** — query it.

## Honest limits — say these rather than let someone discover them

- **Regex-based, not a parser.** It misses things. A miss is a miss, not a wrong answer; fall
  back to Grep, and say you did. The hook inherits this: a file whose symbols it cannot see
  is simply served whole.
- Skips files over 1 MB and minified/bundled files (long-line shape).
- `find` matches names, not usages. "Who calls this" is `code-index`'s `IMPORTEDBY`, or Grep.
- The cache lives in `.claude/code-map/` in the repo. Add it to `.gitignore`.
- The hook's cost result is **n=1** until the six-task A/B reports. The 12.5× write/read price
  asymmetry it relies on is from the published rate card, not measured.

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
