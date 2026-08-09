# Token Audit

**Measure where a Claude Code session's tokens actually went — then optimise the thing that's actually expensive.**

Everyone optimising an agent's token use is guessing. This reads the transcript Claude Code
already writes and reports what was really consumed.

It was built because it refuted its own author inside one command. The guess was *"I read
too many files."* The measurement said:

```
WHERE THE TOKENS WENT
  Bash             674,806 tok  2,746 calls
  Read             223,431 tok    161 calls

FILE READS
  161 reads across 80 files, ~223,431 tok
  RE-READ COST: ~152,383 tok (68% of all read bytes)
      context already paid for once, bought again

TEST / BUILD OUTPUT
  ~86,216 tok, 5,323 lines, 3,718 distinct (30% repeated text)
      a third or more of this is the same lines again.
```

Shell output was 3× the reads, a third of the test output was the same lines again, and the
most-repeated searches in the whole session were variations of grepping that output down to
its failures — paying for the roll-call twice, once to receive it and once to delete it.
The fix that followed cut a full test run from **1,081 lines to 91**. It was invisible to
introspection and obvious after one pass over the transcript.

## Install

Inside Claude Code:

```
/plugin marketplace add AbdulrahmanAmer/token-audit
/plugin install token-audit@token-audit
```

Then ask *"where did this session's tokens go?"*, or run `/token-audit`.

## Skills

| Skill | What it does | Command |
|---|---|---|
| `token-audit` | Reads the transcript Claude Code already writes and reports where a session's tokens went: re-read cost, repeated test output, shell output by kind, cost per commit. | `/token-audit` |
| `quiet-tests` | Measures how much of a project's test output is per-test PASS announcements, then proposes a patch that withholds only those. Refuses when the projected saving is under 25%. | `/quiet-tests` |
| `code-index` | Generates a deterministic, greppable fact table — one line per fact — for what you must know about a file without opening it. Config-driven, derived never authored, `--check` in CI. | `/code-index` |
| `code-map` | Keeps large files out of the context window — a fail-open `Read` hook serves outlines instead of whole files (−94% context on large files, deterministic; cost effect −2.4%, counterbalanced n=10), plus `find`/`outline`/`brief`. Every answer re-verified against disk. | `/code-map` |

`scripts/check-manifests.mjs` fails CI if a skill ships without a row here, or a row here
names a skill that does not ship — both are silent failures for whoever installs this.

<details>
<summary>Without the plugin system</summary>

```bash
git clone https://github.com/AbdulrahmanAmer/token-audit && cd token-audit
./install.sh      # runs the tests first, then installs all four skills
```

Installs `token-audit`, `quiet-tests`, `code-index` and `code-map` into `~/.claude/skills/`, with the
scripts carried alongside. The installer refuses if the tests fail. Nothing is fetched at
install time — whatever is in the checkout is the entire supply chain.
</details>

Requires **Node 18+. No dependencies, no network access anywhere in this repo.**

### What writes, and what doesn't

The four skills differ, so it is worth being exact rather than repeating a slogan that was
true when there was only one of them:

| | reads | writes |
|---|---|---|
| `token-audit` | your transcripts (including subagent ones) | **nothing, ever** |
| `quiet-tests` | your repo; runs your test suite | **nothing** until you pass `--apply` — which patches your test files and adds `quiet.mjs`, after showing you the diff |
| `code-index` | your repo | `CODE-INDEX.txt` (and nothing else) |
| `code-map` | your repo (`code-map.mjs` **never opens a transcript**, and a test asserts it cannot); `code-map-learn.mjs` reads transcripts | `.claude/code-map/` (gitignored cache) |

`token-audit` is the one with the absolute guarantee, and it is the one that reads your
transcripts. The transcript-reading surface of the whole plugin is two files, by design.

## Use

