# Changelog

All notable changes to Token Audit. Versions follow [semver](https://semver.org/).

## [0.9.1] — 2026-08-09

**Retraction: the −71.2% hook figure shipped in v0.9.0 was an artifact of run order, not an
effect.** This is the fourth correction this project has made to its own headline, and the
pattern is the point — every one came from making the measurement stricter:

| headline | shipped in | corrected in |
|---|---|---|
| −11% "total agent tokens" (byte-based) | v0.5.0 | v0.6.0 |
| "the description is what fails" (hypothesis) | v0.7.0 | v0.7.1 |
| "the skill never fires (0/30)" | v0.7.0/v0.7.1 | v0.9.0 |
| **−71.2% cost from the hook** | v0.9.0 | **v0.9.1** |

### What went wrong
Every hook A/B ran `off` then `on` **back to back on the same task**, so the treatment arm
always ran second — on a warm prompt cache. The null control (the same task twice with the
hook **off both times**) measured **−79.7%** by itself ($0.2899 → $0.0589; cache writes
24,551 → 390): the second run of *anything* is 70–80% cheaper, because the first pays the
cache write and the second pays cache reads. The artifact was larger than the claimed
effect, and it always landed on the treatment. The tell, ignored at the time: small files —
which the hook passes through untouched — "improved" by 72%. A treatment cannot help cases
it does not touch.

### The corrected numbers — counterbalanced, half the tasks hook-on first
**n=10, one repo, one model, warm cache:**

| group | off | on | delta |
|---|---|---|---|
| big-file (n=6) | $1.4349 | $1.3697 | **−4.6%** |
| symbol (n=2) | $0.1492 | $0.1504 | +0.8% |
| small-file (n=2) | $0.1176 | $0.1412 | +20.1% (noise; absolutes are cents) |
| **total (n=10)** | **$1.7017** | **$1.6612** | **−2.4%** |

An independent first-runs-only comparison (unpaired, zero order effect) agrees: $0.1801 vs
$0.1698 per task, −5.7%. Two methods agree; −2.4% is the number, it is small, and it is what
was measured.

### The claim that is solid — and it is about context, not money
Deterministic — no agent, no cache, no ordering; the hook fed a real event per file and its
output measured against what `Read` would have returned: **87,890 → 5,247 tokens (−94%)**
across six large files, with the two small files passed through at exactly 0% change. The
tokens kept out of the window would mostly have been billed as cache *reads* at $0.50/MTok —
cheap — which is why 94% less context is only ~4% less money on a warm cache. **The hook is
a context-window tool**: it preserves room and recall, and saves a few percent of cost as a
side effect. It is not a cost optimisation, and the docs no longer present it as one.

### Added: "How not to measure this" (README)
The most reusable artefact of this release is the mistake, documented: back-to-back A/B runs
measure prompt-cache warming, not the treatment; always run a null control and size the
order effect before believing any smaller delta; always include cases the treatment cannot
affect, and treat movement there as a failed experiment rather than noise.

### Changed
- `README.md` and `skills/code-map/SKILL.md` — every occurrence of −71.2% removed and
  replaced with the two honest figures (−94% context, deterministic; −2.4% cost,
  counterbalanced n=10), each labelled as what it is. The hook is reframed as a
  context-window tool throughout, including the skill's `description:`.
- `commands/code-map.md` — instructs against quoting the retracted figure.
- The v0.9.0 adoption correction (unprompted invocation on large-file comprehension tasks)
  is unaffected: it counts invocations, not dollars, and run order does not change who
  invoked what.
- Versions to 0.9.1. No script changes; 105 tests across 4 suites unchanged.

## [0.9.0] — 2026-08-09

> **Retraction (v0.9.1):** the −71.2% figure below is an artifact of run order — every pair
> ran `off` then `on` back to back, and the null control (hook off both times) measured
> −79.7% on its own. Counterbalanced, the cost effect is **−2.4% overall, −4.6% on big-file
> tasks** (n=10). The solid claim is **−94% context on large files**, which is about the
> context window, not money — see [0.9.1]. The hook-management tooling, the fail-open fix,
> and the adoption correction in this entry all stand.

Two things, in order of importance: **a correction of v0.7.x's headline claim**, and the
six-task measurement of the hook that replaces it.

### Corrected: "the skill never fires (0/30)" was too broad
v0.7.0 and v0.7.1 concluded `code-map` is never adopted. All 30 of those runs asked *"where
is symbol X"* or *"enumerate every Y"* — tasks Grep answers correctly, in one call, with no
setup. Adoption was tested on the one task type the tool is not for. On **large-file
comprehension** tasks the agent invokes the skill unprompted, via `Skill
{"skill":"code-map"}` — **5 invocations across the six-task set**. The corrected statement,
now in the README and the skill:

> `code-map` is not adopted for symbol lookup, correctly, because Grep answers that better.
> It **is** adopted when the alternative is reading a whole large file.

The 0/30 data stands; its interpretation narrows to symbol lookup. Scope: one repo, 36 runs
total across both trials.

### Measured: the hook, six paired large-file tasks, hook off vs on
Same clone, same model — **n=6, one repo**:

| task | off | on | delta |
|---|---|---|---|
| H1 | $0.7415 | $0.1366 | −81.6% |
| H2 | $0.3500 | $0.1082 | −69.1% |
| H3 | $0.5272 | $0.1770 | −66.4% |
| H4 | $0.4982 | $0.1543 | −69.0% |
| H5 | $0.5082 | $0.1103 | −78.3% |
| H6 | $0.3626 | $0.1748 | −51.8% |
| **total** | **$2.9877** | **$0.8612** | **−71.2%** |

Every task negative; cache writes fell 10–20× on every one. **H3 is contaminated** — one arm
invoked the skill twice, the other zero — so the total is reported both ways: with H3
−71.2%, without it $2.4605 → $0.6842 = **−72.2%**. The headline does not depend on the
contaminated pair.

**The mechanism is price, not volume.** Billed token counts stayed flat (+0.4% on the paired
single-task run) while cost fell ~71%: a large file entering context is a cache **write** at
$6.25/MTok, and the outline plus cheap cache **reads** at $0.50/MTok replaces it — 12.5×.
The hook does not help symbol lookup and is not claimed to.

### Added: `code-map.mjs hook install|uninstall|status`
Nobody hand-edits JSON anymore:
- `hook install [--root <repo>] [--min-lines N]` merges the `PreToolUse` block into
  `<root>/.claude/settings.json` — non-destructively (existing hooks, permissions and
  settings survive) and idempotently (installing twice yields one entry; the newest
  threshold wins). An unparseable settings file is **refused, never overwritten**.
- `hook uninstall` removes exactly our entry; everything else is left alone.
- `hook status` reports installed/threshold/kill-switch, with the same precedence the hook
  itself uses (env over installed flag over default 300).
- The hook itself now takes the `--min-lines` flag that install writes, and a fail-open gap
  was closed: a garbage `CODE_MAP_HOOK_MIN_LINES` used to become `NaN`, which silently
  disabled the small-file allow and would have denied small files. It now degrades to the
  default, and a test pins that.

### Tests
7 new (105 total across 4 suites, was 98): idempotent install; merge preserves unrelated
hooks and settings; uninstall removes only ours; status correctness; refusal to clobber a
corrupt settings.json; garbage-threshold fail-open; argv/env threshold precedence.
Mutation-verified, three mutants: install without dedup (1 red), install that ignores the
existing file (3 red), uninstall that deletes all hooks (1 red).

### Changed
- `skills/code-map/SKILL.md` rewritten around the three mechanisms in order of measured
  value: hook (−71.2%, n=6), `/code-map` command, manual `find`/`outline`/`brief`. The
  "never fires" framing is replaced by the corrected adoption finding; every limitation
  kept.
- `README.md` — the Code Map section now leads with the hook and the six-task table, then
  the corrected adoption finding, then the manual tools. Install is one command; the
  hand-written JSON block is gone.
- Versions to 0.9.0.

## [0.8.0] — 2026-08-09

> **Retraction (v0.9.1):** the −54.6% single-task figure below has the same run-order
> artifact as v0.9.0's table — the hook-on run always came second, on a warm cache. See
> [0.9.1] for the corrected numbers and the null control. The hook itself, its fail-open
> contract, and its tests all stand.

**The skill did not work. The hook does. And the reason is the price of tokens, not the
count of them.** `code-map` as an auto-firing skill measured 0 invocations in 30 advertised
runs (v0.7.0/v0.7.1); this release ships the delivery mechanism that does not need to be
chosen — a `PreToolUse` hook that fires on the `Read` call the model was already making.

### Added: `scripts/code-map-hook.mjs`
When the model asks for an entire large file — over `CODE_MAP_HOOK_MIN_LINES` lines (default
300), no `offset`/`limit` — the hook denies that one call and returns the file's outline:
every symbol with its line number, plus instructions to come back with a slice, or with an
explicit full-file range if the whole thing is genuinely needed.

Measured on one large-file task, same clone, same model — **n=1, one task; a six-task paired
A/B is running and its totals will be published when they exist, not extrapolated now**:

| | hook off | hook on | |
|---|---|---|---|
| cost | $0.4082 | **$0.1855** | **−54.6%** |
| cache write | 29,281 | 5,655 | **−80.7%** |
| billed tokens | 190,061 | 190,759 | +0.4% |
| turns | 5 | 5 | unchanged |

**The mechanism is cheaper tokens, not fewer tokens.** A large file entering context is a
cache *write* at $6.25/MTok; the conversation re-sent on the extra turn is a cache *read* at
$0.50/MTok — a 12.5× price difference on the bytes that matter (published rates, not
measured). Token counts barely move, which is exactly why every count-based measurement in
this project looked flat — including this project's own byte accounting until v0.6.0.

**Fail open, always.** The hook never blocks a read it did not positively understand. Allowed
by design and each pinned by its own test: explicit slices, small files, unsupported
languages, unreadable files, files with fewer than 3 symbols, malformed stdin, the
`CODE_MAP_HOOK=off` kill switch, and any thrown error. Install block, kill switch and
threshold are documented in the README.

### Tests
8 new hook tests in `scripts/test/code-map.test.mjs` (98 total across 4 suites, was 90): the
deny case carries the outline and the escape hatch; every allow path above is asserted
individually. Mutation-verified, three mutants: deny small files (1 red), deny explicit
slices (1 red), deny on parse failure instead of allowing (1 red).

### Changed: the skill is demoted to match measurement
- `skills/code-map/SKILL.md` no longer presents itself as something that fires on its own —
  it does not (0/30, two descriptions). Rewritten around the two delivery mechanisms that do
  not depend on being chosen: the hook (automatic) and `/code-map` (explicit). The bench
  figures stay, labelled *available per question*; the hook's n=1 result is the first
  **realised** saving this project has measured.
- `README.md` — hook install instructions with the exact `.claude/settings.json` block, the
  kill switch, the threshold, and the fail-open contract.
- `commands/code-map.md` — offers the hook when a user wants the saving to be automatic.
- Versions to 0.8.0.

## [0.7.1] — 2026-08-09

**The open question from v0.7.0 is answered: no.** One release ago this project shipped the
hypothesis that `code-map`'s `description:` frontmatter was what kept it from firing, and
labelled it untested. It has now been tested and **refuted**. This entry corrects a
hypothesis shipped one release earlier — recorded plainly, because correcting itself in
public is this project's method, not an embarrassment to smooth over.

### The follow-up trial
Same clone, same frozen tasks, same model and effort; **only the skill's `description:`
frontmatter changed**. v1 (651 chars) buried the trigger behind mechanism and ended with
*"fall back to Grep on a miss"* — which reads as standing permission to use Grep. v2
(444 chars) leads with the trigger and instructs the preference outright: *"Run this BEFORE
reaching for Grep … Prefer it over Grep for locating a name."* Both descriptions are
preserved in the trial's frozen artefacts (`skill-description-v1.md`, `-v2.md`; trial commit
`e2ccc7c`).

