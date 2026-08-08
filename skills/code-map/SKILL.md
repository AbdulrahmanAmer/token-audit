---
name: code-map
description: Answers "where is this symbol" and "what is in this file" for about 50 tokens instead of opening the file, by keeping a verified per-repo symbol cache. Use before reading a file to find one function, class, route, table or heading in it; when asked where something is defined; when orienting in an unfamiliar repository; or when a session is re-reading the same files it read last time. Every answer is re-checked against the file on disk, so a stale cache produces a miss and never a wrong location. Also measures what re-reading actually costs across past sessions. Regex-based and deliberately incomplete — fall back to Grep on a miss.
license: MIT
metadata:
  version: "0.7.1"
  author: token-audit contributors
---

# Code Map — read the right 60 lines, not the whole file

**Measured on 589 real sessions (1.27 GB of transcript, ~8.3M tokens shown to the model):**

| | tokens | share of everything shown |
|---|---|---|
| file reads | 4,082,513 | **49%** |
| — of which whole-file (72% of reads) | 2,860,089 | 34% |
| **re-read in a later session** | **1,532,261** | **18%** |
| re-read within one session | 1,014,644 | 12% |
| search (grep/glob) | 616,119 | 7% |
| **repeated searches** | 36,715 | **0.4%** |

Reading is where the tokens go. Rediscovering *where things are* costs almost nothing;
re-reading *the things themselves* costs 30%.

**Measured limitation, stated before anything else (v0.7.1):** in a controlled trial —
byte-identical prompts, this skill installed as a real project skill, map prebuilt — it was
advertised in the skills listing of **30 runs across two different descriptions**, one of
which said outright *"Run this BEFORE reaching for Grep"*, and invoked **zero times**. The
agent reached for Grep every time, and Grep answered the location tasks correctly. One repo;
the mechanism is not disproved — it was never invoked. But every saving on this page is
**available per question, realised only when this skill is explicitly invoked**.

## Use it in this order

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

Use that offset and limit. A whole-file read on this corpus averaged **~1,124 tokens**; the
slice is ~500 and an outline ~150. Getting a line number and then opening the whole file
anyway saves nothing.

**Benchmarked on three real repositories** (16,979 / 849 / 451 files), median cost of one
location question:

| | whole file | find + slice | outline |
|---|---|---|---|
| median tokens | 2,504–3,710 | 563–606 (**−76% to −85%**) | 135–182 (**−95%**) |

These figures are arithmetic over files — the saving *available* when a location question is
answered with a slice — not a saving measured as *realised* by an agent in a live session.
Neither agent trial to date realised any of it: the coached one (n=1, README) finished at
**+47% billed tokens and cost parity**, and the uncoached trial (30 runs, two descriptions)
never invoked the skill at all.

The map is **worse** for 5–26% of files — ones small enough that reading them costs less than
slicing them. Below ~40 lines, just read the file.

## Reach for it when

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
`(file changed since indexing; line re-verified)`.

Build is incremental: a 16,000-file repo is ~46s cold and **~6s warm**; an 850-file repo is
0.3s warm. Run `build` once at the start of a session.

## Nothing is injected into context

Anthropic's context-engineering guidance is explicit that recall **degrades** as context
grows — *"as the number of tokens in the context window increases, the model's ability to
accurately recall information from that context decreases."* An always-on index would trade
tokens for accuracy and lose twice. So nothing here is loaded up front. You ask; you get a
few lines. That is also why the cache file is never pasted into a prompt: **if you are
tempted to cat `.claude/code-map/symbols.tsv` into context, do not** — query it.

## Honest limits — say these rather than let someone discover them

- **Regex-based, not a parser.** It misses things. A miss is a miss, not a wrong answer; fall
  back to Grep, and say you did.
- Skips files over 1 MB and minified/bundled files (long-line shape).
- `find` matches names, not usages. "Who calls this" is `code-index`'s `IMPORTEDBY`, or Grep.
- The cache lives in `.claude/code-map/` in the repo. Add it to `.gitignore`.

## The open question, answered: it is not the description

v0.7.0 recorded the hypothesis that the `description:` frontmatter was what failed, and
labelled it untested. It has been tested: same clone, same frozen tasks, same model and
effort, **only the description changed**. v1 (651 chars) buried the trigger behind mechanism
and ended with *"fall back to Grep on a miss"*; v2 (444 chars) leads with the trigger and
says outright — *"Run this BEFORE reaching for Grep … Prefer it over Grep for locating a
name."*

| description | runs | advertised | **invocations** | answers correct |
|---|---|---|---|---|
| v1 | 24 | 24/24 | **0** | 12/12 on L |
| v2 — "prefer over Grep" | 6 | 6/6 | **0** | 6/6 |
| combined | **30** | 30/30 | **0** | — |

The hypothesis is **refuted**:

> An installed, advertised, plainly-described skill still loses to `Grep` on the exact task it
> was built for — because `Grep` already answers that task correctly, in one call, with no
> setup. `code-map` is not competing against an absence; it is competing against a good tool
> that is already there. That is not a description problem, and no wording fixes it.

Scope: n=6 for v2, one description variant, one repo. This does not prove that *no*
description could ever work; it proves the obvious one does not, and shifts the burden of
proof onto anyone claiming the next rewrite will.

**What remains defensible — untested, plausible, and the subject of any next trial:** the two
things Grep genuinely cannot serve. `outline` on a large file (structure without paying for
the read) and `brief` for orienting in an unfamiliar repository. The trial only tested `find`
against symbol lookup; neither of these was isolated, and nothing yet validates them.

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
