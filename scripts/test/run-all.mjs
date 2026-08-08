#!/usr/bin/env node
// run-all.mjs — every suite in this repo, one exit code.
//
// The suites are separate processes on purpose. Each one patches or inspects global state
// (console.log, cwd, temp directories); importing them into a single process would let one
// suite's cleanup decide another suite's result, which is the failure mode where a test
// passes because of the order it ran in.
//
// The output convention here is the one the quiet-tests skill looks for, and it is not an
// accident: this repo is the first thing that skill is pointed at. Per-suite lines are
// withheld unless VERBOSE=1, and the totals line always prints.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Discovered, not listed. A suite added to this directory and forgotten in a hand-written
// array is a suite that never runs, and it looks exactly like a suite that passes.
const suites = ['run-tests.mjs', ...readdirSync(HERE).filter((f) => f.endsWith('.test.mjs')).sort()];

let passed = 0, failed = 0;
for (const s of suites) {
  const r = spawnSync(process.execPath, [join(HERE, s)], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/(\d+)\s+passed,\s+(\d+)\s+failed/);
  if (m) { passed += Number(m[1]); failed += Number(m[2]); }
  else { failed++; console.log(`  ✗ ${s} — produced no totals line (exit ${r.status})`); }
  // A failing suite prints its failures in full, in both modes. Only the PASS announcement
  // is withheld, and only when nothing went wrong.
  if (r.status !== 0 || !m) process.stdout.write(out.replace(/^\s*✓.*$/gm, '').replace(/\n{3,}/g, '\n\n'));
  else if (process.env.VERBOSE) process.stdout.write(out);
}

console.log(`\ntoken-audit: ${passed} passed, ${failed} failed  (${suites.length} suites)`);
process.exit(failed ? 1 : 0);
