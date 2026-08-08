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

<details>
<summary>Without the plugin system</summary>

```bash
git clone https://github.com/AbdulrahmanAmer/token-audit && cd token-audit
./install.sh      # runs the tests first, then installs to ~/.claude/skills/token-audit/
```

The installer refuses if the tests fail. Nothing is fetched at install time — whatever is in
the checkout is the entire supply chain.
</details>

Requires Node 18+. No dependencies, no network, writes nothing.

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

There is no network access anywhere in this repo, and nothing is written outside the
installer's target directory.

## What's here, and what isn't

This release is **measurement only**, on purpose: it is the piece that is fully portable
today, and the piece that makes every later claim falsifiable — including the ones this
project might want to make about itself.

Planned, in order:

- **`quiet-tests`** — detect a project's test-output convention and propose the quiet-mode
  patch. Highest measured payoff of anything here (1,081 lines → 91), but it has to read
  each project's own conventions, so it advises and patches rather than dropping in.
- **`code-index`** — a generated, cache-stable fact table per source file: what it is, its
  CLI, its imports, who breaks if you change it, who checks it, and a `file:line` pointer to
  a load-bearing invariant. Config-driven, because ~10% of such a generator binds to a
  repo's house conventions and that 10% is where the value is. Measured saving in its home
  repo was 1–3.4k tokens per fix — real, not transformative, and it will ship described that
  way.

Both are held back until they can be shipped with the same standard of evidence as the
measurement: a number, a test that fails when the number is wrong, and a mutant proving the
test is alive.

## Development

```bash
node scripts/test/run-tests.mjs        # privacy invariant + correctness
VERBOSE=1 node scripts/test/run-tests.mjs
node scripts/check-manifests.mjs       # the two manifests and the skill must agree
```

CI runs all of it on every push, plus `bash -n install.sh`.

---
MIT. Not affiliated with or endorsed by Anthropic.
