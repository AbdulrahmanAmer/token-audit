#!/usr/bin/env node
// audit.mjs — where did this session's tokens actually go?
//
//   node scripts/audit.mjs                    # the most recently active session
//   node scripts/audit.mjs --project <path>   # newest session for that project directory
//   node scripts/audit.mjs --file <a.jsonl>   # one specific transcript
//   node scripts/audit.mjs --list             # what transcripts exist
//   node scripts/audit.mjs --per-commit       # cost of each commit, for A/B comparisons
//   node scripts/audit.mjs --json             # machine-readable, same numbers
//
// ── What this is for ──────────────────────────────────────────────────────────────────
//
// Everybody optimising an agent's token use is guessing. This reads the transcript Claude
// Code already writes and reports what was actually consumed, so the next optimisation
// targets measured waste instead of a plausible story about it.
//
// The tool exists because its first run refuted its own author. The guess was "I read too
// many files". The measurement said file reads were ~222k tokens against ~649k of shell
// output — and that 37% of the test-and-gate output was byte-identical repeated text, with
// the six most-repeated searches in the whole session being variations of grepping that
// output down to its failures. The roll-call was paid for twice: once to receive it, once
// to delete it. No amount of introspection produces that; one pass over the transcript does.
//
// ── PRIVACY: the invariant this file is built around ──────────────────────────────────
//
// A transcript contains everything — source code, pasted credentials, customer data,
// whatever was in the window. So the rule here is absolute and mechanically tested
// (scripts/test/run-tests.mjs):
//
//     NO TOOL-RESULT CONTENT, AND NO COMMAND OR SEARCH TEXT, IS EVER PRINTED.
//
// Result bodies are measured by LENGTH and discarded. Commands are classified into a fixed
// vocabulary of kinds and discarded. What can reach the output is: counts, byte totals,
// tool names, the fixed kind vocabulary, and file paths.
//
// File paths are the one judgement call, and they are opt-out (`--no-paths`) rather than
// opt-in, because "which file did I read twelve times" is the single most actionable line
// in the report and a path is far less sensitive than a payload. A repository whose
// FILENAMES are confidential should pass --no-paths, and the numbers all still work.
//
// There is no network access here, and nothing is written anywhere. It reads and prints.