| description | runs | advertised | **invocations** | answers correct |
|---|---|---|---|---|
| v1 | 24 | 24/24 | **0** | 12/12 on L |
| v2 — "prefer over Grep" | 6 | 6/6 | **0** | 6/6 |
| combined | **30** | 30/30 | **0** | — |

Every v2 run was verified to carry the new description in its skills listing; all six used
Grep and Read, and all six answered correctly.

### The stronger conclusion
> An installed, advertised, plainly-described skill still loses to `Grep` on the exact task
> it was built for — because `Grep` already answers that task correctly, in one call, with no
> setup. `code-map` is not competing against an absence; it is competing against a good tool
> that is already there. That is not a description problem, and no wording fixes it.

A value-proposition finding, not a wording one. Scope: n=6 for v2, one description variant,
one repo. It does not prove that no description could ever work; it proves the obvious one
does not, and shifts the burden of proof onto anyone claiming the next rewrite will.

### What remains defensible
The trial only tested `find` against symbol lookup — the task Grep already serves. The two
claims it did not touch are the ones Grep cannot serve: `outline` on a large file, and
`brief` for orienting in an unfamiliar repository. Untested and plausible, and named as the
subject of any next trial — not presented as validated. The `bench` figures stay: they remain
correct arithmetic about an available saving.

