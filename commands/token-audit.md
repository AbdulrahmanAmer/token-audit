---
description: Measure where this session's tokens actually went — re-read cost, repeated test output, cost per commit.
---

Run the token audit and report what it says.

1. Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/audit.mjs --project $(pwd)`. If that finds no
   transcript for this project, fall back to `node ${CLAUDE_PLUGIN_ROOT}/scripts/audit.mjs`
   (most recently active session) and say which session you measured.
2. If the user asked for a before/after comparison, add `--per-commit`.
3. Report the aggregates. Lead with `BILLED TOKENS` — those are counted by the API, and the
   dollar line is an estimate at the named rates. If the report says no usage accounting was
   found, say the cost is unknown; do not substitute the byte total. For the byte-derived
   sections below it, name the ratio rather than the absolute figures — they are estimated
   at 3.6 bytes per token and cover tool output only.
4. Propose at most two changes, each tied to a number in the report. If nothing in the
   report is above the thresholds the skill names, say the session looks efficient rather
   than inventing an optimisation.

Do not read the transcript yourself to add detail. The tool withholds transcript content on
purpose; reading it by hand defeats that.

Arguments (optional, passed through): $ARGUMENTS