```bash
node scripts/audit.mjs                     # most recently active session
node scripts/audit.mjs --project /path     # newest session for a project
node scripts/audit.mjs --file <a.jsonl>    # one specific transcript
node scripts/audit.mjs --list              # what transcripts exist
node scripts/audit.mjs --per-commit        # cost per commit, for before/after work
node scripts/audit.mjs --json              # same numbers, machine-readable
node scripts/audit.mjs --no-paths          # withhold file paths
node scripts/audit.mjs --no-subagents      # exclude delegated work (included by default)
node scripts/audit.mjs --rate-in 5 --rate-out 25 --rate-cache-read 0.5 --rate-cache-write 6.25
                                           # $/MTok assumptions for the cost estimate
```

**Subagent work is included by default, and it is not optional detail.** Claude Code writes a
subagent's turns to `<project>/<session>/subagents/*.jsonl`, never into the parent transcript,
so a scan of the parent alone reports a delegating session as nearly free. On the session that
ran this project's A/B, two agents consumed ~25,000 tokens of tool output while the parent
attributed **3,432** to the Agent tool — just the summaries. Counting them moved that session
from 43,139 to 68,133 tokens: **it had been under-reporting by 58%.** If your workflow leans on
agents, every number you got before v0.5.0 was too low.

| Section | The question it answers |
|---|---|
| `BILLED TOKENS` | **The headline: what the session actually cost.** Input/output/cache tokens counted by the API, and an estimated dollar figure. Everything below it is a lower bound on tool output. |
| `WHERE THE TOOL OUTPUT WENT` | Which tool is actually expensive. Usually not the one you'd name. |
| `SHELL OUTPUT BY KIND` | Reading, searching, testing, building — where shell output concentrates. |
| `FILE READS` | **`RE-READ COST`** — context already paid for once and bought again. |
| `TEST / BUILD OUTPUT` | Repeated-text share. Above ~25%, a quiet mode is the cheapest saving available. |
| `MOST EXPENSIVE FILES` | The file you read twelve times. Nearly always a surprise. |
| `COST PER COMMIT` | Same-shaped task with and without a change — the honest A/B. |

Billed tokens are read from the `usage` object Claude Code writes on assistant turns,
deduplicated by `message.id` — one API call is written once per content block, and summing
the records double-counts the bill ~2.8×. The dollar line multiplies those counts by
published rates ($5 in / $25 out / $0.50 cache-read / $6.25 cache-write per MTok by default);
the rates are assumptions, not measurements — override them with the `--rate-*` flags. Older
transcripts without `usage` say so plainly instead of printing $0.00.

Three caveats worth stating out loud, because a measurement tool that oversells is worse than
no measurement tool:

- **The byte-derived figures are estimated at 3.6 bytes per token, not counted**, and they
  cover tool output only — on the sessions measured here that was a few percent of the bill.
  They answer "which tool was expensive", not "what did this cost"; `BILLED TOKENS` answers
  that.
- **The dollar figure is only as right as the rates you feed it.** The token counts are exact.
- **The current session's transcript lags behind live.** When measuring work you just
  finished, use `--per-commit` boundaries rather than a delta against the last line.

## Privacy

A transcript contains everything that was in the session: source, pasted credentials,
customer data. So the invariant is absolute, and it is a test rather than a promise:

> **No tool-result content, and no command or search text, is ever printed.**

Result bodies are measured by length and discarded. Commands are reduced to one word from a
closed vocabulary — `read-a-file`, `search`, `run-tests`, `run-build`, `git`, `inspect-fs`,
`write-file`, `other` — and discarded. `scripts/test/run-tests.mjs` plants a canary in every
position a transcript can hold one (a result body, a command line, a search pattern, a web
result) and asserts it never surfaces, in every output mode. The classifier is separately
asserted to be incapable of emitting any word outside that vocabulary, because leaking
command text through the "kind" column is the least obvious way this tool could betray you.

Three mutants confirm those tests are alive: adding a "sample line" to the report, making
the classifier echo its input, and ignoring `--no-paths` each turn the suite red.

