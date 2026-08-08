#!/usr/bin/env node
// code-map-learn.mjs — what does rediscovery actually cost, and what was actually looked for?
//
//   node scripts/code-map-learn.mjs tax                 # the rediscovery tax, across all sessions
//   node scripts/code-map-learn.mjs tax --project <dir> # one project
//   node scripts/code-map-learn.mjs hot  --project <dir> # files this project re-reads most
//   node scripts/code-map-learn.mjs tax --json
//
// ── Why this file exists, and why it is SEPARATE from code-map.mjs ────────────────────
//
// This is the only file in the plugin that opens a transcript. code-map.mjs — the index and
// its query — never does, and a test asserts it cannot. That is a FILE BOUNDARY standing in
// for a security boundary: you can audit the transcript-reading surface of this tool by
// reading one file, and no future change to the indexer can quietly acquire the ability to
// read your session history.
//
// ── A FEATURE THIS WAS SUPPOSED TO HAVE, AND THE MEASUREMENT THAT CUT IT ──────────────
//
// The plan was to learn WHAT WAS SEARCHED FOR — mine the transcripts for search terms, rank
// them, and pre-answer the popular ones. It needed a privacy gate to be safe (record a term
// only if it already exists as a symbol in your own code, so a pasted credential cannot
// survive), and that gate was designed and ready to build.
//
// Then `tax` measured it. Across 589 real sessions, repeated searches cost 0.4% of all
// tokens. The feature would have added a transcript-reading surface, a privacy control to
// maintain, and a disk format — to chase four tenths of one percent. It was cut.
//
// What the same measurement found instead: RE-READING FILES costs 30% (18% across sessions,
// 12% within one). So this file ships `tax`, which measures that, and `hot`, which names the
// files a project re-reads every session so they can be outlined instead of opened.
//
// PRIVACY. `tax` prints no terms and no paths at all — counts and byte totals only, and a
// test plants a credential-shaped canary in a search pattern and asserts it never surfaces.
// `hot` prints FILE PATHS, which is the same documented, deliberate exception the token-audit
// skill makes: a path is far less sensitive than a payload, and "which file do you re-read
// every session" cannot be answered without naming it. No result body, command or search
// pattern is printed by anything in this file, in any mode.

import { createReadStream, existsSync, readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const PROJECTS = join(homedir(), '.claude', 'projects');
const BYTES_PER_TOKEN = 3.6;          // same estimate as audit.mjs; ratios are the point
const tok = (b) => Math.round(b / BYTES_PER_TOKEN);

/** Claude Code hyphenates every character outside [A-Za-z0-9-] when encoding a project dir. */
export const encodeProject = (p) => String(p).replace(/[^A-Za-z0-9]/g, '-');

// ── Classifying a search ──────────────────────────────────────────────────────────────

/**
 * Is this search a LOCATION question — the kind an index can answer?
 *
 * The distinction decides the entire honesty of the number below, so it is drawn narrowly:
 *
 *   identifier  a bare name with no regex metacharacters. "Where is `resolveImport`?" An
 *               index answers this completely, in one line, and it is the overwhelmingly
 *               common shape of an agent's search.
 *   glob        a filename pattern. Also purely a location question.
 *   pattern     anything with regex metacharacters, or a phrase. "Find every call that
 *               passes null here." An index CANNOT answer this and it is not counted as
 *               addressable — counting it would inflate the headline by roughly a third.
 *
 * Erring toward `pattern` is deliberate. The claim this file exists to support must survive
 * someone checking it.
 */
export function classifySearch(pattern, tool) {
  const s = String(pattern ?? '');
  if (!s.trim()) return 'pattern';
  if (tool === 'Glob') return 'glob';
  // Metacharacters that mean the caller wanted a REGEX, not a name.
  if (/[\\^$.|?*+()[\]{}]/.test(s)) return 'pattern';
  if (/\s/.test(s)) return 'pattern';              // a phrase, not an identifier
  if (s.length < 3) return 'pattern';              // too short to be a useful index key
  if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(s)) return 'pattern';
  return 'identifier';
}

