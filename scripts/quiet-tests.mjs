#!/usr/bin/env node
// quiet-tests.mjs — find out whether a repo's test output is worth quieting, and by how much.
//
//   node scripts/quiet-tests.mjs                     # detect + measure + verdict (default)
//   node scripts/quiet-tests.mjs --dir <repo>        # somewhere other than cwd
//   node scripts/quiet-tests.mjs --cmd "npm test"    # override the detected command
//   node scripts/quiet-tests.mjs --propose           # print the patch, change nothing
//   node scripts/quiet-tests.mjs --apply             # write the patch, then re-measure
//   node scripts/quiet-tests.mjs --json
//
// ── Why this advises instead of dropping in ───────────────────────────────────────────
//
// The mechanism is trivial and the CONVENTION is not. A repo's test output has a per-test
// success marker, a summary line, and — the part that bites — CI gates that parse one or
// both. Quieting output without knowing which line four gates grep for is how you ship a
// pipeline that is still green because it stopped checking. So this measures and proposes;
// applying is a separate, explicit act.
//
// ── The refusal that makes it a measurement ───────────────────────────────────────────
//
// If the projected saving is under 25% it says SO and stops. A tool that always finds work
// is not measuring, it is selling. And if it cannot identify a summary line it stops
// outright: withholding output from a runner whose totals you cannot find is indistinguishable
// from hiding a failure.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { join, dirname, relative, resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// ── Conventions this knows how to recognise ───────────────────────────────────────────
//
// A closed list, ordered by how unambiguous each one is. `ok ` is last and deliberately
// space-suffixed: TAP's marker is a whole English word and matching it loosely would claim
// every line of prose beginning "ok" as a test result.
export const MARKERS = ['✓', '✔', '√', '✅', 'PASS', 'pass', 'ok '];

// A summary is a line stating TOTALS. Each pattern must bind a number to a word about
// tests, so that a line merely containing "passed" cannot be mistaken for the totals.
export const SUMMARY_PATTERNS = [
  /\b(\d+)\s+pass(?:ed|ing)?\b[\s\S]{0,40}?\b(\d+)\s+fail(?:ed|ing)?\b/i,
  /\b(\d+)\s+fail(?:ed|ing)?\b[\s\S]{0,40}?\b(\d+)\s+pass(?:ed|ing)?\b/i,
  /^\s*tests?:?\s+\d+\s+(passed|failed)/i,
  /\b(\d+)\s+pass(?:ed|ing)\b/i,
  /^\s*1\.\.(\d+)\s*$/,               // TAP plan
  /\b(\d+)\s+of\s+(\d+)\s+tests?\b/i,
];

/** Where a gate would live: anything that could be parsing the test output. */
const GATE_GLOBS = ['.github/workflows', 'scripts', 'tools', 'bin', 'ci', 'Makefile', 'makefile', 'justfile'];

// ── Detection ─────────────────────────────────────────────────────────────────────────

export function detectCommand(dir) {
  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts?.test && !/no test specified/i.test(pkg.scripts.test)) return 'npm test';
    } catch { /* an unreadable package.json is not fatal; fall through */ }
  }
  for (const [file, cmd] of [
    ['Cargo.toml', 'cargo test'], ['go.mod', 'go test ./...'],
    ['pytest.ini', 'pytest'], ['pyproject.toml', 'pytest'], ['Gemfile', 'bundle exec rspec'],
  ]) if (existsSync(join(dir, file))) return cmd;
  return null;
}

/**
 * Which marker does this output use, and how sure are we?
 *
 * Confidence is the share of NON-BLANK lines that begin with the winner. It is reported
 * rather than thresholded into a boolean, because "42% of lines start with ✓" and "3% do"
 * call for different amounts of human attention and collapsing them to "detected" throws
 * that away.
 */
export function detectMarker(output) {
  const lines = output.split('\n').filter((l) => l.trim());
  if (!lines.length) return { marker: null, hits: 0, confidence: 0, lines: 0 };
  let best = { marker: null, hits: 0 };
  for (const m of MARKERS) {
    const hits = lines.filter((l) => l.trimStart().startsWith(m)).length;
    if (hits > best.hits) best = { marker: m.trim() || m, hits };
  }
  return { ...best, lines: lines.length, confidence: best.hits / lines.length };
}