**File paths are the one exception, and they are opt-out rather than opt-in.** *"Which file
did I read twelve times"* is the most actionable line in the report, and a path is far less
sensitive than a payload. Pass `--no-paths` where filenames themselves are confidential —
every number still works.

There is no network access anywhere in this repo. `scripts/audit.mjs` — the only script that
reads your transcripts — writes nothing at all, anywhere. See the table above for the other
two, which read source and never touch a transcript.

## Quiet Tests

A suite that prints a line per passing test spends most of its output on the things that went
right. In the repo this was built for, a full run was **1,081 lines; afterwards, 91.** That is
the largest single measured saving in this project.

```bash
node scripts/quiet-tests.mjs --dir <repo>            # detect, measure, verdict
node scripts/quiet-tests.mjs --dir <repo> --apply    # patch, then re-measure
```

It runs your suite to measure it, so it takes as long as your tests do.

**Two invariants, and they are the whole design:**

1. **Nothing about assertions, counts or exit codes changes.** `console.log` is replaced; the
   runner is not touched. Only single-line, single-argument *pass announcements* are withheld.
   A red run still says so, in full, in both modes. `VERBOSE=1` restores the previous output
   byte for byte — verified against an unpatched run, not asserted.
2. **The summary always prints.** In the original repo, four CI gates parsed that line.
   Suppressing it would have left a green pipeline that had stopped checking anything. It is
   *explicitly exempted* in the code, not merely unlikely to match the filter.

**Two refusals**, because a tool that always finds work is not measuring:

- **No summary line found → it stops.** Withholding output from a runner whose totals you
  cannot identify is indistinguishable from hiding a failure.
- **Projected saving under 25% → it says there is nothing worth doing.** Pointed at this
  repository, it declines: *"3 lines, 3 distinct, 0% saved."*

The bar is on **projected saving**, not on the byte-identical-repeat share. Pass announcements
are nearly all distinct — each carries a different test name — so a repeat-share gate would
decline the exact case with the largest payoff. Both numbers are printed so the claim can be
checked instead of believed.

The filter is twelve lines, and every plausible *simpler* version of it is wrong in a way that
deletes something you needed. Four cases must survive it: a marker inside a captured table
(`| ✓ | migrate | 42ms |`), a multi-argument call (`console.log('✓', name, ms)`), a failure
line, and the summary. Three mutants are asserted to break it — a loose
`String(args).includes(marker)`, a filter that also eats the summary, and an inverted verbose
gate — each run against the real implementation, not a copy.

## Code Index

One line per fact, answering *"what must I know about this file without opening it?"*

```
scripts/audit.mjs	IS	where did this session's tokens actually go?
scripts/audit.mjs	CLI	--file --json --list --no-paths --per-commit --project
scripts/audit.mjs	DEFINES	KINDS analyze classify encodeProject listTranscripts
scripts/audit.mjs	IMPORTEDBY	scripts/test/run-tests.mjs
scripts/audit.mjs	GUARD	scripts/test/run-tests.mjs
scripts/audit.mjs	WHY	scripts/audit.mjs:30 NO TOOL-RESULT CONTENT
```

**What it is worth, stated plainly: 1–3.4k tokens per fix, n=1, with a real confound** — the
code was already in context for most of those fixes, so some of that saving is not
attributable to the index. It is **not** the headline of this project. It is a modest,
reliable saving on one shape of question — *who breaks if I change this* — otherwise answered
by reading four files. [`CODE-INDEX.txt`](CODE-INDEX.txt) is this repo's own, generated.

```bash
node scripts/code-index.mjs             # write it
node scripts/code-index.mjs --check     # CI: fail if stale
```

**Two properties, or it costs more than it saves:**

1. **Deterministic** — sorted lists, nothing from the clock, nothing from filesystem order,
   **no generation date.** It is meant for a cached prompt prefix; one volatile byte at the
   top invalidates every token after it, turning the saving into a cost.
2. **Derived, never authored** — `--check` runs in CI, so it cannot drift into a confident
   liar.