/** A search's identity for repeat-detection. Case-folded; never printed. */
const keyOf = (tool, pattern) => `${tool === 'Glob' ? 'glob' : 'text'}:${String(pattern).toLowerCase()}`;

/** Pull the needle out of a shell search command, or null if it is not a search. */
export function bashNeedle(command) {
  const s = String(command || '');
  if (!/^\s*(rg|grep|ag|ack)\b/.test(s) && !/\|\s*(rg|grep)\b/.test(s)) return null;
  // The first quoted argument, or the first bare word after the flags.
  const q = s.match(/(['"])((?:\\.|(?!\1).)+)\1/);
  if (q) return q[2];
  const bare = s.replace(/^\s*\S+\s*/, '').match(/(?:^|\s)(?!-)([^\s|>]+)/);
  return bare ? bare[1] : null;
}

// ── One pass over one transcript ──────────────────────────────────────────────────────

/**
 * Streamed, because these files reach 133MB on this machine and a tool about memory
 * pressure that loads one into a string would be its own counter-example.
 *
 * Returns per-session aggregates plus the SET OF SEARCH KEYS SEEN. Keys stay in memory to
 * be intersected across sessions; nothing derived from a result body is retained.
 */
export async function scanTranscript(path) {
  const pending = new Map();
  const seen = new Map();                    // key -> {n, bytes, kind}
  const filesRead = new Map();               // path -> {n, bytes, firstBytes, whole}
  let searchCalls = 0, searchBytes = 0, addressableCalls = 0, addressableBytes = 0;
  let withinRepeats = 0, withinRepeatBytes = 0;
  let readCalls = 0, readBytes = 0, totalCalls = 0, totalBytes = 0;
  let wholeFileReads = 0, wholeFileBytes = 0;
  let lookupThenRead = 0;
  let lastSearchKey = null, lastSearchAddressable = false;

  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
    for (const block of content) {
      if (block.type === 'tool_use') {
        const name = block.name;
        let pattern = null, tool = null;
        if (name === 'Grep') { pattern = block.input?.pattern; tool = 'Grep'; }
        else if (name === 'Glob') { pattern = block.input?.pattern; tool = 'Glob'; }
        else if (name === 'Bash' || name === 'PowerShell') {
          const needle = bashNeedle(block.input?.command);
          if (needle != null) { pattern = needle; tool = 'Grep'; }
        }
        pending.set(block.id, {
          name, tool, pattern,
          file: name === 'Read' ? block.input?.file_path : null,
          // A read with no offset/limit pulled the WHOLE file in. When the question was
          // "where is X", that is the difference between 20 lines and 2,000.
          whole: name === 'Read' && block.input?.offset == null && block.input?.limit == null,
        });
        continue;
      }
      if (block.type !== 'tool_result') continue;
      const meta = pending.get(block.tool_use_id);
      if (!meta) continue;
      pending.delete(block.tool_use_id);

      const body = typeof block.content === 'string' ? block.content
        : Array.isArray(block.content)
          ? block.content.filter((c) => c?.type === 'text').map((c) => c.text).join('')
          : '';
      const bytes = body.length;                 // only the LENGTH is taken; body dies here
      totalCalls++; totalBytes += bytes;

      if (meta.name === 'Read') {
        readCalls++; readBytes += bytes;
        if (meta.whole) { wholeFileReads++; wholeFileBytes += bytes; }
        const fk = String(meta.file || '(unknown)');
        const fe = filesRead.get(fk);
        if (fe) { fe.n++; fe.bytes += bytes; if (meta.whole) fe.whole++; }
        else filesRead.set(fk, { n: 1, bytes, firstBytes: bytes, whole: meta.whole ? 1 : 0 });
        if (lastSearchAddressable) { lookupThenRead++; lastSearchAddressable = false; }
        continue;
      }
      if (meta.tool == null || meta.pattern == null) { lastSearchAddressable = false; continue; }

      const kind = classifySearch(meta.pattern, meta.tool);
      searchCalls++; searchBytes += bytes;
      const addressable = kind === 'identifier' || kind === 'glob';
      if (addressable) { addressableCalls++; addressableBytes += bytes; }
      lastSearchAddressable = addressable;

      const key = keyOf(meta.tool, meta.pattern);
      lastSearchKey = key;
      const e = seen.get(key);
      if (e) {
        e.n++; e.bytes += bytes;
        if (addressable) { withinRepeats++; withinRepeatBytes += bytes; }
      } else {
        seen.set(key, { n: 1, bytes, kind });
      }
    }
  }
  void lastSearchKey;

  // Re-reads WITHIN this session: everything after each file's first read.
  let withinRereadBytes = 0;
  for (const e of filesRead.values()) if (e.n > 1) withinRereadBytes += e.bytes - e.firstBytes;

  return {
    path, seen, filesRead,
    searchCalls, searchBytes, addressableCalls, addressableBytes,
    withinRepeats, withinRepeatBytes,
    readCalls, readBytes, totalCalls, totalBytes, lookupThenRead,
    wholeFileReads, wholeFileBytes, withinRereadBytes,
    distinctFilesRead: filesRead.size,
  };
}

// ── Across a whole corpus ─────────────────────────────────────────────────────────────

export function listTranscripts(root = PROJECTS) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const dir of readdirSync(root).sort()) {
    const full = join(root, dir);
    let st; try { st = statSync(full); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of readdirSync(full).sort()) {
      if (!f.endsWith('.jsonl')) continue;
      try { out.push({ path: join(full, f), project: dir, size: statSync(join(full, f)).size }); } catch { /* vanished */ }
    }
  }
  return out;
}

