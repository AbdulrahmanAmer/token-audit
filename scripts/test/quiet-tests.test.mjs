#!/usr/bin/env node
// quiet-tests.test.mjs — tests for the quiet-tests skill.
//
// The mechanism here is twelve lines long, which is exactly why it needs this many tests:
// every plausible SIMPLER version of those twelve lines is wrong in a way that silently
// deletes information a developer needed. So the suite is built around the wrong versions.
//
// Three of them are written out as executable mutants at the bottom of this file and
// asserted to FAIL the same checks the real filter passes. A test that only ever sees the
// correct implementation cannot tell you it would have caught the incorrect one.
import { shouldWithhold, isVerbose, install, DEFAULT_MARKER, SUMMARY_RE } from '../quiet.mjs';
import { detectMarker, detectSummary, measure, findEmitters, proposePatch, WORTH_DOING, detectCommand } from '../quiet-tests.mjs';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let ok = 0, fail = 0;
const it = (name, fn) => {
  try { fn(); ok++; if (process.env.VERBOSE) console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'expected truthy'); };
const SB = mkdtempSync(join(tmpdir(), 'quiet-tests-'));

// ── The filter: what must be withheld ─────────────────────────────────────────────────

it('withholds a plain pass announcement, indented or not', () => {
  assert(shouldWithhold(['✓ parses a torn line']), 'a bare pass line should be withheld');
  assert(shouldWithhold(['  ✓ parses a torn line']), 'indentation is normal; it should still be withheld');
  assert(shouldWithhold(['\t✓ tabbed']), 'a tab is whitespace too');
});

// ── The filter: what must SURVIVE. Each of these is a real defect, not a hypothetical ──

it('a marker inside a rendered table survives', () => {
  // A test that captured a table and printed it did so ON PURPOSE — the table IS the
  // assertion's evidence. A filter written with `includes` eats this and the developer
  // loses the only view of what the code produced.
  assert(!shouldWithhold(['| ✓ | migrate | 42ms |']), 'a table row containing the marker was withheld');
  assert(!shouldWithhold(['status: ✓']), 'a line merely ending in the marker was withheld');
  assert(!shouldWithhold(['┌─────┐\n│  ✓  │\n└─────┘']), 'a captured multi-line block was withheld');
});

it('a multi-argument log call survives', () => {
  // `console.log('✓', name, ms)` is a formatted report; the parts after the first ARE the
  // information. Only a single-string announcement is a candidate.
  assert(!shouldWithhold(['✓', 'migrate', '42ms']), 'a multi-argument log was withheld');
  assert(!shouldWithhold(['✓ done', { detail: 1 }]), 'a log with a trailing object was withheld');
  assert(!shouldWithhold([]), 'an empty log call was withheld');
});

it('a failure line survives, and so does anything that is not a string', () => {
  assert(!shouldWithhold(['✗ parses a torn line — expected 7, got 3']), 'A FAILURE WAS WITHHELD');
  assert(!shouldWithhold(['✘ nope']), 'a failure with a different cross was withheld');
  assert(!shouldWithhold(['FAIL src/x.test.ts']), 'a failure was withheld');
  assert(!shouldWithhold([{ toString: () => '✓ sneaky' }]), 'an object that stringifies to a pass line was withheld');
  assert(!shouldWithhold([null]), 'null was withheld');
});

it('the summary line survives — explicitly, not by luck', () => {
  // Four CI gates parsed this line in the repo this came from. Suppressing it would have
  // left a green pipeline that had stopped checking anything. The exemption is asserted
  // here against summaries that DO start with the marker, because a summary that merely
  // fails the marker test is protected by accident and a later marker change undoes it.
  assert(!shouldWithhold(['15 passed, 0 failed']), 'the summary was withheld');
  assert(!shouldWithhold(['✓ All 15 tests passed']), 'a summary that starts with the marker was withheld');
  assert(!shouldWithhold(['  ✓ 42 passing']), 'a marker-prefixed totals line was withheld');
  assert(!shouldWithhold(['Tests: 15 passed, 15 total']), 'a jest-shaped summary was withheld');
  assert(SUMMARY_RE.test('1 failed'), 'SUMMARY_RE should recognise a totals line');
});