/** The totals line. Returned as text so the caller can show the user what it will protect. */
export function detectSummary(output) {
  const lines = output.split('\n');
  for (const re of SUMMARY_PATTERNS) {
    for (let i = lines.length - 1; i >= 0; i--) {      // last match wins; totals come last
      if (re.test(lines[i])) return { line: lines[i].trim(), pattern: String(re), index: i };
    }
  }
  return null;
}

const walk = (root, depth = 0, out = []) => {
  if (depth > 4 || !existsSync(root)) return out;
  let entries; try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'target' || e.name === 'dist') continue;
    const p = join(root, e.name);
    if (e.isDirectory()) walk(p, depth + 1, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
};

/**
 * Anything that looks like it parses the test output.
 *
 * Reported, never acted on. The point is to put "four gates grep this line" in front of a
 * human before they agree to change what that line looks like.
 */
export function detectGates(dir, marker, summaryLine) {
  const found = [];
  const needleWords = (summaryLine || '').match(/\b(pass(?:ed|ing)?|fail(?:ed|ing)?)\b/gi) || [];
  const files = GATE_GLOBS.flatMap((g) => {
    const p = join(dir, g);
    if (!existsSync(p)) return [];
    try { return statSync(p).isDirectory() ? walk(p) : [p]; } catch { return []; }
  });
  for (const f of files) {
    if (/\.(png|jpg|gif|ico|pdf|zip|gz|lock)$/i.test(f)) continue;
    let body; try { body = readFileSync(f, 'utf8'); } catch { continue; }
    const reasons = [];
    if (marker && body.includes(marker) && /grep|rg |match|includes|=~/.test(body)) reasons.push(`references the ${marker} marker near a match`);
    for (const w of new Set(needleWords.map((w) => w.toLowerCase()))) {
      if (new RegExp(`(grep|rg |match|includes|=~|test\\()[^\\n]{0,80}${w}`, 'i').test(body)) reasons.push(`parses "${w}"`);
    }
    if (reasons.length) found.push({ file: relative(dir, f), reasons: [...new Set(reasons)] });
  }
  return found;
}

// ── Measurement ───────────────────────────────────────────────────────────────────────

export function runSuite(cmd, dir, extraEnv = {}) {
  const r = spawnSync(cmd, { cwd: dir, shell: true, encoding: 'utf8', env: { ...process.env, ...extraEnv }, maxBuffer: 64 * 1024 * 1024 });
  return { stdout: r.stdout || '', stderr: r.stderr || '', output: (r.stdout || '') + (r.stderr || ''), status: r.status };
}

/**
 * What would quieting actually save?
 *
 * TWO components, reported separately, and this is a deliberate departure from "measure the
 * repeated-line share and gate on that":
 *
 *   repeated  — byte-identical lines printed more than once. Pure waste.
 *   withheld  — per-test PASS announcements. Almost all DISTINCT, because each carries a
 *               different test name.
 *
 * The 1,081 -> 91 result that motivates this whole skill was overwhelmingly the second kind.
 * A gate on repeated-share alone would have declined to do the one job with the largest
 * measured payoff available. So the 25% refusal is applied to the PROJECTED SAVING, of which
 * repeated share is one part, and both numbers are printed so the claim can be checked.
 */
export function measure(output, marker) {
  const lines = output.split('\n');
  const nonBlank = lines.filter((l) => l.trim());
  const distinct = new Set(nonBlank.map((l) => l.trim()));
  const withheld = marker ? nonBlank.filter((l) => l.trimStart().startsWith(marker) && !SUMMARY_PATTERNS.some((re) => re.test(l))).length : 0;
  const repeated = nonBlank.length - distinct.size;
  // Union, not sum: a repeated line that is ALSO a pass announcement must not be counted
  // twice, or the projection oversells itself — the exact failure this project exists to
  // avoid. Counted by simulating the filter and then deduplicating what is left.
  const surviving = nonBlank.filter((l) => !(marker && l.trimStart().startsWith(marker) && !SUMMARY_PATTERNS.some((re) => re.test(l))));
  const after = new Set(surviving.map((l) => l.trim())).size;
  return {
    lines: nonBlank.length,
    distinctLines: distinct.size,
    repeatedLines: repeated,
    repeatedShare: nonBlank.length ? repeated / nonBlank.length : 0,
    withholdableLines: withheld,
    projectedLines: surviving.length,
    projectedDistinctLines: after,
    projectedSaving: nonBlank.length ? (nonBlank.length - surviving.length) / nonBlank.length : 0,
  };
}

