# Changelog

All notable changes to Token Audit. Versions follow [semver](https://semver.org/).

## [0.3.0] — 2026-08-08

Adds `code-index`. **Stated honestly up front: measured saving in its home repo was 1–3.4k
tokens per fix, n=1, with a real confound** — the code was already in context for most of
those fixes. It is not the headline; the measurement skill is.

### Added
- `code-index` skill and `/code-index` command.
- `scripts/code-index.mjs` — a deterministic, greppable fact table, one line per fact:
  `IS`, `CLI`, `USES`, `IMPORTEDBY`, `SPAWNEDBY`, `GUARD`, `DEFINES`, `WHY`.
  `--check`, `--stdout`, `--root`, `--config`.
- `code-index.config.json` — this repo's own config, shipped as the worked example with
  every field commented. ~10% of a generator like this binds to a repo's house conventions
  and that 10% is where the value is. (The repo it was first built in is not public, so the
  worked example is this one; it exercises every field.)
- `CODE-INDEX.txt` — this repo's generated index, and CI's `--check` target.

### Two properties
- **Deterministic**: sorted, nothing from the clock or filesystem order, **no generation
  date**. Meant for a cached prompt prefix, where one volatile byte at the top invalidates
  every token after it. Pinned by a test that fails on any date, time or absolute path.
- **Derived, never authored**: `node scripts/code-index.mjs --check` runs in CI.

### Nine defects, each with a test naming it
Five from the tool's original construction:
1. A path named in a **comment** became a call edge — repo comments cite files constantly, so
   the graph was partly a reading of its own prose.
2. The comment stripper **desynchronised on a regex literal containing a quote**
   (`/'(?:[^'\\\n]|\\.)*'/`) and let every later comment through. Fixed by making string state
   **line-local** rather than by writing a better scanner: the worst case becomes one wrong
   line instead of a whole file, and a real parser is not a defensible dependency for an index.
3. A **register** naming every file became a caller of every file. A file referencing more than
   half the **eligible** population is a manifest, not a caller.
4. The ratio must be taken against the **eligible set**, not the whole tree — padding a repo
   with docs otherwise makes a register look like a minority and it slips back through.
5. **Test files were excluded** from the caller set — the group that breaks *first*, reported
   as absent. They are in it deliberately.
6. A **spawn target must be executable** (shebang) and the string literal **whitespace-free
   end to end**; `"run tools/x/gen.mjs"` is a sentence addressed to a human.

Four more found by running the generator on this repository and reading the output:
7. An **import specifier** counted as a spawn, making `SPAWNEDBY` a wrong copy of `USES`.
8. A file **copied** (`copyFileSync`) counted as **spawned**.
9. A flag-shaped **regex literal** (`/--dry-run/`) advertised as a CLI option that does not
   exist — caused by a string-literal regex that paired one literal's closing quote with the
   next one's opening quote.
10. Fixture source inside **template literals** counted as the test file's exports.

### The trap, avoided
Blast-radius tests assert against a **fresh `build()`**, never the committed artifact. A
mutated generator never rewrites the file, so a suite reading `CODE-INDEX.txt` stays green
through any semantic breakage and only the staleness check fires. That trap made this tool's
first suite dead.

### Honest note on the tests
Two of these tests were **dead when first written** — built from prose citing a path, which
never matches an import pattern even with the stripper removed, so they passed against the
broken generator. The mutation run is what exposed it; the fixtures now use commented-out
imports. Six mutants are verified against the real generator: unstripped comments (5 red),
string state carried across lines (2 red), manifest suppression removed (2 red), test files
excluded (3 red), spawn executability dropped (1 red), and a generation date added (2 red).

### Known limits, stated rather than discovered later
- **`SPAWNEDBY` under-reports on purpose.** A literal must reach a spawn call directly or
  through one variable; a path reaching one through a loop variable is missed. A missing edge
  costs one grep, a wrong edge costs the trust that makes the table worth reading.
- Every fact is a heuristic. Spot-check before relying on one.

### Changed
- CI runs `code-index.mjs --check` and asserts no `CLAUDE_PLUGIN_ROOT` survives in any of the
  three installed skills. 61 tests across 3 suites.

## [0.2.0] — 2026-08-08

Adds `quiet-tests`, the highest-payoff change measured by v0.1.0: in the repo it was first
done in, a full test run went from **1,081 lines to 91**.

### Added
- `quiet-tests` skill and `/quiet-tests` command. Detects a project's test-output convention
  (success marker with a **confidence**, summary line, and any CI gates parsing either),
  measures the suite, and proposes a unified diff. Applying is a separate, explicit act.
- `scripts/quiet.mjs` — the artifact copied into a target repo. Patches `console.log` to
  withhold single-line, single-argument pass announcements; prints a one-line tally on exit;
  `VERBOSE=1` / `-v` / `--verbose` restores the previous output byte for byte.
- `scripts/quiet-tests.mjs` — detect, measure, `--propose`, `--apply`, `--json`.
- `scripts/test/run-all.mjs` — every suite, one exit code. Suites run as separate processes
  so one suite's cleanup cannot decide another's result; discovered from the directory rather
  than listed, because a suite missing from a hand-written array looks exactly like one that
  passes.
- `package.json` — `npm test`. No dependencies, and CI now fails if any are added.

### The two invariants, and why they are invariants
- **Nothing about assertions, counts or exit codes changes.** Verified end to end on a real
  repo: 46 lines → 7, exit code 1 → 1, failure line intact.
- **The summary always prints.** In the original repo four CI gates parsed it; suppressing it
  would have left a green pipeline that had stopped checking anything. It is *explicitly*
  exempted (`SUMMARY_RE`, tested against summaries that themselves start with the marker) —
  not merely unlikely to match the filter, which is an accident a later marker change undoes.
- `VERBOSE=1` was diffed against an unpatched run of the same suite: byte for byte identical,
  44 lines.

### The two refusals
- **No summary line found → stop.** Withholding output from a runner whose totals cannot be
  identified is indistinguishable from hiding a failure.
- **Projected saving under 25% → "nothing worth doing here."** Pointed at this repository it
  declines: *3 lines, 3 distinct, 0% saved.* A tool that always finds work is not measuring.
- The bar is on **projected saving**, not byte-identical-repeat share. Pass announcements are
  nearly all distinct — each carries a different test name — so a repeat-share gate would
  decline the exact case with the largest measured payoff. Both numbers are printed.

### Tests
- 21 new tests, 37 total. Four cases must survive the filter: a marker inside a captured
  table, a multi-argument call, a failure line, and the summary.
- Mutation-verified against the **real** implementation, not a copy: a loose
  `String(args).includes(marker)` (6 red), removing the summary exemption (1 red), and an
  inverted verbose gate (4 red).

### Changed
- `check-manifests.mjs` now enforces every skill: version matches `plugin.json`, frontmatter
  name matches its directory, description long enough to be matched on, and the README
  advertises exactly the skills that ship — **both** directions fail, since a skill shipped
  without a README row is a capability nobody is told about, and a row without a skill is a
  plugin that looks broken. Scripts referenced as `${CLAUDE_PLUGIN_ROOT}/…` are extracted from
  the skill and command bodies and checked to exist, so a new skill's scripts are covered
  without anyone remembering to add them.
- `install.sh` installs every directory under `skills/`, discovered rather than listed.
- CI runs on **ubuntu, windows and macos**. Both defects found before v0.1.0 was tagged were
  Windows-only, and a ubuntu-only pipeline was green for all of it. CI also now runs the
  installer on a clean target and asserts no `CLAUDE_PLUGIN_ROOT` survives in any installed
  skill.

### Fixed
- The proposed diff used the platform path separator, so on Windows it emitted
  `--- a/test\suite.mjs` — which `patch` and `git apply` both reject. Forward slashes always.

## [0.1.0] — 2026-08-08

First release. **Measurement only**, deliberately: it is the fully portable piece, and the
one that makes every later claim in this project falsifiable.

### Added
- `token-audit` skill — reads `~/.claude/projects/**/*.jsonl` and reports where a session's
  tokens went: tool breakdown, shell output by kind, re-read cost, repeated test-output
  share, most expensive files, and cost per commit.
- `/token-audit` slash command.
- `scripts/audit.mjs` — streaming analyzer. `--project`, `--file`, `--list`, `--per-commit`,
  `--json`, `--no-paths`. Node 18+, no dependencies, no network, writes nothing.
- `scripts/check-manifests.mjs` — plugin.json, marketplace.json and the skill frontmatter
  must agree. A marketplace entry pointing at a name the plugin no longer has installs
  nothing, silently.
- `install.sh` — non-plugin install path. Runs the suite first and refuses on failure;
  rewrites `${CLAUDE_PLUGIN_ROOT}` in the installed copy, since a bare skill has no plugin root.
- CI on every push: manifests, syntax, tests, installer shell-check.

### Privacy
- Invariant: no tool-result content, and no command or search text, is ever printed. Bodies
  are measured by length and discarded; commands are reduced to one word from a closed
  vocabulary and discarded.
- 16 tests. A canary is planted in every position a transcript can hold one and asserted
  absent from every output mode. The classifier is separately asserted to be incapable of
  emitting any word outside its fixed vocabulary.
- Mutation-verified: a "sample line" feature, a classifier that echoes its input, and an
  ignored `--no-paths` each turn the suite red.
- File paths are the documented exception, opt-out via `--no-paths`, pinned by a test in
  both directions so the trade cannot be quietly changed.

### Windows
Both of these were found by running the shipped suite on Windows before tagging, and both
failed in the shape that is hardest to notice — a zero exit code with a wrong answer.
- The CLI main-guard compared `import.meta.url` against `` `file://${process.argv[1]}` ``,
  which never matches on Windows (`file:///D:/…` vs `file://D:\…`). The CLI loaded as a
  library and printed **nothing**, exiting 0. Now uses `pathToFileURL`. The existing privacy
  and path tests caught it: 7 red before, 15 green after.
- `--project` did not resolve any path containing a dot or a space. Claude Code hyphenates
  **every** character outside `[A-Za-z0-9-]` when encoding a project directory name
  (`~/.claude` → `C--Users-DELL--claude`), not just `/ \ :`. Fixed, and pinned by a test
  whose cases are copied from a real `~/.claude/projects` listing rather than derived from
  the implementation.

### Known limits, stated rather than discovered later
- Tokens are **estimated** at 3.6 bytes each. There is no offline tokenizer; ratios are the
  deliverable, not the absolute figures.
- The live session's transcript lags behind — measure across `--per-commit` boundaries
  rather than against the last line.