### Changed
- `skills/code-map/SKILL.md` — the "Open question — untested" section is replaced by the
  answer; the headline limitation now counts **30 advertised runs across two descriptions,
  zero invocations**.
- `README.md` — the "Does an agent actually use it? Measured: no." section gains the
  follow-up table and conclusion, in place — not moved lower, not softened.
- Versions to 0.7.1. No script changes; 90 tests across 4 suites unchanged.

## [0.7.0] — 2026-08-09

A null result, and it is the headline because it is one: **in a controlled 24-task trial,
`code-map` — installed as a real project skill, advertised in the skills listing of every
single run, its map prebuilt — was invoked zero times.** The agent reached for Grep every
time, and Grep scored 12/12 on the location block the skill exists to serve. This release
ships no code; it ships the result, in the README and in the skill's own file.

### The trial
24 tasks × 2 arms on a 99k-line production codebase (638 files, 99,048 lines under `src/`;
baseline verified green before the trial — `tsc --noEmit` clean, 912 tests passing). Prompts
**byte-identical**; the only difference between the arms was what was installed on disk.
Answer key, scoring formulas and predictions were git-committed (freeze commit `cab1b96`)
**before** either arm ran; the full artefact set — frozen key, per-task prompts, outputs,
diffs — is at trial commit `f2516b2`. Neither arm was coached, which is the difference from
the v0.5.0/v0.6.0 A/B, whose treatment arm was told what to run.