**It is config-driven, and that is the design.** About 10% of a generator like this binds to a
repo's house conventions — header format, argv dispatch shape, where the guard register lives,
how the codebase writes emphasis — and that 10% is where all the value is.
[`code-index.config.json`](code-index.config.json) is this repo's, shipped as the worked
example with every field commented. (The repo this skill was first built in is not public, so
the worked example is this one; it exercises every field.)

**`SPAWNEDBY` deliberately under-reports.** A spawn is recorded only when a whitespace-free
string literal reaches a spawn call directly or through one variable *and* the target has a
shebang. A path reaching a spawn through a loop variable is missed. A missing edge costs one
grep; a wrong edge costs the trust that makes the table worth reading.

Seven defects have tests naming them — five from the original construction (a path in a
comment becoming a call edge; a comment stripper desynchronising on a regex literal containing
a quote; a register becoming a caller of everything; test files excluded from the caller set,
which are the group that breaks *first*; a spawn target that cannot be executed), and four
more found by running the generator on this repository and reading the output (an import
specifier counted as a spawn, a copied file counted as spawned, a flag-shaped regex literal
advertised as a CLI option, and fixture source inside template literals counted as exports).

Every one is mutation-verified against the real generator. Two of those tests were **dead when
first written** — built from prose citing a path, which never matches an import pattern even
with the stripper removed — and only the mutation run exposed it.

## Code Map

The premise for this one was *"agents waste tokens grepping for things they already found."*
So it got measured first, across **589 real sessions — 1.27 GB of transcript, ~8.3M tokens
shown to a model.** The premise was wrong:

| | tokens | share of everything shown |
|---|---|---|
| file reads | 4,082,513 | **49%** |
| — of which whole-file (72% of all reads) | 2,860,089 | 34% |
| **re-read in a later session** | **1,532,261** | **18%** |
| re-read within one session | 1,014,644 | 12% |
| search (grep/glob) | 616,119 | 7% |
| **repeated searches** | 36,715 | **0.4%** |

Rediscovering *where things are* costs 0.4%. Re-reading *the things themselves* costs 30%.
Run `code-map-learn.mjs tax` to get these numbers for your own machine.

So this is not a search index and it does not replace grep — Anthropic
[tested embedding-based retrieval for Claude Code against plain agentic search and kept agentic
search](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents). It
attacks the read side, by **replacing reading the wrong amount.**

### The hook: −94% context on large files. Not −71.2% cost — that figure is retracted.

The delivery mechanism that does not need to be chosen. `code-map`'s **`PreToolUse` hook**
sits in front of `Read`: when the model asks for an entire large file (over 300 lines, no
`offset`/`limit`), it denies that one call and returns the file's outline — every symbol
with its line number — plus instructions to come back for a slice, or for the explicit
full-file range if genuinely needed. Installing is one command, and so is leaving:

```bash
node scripts/code-map.mjs hook install                   # merges into .claude/settings.json
node scripts/code-map.mjs hook install --min-lines 500   # raise the threshold (default 300)
node scripts/code-map.mjs hook status                    # installed? threshold? kill switch?
node scripts/code-map.mjs hook uninstall                 # removes only its own entry
```

The merge is non-destructive and idempotent — existing hooks and settings survive, installing
twice does not duplicate, and an unparseable `settings.json` is refused, never overwritten.
Per-session kill switch: `CODE_MAP_HOOK=off`.

**What it verifiably does — deterministic, no agent, no cache, no ordering.** The hook was
fed a real event per file and its output measured against what `Read` would have returned:

| file | whole (tok) | served (tok) | |
|---|---|---|---|
| settings.index.tsx | 19,580 | 1,153 | −94% |
| tier-dashboards.tsx | 18,326 | 1,029 | −94% |
| leads.workspace.tsx | 15,760 | 788 | −95% |
| agent-dashboard.tsx | 14,453 | 886 | −94% |
| CasesConductPanel.tsx | 9,866 | 428 | −96% |
| leads-adapter.ts | 9,605 | 663 | −93% |
| use-mobile.tsx | 160 | 160 | **0% — passed through** |
| index.ts | 140 | 140 | **0% — passed through** |
| **total** | **87,890** | **5,247** | **−94%** |