// ── The verbose gate ──────────────────────────────────────────────────────────────────

it('verbose restores everything, and VERBOSE=0 does not mean verbose', () => {
  assert(isVerbose({ VERBOSE: '1' }, []), 'VERBOSE=1 should be verbose');
  assert(isVerbose({}, ['node', 't.mjs', '-v']), '-v should be verbose');
  assert(isVerbose({}, ['node', 't.mjs', '--verbose']), '--verbose should be verbose');
  // A CI system exporting VERBOSE=0 is asking for QUIET. Reading any-value-as-true there
  // turns the feature off across a whole fleet and nobody notices, because the symptom is
  // "the output looks like it always did".
  assert(!isVerbose({ VERBOSE: '0' }, []), 'VERBOSE=0 must not mean verbose');
  assert(!isVerbose({ VERBOSE: '' }, []), 'VERBOSE= must not mean verbose');
  assert(!isVerbose({ VERBOSE: 'false' }, []), 'VERBOSE=false must not mean verbose');
  assert(!isVerbose({}, ['node', 't.mjs']), 'no flag means quiet');
});

// ── install(): the end-to-end behaviour, driven without a subprocess ───────────────────

const fakeConsole = () => { const out = []; return { out, log: (...a) => out.push(a.map(String).join(' ')) }; };

it('install() withholds passes, keeps everything else, and counts what it withheld', () => {
  const c = fakeConsole();
  const h = install({ console: c, env: {}, argv: [], onExit: false });
  c.log('  ✓ one'); c.log('  ✓ two');
  c.log('  ✗ three — boom');
  c.log('| ✓ | table |');
  c.log('✓', 'multi', 'arg');
  c.log('15 passed, 1 failed');
  h.restore();
  assert(h.withheld === 2, `expected 2 withheld, got ${h.withheld}`);
  assert(c.out.length === 4, `expected 4 surviving lines, got ${c.out.length}: ${JSON.stringify(c.out)}`);
  assert(c.out.some((l) => l.includes('✗ three')), 'the failure did not survive');
  assert(c.out.some((l) => l.includes('15 passed, 1 failed')), 'the summary did not survive');
  assert(/withheld/.test(h.summary()), 'the tally should say how much was withheld');
});

it('install() in verbose mode is a no-op — byte for byte', () => {
  const c = fakeConsole();
  const h = install({ console: c, env: { VERBOSE: '1' }, argv: [], onExit: false });
  c.log('  ✓ one'); c.log('  ✗ two'); c.log('15 passed, 1 failed');
  h.restore();
  assert(h.withheld === 0, 'verbose withheld something');
  assert(c.out.length === 3, `verbose changed the output: ${JSON.stringify(c.out)}`);
  assert(h.summary() === '', 'verbose should print no tally');
});

it('restore() is idempotent and puts back the original function', () => {
  const c = fakeConsole();
  const original = c.log;
  const h = install({ console: c, env: {}, argv: [], onExit: false });
  assert(c.log !== original, 'install did not patch');
  h.restore(); h.restore();
  assert(c.log === original, 'restore left a wrapper behind');
});

// ── Detection ─────────────────────────────────────────────────────────────────────────

const SAMPLE = [
  '  ✓ parses a torn line', '  ✓ counts re-reads', '  ✓ classifies commands',
  '  ✗ segments commits — expected 2, got 1', '', 'token-audit tests: 3 passed, 1 failed',
].join('\n');

it('detectMarker finds the marker and reports a confidence rather than a boolean', () => {
  const d = detectMarker(SAMPLE);
  assert(d.marker === '✓', `expected ✓, got ${d.marker}`);
  assert(d.hits === 3, `expected 3 hits, got ${d.hits}`);
  assert(d.confidence > 0.5 && d.confidence < 1, `confidence should be a share, got ${d.confidence}`);
  assert(detectMarker('').marker === null, 'empty output should detect nothing');
});

