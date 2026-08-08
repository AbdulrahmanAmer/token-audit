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

`scripts/check-manifests.mjs` fails CI if a skill ships without a row here, or a row here
names a skill that does not ship — both are silent failures for whoever installs this.

<details>
<summary>Without the plugin system</summary>

```bash
git clone https://github.com/AbdulrahmanAmer/token-audit && cd token-audit
./install.sh      # runs the tests first, then installs all three skills
```

Installs `token-audit`, `quiet-tests` and `code-index` into `~/.claude/skills/`, with the
scripts carried alongside. The installer refuses if the tests fail. Nothing is fetched at
install time — whatever is in the checkout is the entire supply chain.
</details>

Requires **Node 18+. No dependencies, no network access anywhere in this repo.**

### What writes, and what doesn't

The three skills differ, so it is worth being exact rather than repeating a slogan that was
true when there was only one of them:

| | reads | writes |
|---|---|---|
| `token-audit` | your transcripts | **nothing, ever** |
| `quiet-tests` | your repo; runs your test suite | **nothing** until you pass `--apply` — which patches your test files and adds `quiet.mjs`, after showing you the diff |
| `code-index` | your repo | `CODE-INDEX.txt` (and nothing else) |

`token-audit` is the one with the absolute guarantee, and it is the one that reads your
transcripts. The two that write are the two that only ever read your own source.

## Use

```bash
node scripts/audit.mjs                     # most recently active session
node scripts/audit.mjs --project /path     # newest session for a project
node scripts/audit.mjs --file <a.jsonl>    # one specific transcript
node scripts/audit.mjs --list              # what transcripts exist
node scripts/audit.mjs --per-commit        # cost per commit, for before/after work
node scripts/audit.mjs --json              # same numbers, machine-readable
node scripts/audit.mjs --no-paths          # withhold file paths
```

| Section | The question it answers |
|---|---|
| `WHERE THE TOKENS WENT` | Which tool is actually expensive. Usually not the one you'd name. |
| `SHELL OUTPUT BY KIND` | Reading, searching, testing, building — where shell output concentrates. |
| `FILE READS` | **`RE-READ COST`** — context already paid for once and bought again. |
| `TEST / BUILD OUTPUT` | Repeated-text share. Above ~25%, a quiet mode is the cheapest saving available. |
| `MOST EXPENSIVE FILES` | The file you read twelve times. Nearly always a surprise. |
| `COST PER COMMIT` | Same-shaped task with and without a change — the honest A/B. |

Two caveats worth stating out loud, because a measurement tool that oversells is worse than
no measurement tool:

- **Tokens are estimated at 3.6 bytes each, not counted.** There is no offline tokenizer.
  The ratios are the point; don't quote the absolute figures as exact.
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
