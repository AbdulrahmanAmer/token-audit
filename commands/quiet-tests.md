---
description: Measure how much of this project's test output is pass announcements, and propose a patch that withholds only those.
---

Measure this project's test output and report whether quieting it is worth doing.

1. Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/quiet-tests.mjs --dir $(pwd)`. It runs the suite,
   so it takes as long as the tests do. If no test command is detected, ask the user for one
   and pass it with `--cmd`.
2. Report what it detected — the success marker **with its confidence**, the summary line,
   and any CI gates found parsing either. If gates were found, name them: the user is being
   asked to change what those lines look like.
3. If it stopped because no summary line was found, say so and stop. Do not guess the totals
   from the exit code — withholding output from a runner whose totals cannot be identified is
   indistinguishable from hiding a failure.
4. If the projected saving is under 25%, report that there is nothing worth doing here and
   suggest `/token-audit` instead. Do not look for a smaller win to justify the run.
5. Otherwise show the proposed diff and the two invariants — exit codes and assertions are
   untouched, and the summary always prints — then **ask before applying**.
6. After `--apply`, report the before/after line count, the exit code both times, and whether
   the summary survived. If the exit code changed or the summary is gone, tell the user to
   revert.