it('detectSummary finds the totals line and refuses a line that merely says "passed"', () => {
  assert(detectSummary(SAMPLE).line === 'token-audit tests: 3 passed, 1 failed', 'did not find the totals');
  // Prose about passing is not a summary. Claiming it is would let the tool proceed on a
  // runner whose real totals it never located — the exact thing the refusal exists to stop.
  assert(detectSummary('the migration passed review\nall good') === null, 'prose was mistaken for a summary');
  assert(detectSummary('no totals anywhere') === null, 'invented a summary');
});

it('measure() reports repeats and withholdable lines separately, and never double-counts', () => {
  const m = measure(SAMPLE, '✓');
  assert(m.lines === 5, `expected 5 non-blank lines, got ${m.lines}`);
  assert(m.withholdableLines === 3, `expected 3 withholdable, got ${m.withholdableLines}`);
  assert(m.projectedLines === 2, `expected 2 lines left, got ${m.projectedLines}`);
  assert(Math.abs(m.projectedSaving - 0.6) < 1e-9, `expected 60% saving, got ${m.projectedSaving}`);
  // A pass line that is ALSO a repeat must be counted once. Summing the two shares would
  // let the tool advertise a saving larger than the output it is removing.
  const dup = ['  ✓ a', '  ✓ a', '  ✓ a', 'x', '1 passed, 0 failed'].join('\n');
  const d = measure(dup, '✓');
  assert(d.projectedSaving <= 1, 'projected saving exceeded 100%');
  assert(d.projectedLines === 2, `expected 2 survivors, got ${d.projectedLines}`);
});

it('measure() declines dense output rather than finding work in it', () => {
  // A tool that always finds something to do is not measuring. This is the shape of a suite
  // that already prints only failures and a total: there is nothing here to take away.
  const dense = ['building…', 'linking…', 'running 400 cases', '400 passed, 0 failed'].join('\n');
  const m = measure(dense, '✓');
  assert(m.projectedSaving < WORTH_DOING, `dense output should fall under the ${WORTH_DOING} bar, got ${m.projectedSaving}`);
});

it('the summary line is never counted as withholdable, even when it starts with the marker', () => {
  const m = measure(['✓ a', '✓ b', '✓ 2 passed, 0 failed'].join('\n'), '✓');
  assert(m.withholdableLines === 2, `the totals line was counted as withholdable (got ${m.withholdableLines})`);
});

// ── Proposal, against a real directory ────────────────────────────────────────────────

it('findEmitters picks files that LOG the marker, not files that merely mention it', () => {
  const repo = join(SB, 'repo'); mkdirSync(join(repo, 'test'), { recursive: true });
  writeFileSync(join(repo, 'test', 'a.test.mjs'), "import x from 'x';\nconsole.log('  ✓ ' + name);\n");
  // Mentions the marker in prose only. A patch that touches this file is editing a file
  // that prints nothing, which is how a "safe" refactor acquires a diff nobody can explain.
  writeFileSync(join(repo, 'docs.mjs'), "// we print ✓ for passes\nexport const x = 1;\n");
  writeFileSync(join(repo, 'test', 'b.test.mjs'), "export const y = 2;\n");
  const e = findEmitters(repo, '✓');
  assert(e.length === 1, `expected 1 emitter, got ${e.length}: ${e.map((x) => x.file).join(', ')}`);
  assert(e[0].file.includes('a.test.mjs'), `wrong emitter: ${e[0].file}`);
});

it('proposePatch inserts after the imports and is a no-op the second time', () => {
  const repo = join(SB, 'repo2'); mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 't.test.mjs'), "#!/usr/bin/env node\nimport a from 'a';\nimport b from 'b';\nconsole.log('✓ ok');\n");
  const h = proposePatch(repo, findEmitters(repo, '✓'), '✓');
  assert(h.length === 1, 'expected one hunk');
  assert(h[0].at === 3, `expected insertion after the import block (line 3), got ${h[0].at}`);
  assert(h[0].insert.some((l) => l.includes('quiet.mjs')), 'the patch does not import quiet.mjs');
  // Applying twice would double-install. The detector for that is the presence of the
  // import, checked before anything is written.
  writeFileSync(join(repo, 't.test.mjs'), "import { install } from './quiet.mjs';\nconsole.log('✓ ok');\n");
  assert(proposePatch(repo, findEmitters(repo, '✓'), '✓')[0].skipped, 'a second proposal was not skipped');
});

