---
name: token-audit
description: Measures where a Claude Code session's tokens actually went, by reading the transcript Claude Code already writes. Use when the user asks why a session is expensive, where the context or tokens are going, how to reduce token usage or cost, what is filling the context window, whether a change actually saved tokens, or asks for a before/after comparison of two pieces of work. Also use before designing any token optimisation — an index, a caching scheme, a summarisation step — so the design targets measured waste instead of a guess. Reports billed tokens and estimated dollar cost from the API's own usage records, plus re-read cost, repeated test output, shell output by kind, and cost per commit. Aggregates only; transcript content is never printed.
license: MIT
metadata:
  version: "0.6.0"
  author: token-audit contributors
---

# Token Audit — measure first, then optimise

Everyone optimising an agent's token use is guessing. This reads the transcript Claude Code
already writes to `~/.claude/projects/**/*.jsonl` and reports what was actually consumed.

**Run it before designing an optimisation, not after.** The first time this was run, it
refuted its own author inside one command. The guess was "I read too many files." The
measurement said file reads were ~222k tokens against ~649k of shell output — and that 30%
of the test-and-build output was byte-identical repeated text, with the most-repeated
searches in the entire session being variations of grepping that output down to its
failures. The roll-call was paid for twice: once to receive it, once to delete it. The fix
that followed cut a full test run from 1,081 lines to 91. That fix was invisible to
introspection and obvious after one pass over the transcript.

## Running it

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/audit.mjs                     # most recently active session
node ${CLAUDE_PLUGIN_ROOT}/scripts/audit.mjs --project /path     # newest session for a project
node ${CLAUDE_PLUGIN_ROOT}/scripts/audit.mjs --file <a.jsonl>    # one specific transcript
node ${CLAUDE_PLUGIN_ROOT}/scripts/audit.mjs --list              # what transcripts exist
node ${CLAUDE_PLUGIN_ROOT}/scripts/audit.mjs --per-commit        # cost per commit (A/B work)
node ${CLAUDE_PLUGIN_ROOT}/scripts/audit.mjs --json              # same numbers, machine-readable
node ${CLAUDE_PLUGIN_ROOT}/scripts/audit.mjs --no-paths          # withhold file paths
node ${CLAUDE_PLUGIN_ROOT}/scripts/audit.mjs --rate-in 5 --rate-out 25 --rate-cache-read 0.5 --rate-cache-write 6.25
                                                                 # $/MTok for the cost line
```

Node 18+. No dependencies, no network, writes nothing — this script reads transcripts and prints; it never writes anywhere.

**The current session's transcript lags behind live** — it is flushed as the session
proceeds, so the last few turns may be missing. That matters when measuring work you just
finished: prefer `--per-commit` boundaries, or re-run a moment later, rather than trusting a
delta taken against the very last line.

## Reading the report

| Section | The question it answers |
|---|---|
| `BILLED TOKENS` | **What the session actually cost — lead with this.** Input/output/cache tokens counted by the API (deduplicated by message id), and an estimated dollar figure. |
| `WHERE THE TOOL OUTPUT WENT` | Which tool is actually expensive. Usually not the one you'd name. |
| `SHELL OUTPUT BY KIND` | Reading, searching, testing, building — where shell output concentrates. |
| `FILE READS` | **`RE-READ COST`**: context already paid for once and bought again. |
| `TEST / BUILD OUTPUT` | Repeated-text share. Above ~25%, a quiet mode is the cheapest available saving. |
| `MOST EXPENSIVE FILES` | The file read twelve times. Nearly always a surprise. |
| `COST PER COMMIT` | For before/after comparisons — same-shaped task, with and without a change. |

**Lead with `BILLED TOKENS` when reporting.** Those counts come from the `usage` records the
API bills on — they are counted, not estimated. The dollar line is those counts at published
rates; call it an estimate and name the rates (override with the `--rate-*` flags). Every
figure below that section is derived from tool-result **bytes** at ~3.6 bytes per token: a
**lower bound covering tool output only**, historically a few percent of the bill. Quote the
byte figures for *which tool was expensive*, never for *what the session cost*. A transcript
with no usage accounting (older Claude Code) is reported as unknown cost, not $0 — pass that
on honestly rather than substituting the byte total.

## What to do with the answer

Read the numbers before proposing anything. The three findings that recur, in the order they
usually pay off:

1. **High repeated-text share in test output.** A test run that prints one line per passing
   assertion is a roll-call nobody reads and an agent pays for twice. Print failures and the
   summary; keep a verbose flag. Cheapest win, needs no discipline afterwards.
2. **High re-read cost.** Re-reading a file is rarely a symbol lookup — it is usually
   re-establishing context: what does this file guarantee, who breaks if I change it, who
   checks it. That is cheap to state once and expensive to reconstruct each time.
3. **A single dominant file.** Often a document that should have been summarised, split, or
   read with an offset.

Two honest cautions when advising on this:

- **A saving is a claim until it is re-measured.** Note the current re-read share, make the
  change, and measure a later comparable session. If the number does not move, say so.
- **Do not assume the fix is an index.** A symbol index is the instinctive answer and the
  measurement frequently refuses it — in the session above, only 178 of 1,109 searches were
  bare-identifier lookups. Let the report choose the target.

## Privacy

A transcript contains everything that was in the session: source, pasted credentials,
customer data. So the invariant is absolute and mechanically tested:

> **No tool-result content, and no command or search text, is ever printed.**

Result bodies are measured by length and discarded. Commands are reduced to one word from a
fixed vocabulary (`read-a-file`, `search`, `run-tests`, `run-build`, `git`, `inspect-fs`,
`write-file`, `other`) and discarded. `scripts/test/run-tests.mjs` plants a canary in every
position a transcript can hold one and asserts it never surfaces, in every output mode.

**File paths are the one exception, and they are opt-out rather than opt-in** — "which file
did I read twelve times" is the most actionable line in the report, and a path is far less
sensitive than a payload. Pass `--no-paths` where filenames themselves are confidential; all
the numbers still work.

When reporting results to a user, quote the aggregates. Do not go and read the transcript
yourself to add colour — that reintroduces by hand exactly what this tool refuses to do.