**This is a context-window claim, not a cost claim, and the distinction matters.** The
tokens kept out of the window would mostly have been billed as cache *reads* at $0.50/MTok —
cheap. Keeping them out matters for recall (Anthropic's guidance: recall degrades as context
grows) and for how much room is left, and it saves a few percent of cost as a side effect.
What the hook is **not** is a cost optimisation. Measured cost, counterbalanced (half the
tasks ran hook-on first) — **n=10, one repo, one model, warm cache**:

| group | off | on | delta |
|---|---|---|---|
| big-file (n=6) | $1.4349 | $1.3697 | **−4.6%** |
| symbol (n=2) | $0.1492 | $0.1504 | +0.8% |
| small-file (n=2) | $0.1176 | $0.1412 | +20.1% (noise; absolutes are cents) |
| **total (n=10)** | **$1.7017** | **$1.6612** | **−2.4%** |

An independent check using first-runs only (unpaired, zero order effect) agrees: $0.1801 vs
$0.1698 per task, −5.7%. −2.4% is small, and it is what was measured.

**v0.9.0's −71.2% is retracted — it was an artifact of run order, not an effect.** Every
earlier hook A/B ran `off` then `on` back to back on the same task, so the treatment arm
always ran second, on a warm prompt cache. The null control — the same task twice with the
hook **off both times** — measured **−79.7%** ($0.2899 → $0.0589; cache writes 24,551 → 390):
the artifact was larger than the claimed effect. The tell, ignored at the time: small files,
which the hook passes through untouched, "improved" 72%. A treatment cannot help cases it
does not touch. The hook does **not** help symbol lookup — Grep wins that, correctly; it
targets whole-file reads only.

### How not to measure this

The most reusable thing in this release is the mistake:

- **Back-to-back A/B runs measure prompt-cache warming, not your treatment.** The second run
  of *anything* is 70–80% cheaper here, because the first pays the cache write ($6.25/MTok)
  and the second pays cache reads ($0.50/MTok). If the treatment arm always runs second, the
  order effect lands entirely on it and reads as a win.
- **Always run a null control** — the same task twice with the treatment off — and size the
  order effect before believing any delta smaller than it. Here the null control was −79.7%.
- **Always include cases the treatment cannot affect**, and treat movement there as a failed
  experiment, not noise to wave away. Small files "improving" 72% was the alarm, and it was
  ignored once.
- Counterbalance (half the pairs treatment-first), or compare first-runs only across arms.
  The two methods agreed here (−2.4% and −5.7%), which is what earned the number a place in
  this README.

**It sits in front of `Read` and fails open by design.** Every path it does not positively
understand allows the read: explicit slices, small files, unsupported languages, unreadable
files, fewer than 3 symbols, malformed input, a garbage threshold value (degrades to the
default), any thrown error. Each allow path is pinned by a test; mutants that deny small
files, deny slices, or deny on parse failure each turn the suite red. It reads only the file
the model asked for, writes nothing, and has no network access.

### Adoption, corrected — what v0.7.0 and v0.7.1 over-claimed

Those releases reported the trial below as **"the skill never fires."** That conclusion was
too broad, and this section corrects it: all 30 of those runs asked *"where is symbol X"* or
*"enumerate every Y"* — tasks Grep answers correctly, in one call, with no setup. Adoption
was tested on the one task type the tool is not for. On **large-file comprehension** tasks —
the six big-file tasks in the cost table above — the agent invokes the skill unprompted, via
`Skill {"skill":"code-map"}`: **5 invocations across the set.** The honest statement:

> `code-map` is not adopted for symbol lookup, correctly, because Grep answers that better.
> It **is** adopted when the alternative is reading a whole large file.