it('detectCommand ignores npm\'s placeholder test script', () => {
  const repo = join(SB, 'repo3'); mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  assert(detectCommand(repo) === null, 'the npm placeholder was treated as a real test command');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node t.mjs' } }));
  assert(detectCommand(repo) === 'npm test', 'a real test script was not detected');
});

// ── MUTANTS ───────────────────────────────────────────────────────────────────────────
//
// Each of these is a filter someone would plausibly write instead. They are run against the
// SAME cases as the real one and asserted to get them WRONG. This is what makes the tests
// above load-bearing: without it, they demonstrate that the correct implementation is
// correct, which nobody doubted.

const CASES = [
  { args: ['  ✓ one'], withhold: true },
  { args: ['| ✓ | table |'], withhold: false },
  { args: ['✓', 'multi', 'arg'], withhold: false },
  { args: ['✗ failed — boom'], withhold: false },
  { args: ['15 passed, 0 failed'], withhold: false },
  { args: ['✓ All 15 tests passed'], withhold: false },
];

const disagrees = (filter) => CASES.some((c) => {
  let got; try { got = !!filter(c.args, DEFAULT_MARKER); } catch { return true; }
  return got !== c.withhold;
});

it('MUTANT: a loose String(args).includes(marker) filter is caught', () => {
  const mutant = (args, marker) => String(args).includes(marker);
  assert(disagrees(mutant), 'the includes-based filter passed every case — the suite is dead');
});

it('MUTANT: a filter that also eats the summary line is caught', () => {
  const mutant = (args, marker) =>
    Array.isArray(args) && args.length === 1 && typeof args[0] === 'string' &&
    !args[0].includes('\n') && args[0].trimStart().startsWith(marker);   // SUMMARY_RE guard removed
  assert(disagrees(mutant), 'dropping the summary exemption changed nothing — the guard is untested');
});

it('MUTANT: an inverted verbose gate is caught', () => {
  // An inverted gate is quiet when asked to be loud. Driven through install() rather than
  // asserted against isVerbose directly, because the damage is done by what reaches the
  // terminal: VERBOSE=1 must hand back every line, including the passes.
  const real = fakeConsole();
  const h = install({ console: real, env: { VERBOSE: '1' }, argv: [], onExit: false });
  real.log('  ✓ one'); real.log('  ✗ two');
  h.restore();
  assert(real.out.length === 2, `VERBOSE=1 dropped a line — the gate is inverted (kept ${real.out.length}/2)`);

  const flipped = fakeConsole();
  const originalLog = flipped.log;
  // The mutant: gate on !isVerbose. Same install, opposite condition.
  if (!isVerbose({ VERBOSE: '1' }, [])) { /* unreachable for the real gate */ }
  else {
    flipped.log = (...args) => { if (shouldWithhold(args)) return; originalLog(...args); };
  }
  flipped.log('  ✓ one'); flipped.log('  ✗ two');
  assert(flipped.out.length === 1, 'sanity: the inverted gate should have eaten the pass line');
  assert(real.out.length !== flipped.out.length, 'the real gate and the inverted gate produce the same output');
});

it('MUTANT: withholding by "contains a marker anywhere" is caught by the failure case', () => {
  // The nastiest version, because it looks careful: it checks arity and type, and still
  // eats a failure line that happens to mention a pass ("✗ expected ✓, got ✗").
  const mutant = (args, marker) =>
    Array.isArray(args) && args.length === 1 && typeof args[0] === 'string' && args[0].includes(marker);
  assert(mutant(['✗ expected ✓ but got nothing'], '✓'), 'sanity: the mutant should eat this line');
  assert(!shouldWithhold(['✗ expected ✓ but got nothing']), 'THE REAL FILTER ATE A FAILURE LINE');
});

rmSync(SB, { recursive: true, force: true });
console.log(`\nquiet-tests tests: ${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