/**
 * The cross-session number, which is the one that matters.
 *
 * A repeat WITHIN a session is partly the agent's own fault and partly unavoidable. A repeat
 * ACROSS sessions is pure rediscovery: the answer was found, used, and then thrown away
 * because nothing outlives the context window. That is precisely the gap a persistent index
 * closes, so it is reported separately and it is the only figure quoted as the headline.
 */
export async function measureCorpus(files, onProgress) {
  const perProject = new Map();
  const totals = {
    sessions: 0, projects: 0, bytesScanned: 0,
    searchCalls: 0, searchBytes: 0, addressableCalls: 0, addressableBytes: 0,
    withinRepeats: 0, withinRepeatBytes: 0,
    crossRepeats: 0, crossRepeatBytes: 0,
    readCalls: 0, readBytes: 0, totalCalls: 0, totalBytes: 0, lookupThenRead: 0,
    wholeFileReads: 0, wholeFileBytes: 0, withinRereadBytes: 0, distinctFilesRead: 0,
    crossReadFiles: 0, crossReadBytes: 0,
  };

  for (const [i, f] of files.entries()) {
    let r; try { r = await scanTranscript(f.path); } catch { continue; }
    totals.sessions++; totals.bytesScanned += f.size;
    for (const k of ['searchCalls', 'searchBytes', 'addressableCalls', 'addressableBytes',
      'withinRepeats', 'withinRepeatBytes', 'readCalls', 'readBytes', 'totalCalls', 'totalBytes',
      'lookupThenRead', 'wholeFileReads', 'wholeFileBytes', 'withinRereadBytes', 'distinctFilesRead']) {
      totals[k] += r[k];
    }
    let p = perProject.get(f.project);
    if (!p) {
      p = { firstSeen: new Map(), firstRead: new Map(), fileSessions: new Map(), sessions: 0,
        crossRepeats: 0, crossRepeatBytes: 0, crossReadFiles: 0, crossReadBytes: 0 };
      perProject.set(f.project, p);
    }
    p.sessions++;
    for (const [key, e] of r.seen) {
      if (e.kind !== 'identifier' && e.kind !== 'glob') continue;
      if (p.firstSeen.has(key)) {
        // Every occurrence in this later session was avoidable: a persistent index would
        // have answered it. Counted as the whole session's spend on that key, not just the
        // repeats within it.
        p.crossRepeats += e.n; p.crossRepeatBytes += e.bytes;
      } else {
        p.firstSeen.set(key, true);
        // The FIRST session to ask still pays for all but its own first ask.
        if (e.n > 1) { p.crossRepeats += e.n - 1; p.crossRepeatBytes += Math.round(e.bytes * (e.n - 1) / e.n); }
      }
    }
    // Cross-session RE-READS: a file this project already pulled into context in an earlier
    // session, pulled in again from scratch. This is the read-side twin of rediscovery, and
    // on real transcripts it is far larger than the search-side one.
    for (const [fk, e] of r.filesRead) {
      const fs2 = p.fileSessions.get(fk) || { sessions: 0, bytes: 0 };
      fs2.sessions++; fs2.bytes += e.bytes; p.fileSessions.set(fk, fs2);
      if (p.firstRead.has(fk)) { p.crossReadFiles += e.n; p.crossReadBytes += e.bytes; }
      else {
        p.firstRead.set(fk, true);
        if (e.n > 1) { p.crossReadFiles += e.n - 1; p.crossReadBytes += e.bytes - e.firstBytes; }
      }
    }
    if (onProgress && i % 25 === 0) onProgress(i + 1, files.length);
  }

  for (const p of perProject.values()) {
    totals.crossRepeats += p.crossRepeats; totals.crossRepeatBytes += p.crossRepeatBytes;
    totals.crossReadFiles += p.crossReadFiles; totals.crossReadBytes += p.crossReadBytes;
  }
  totals.projects = perProject.size;

  // The actionable list: files pulled into context in more than one session, ranked by what
  // they actually cost.
  //
  // ZERO-BYTE READS ARE EXCLUDED, and finding out why was the point of running this. The
  // first version ranked by session count, and the top of every list was PNG screenshots
  // re-read six times each — true, and useless. An image's tool_result carries no text, so
  // it costs 0 bytes here, there is nothing for an outline to replace, and ranking by
  // sessions put the one category this tool cannot help at the top of its own advice.
  //
  // Stated as a limit rather than hidden: image reads DO cost real vision tokens, and this
  // tool cannot see them. It measures text, and says so.
  const hot = [...perProject.entries()].map(([project, p]) => ({
    project,
    sessions: p.sessions,
    files: [...p.fileSessions.entries()]
      .map(([path, e]) => ({ path, sessions: e.sessions, bytes: e.bytes }))
      .filter((f) => f.sessions > 1 && f.bytes > 0)
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 15),
  })).filter((x) => x.files.length)
    .sort((a, b) => b.files[0].bytes - a.files[0].bytes);

  return { totals, perProject, hot };
}