The evidence, which stands unchanged even as its interpretation narrows: **24 tasks × 2
arms** on a
99k-line production codebase (638 files, 99,048 lines under `src/`). Prompts
**byte-identical** — the only difference between the arms was what was installed on disk.
Arm B had `code-map` installed as a real project skill, advertised in its skills listing,
with the map prebuilt (8,924 symbols). The answer key, scoring formulas and predictions were
git-committed (freeze commit `cab1b96`) **before** either arm ran.

| | arm-a (control) | arm-b (code-map installed) |
|---|---|---|
| code-map advertised in the skills listing | 0/24 | **24/24** |
| **code-map invocations** | 0 | **0** |

**The skill was installed, advertised in every single run, and invoked zero times.** Arm B
reached for `Grep` every time — and Grep scored 12/12 on the location block `code-map` exists
to serve. Scores against the frozen key were near-identical:

| block | max | arm-a | arm-b |
|---|---|---|---|
| L — location (12 items, tool-blind sample) | 12 | 12 | 12 |
| P — pattern, complete hit sets | 10 | 10.0 | 10.0 |
| S — structural | 12 | 11.0 | 10.0 |
| R — refactor | 10 | 10 | 10 |
| E — edit, graded by the repo's own gate | 10 | 10 | 10 |
| **total** | 54 | **53.0** | **52.0** |

Cost: $10.0280 vs $9.9020 (−1.3%), billed tokens 5,602,597 vs 5,556,003 (−0.8%). With the
skill never invoked, those deltas are run-to-run noise between two arms that behaved
identically — reported because pre-registration requires it, not because they mean anything.

**On this evidence the skill is not chosen for symbol lookup — and that is the correct
choice, not a defect: Grep scored 12/12.** Scope: one repo, 24 tasks, n=1 per item.

**Follow-up — is the description what fails? Tested: no.** v0.7.0 shipped that hypothesis
labelled untested. Same clone, same frozen tasks, same model and effort; **only the skill's
`description:` frontmatter changed**. v1 (651 chars) buried the trigger behind mechanism and
ended with *"fall back to Grep on a miss"*; v2 (444 chars) leads with the trigger and says
outright — *"Run this BEFORE reaching for Grep … Prefer it over Grep for locating a name."*

| description | runs | advertised | **invocations** | answers correct |
|---|---|---|---|---|
| v1 | 24 | 24/24 | **0** | 12/12 on L |
| v2 — "prefer over Grep" | 6 | 6/6 | **0** | 6/6 |
| combined | **30** | 30/30 | **0** | — |

> An installed, advertised, plainly-described skill still loses to `Grep` on symbol lookup —
> because `Grep` already answers that correctly, in one call, with no setup. No wording fixes
> that, and this project has stopped trying: for symbol lookup, Grep is the right tool.

n=6 for v2, one description variant, one repo. What v0.7.1 called "untested and plausible" —
value on the tasks Grep cannot serve — has since been measured: outline-shaped help on large
files is what the hook delivers (−94% context, deterministic table above; −4.6% cost on
big-file tasks), and the six comprehension tasks drew 5 unprompted skill invocations.
`brief` for orientation remains unmeasured.

```bash
node scripts/code-map.mjs build          # incremental; ~6s warm on a 16,000-file repo
node scripts/code-map.mjs find analyze   # scripts/audit.mjs:122  export  analyze
node scripts/code-map.mjs outline <file> # what's in it, ~40 lines
node scripts/code-map.mjs brief          # orient in a new repo, ~200 tokens
node scripts/code-map.mjs bench          # measure it on YOUR repo
```

`find` prints the next command — `→ Read scripts/audit.mjs offset=110 limit=60` — because the
saving is not the lookup, it is the slice. Benchmarked over three real repositories
(16,979 / 849 / 451 files), median cost of one location question:

| | whole file | find + slice | outline |
|---|---|---|---|
| median tokens | 2,504–3,710 | 563–606 (**−76% to −85%**) | 135–182 (**−95%**) |