| block | max | arm-a | arm-b |
|---|---|---|---|
| L — location (12 items, tool-blind sample) | 12 | 12 | 12 |
| P — pattern, complete hit sets | 10 | 10.0 | 10.0 |
| S — structural | 12 | 11.0 | 10.0 |
| R — refactor | 10 | 10 | 10 |
| E — edit, graded by the repo's own gate | 10 | 10 | 10 |
| **total** | 54 | **53.0** | **52.0** |

| | arm-a | arm-b | |
|---|---|---|---|
| cost | $10.0280 | $9.9020 | −1.3% |
| billed tokens | 5,602,597 | 5,556,003 | −0.8% |
| code-map advertised in the skills listing | 0/24 | **24/24** | |
| **code-map invocations** | 0 | **0** | |

With the skill never invoked, the cost and token deltas are run-to-run noise between two arms
that behaved identically — reported because pre-registration requires it, not because they
mean anything.

### Predictions: two were wrong, quoted verbatim
This project's credibility rests on reporting its own failures, so here they are.

> **P2 — Where it helps.** `code-map` will help the **L** block and will **not** help the
> **P** block.

**Wrong on the first half, right on the second.** It helped L not at all — because it was
never used. L came out 12/12 to 12/12 on grep alone.

> **P4 — Adoption.** I predict it will invoke `code-map` on the **L** block and largely
> ignore it on **P** and **E**. If B never invokes it at all, that is a product finding about
> the skill's description, not a failed experiment.

**Wrong in the specific, right in the escape clause.** It never invoked it, anywhere, once.

(P1 — cost within ±15% — held, at −1.3%, though attributable to noise rather than the tool.
P3 — the under-exploration risk — did not trigger: both arms were complete and identical on
the P and R blocks.)

### What is claimed, and what is not
- **Claimed:** the saving `bench` measures is **available and not taken.** With its current
  description, installed-and-advertised does not make the skill fire; its value is contingent
  on being invoked explicitly.
- **Not claimed:** that the mechanism is disproved. It was never invoked, so it was never
  tested. The bench arithmetic (−76% to −85% per location question) is unaffected by this
  trial.