// ── Report ────────────────────────────────────────────────────────────────────────────

const n = (x) => Math.round(x).toLocaleString('en-US');
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '0%');

export function renderHot(hot) {
  if (!hot || !hot.length) return 'no file was read in more than one session — nothing to pre-digest';
  const L = ['FILES THIS PROJECT RE-READS ACROSS SESSIONS', ''];
  for (const proj of hot.slice(0, 6)) {
    L.push(`${proj.project}  (${proj.sessions} sessions)`);
    for (const f of proj.files.slice(0, 10)) {
      L.push(`  read in ${String(f.sessions).padStart(3)} sessions  ~${n(tok(f.bytes)).padStart(8)} tok total  ${f.path}`);
    }
    L.push('');
  }
  L.push('Each of these was pulled into context from scratch, once per session. Outline them');
  L.push('instead:  code-map.mjs outline <file>');
  return L.join('\n');
}

export function renderTax(t) {
  const L = [];
  L.push(`REDISCOVERY TAX — ${n(t.sessions)} sessions across ${n(t.projects)} projects, ${n(t.bytesScanned / 1048576)} MB of transcript`);
  L.push('');
  L.push('WHAT SEARCH COSTS');
  L.push(`  ${n(t.searchCalls)} searches returned ~${n(tok(t.searchBytes))} tok  (${pct(t.searchBytes, t.totalBytes)} of everything the model was shown)`);
  L.push(`  ${n(t.readCalls)} file reads returned ~${n(tok(t.readBytes))} tok`);
  L.push('');
  L.push('HOW MUCH OF IT AN INDEX COULD ANSWER');
  L.push(`  ${n(t.addressableCalls)} of ${n(t.searchCalls)} searches (${pct(t.addressableCalls, t.searchCalls)}) were LOCATION questions —`);
  L.push('    a bare identifier or a filename glob, no regex. Everything else is a content');
  L.push('    scan and is NOT counted as addressable.');
  L.push(`  those cost ~${n(tok(t.addressableBytes))} tok`);
  L.push('');
  L.push('THE PART THAT IS PURE REDISCOVERY');
  L.push(`  same question, later session: ${n(t.crossRepeats)} searches  ~${n(tok(t.crossRepeatBytes))} tok`);
  L.push('      the answer was found once, used, and thrown away with the context window');
  L.push(`  same question, same session: ${n(t.withinRepeats)} searches  ~${n(tok(t.withinRepeatBytes))} tok`);
  L.push('');
  L.push(`  REDISCOVERY IS ${pct(t.crossRepeatBytes, t.searchBytes)} OF ALL SEARCH SPEND, ~${n(tok(t.crossRepeatBytes))} tok`);
  L.push(`  and ${pct(t.crossRepeatBytes, t.totalBytes)} of every token the model was shown.`);
  L.push('');
  L.push(`  ${n(t.lookupThenRead)} location searches were immediately followed by a file read —`);
  L.push('    the search existed only to find the path.');
  L.push('');
  L.push('THE READ SIDE, WHICH IS WHERE THE MONEY ACTUALLY IS');
  L.push(`  ${n(t.readCalls)} reads, ${n(t.wholeFileReads)} of them whole-file (${pct(t.wholeFileReads, t.readCalls)}) — ~${n(tok(t.wholeFileBytes))} tok`);
  L.push(`  re-read in the same session:  ~${n(tok(t.withinRereadBytes))} tok`);
  L.push(`  re-read in a LATER session:   ${n(t.crossReadFiles)} reads  ~${n(tok(t.crossReadBytes))} tok`);
  L.push('      a file this project already pulled into context, pulled in again from scratch');
  L.push('');
  L.push(`  READ REDISCOVERY IS ${pct(t.crossReadBytes, t.totalBytes)} OF EVERY TOKEN THE MODEL WAS SHOWN`);
  L.push(`  — against ${pct(t.crossRepeatBytes, t.totalBytes)} for search rediscovery.`);
  L.push('');
  L.push(`tokens estimated at ${BYTES_PER_TOKEN} bytes each; the ratios are the point, not the absolutes`);
  return L.join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flag = (x) => argv.includes(x);
  const value = (x) => { const i = argv.indexOf(x); return i >= 0 ? argv[i + 1] : null; };

  if (cmd !== 'tax' && cmd !== 'hot') {
    console.error('usage: code-map-learn.mjs tax|hot [--project <dir>] [--limit N] [--json]');
    process.exit(1);
  }

  let files = listTranscripts();
  const proj = value('--project');
  if (proj) files = files.filter((f) => f.project === encodeProject(proj) || f.project === proj);
  const limit = Number(value('--limit') || 0);
  if (limit > 0) files = [...files].sort((a, b) => b.size - a.size).slice(0, limit);
  if (!files.length) { console.error(`no transcripts found under ${PROJECTS}`); process.exit(1); }

  const quiet = flag('--json');
  const { totals, hot } = await measureCorpus(files, quiet ? null : (i, total) => process.stderr.write(`\rscanning ${i}/${total}…`));
  if (!quiet) process.stderr.write('\r                              \r');

  if (cmd === 'hot') { console.log(renderHot(hot)); process.exit(0); }
  if (flag('--json')) console.log(JSON.stringify(totals, null, 2));
  else console.log(renderTax(totals));
}