**It is worse for 5–26% of files** — ones small enough that reading them beats slicing them.
`bench` prints that number next to the headline, because a benchmark that cannot report a loss
is marketing.

### Does it actually change what a session costs?

Two subagents, same model, same repo, the same five orientation questions requiring locations
across four files. Arm A used normal tools; Arm B was told the map existed and to use the
`offset`/`limit` that `find` prints. **Both got all five answers right.**

Measured from the `usage` records the API bills on — the accounting v0.6.0 added,
deduplicated by `message.id` — the answer is **no**:

| | A (control) | B (code-map) | |
|---|---|---|---|
| billed tokens | 375,061 | 551,067 | **+47%** |
| cost @ Opus rates | $0.7252 | $0.7296 | **+0.6% — parity** |

**`code-map` used 47% more tokens for the same money.** It did not save anything measurable.
The extra round trips (14 → 24 tool calls) each re-send the conversation, and re-sent context
bills as cache reads at a tenth of the input rate — which is how billed tokens can rise 47%
while dollars stay flat. **n=1**, one task, one repo — and Arm B was *told* to use the map, so
this measures the ceiling when the skill fires, not adoption. Adoption has since been
measured, and it is task-shaped — see *"Adoption, corrected"* above: never for symbol lookup
(30/30, correctly — Grep wins those), unprompted for large-file comprehension (5 invocations
across six tasks).

This table has been corrected twice, and each correction made the tool look worse and the
measurement better. v0.5.0 shipped **−11%** "total agent tokens" — a figure derived from
tool-output bytes, which turn out to be a few percent of what a session actually bills. The
first `usage`-based recomputation said **−8%** cost — wrong again, because summing every
transcript record double-counts each API call ~2.8× (Claude Code writes one record per
content block). The current figures come from `usage` deduplicated by `message.id` and are
what `audit.mjs` itself now reports. The byte-level intermediates remain true as far as they
go — tool output fell 40% (15,601 → 9,393 tok), whole-file reads went 2 → 0 — but they are a
lower bound on tool output, not the bill.

The run also paid for itself twice: it exposed that `find` missed both function-local consts in
the question set, and each miss cost a fallback round trip. Locals are now indexed (ranked
below real declarations), which is where the extra calls came from and the first thing to improve.

### Why you can act on it without checking

> **The index is a cache. The file is always the source of truth.**

Before any location is returned, the file's size and mtime are compared with what was indexed;
if they moved, that file is re-scanned in-process and the answer comes from the fresh scan. **A
stale cache produces a miss, never a wrong location.** There is no `--check` mode and no
staleness to manage. Four tests mutate a file *after* indexing it — the only way to tell a
verified answer from a lucky one.

### Nothing is injected into your context

Anthropic's guidance is explicit that recall **degrades** as context grows: *"as the number of
tokens in the context window increases, the model's ability to accurately recall information
from that context decreases."* An always-on index would trade tokens for accuracy and lose
twice. Nothing is loaded up front; you query, and get a few lines back. Don't `cat` the cache
into a prompt.

### Limits, stated

Regex-based, not a parser — it misses things, and a miss is a miss rather than a wrong answer.
Skips files over 1 MB and minified bundles. `find` matches definitions, not usages. Image reads
cost real vision tokens this cannot see; it measures text and says so.

A feature was **cut** by the same measurement: learning *what was searched for*, with a privacy
gate to keep credentials out of it. Repeated searches turned out to cost 0.4%. It would have
added a transcript-reading surface and a privacy control to maintain, to chase four tenths of
one percent.

## Development

```bash
npm test                               # every suite, one exit code
VERBOSE=1 npm test                     # per-test lines restored
node scripts/check-manifests.mjs       # manifests, skills, README and scripts must agree
node scripts/code-index.mjs --check    # the committed fact table matches a fresh build
```

CI runs all of it on every push, plus `bash -n install.sh`.

---
MIT. Not affiliated with or endorsed by Anthropic.