- **Scope:** one repo, 24 tasks, n=1 per item. This is not evidence about any other repo.

### Changed
- `README.md` — new section under Code Map, **"Does an agent actually use it? Measured:
  no."**, placed above the bench figures rather than under them; the v0.6.0 A/B section now
  defers to it on the adoption question.
- `skills/code-map/SKILL.md` — the measured limitation stated before anything else; the bench
  figures now read unambiguously as *available per question*, realised only on explicit
  invocation; and a new **"Open question — untested"** section records the hypothesis that
  the `description:` frontmatter is what fails, not the mechanism — and that testing it
  requires re-running the trial with a changed description. The description itself is
  deliberately **not** rewritten: that would be shipping an untested adoption fix on the back
  of a trial that just demonstrated the cost of untested claims.
- Versions to 0.7.0 everywhere `check-manifests.mjs` requires. No script changes; the test
  suite and privacy invariant are untouched (90 tests, 4 suites).

## [0.6.0] — 2026-08-09

This release corrects this project's own headline claim — for the second time — and ships the
accounting that makes a third correction unlikely. The short version: **the A/B result for
`code-map` is not −11%. It is +47% billed tokens at cost parity.** The tool did not save
anything measurable in that trial.

### Added: billed tokens and estimated cost, from the transcript's own `usage` records
`audit.mjs` previously measured **tool-result bytes only**. On the A/B control transcript that
was 15,601 tokens against 375,061 actually billed — about **4% of the bill** — yet every cost
claim this project shipped rested on it. Claude Code writes a full `usage` object
(input / output / cache-read / cache-creation) on every assistant turn; the report now reads it.

- New `BILLED TOKENS` section, **above** the byte figures, because it is the honest headline:
  input, output, cache read, cache write, billed total, API-call count, and an estimated
  dollar cost.
- Rates are declared constants (`RATES`) commented as **published-rate assumptions, not
  measurements** — $5 in / $25 out / $0.50 cache-read / $6.25 cache-write per MTok — and
  overridable per run via `--rate-in`, `--rate-out`, `--rate-cache-read`, `--rate-cache-write`.
- The old byte figure is kept — it is still the right number for "which tool was expensive" —
  but is now labelled a **lower bound covering tool output only**, and its section is renamed
  `WHERE THE TOOL OUTPUT WENT`.
- Transcripts that predate `usage` accounting say **"no usage accounting found"** rather than
  printing $0.00; `--json` carries `estimatedCostUSD: null` for them.
- Privacy unchanged and extended: only the four numeric `usage` fields are read, each coerced
  to a number. The test suite plants a canary inside `usage` itself and in the message id and
  asserts neither can surface.

### Fixed: summing `usage` per record double-counts every API call ~2.8×
Found while implementing the feature, by summing the two A/B transcripts and checking the
result against raw records: Claude Code writes one transcript record **per content block**,
all sharing one `message.id`, each carrying a mid-stream `usage` snapshot (input and cache
fields repeat unchanged; `output_tokens` climbs toward its final value). The control
transcript holds 23 usage records for **8 API calls**. Summing records triple-counted most of
the bill. The conclusion rests on that record-to-id ratio; in the control transcript the cache
arithmetic corroborates it (each call's `cache_read` equals the running sum of prior calls'
cache writes — 0 → 28,797 → 34,406 → 35,272), though not in the B transcript, which inherited
a warm cache prefix from its parent session.

`analyze()` therefore deduplicates by `message.id`, keeping each field's maximum (the final
snapshot), and reports both counts: distinct API calls and raw usage records.

### Corrected: the `code-map` A/B, now three claims deep
Each correction came from making the measurement stricter, and each made the result worse:

| claim | source | status |
|---|---|---|
| **−11%** "total agent tokens" | tool-output bytes (~4% of the bill) | shipped in v0.5.0 — **wrong** |
| **−8%** cost | per-record `usage` sum | wrong — double-counted ~2.8× |
| **+47% billed tokens, +0.6% cost** | `usage` deduped by `message.id` | current, verified twice |

The corrected table (n=1, one task, one repo, Arm B *told* to use the map — a ceiling, not
adoption):