export const WORTH_DOING = 0.25;

// ── Proposal ──────────────────────────────────────────────────────────────────────────

/** Files that actually emit the marker through console.log — the ones a patch must touch. */
export function findEmitters(dir, marker) {
  if (!marker) return [];
  const out = [];
  for (const f of walk(dir)) {
    if (!/\.(m?js|cjs|ts|mts|tsx|jsx)$/.test(f)) continue;
    let body; try { body = readFileSync(f, 'utf8'); } catch { continue; }
    if (!body.includes(marker)) continue;
    // The marker has to reach console.log on some line, or this file merely mentions it.
    if (!body.split('\n').some((l) => l.includes('console.log') && l.includes(marker))) continue;
    // Forward slashes always: a unified diff with `test\suite.mjs` in the header is not a
    // diff, it is a picture of one — `patch` and `git apply` both reject it on every OS.
    out.push({ file: relative(dir, f).replace(/\\/g, '/'), cjs: /\.cjs$/.test(f) || (!/\.mjs$/.test(f) && /\brequire\s*\(/.test(body) && !/^\s*import\s/m.test(body)) });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** A unified diff for "insert these lines after the import block". No dependency, no guessing. */
export function proposePatch(dir, emitters, marker) {
  const hunks = [];
  for (const e of emitters) {
    const abs = join(dir, e.file);
    let body; try { body = readFileSync(abs, 'utf8'); } catch { continue; }
    const lines = body.split('\n');
    if (/quiet\.mjs/.test(body)) { hunks.push({ file: e.file, skipped: 'already installed' }); continue; }
    let at = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(import\s|const\s+.*=\s*require\()/.test(lines[i])) at = i + 1;
      else if (/^#!/.test(lines[i]) && i === 0) at = 1;
    }
    const rel = relative(dirname(abs), join(dir, 'quiet.mjs')).replace(/\\/g, '/');
    const spec = rel.startsWith('.') ? rel : `./${rel}`;
    const insert = e.cjs
      ? [`const { install: installQuiet } = require('${spec.replace(/\.mjs$/, '.cjs')}');`, 'installQuiet();']
      : [`import { install as installQuiet } from '${spec}';`, `installQuiet(${marker && marker !== '✓' ? `{ marker: ${JSON.stringify(marker)} }` : ''});`];
    hunks.push({ file: e.file, at, insert, cjs: e.cjs });
  }
  return hunks;
}

export function renderDiff(hunks, dir) {
  const L = [];
  for (const h of hunks) {
    if (h.skipped) { L.push(`# ${h.file}: ${h.skipped}`); continue; }
    const lines = readFileSync(join(dir, h.file), 'utf8').split('\n');
    const ctxStart = Math.max(0, h.at - 3);
    const before = lines.slice(ctxStart, h.at);
    const after = lines.slice(h.at, h.at + 3);
    L.push(`--- a/${h.file}`);
    L.push(`+++ b/${h.file}`);
    L.push(`@@ -${ctxStart + 1},${before.length + after.length} +${ctxStart + 1},${before.length + h.insert.length + after.length} @@`);
    for (const l of before) L.push(` ${l}`);
    for (const l of h.insert) L.push(`+${l}`);
    for (const l of after) L.push(` ${l}`);
    L.push('');
  }
  return L.join('\n');
}

export function applyPatch(dir, hunks) {
  const touched = [];
  copyFileSync(join(HERE, 'quiet.mjs'), join(dir, 'quiet.mjs'));
  touched.push('quiet.mjs (new)');
  for (const h of hunks) {
    if (h.skipped) continue;
    const abs = join(dir, h.file);
    const lines = readFileSync(abs, 'utf8').split('\n');
    lines.splice(h.at, 0, ...h.insert);
    writeFileSync(abs, lines.join('\n'));
    touched.push(h.file);
  }
  return touched;
}

// ── Report ────────────────────────────────────────────────────────────────────────────

const pct = (x) => `${Math.round(x * 100)}%`;

export function report(state) {
  const { cmd, marker, summary, gates, m, emitters } = state;
  const L = [];
  L.push(`test command: ${cmd}`);
  L.push('');
  L.push('CONVENTION DETECTED');
  L.push(marker.marker
    ? `  success marker: "${marker.marker}" — ${marker.hits}/${marker.lines} lines begin with it (${pct(marker.confidence)} confidence)`
    : '  success marker: none found');
  L.push(summary ? `  summary line:   ${JSON.stringify(summary.line)}` : '  summary line:   NONE FOUND');
  if (gates.length) {
    L.push(`  gates parsing the output: ${gates.length}`);
    for (const g of gates.slice(0, 6)) L.push(`    ${g.file} — ${g.reasons.join('; ')}`);
    L.push('    changing what these lines look like is the risk; the patch below does not.');
  } else {
    L.push('  gates parsing the output: none found (searched CI workflows, scripts/, tools/, Makefile)');
  }
  L.push('');
  L.push('MEASURED');
  L.push(`  ${m.lines} lines, ${m.distinctLines} distinct (${pct(m.repeatedShare)} byte-identical repeats)`);
  L.push(`  pass announcements that would be withheld: ${m.withholdableLines}`);
  L.push(`  projected: ${m.lines} -> ${m.projectedLines} lines (${pct(m.projectedSaving)} saved)`);
  L.push('');
  return L.join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(n);
  const value = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };

  const dir = resolve(value('--dir') || process.cwd());
  const cmd = value('--cmd') || detectCommand(dir);
  if (!cmd) {
    console.error(`no test command found in ${dir} — pass --cmd "<how you run your tests>"`);
    process.exit(1);
  }

  const run = runSuite(cmd, dir);
  const marker = detectMarker(run.output);
  const summary = detectSummary(run.output);
  const gates = detectGates(dir, marker.marker, summary?.line);
  const m = measure(run.output, marker.marker);
  const emitters = findEmitters(dir, marker.marker);
  const state = { cmd, dir, marker, summary, gates, m, emitters, exitStatus: run.status };

  if (flag('--json')) {
    console.log(JSON.stringify({ ...state, dir: basename(dir) }, null, 2));
    process.exit(0);
  }

  console.log(report(state));

  // ── The two refusals ────────────────────────────────────────────────────────────────
  if (!summary) {
    console.log('STOPPING: no summary line found.');
    console.log('  Withholding output from a runner whose totals cannot be identified is');
    console.log('  indistinguishable from hiding a failure. Name the totals line with --cmd');
    console.log('  pointing at a runner that prints one, or do this by hand.');
    process.exit(2);
  }
  if (!marker.marker) {
    console.log('STOPPING: no per-test success marker found — there is nothing to withhold.');
    process.exit(2);
  }
  if (m.projectedSaving < WORTH_DOING) {
    console.log(`VERDICT: nothing worth doing here. Projected saving is ${pct(m.projectedSaving)}, below the ${pct(WORTH_DOING)} bar.`);
    console.log('  This output is already about as dense as it gets. Spend the effort elsewhere');
    console.log('  — run token-audit to find where the tokens are actually going.');
    process.exit(0);
  }

  console.log(`VERDICT: worth doing — ${pct(m.projectedSaving)} of the output is pass announcements.`);
  console.log(`  ${emitters.length} file(s) emit the marker.`);
  console.log('');

  const hunks = proposePatch(dir, emitters, marker.marker);
  if (!flag('--apply')) {
    console.log('PROPOSED PATCH  (nothing has been changed; re-run with --apply)');
    console.log('');
    console.log(`+++ b/quiet.mjs   (new file, copied from ${relative(dir, join(HERE, 'quiet.mjs')) || 'the plugin'})`);
    console.log(renderDiff(hunks, dir));
    process.exit(0);
  }

  const touched = applyPatch(dir, hunks);
  console.log(`APPLIED to ${touched.length} file(s): ${touched.join(', ')}`);
  const after = runSuite(cmd, dir);
  const am = measure(after.output, marker.marker);
  console.log('');
  console.log('BEFORE / AFTER');
  console.log(`  lines:      ${m.lines} -> ${am.lines}  (${pct(1 - (am.lines / (m.lines || 1)))} fewer)`);
  console.log(`  exit code:  ${run.status} -> ${after.status}${run.status === after.status ? '  (unchanged, as required)' : '  ** CHANGED — REVERT THIS PATCH **'}`);
  const stillHasSummary = detectSummary(after.output);
  console.log(`  summary:    ${stillHasSummary ? JSON.stringify(stillHasSummary.line) : '** GONE — REVERT THIS PATCH **'}`);
  process.exit(run.status === after.status && stillHasSummary ? 0 : 1);
}