import { readFileSync, readdirSync, statSync, existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const PROJECTS = join(homedir(), '.claude', 'projects');

// Tokens are estimated, never counted. Anthropic's tokenizer is not available offline and a
// wrong-but-consistent divisor is fine for the only question being asked — the RATIO between
// where the tokens went. Code tokenizes denser than prose; 3.6 bytes/token is the middle of
// the range observed across mixed transcripts. Stated here so nobody mistakes it for exact.
const BYTES_PER_TOKEN = 3.6;
const tok = (bytes) => Math.round(bytes / BYTES_PER_TOKEN);

// ── The fixed kind vocabulary ─────────────────────────────────────────────────────────
//
// A command is reduced to one of these words and then FORGOTTEN. This list is the complete
// set of strings this classifier can ever emit about a command, which is what makes the
// privacy claim checkable rather than aspirational: no input can produce an output not
// found below.
export const KINDS = [
  'read-a-file', 'search', 'run-tests', 'run-build', 'git', 'inspect-fs', 'write-file', 'other',
];

export function classify(command) {
  const s = String(command || '').trim();
  if (/^(cat|head|tail|less|more)\b/.test(s) || /\bsed\s+-n\b/.test(s)) return 'read-a-file';
  if (/^(rg|grep|ag|ack)\b/.test(s) || /\|\s*(rg|grep)\b/.test(s)) return 'search';
  if (/\b(test|spec|jest|vitest|pytest|mocha|gradle\s+test|go\s+test|cargo\s+test)\b/.test(s)) return 'run-tests';
  if (/\b(make|npm\s+run|yarn|pnpm|tsc|cargo\s+build|go\s+build|mvn|gradle)\b/.test(s)) return 'run-build';
  if (/^git\b/.test(s)) return 'git';
  if (/^(ls|find|wc|stat|du|df|tree|pwd)\b/.test(s)) return 'inspect-fs';
  if (/<<\s*'?[A-Z]/.test(s) || /^(touch|mkdir|cp|mv)\b/.test(s)) return 'write-file';
  return 'other';
}

// ── Transcript discovery ──────────────────────────────────────────────────────────────

/** Claude Code encodes a project path into a directory name by replacing separators. */
const encodeProject = (p) => p.replace(/[/\\:]/g, '-');

export function listTranscripts(root = PROJECTS) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const dir of readdirSync(root)) {
    const full = join(root, dir);
    let st; try { st = statSync(full); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of readdirSync(full)) {
      if (!f.endsWith('.jsonl')) continue;
      const p = join(full, f);
      try { out.push({ path: p, project: dir, mtime: statSync(p).mtimeMs, size: statSync(p).size }); } catch { /* vanished */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// ── The pass ──────────────────────────────────────────────────────────────────────────

/**
 * One streaming pass over a transcript.
 *
 * Streamed line by line rather than read whole because these files reach tens of megabytes
 * — the session that produced this tool wrote 48MB — and a tool about memory pressure that
 * loads 48MB into a string to talk about it would be its own counter-example.
 *
 * Everything derived from a result body is derived HERE, from a local variable that goes out
 * of scope at the end of the iteration. No body, command or pattern is stored on the returned
 * object; see the privacy note at the top.
 */
export async function analyze(path) {
  const pending = new Map();               // tool_use id -> {name, command, file}
  const byTool = new Map();                // tool name -> {calls, bytes}
  const byKind = new Map();                // command kind -> {calls, bytes}
  const reads = new Map();                 // file path -> {n, bytes, firstBytes, partial}
  const commits = [];                      // per-commit segments
  let seg = { bytes: 0, calls: 0, readCalls: 0, readBytes: 0 };
  let testBytes = 0, testLines = 0;
  const testDistinct = new Set();
  let totalBytes = 0, totalCalls = 0, assistantTurns = 0;

  const bump = (map, key, bytes) => {
    const e = map.get(key) || { calls: 0, bytes: 0 };
    e.calls++; e.bytes += bytes; map.set(key, e);
  };

  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }   // a torn last line is normal
    if (ev.type === 'assistant') assistantTurns++;
    const content = Array.isArray(ev.message?.content) ? ev.message.content : [];

    for (const block of content) {
      if (block.type === 'tool_use') {
        pending.set(block.id, {
          name: block.name,
          command: block.name === 'Bash' ? String(block.input?.command || '') : '',
          file: block.name === 'Read' ? String(block.input?.file_path || '') : '',
          partial: block.input?.offset != null || block.input?.limit != null,
        });
        continue;
      }
      if (block.type !== 'tool_result') continue;
      const meta = pending.get(block.tool_use_id);
      if (!meta) continue;
      pending.delete(block.tool_use_id);

      // The only thing taken from the body is its length. `body` dies with this iteration.
      const body = typeof block.content === 'string' ? block.content
        : Array.isArray(block.content)
          ? block.content.filter((c) => c?.type === 'text').map((c) => c.text).join('')
          : '';
      const bytes = body.length;

      totalBytes += bytes; totalCalls++;
      seg.bytes += bytes; seg.calls++;
      bump(byTool, meta.name, bytes);

      if (meta.name === 'Read') {
        seg.readCalls++; seg.readBytes += bytes;
        const key = meta.file || '(unknown)';
        const e = reads.get(key) || { n: 0, bytes: 0, firstBytes: bytes, partial: 0 };
        e.n++; e.bytes += bytes; if (meta.partial) e.partial++;
        reads.set(key, e);
      }

      if (meta.name === 'Bash') {
        const kind = classify(meta.command);
        bump(byKind, kind, bytes);
        if (kind === 'run-tests' || kind === 'run-build') {
          testBytes += bytes;
          for (const l of body.split('\n')) { testLines++; testDistinct.add(l.trim()); }
        }
        if (/\bgit\s+commit\b/.test(meta.command) && !/--dry-run/.test(meta.command)) {
          commits.push(seg);
          seg = { bytes: 0, calls: 0, readCalls: 0, readBytes: 0 };
        }
      }
    }
  }
  commits.push(seg);   // work since the last commit

  const readRows = [...reads.entries()].map(([file, r]) => ({ file, ...r }))
    .sort((a, b) => b.bytes - a.bytes);
  const repeats = readRows.filter((r) => r.n > 1);

  return {
    path,
    assistantTurns,
    totalCalls,
    totalBytes,
    byTool: [...byTool.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.bytes - a.bytes),
    byKind: [...byKind.entries()].map(([kind, v]) => ({ kind, ...v })).sort((a, b) => b.bytes - a.bytes),
    reads: readRows,
    readTotals: {
      calls: readRows.reduce((a, r) => a + r.n, 0),
      bytes: readRows.reduce((a, r) => a + r.bytes, 0),
      distinctFiles: readRows.length,
      repeatedFiles: repeats.length,
      // The headline. Re-read bytes are everything after each file's FIRST read: context
      // that was already paid for once and bought again.
      rereadBytes: repeats.reduce((a, r) => a + (r.bytes - r.firstBytes), 0),
      wholeFileReads: readRows.reduce((a, r) => a + (r.n - r.partial), 0),
    },
    testOutput: {
      bytes: testBytes,
      lines: testLines,
      distinctLines: testDistinct.size,
      repeatedShare: testLines ? 1 - testDistinct.size / testLines : 0,
    },
    commits: commits.filter((c) => c.calls > 0),
  };
}

// ── Rendering ─────────────────────────────────────────────────────────────────────────

const pct = (x) => `${Math.round(x * 100)}%`;
const n = (x) => x.toLocaleString('en-US');

function render(a, { showPaths, perCommit }) {
  const L = [];
  L.push(`transcript: ${basename(a.path)}`);
  L.push(`${n(a.assistantTurns)} assistant turns, ${n(a.totalCalls)} tool results, ~${n(tok(a.totalBytes))} tokens taken in`);
  L.push('');

  L.push('WHERE THE TOKENS WENT');
  for (const t of a.byTool.slice(0, 8)) {
    L.push(`  ${t.name.padEnd(14)} ${String(n(tok(t.bytes))).padStart(9)} tok  ${String(n(t.calls)).padStart(5)} calls`);
  }

  if (a.byKind.length) {
    L.push('');
    L.push('SHELL OUTPUT BY KIND');
    for (const k of a.byKind) {
      L.push(`  ${k.kind.padEnd(14)} ${String(n(tok(k.bytes))).padStart(9)} tok  ${String(n(k.calls)).padStart(5)} calls`);
    }
  }

  const r = a.readTotals;
  if (r.calls) {
    L.push('');
    L.push('FILE READS');
    L.push(`  ${n(r.calls)} reads across ${n(r.distinctFiles)} files, ~${n(tok(r.bytes))} tok`);
    L.push(`  whole-file (no offset/limit): ${n(r.wholeFileReads)}/${n(r.calls)} (${pct(r.wholeFileReads / r.calls)})`);
    L.push(`  read more than once: ${n(r.repeatedFiles)}/${n(r.distinctFiles)} files`);
    L.push(`  RE-READ COST: ~${n(tok(r.rereadBytes))} tok (${pct(r.bytes ? r.rereadBytes / r.bytes : 0)} of all read bytes)`);
    L.push('      context already paid for once, bought again');
  }

  const t = a.testOutput;
  if (t.lines) {
    L.push('');
    L.push('TEST / BUILD OUTPUT');
    L.push(`  ~${n(tok(t.bytes))} tok, ${n(t.lines)} lines, ${n(t.distinctLines)} distinct (${pct(t.repeatedShare)} repeated text)`);
    if (t.repeatedShare > 0.25) {
      L.push('      a third or more of this is the same lines again. A quiet mode that prints');
      L.push('      failures and the summary is usually the cheapest saving available.');
    }
  }

  if (showPaths && a.reads.length) {
    L.push('');
    L.push('MOST EXPENSIVE FILES');
    for (const row of a.reads.slice(0, 12)) {
      L.push(`  ${String(row.n).padStart(3)}x ${String(n(tok(row.bytes))).padStart(8)} tok  ${row.file}`);
    }
  }

  if (perCommit && a.commits.length > 1) {
    L.push('');
    L.push('COST PER COMMIT  (for before/after comparisons)');
    L.push(`  ${'tok'.padStart(8)} ${'calls'.padStart(6)} ${'reads'.padStart(6)} ${'read tok'.padStart(9)}`);
    for (const c of a.commits) {
      L.push(`  ${String(n(tok(c.bytes))).padStart(8)} ${String(c.calls).padStart(6)} ${String(c.readCalls).padStart(6)} ${String(n(tok(c.readBytes))).padStart(9)}`);
    }
  }

  L.push('');
  L.push(`tokens estimated at ${BYTES_PER_TOKEN} bytes each — the ratios are the point, not the absolute figures`);
  return L.join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };

// `file://${argv[1]}` is the common idiom and it is wrong on Windows: argv[1] is
// `D:\...\audit.mjs` while import.meta.url is `file:///D:/.../audit.mjs`, so the guard never
// matches, the CLI runs as a library and prints NOTHING while exiting 0. pathToFileURL does
// the drive-letter and separator normalisation that makes the two comparable.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const all = listTranscripts();

  if (flag('--list')) {
    if (!all.length) { console.log(`no transcripts under ${PROJECTS}`); process.exit(0); }
    for (const t of all.slice(0, 25)) {
      console.log(`${String(Math.round(t.size / 1024)).padStart(8)} KB  ${t.project}/${basename(t.path)}`);
    }
    process.exit(0);
  }

  let target = value('--file');
  if (!target) {
    const project = value('--project');
    const pool = project ? all.filter((t) => t.project === encodeProject(project)) : all;
    if (!pool.length) {
      console.error(project
        ? `no transcript found for project ${project} (looked for ${encodeProject(project)} under ${PROJECTS})`
        : `no transcripts under ${PROJECTS} — has Claude Code run on this machine?`);
      process.exit(1);
    }
    target = pool[0].path;
  }
  if (!existsSync(target)) { console.error(`no such transcript: ${target}`); process.exit(1); }

  const result = await analyze(target);
  if (flag('--json')) {
    // Paths are stripped from JSON unless asked for, same rule as the text report.
    const out = flag('--no-paths') ? { ...result, path: basename(result.path), reads: [] } : result;
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(render(result, { showPaths: !flag('--no-paths'), perCommit: flag('--per-commit') }));
  }
}