| | A (control) | B (code-map) | |
|---|---|---|---|
| billed tokens | 375,061 | 551,067 | **+47%** |
| cost @ Opus rates | $0.7252 | $0.7296 | **+0.6% — parity** |

README, `skills/token-audit/SKILL.md` and `skills/code-map/SKILL.md` updated to match: the
skill now leads with billed tokens, names the byte figure a lower bound, and the `code-map`
bench figures (−76% to −85%) are explicitly a saving *available* per question, not one
measured as *realised* by an agent. A note under [0.5.0] below points here; the historical
entry itself is left as written, because it was accurate to what was known and rewriting it
would hide the error.

### Tests
90 across 4 suites (was 85). New: multi-transcript `usage` summation against a hand-computed
fixture (including the dedup-keeps-final-snapshot case), per-rate cost pins plus a mixed
hand-computed dollar total, a CLI test that the billed headline comes from `usage` and not
from bytes (including `--rate-*` override), absence-reported-not-$0.00, and the
canary-inside-`usage` test. Mutation-verified: summing only `input_tokens` (3 red), dropping
the cache-read term from the cost (2 red), printing the byte total as the billed headline
(1 red).

## [0.5.0] — 2026-08-08

> **Correction (v0.6.0):** the A/B table below is superseded. Its "total agent tokens −11%"
> row was computed from tool-output bytes, which are ~4% of what the session actually billed.
> Recomputed from the API's own `usage` records, deduplicated by `message.id`, the result is
> **+47% billed tokens at cost parity** — see [0.6.0]. The byte-level rows (tool output,
> reads, tool calls) remain accurate as byte measurements. The entry is otherwise left as
> written: it was accurate to what was known at the time.

The first **end-to-end** evidence in this project, and a defect the experiment found in the
tool that has been measuring everything else.

### The A/B: does `code-map` actually change what a session costs?
Two subagents, same model, same repository, the same five orientation questions requiring
locations across four files. Arm A used normal tools; Arm B was told the map existed and to
use the `offset`/`limit` that `find` prints. **Both got all five answers right**, verified
against source.

| | A (control) | B (code-map) | |
|---|---|---|---|
| all tool output | 15,601 tok | 9,393 tok | **−40%** |
| read tokens | 10,462 | 5,863 | **−44%** |
| whole-file reads | 2 | **0** | eliminated |
| tool calls | 14 | 24 | **+71%** |
| total agent tokens | 64,538 | 57,584 | **−11%** |

**The honest headline is −11%, not −40%.** Tool output fell 40%; the extra round trips ate
most of it back. n=1, one task, one repo, and Arm B was *told* to use the map — so this
measures the ceiling when the skill fires, not whether it fires on its own.

### Fixed: token-audit could not see subagent work at all
Claude Code writes a subagent's turns to `<project>/<session>/subagents/agent-*.jsonl`, not
into the parent transcript. `listTranscripts` globbed only `<project>/*.jsonl` and missed all
of it. Measured on the session that ran the A/B: the two agents consumed ~25,000 tokens of
tool output while the parent transcript attributed **3,432** to the Agent tool — just the
summaries they handed back. Re-measured with the fix, this session went **43,139 → 68,133
tokens: it had been under-reporting by 58%.**

Under-reporting the expensive case is the worst failure available to a measurement tool: it
does not lose precision, it points you at the part that was already cheap. Anyone whose
workflow leans on agents has been getting a materially wrong picture.

- `listTranscripts` now finds subagent transcripts and tags them `isSubagent`/`subagentOf`.
- `analyze` accepts several transcripts and measures them as one cost.
- Subagents are **included by default**; `--no-subagents` opts out. Per-commit segmentation
  still follows the main session's commits, and the report says when subagents are folded in.
- Mutation-verified: reverting to a shallow scan, and ignoring all but the first path, each
  turn the new test red.

### Changed: `code-map` indexes function-local bindings
The A/B exposed the recall gap directly — two of the five questions were about function-local
consts, `find` missed both, and each miss cost a fallback round trip, which is exactly what
ate the token saving. `const`/`let` bindings of 4+ characters are now indexed as kind `local`
and ranked **below** every real declaration, so a local can never outrank an export of the
same name. Index grew 183 → 401 symbols on this repo; nothing is injected into context, so
the cost is disk, not tokens. Both rules mutation-verified.

