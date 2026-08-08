---
name: quiet-tests
description: Measures how much of a project's test output is per-test PASS announcements, and proposes a patch that withholds only those while leaving failures, the summary line, and exit codes untouched. Use when a test or build run is flooding the context, when the user asks to reduce test output or make tests quieter, when a suite prints a line per passing test, or when token-audit reports that test/build output is a large share of a session. Detects the project's own success marker and summary line first, refuses if it cannot find the summary, and says there is nothing worth doing when the projected saving is under 25%. Advises and patches; never drops in blind.
license: MIT
metadata:
  version: "0.4.0"
  author: token-audit contributors
---

# Quiet Tests — withhold the roll-call, keep everything that matters

A suite that prints a line per passing test spends most of its output telling you about the
things that went right. In the repository this was first built for, a full test run was
**1,081 lines; after this change it was 91.** That is the largest single measured saving in
this project.

It is also the most convention-bound, which is why this **advises and patches — it does not
drop in.** A repo's test output has a success marker, a summary line, and, in the case that
motivated this, **four CI gates parsing that summary**. Quieting output without knowing what
greps it is how you ship a pipeline that is still green because it stopped checking.

## The two invariants — repeat them to the user before applying

**1. Nothing about assertions, counts or exit codes changes.** `console.log` is replaced; the
runner is not touched. Only lines *announcing a pass* are withheld. A red run still says so,
in full, in both modes.

**2. The `N passed, M failed` summary always prints.** It is explicitly exempted in the code,
not merely unlikely to match the filter — those are different things, and the first is an
accident that a later marker change undoes.

`VERBOSE=1`, `-v` or `--verbose` restores the previous output byte for byte.

## How to run it

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/quiet-tests.mjs --dir <repo>     # detect, measure, verdict
node ${CLAUDE_PLUGIN_ROOT}/scripts/quiet-tests.mjs --dir <repo> --propose
node ${CLAUDE_PLUGIN_ROOT}/scripts/quiet-tests.mjs --dir <repo> --apply
```

It runs the suite to measure it, so expect it to take as long as the tests do. `--cmd`
overrides the detected test command.

## What to do with the output

**Report the detection and its confidence before proposing anything.** "89% of lines begin
with `✓`" and "3% do" call for different amounts of human attention. If gates were found,
name them — the user is being asked to change what those lines look like.

**Two refusals, and they are the point. Do not talk the user past either:**

- **No summary line found → stop.** Withholding output from a runner whose totals you cannot
  identify is indistinguishable from hiding a failure. Say so and stop. Do not guess at the
  totals from the exit code.
- **Projected saving under 25% → say there is nothing worth doing here.** A tool that always
  finds work is not measuring. Tell the user their output is already dense and point them at
  `token-audit` to find where the tokens are actually going.

**Never apply without being asked.** `--propose` prints a unified diff and changes nothing.
After `--apply`, the script re-runs the suite and reports before/after line counts, whether
the exit code changed, and whether the summary survived. **If either the exit code changed or
the summary is gone, tell the user to revert** — the script exits non-zero for exactly that.

## A note on how the 25% bar is computed

The bar is on the **projected saving**, not on the byte-identical-repeat share. Pass
announcements are almost all *distinct*, because each carries a different test name, so a
repeat-share gate would decline the exact case with the largest measured payoff. Both numbers
are printed so the claim can be checked rather than believed.

## What this does not do

It does not touch the runner, reorder tests, suppress warnings, change reporters, or
summarise failures. It withholds single-line, single-argument pass announcements and counts
them. Anything else that shrinks test output is a different change and should be argued for
on its own.
