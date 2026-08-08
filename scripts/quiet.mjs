#!/usr/bin/env node
// quiet.mjs — withhold PASS announcements from a test run, and nothing else.
//
// This is the artifact that gets copied INTO a target repository. It is deliberately small
// enough to read in one sitting, because a stranger is being asked to let it wrap the one
// output they trust to tell them whether their code works.
//
//   import { install } from './quiet.mjs';
//   install();                       // or install({ marker: '✔' })
//
//   npm test              -> failures, the summary, and a one-line tally
//   VERBOSE=1 npm test    -> byte-for-byte what you had before
//
// ── The two invariants ────────────────────────────────────────────────────────────────
//
// 1. IT CHANGES NOTHING ABOUT ASSERTIONS, COUNTS OR EXIT CODES. It replaces console.log
//    and does not touch the runner. Only lines ANNOUNCING A PASS are withheld. A red run
//    still says so, in full, in both modes.
//
// 2. THE SUMMARY ALWAYS PRINTS. In the repo this was first written for, four CI gates
//    parsed the `N passed, M failed` line. Suppressing it would have silently disabled
//    them — a green pipeline that had stopped checking anything. So the summary is not
//    merely "unlikely to match the filter", it is explicitly exempted below, and a test
//    pins that exemption. Those are different things: the first is an accident that a
//    later marker change undoes, the second is a decision.
//
// The filter is a pure function (`shouldWithhold`) so it can be mutation-tested directly
// rather than through a subprocess. Everything subtle about this file is in those 12 lines.

/** The per-test success marker. Overridable because it is a house convention, not a law. */
export const DEFAULT_MARKER = '✓'; // ✓

/**
 * A line carrying TOTALS is never withheld, whatever it starts with.
 *
 * This exists for runners whose summary itself begins with the success marker — "✓ All 15
 * tests passed" is a real shape — and, more importantly, so that "the summary survives" is
 * an assertion in the code rather than a lucky consequence of the marker test. It is
 * checked BEFORE the marker test for that reason.
 */
export const SUMMARY_RE = /\b\d+\s*(?:\/\s*\d+\s*)?(passed|passing|failed|failing|pass|fail|ok|not ok|skipped|pending|tests?|assertions?|suites?)\b/i;

/**
 * Should this console.log call be withheld?
 *
 * Four things must all hold, and each one is a defect someone has actually shipped:
 *
 *  - EXACTLY ONE ARGUMENT. `console.log('✓', name, ms)` is a formatted report, not an
 *    announcement, and the parts after the first are the information. A filter written as
 *    `String(args).includes(marker)` eats it.
 *  - THAT ARGUMENT IS A STRING. Objects stringify to "[object Object]" and to substrings of
 *    their contents; neither should be able to reach the marker test.
 *  - IT IS A SINGLE LINE. A multi-line blob is captured output being replayed — a rendered
 *    table, a diff, a fixture — and it belongs to the test, not to the harness.
 *  - THE MARKER IS THE FIRST NON-WHITESPACE CHARACTER. `startsWith`, never `includes`: a
 *    table row `| ✓ | migrate | 42ms |` contains the marker and must survive, because a
 *    test that captured and printed it did so on purpose.
 */
export function shouldWithhold(args, marker = DEFAULT_MARKER, summaryRe = SUMMARY_RE) {
  if (!Array.isArray(args) || args.length !== 1) return false;
  const only = args[0];
  if (typeof only !== 'string') return false;
  if (only.includes('\n')) return false;
  if (summaryRe.test(only)) return false;
  return only.trimStart().startsWith(marker);
}

/**
 * Verbose restores the old behaviour exactly.
 *
 * `VERBOSE=0` and `VERBOSE=` are NOT verbose — a CI system that exports the variable set to
 * zero is asking for quiet, and reading any-value-is-true there turns the feature off for a
 * whole fleet without anyone noticing.
 */
export function isVerbose(env = process.env, argv = process.argv) {
  const v = env.VERBOSE;
  if (v != null && v !== '' && v !== '0' && v.toLowerCase() !== 'false') return true;
  return argv.includes('-v') || argv.includes('--verbose');
}

/**
 * Patch console.log for the life of the process.
 *
 * Returns a handle so a test can drive this without a subprocess. `restore()` is idempotent
 * and puts back the exact function that was there, not a fresh binding — patching twice and
 * restoring twice must not leave a wrapper behind.
 */
export function install({
  marker = DEFAULT_MARKER,
  env = process.env,
  argv = process.argv,
  console: target = console,
  tally = true,
  onExit = true,
} = {}) {
  let withheld = 0;
  const original = target.log;
  const verbose = isVerbose(env, argv);

  const handle = {
    verbose,
    get withheld() { return withheld; },
    restore() { if (target.log !== original) target.log = original; },
    /** The tally line. Returned rather than printed so a test can assert on it. */
    summary: () => (withheld ? `  (${withheld} passing ${withheld === 1 ? 'line' : 'lines'} withheld — VERBOSE=1 to show)` : ''),
  };

  if (verbose) return handle;

  target.log = (...args) => {
    if (shouldWithhold(args, marker)) { withheld++; return; }
    return original.apply(target, args);
  };

  if (onExit && tally && typeof process?.on === 'function') {
    // Printed through the ORIGINAL log: routing the tally through the patched one would
    // make a marker change able to swallow the notice that anything was swallowed.
    process.on('exit', () => { const s = handle.summary(); if (s) original.call(target, s); });
  }

  return handle;
}

export default install;