### Tests
85 across 4 suites (was 83).

## [0.4.0] — 2026-08-08

Adds `code-map`. **The premise it was commissioned on turned out to be wrong, and the
measurement is why.**

### The measurement came first, and it refuted the plan
The brief was "stop wasting tokens rediscovering where things are — grep output is draining
the budget." Measured across **589 real sessions, 1.27 GB of transcript, ~8.3M tokens shown to
a model**:

| | tokens | share of everything shown |
|---|---|---|
| file reads | 4,082,513 | **49%** |
| — of which whole-file (72% of all reads) | 2,860,089 | 34% |
| **re-read in a later session** | **1,532,261** | **18%** |
| re-read within one session | 1,014,644 | 12% |
| search (grep/glob) | 616,119 | 7% |
| **repeated searches** | 36,715 | **0.4%** |

Search rediscovery is a rounding error. Re-reading files is 30%. So `code-map` is not a search
index and does not replace grep — Anthropic tested embedding retrieval for Claude Code against
plain agentic search and kept agentic search. It attacks the read side.

### Added
- `code-map` skill and `/code-map`. `build`, `find`, `outline`, `brief`, `bench`.
- `scripts/code-map.mjs` — a per-repo symbol cache. `find` prints the next command
  (`→ Read file offset=N limit=M`), because the saving is the slice, not the lookup.
  22 languages by regex; deliberately not a parser.
- `scripts/code-map-learn.mjs` — `tax` (what re-reading costs, on your own transcripts) and
  `hot` (files a project re-reads every session).
- `bench` — deterministic, no model, arithmetic over real files. Across three real repos
  (16,979 / 849 / 451 files) the median location question costs 2,504–3,710 tok as a
  whole-file read, 563–606 as a slice (**−76% to −85%**), 135–182 as an outline (**−95%**).
  It also reports that the map is **worse for 5–26% of files** — a benchmark that cannot
  report a loss is marketing.

### The invariant
> **The index is a cache. The file is always the source of truth.**

Size and mtime are checked before any location is returned; a changed file is re-scanned
in-process and the answer comes from the fresh scan. **A stale cache produces a miss, never a
wrong location** — hence no `--check` mode and no staleness to manage. Four tests mutate a file
*after* indexing it, which is the only way to distinguish a verified answer from a lucky one.

### A feature cut by its own measurement
Learning *what was searched for*, with a privacy gate (record a term only if it already exists
as a symbol in your code, so a pasted credential cannot survive). Designed, then cut: repeated
searches cost 0.4%, and it would have added a transcript-reading surface and a privacy control
to maintain to chase four tenths of one percent.

### Performance, because a slow tool is an unused tool
The first build of a 16,000-file repo took **314s**. The char-by-char comment stripper was the
cost; replaced with per-line string-blanking plus `indexOf`, and minified/bundled files are now
skipped by shape. **46s cold, ~6s warm** — incremental reuse keys on the same (mtime, size)
pair the query path uses, so there is one staleness rule in the system, not two.

### Tests
22 new, **83 total across 4 suites**. Mutation-verified against the real implementation:
trusting the cache (2 red), reporting deleted files (1 red), removing the stripper (3 red),
dropping the reserved-word filter (1 red), unsorted output (1 red).

**Two of these tests were dead when written** — again. The comment fixtures used
`// export function ghost()`, which never matches `^\s*export` even with the stripper removed.
Only the mutation run caught it; the fixtures now use block comments whose inner lines match
raw. Fixing them immediately exposed a real defect: **declarations inside Python docstrings
were being indexed as symbols**, since Python has no block comment. Triple-quote handling
added.

### Privacy
`code-map.mjs` never opens a transcript, and a test asserts it cannot name the transcript
directory at all — a file boundary standing in for a security boundary. `tax` prints no paths
and no search text; a credential-shaped canary is planted in a search pattern and asserted
absent. `hot` prints file paths, the same documented exception `token-audit` makes.

### Known limits
- Regex-based: it misses things. A miss is a miss, never a wrong answer.
- Skips files over 1 MB and minified bundles; `find` matches definitions, not usages.
- Image reads cost real vision tokens this cannot see. It measures text and says so.
- `.claude/code-map/` is gitignored — derived, per-machine, never committed.

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

