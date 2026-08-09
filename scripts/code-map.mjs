#!/usr/bin/env node
// code-map.mjs — where is it, and what is in it, without opening the file.
//
//   node scripts/code-map.mjs build   [--root <repo>]     # build/refresh the cache
//   node scripts/code-map.mjs find    <name> [--root ...] # symbol -> path:line, verified
//   node scripts/code-map.mjs outline <file>              # what is in this file, ~40 lines
//   node scripts/code-map.mjs brief   [--root ...]        # orient in a repo, ~30 lines
//   node scripts/code-map.mjs stats   [--root ...]
//   node scripts/code-map.mjs hook install [--min-lines N] [--root ...]   # the read hook
//   node scripts/code-map.mjs hook uninstall|status       [--root ...]
//
// ── What this is for, and the measurement that decided it ─────────────────────────────
//
// The obvious story is that agents waste tokens grepping. Measured across 12 of the largest
// real sessions on this machine (517MB of transcript), that story is WRONG:
//
//     search returned          ~322k tok   (7% of everything the model was shown)
//     file reads returned    ~2,218k tok   (7x more)
//     68% of reads pulled the WHOLE file
//     re-reading a file a LATER session had already read:  ~703k tok  = 16% of all tokens
//     the same figure for repeated searches:                            0%
//
// So this tool is not a search index. Grep is fine — Anthropic tested embedding-based
// retrieval for Claude Code against plain agentic search and kept agentic search. The waste
// is on the READ side, and it has two shapes:
//
//   1. Opening a 2,000-line file to look at one 30-line function.
//   2. Session 2 re-reading what session 1 already read, because nothing outlives the
//      context window.
//
// This attacks both, by making two questions answerable for ~50 tokens instead of ~1,450:
// "where is X" and "what is in this file". It does not replace reading; it replaces reading
// the WRONG AMOUNT.
//
// ── THE INDEX IS A CACHE. THE FILE IS ALWAYS THE SOURCE OF TRUTH ──────────────────────
//
// Every answer is verified against the file on disk before it is returned: if the file's
// size or mtime has moved since it was indexed, that one file is re-scanned in-process and
// the answer comes from the fresh scan. A stale cache therefore produces a MISS, never a
// wrong location. This is the whole reason the thing is trustworthy enough to act on
// without checking, and it is why there is no `--check` mode here and no staleness failure
// mode to manage.
//
// It also never writes into the context window on its own. Anthropic's context-engineering
// guidance is explicit that recall DEGRADES as context grows — "as the number of tokens in
// the context window increases, the model's ability to accurately recall information from
// that context decreases" — so an always-on index would trade tokens for accuracy and lose
// twice. Nothing here is injected. You ask; you get a few lines back.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join, relative, resolve, extname, dirname, sep, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// ── Languages ─────────────────────────────────────────────────────────────────────────
//
// Regexes, not parsers — the same trade the rest of this plugin makes, for the same reason:
// a parser per language is not a defensible dependency for a lookup table, and installing
// this must stay free. The cost is recall, never correctness: a symbol this misses is a
// symbol you grep for, and verification means a symbol it finds is really there.

const C_FAMILY = { line: '//', block: ['/*', '*/'] };
const HASH = { line: '#', block: null };
// Python has no block comment, so a docstring is the only place a whole paragraph can hide —
// and docstrings are full of example code. Without this, every `def` in every usage example
// becomes a symbol and the map answers "where is X" with a line inside prose.
const PY = { line: '#', block: null, doc: ['"""', "'''"] };

export const LANGS = {
  '.mjs': C_FAMILY, '.cjs': C_FAMILY, '.js': C_FAMILY, '.jsx': C_FAMILY,
  '.ts': C_FAMILY, '.tsx': C_FAMILY, '.mts': C_FAMILY, '.cts': C_FAMILY,
  '.go': C_FAMILY, '.rs': C_FAMILY, '.java': C_FAMILY, '.kt': C_FAMILY, '.kts': C_FAMILY,
  '.c': C_FAMILY, '.h': C_FAMILY, '.cc': C_FAMILY, '.cpp': C_FAMILY, '.hpp': C_FAMILY,
  '.cs': C_FAMILY, '.swift': C_FAMILY, '.scala': C_FAMILY, '.php': C_FAMILY, '.dart': C_FAMILY,
  '.py': PY, '.rb': HASH, '.sh': HASH, '.bash': HASH, '.zsh': HASH, '.yml': HASH, '.yaml': HASH,
  '.sql': { line: '--', block: ['/*', '*/'] },
  '.md': { line: null, block: null },
};

/** name-capturing patterns, applied per stripped line. Order matters only for `kind`. */
const PATTERNS = [
  // JS / TS
  { ext: /\.(m?[jt]sx?|cts|mts)$/, kind: 'export', re: /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/ },
  { ext: /\.(m?[jt]sx?|cts|mts)$/, kind: 'function', re: /^\s*(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/ },
  { ext: /\.(m?[jt]sx?|cts|mts)$/, kind: 'class', re: /^\s*(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { ext: /\.(m?[jt]sx?|cts|mts)$/, kind: 'const', re: /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/ },
  { ext: /\.(m?[jt]sx?|cts|mts)$/, kind: 'type', re: /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/ },
  { ext: /\.(m?[jt]sx?|cts|mts)$/, kind: 'method', re: /^\s{2,}(?:public|private|protected|static|async|\*)?\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/ },
  // Function-local bindings. Added because the A/B run measured the cost of NOT having them:
  // two of five questions were about locals (`manifestLimit`, `eligibleCount`), `find` missed
  // both, and each miss cost a fallback round trip — which is what ate most of the token
  // saving. Ranked below real declarations by `score()`, so they never outrank an export.
  // Length >= 4 keeps `i`, `j`, `e`, `re`, `ok` out of a lookup table.
  { ext: /\.(m?[jt]sx?|cts|mts)$/, kind: 'local', re: /^\s+(?:const|let)\s+([A-Za-z_$][\w$]{3,})\s*=/ },

  // Python
  { ext: /\.py$/, kind: 'function', re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
  { ext: /\.py$/, kind: 'class', re: /^\s*class\s+([A-Za-z_]\w*)/ },
  // Go
  { ext: /\.go$/, kind: 'function', re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/ },
  { ext: /\.go$/, kind: 'type', re: /^\s*type\s+([A-Za-z_]\w*)/ },
  // Rust
  { ext: /\.rs$/, kind: 'function', re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/ },
  { ext: /\.rs$/, kind: 'type', re: /^\s*(?:pub\s+)?(?:struct|enum|trait|impl|type)\s+([A-Za-z_]\w*)/ },
  // JVM / C-family / C#
  { ext: /\.(java|kt|kts|scala|cs|swift|dart)$/, kind: 'class', re: /^\s*(?:public|private|internal|open|final|abstract|sealed|data|\s)*\s*(?:class|interface|object|struct|enum|protocol)\s+([A-Za-z_]\w*)/ },
  { ext: /\.(java|kt|kts|scala|cs|swift|dart)$/, kind: 'function', re: /^\s*(?:public|private|protected|internal|static|override|open|suspend|func|fun|void|\s)+\s*([A-Za-z_]\w*)\s*\(/ },
  { ext: /\.(c|h|cc|cpp|hpp)$/, kind: 'function', re: /^[A-Za-z_][\w \t*&:<>]*\s[*&]?([A-Za-z_]\w*)\s*\([^;]*$/ },
  // Ruby / PHP
  { ext: /\.rb$/, kind: 'function', re: /^\s*def\s+([A-Za-z_]\w*)/ },
  { ext: /\.rb$/, kind: 'class', re: /^\s*(?:class|module)\s+([A-Za-z_]\w*)/ },
  { ext: /\.php$/, kind: 'function', re: /^\s*(?:public|private|protected|static|\s)*function\s+([A-Za-z_]\w*)/ },
  { ext: /\.php$/, kind: 'class', re: /^\s*(?:abstract\s+|final\s+)?(?:class|trait|interface)\s+([A-Za-z_]\w*)/ },
  // SQL / shell / markdown — the ones people actually hunt for and never index
  { ext: /\.sql$/, kind: 'table', re: /^\s*create\s+(?:or\s+replace\s+)?(?:table|view|function|index)\s+(?:if\s+not\s+exists\s+)?["`]?([A-Za-z_][\w.]*)/i },
  { ext: /\.(sh|bash|zsh)$/, kind: 'function', re: /^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\)\s*\{/ },
  { ext: /\.md$/, kind: 'heading', re: /^#{1,3}\s+(.{3,60}?)\s*$/ },
];

/**
 * Strip comments without changing the line count, statelessly across lines.
 *
 * The same design as code-index.mjs, for the same reason recorded there: a scanner that
 * knows strings but not regex literals will desynchronise on `/'(?:[^'\\\n]|\\.)*'/` and
 * hand back every later comment as code. Resetting string state at each newline bounds that
 * to ONE wrong line. Line count is preserved because every symbol here is a `path:line` and
 * an index that cites the wrong line is worse than one that cites nothing.
 */
/**
 * A string literal whose closing quote matches its opening one.
 *
 * `/['"]...['"]/ ` pairs one literal's closing quote with the next one's opening quote and
 * hands back the code between them — the defect code-index.mjs shipped, which advertised a
 * flag written inside a regex as a real CLI option.
 */
const STRING_RE = /(['"`])(?:\\.|(?!\1)[^\\])*?\1/g;

export function stripFor(ext, source) {
  const lang = LANGS[ext] || C_FAMILY;
  if (!lang.line && !lang.block && !lang.doc) return source;   // markdown: comments are content
  const [bo, bc] = lang.block || [null, null];
  const lines = source.split('\n');
  const out = new Array(lines.length);
  let inBlock = false, inDoc = null;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Triple-quoted docstrings first, because the delimiter is ITSELF a string opener —
    // blanking strings before finding them would consume the opening `"""` as an empty
    // string and leave the docstring body looking like code.
    if (lang.doc) {
      if (inDoc) {
        const close = line.indexOf(inDoc);
        if (close < 0) { out[i] = ''; continue; }
        line = ' '.repeat(close + inDoc.length) + line.slice(close + inDoc.length);
        inDoc = null;
      }
      for (;;) {
        let at = -1, delim = null;
        for (const d of lang.doc) { const k = line.indexOf(d); if (k >= 0 && (at < 0 || k < at)) { at = k; delim = d; } }
        if (at < 0) break;
        const close = line.indexOf(delim, at + delim.length);
        if (close < 0) { inDoc = delim; line = line.slice(0, at); break; }
        line = line.slice(0, at) + ' '.repeat(close + delim.length - at) + line.slice(close + delim.length);
      }
    }

    if (inBlock) {
      const close = bc ? line.indexOf(bc) : -1;
      if (close < 0) { out[i] = ''; continue; }
      inBlock = false;
      out[i] = ' '.repeat(close + bc.length) + line.slice(close + bc.length);
      continue;
    }
    // Blank the CONTENTS of string literals before looking for a comment marker, so a `//`
    // or a `#` inside a string cannot truncate the line, and so a declaration quoted inside
    // a string ("export function ghost() {}") cannot be indexed as a symbol.
    let s = line.indexOf('"') < 0 && line.indexOf("'") < 0 && line.indexOf('`') < 0
      ? line
      : line.replace(STRING_RE, (m, q) => q + q);
    if (bo) {
      const open = s.indexOf(bo);
      if (open >= 0) {
        const close = bc ? s.indexOf(bc, open + bo.length) : -1;
        if (close < 0) { inBlock = true; s = s.slice(0, open); }
        else s = s.slice(0, open) + s.slice(close + bc.length);
      }
    }
    if (lang.line) { const c = s.indexOf(lang.line); if (c >= 0) s = s.slice(0, c); }
    out[i] = s;
  }
  return out.join('\n');
}

/** Every symbol in a source string, with 1-based line numbers. Sorted by line. */
export function extractSymbols(source, ext) {
  const pats = PATTERNS.filter((p) => p.ext.test(`x${ext}`));
  if (!pats.length) return [];
  const lines = stripFor(ext, source).split('\n');
  const seen = new Set();
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    for (const p of pats) {
      const m = line.match(p.re);
      if (!m) continue;
      const name = m[1];
      // Keywords slip through the looser method/function patterns; a hit on `if` or `return`
      // is noise that would make `find` untrustworthy on its most common queries.
      if (RESERVED.has(name)) continue;
      const key = `${name}:${i + 1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, kind: p.kind, line: i + 1 });
      break;                                     // first pattern wins; one symbol per line
    }
  }
  return out;
}

const RESERVED = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'class', 'const', 'let', 'var',
  'else', 'do', 'try', 'new', 'typeof', 'await', 'yield', 'import', 'export', 'default', 'case',
  'break', 'continue', 'throw', 'delete', 'in', 'of', 'this', 'super', 'void', 'with', 'and', 'or',
  'not', 'is', 'pass', 'def', 'end', 'then', 'elif', 'print', 'require', 'module', 'public',
  'private', 'protected', 'static', 'async', 'get', 'set', 'constructor',
]);

// ── The store ─────────────────────────────────────────────────────────────────────────

export const STORE_DIR = join('.claude', 'code-map');
const MAX_FILE = 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'coverage', 'vendor',
  '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.cache', 'out', 'bin', 'obj', '.claude',
  'Pods', 'DerivedData', '.terraform', 'site-packages', 'bower_components', '.pytest_cache']);

function walk(root, dir = root, out = [], depth = 0) {
  if (depth > 12) return out;
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) walk(root, abs, out, depth + 1);
    else if (e.isFile() && LANGS[extname(e.name)]) out.push(abs);
  }
  return out;
}

const relPath = (root, abs) => relative(root, abs).split(sep).join('/');

/**
 * Build, reusing the previous index for files that have not moved.
 *
 * A cold build of a 16,000-file repository takes ~52s; re-reading and re-scanning every file
 * to discover that none of them changed is most of that. Incremental turns the everyday case
 * — build at the start of a session — into something under a second, and a tool that costs a
 * minute before it answers anything is a tool nobody runs twice.
 *
 * The reuse key is (mtime, size), the same pair `verifyFile` uses at query time, so a file
 * that is stale for the cache is stale for both and there is only one staleness rule in the
 * system to reason about.
 */
export function buildIndex(root, { onFile, previous } = {}) {
  const files = walk(root);
  const rows = [];
  const meta = [];
  const prevRows = new Map();
  if (previous) {
    for (const r of previous.rows) {
      const list = prevRows.get(r.path) || [];
      list.push(r); prevRows.set(r.path, list);
    }
  }
  let reused = 0;
  for (const abs of files) {
    let src, st;
    try { st = statSync(abs); } catch { continue; }
    if (st.size > MAX_FILE) continue;
    const rp = relPath(root, abs);
    const known = previous?.meta?.get?.(rp);
    if (known && known.mtime === Math.round(st.mtimeMs) && known.size === st.size) {
      for (const r of prevRows.get(rp) || []) rows.push(r);
      meta.push({ path: rp, mtime: known.mtime, size: known.size, symbols: known.symbols });
      reused++;
      continue;
    }
    try { src = readFileSync(abs, 'utf8'); } catch { continue; }
    // Minified and bundled files are not code anyone navigates: one line, tens of thousands
    // of characters, and every symbol in them is a mangled name. Indexing them costs most of
    // the build and pollutes every lookup, so they are skipped by SHAPE rather than by a
    // filename convention nobody follows consistently.
    if (src.length > 4096 && src.length / (src.split('\n').length || 1) > 400) continue;
    const syms = extractSymbols(src, extname(abs));
    for (const y of syms) rows.push({ name: y.name, kind: y.kind, path: rp, line: y.line });
    meta.push({ path: rp, mtime: Math.round(st.mtimeMs), size: st.size, symbols: syms.length });
    if (onFile) onFile(rp, syms.length);
  }
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path) || a.line - b.line);
  meta.sort((a, b) => a.path.localeCompare(b.path));
  return { rows, meta, reused, scanned: meta.length - reused };
}

/** An absolute --store keeps the cache out of the repo entirely (read-only checkouts, CI). */
const storePath = (root, storeDir) => (isAbsolute(storeDir) ? storeDir : join(root, storeDir));

export function saveIndex(root, index, storeDir = STORE_DIR) {
  const dir = storePath(root, storeDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'symbols.tsv'),
    `${index.rows.map((r) => `${r.name}\t${r.kind}\t${r.path}\t${r.line}`).join('\n')}\n`);
  writeFileSync(join(dir, 'files.tsv'),
    `${index.meta.map((m) => `${m.path}\t${m.mtime}\t${m.size}\t${m.symbols}`).join('\n')}\n`);
  return dir;
}

export function loadIndex(root, storeDir = STORE_DIR) {
  const dir = storePath(root, storeDir);
  const sp = join(dir, 'symbols.tsv'); const fp = join(dir, 'files.tsv');
  if (!existsSync(sp) || !existsSync(fp)) return null;
  const rows = readFileSync(sp, 'utf8').split('\n').filter(Boolean).map((l) => {
    const [name, kind, path, line] = l.split('\t');
    return { name, kind, path, line: Number(line) };
  });
  const meta = new Map(readFileSync(fp, 'utf8').split('\n').filter(Boolean).map((l) => {
    const [path, mtime, size, symbols] = l.split('\t');
    return [path, { path, mtime: Number(mtime), size: Number(size), symbols: Number(symbols) }];
  }));
  return { rows, meta };
}

// ── Verification: the file is always the source of truth ──────────────────────────────

/**
 * Fresh symbols for one file, re-scanning it if it has moved since it was indexed.
 *
 * `null` means the file is gone. This is the function that makes a stale cache produce a
 * MISS rather than a wrong location, and it is why this tool has no staleness mode to
 * manage: nothing is ever returned that has not just been checked against disk.
 */
export function verifyFile(root, path, meta) {
  const abs = join(root, path);
  let st; try { st = statSync(abs); } catch { return null; }
  const known = meta?.get?.(path);
  if (known && Math.round(st.mtimeMs) === known.mtime && st.size === known.size) return 'unchanged';
  try { return extractSymbols(readFileSync(abs, 'utf8'), extname(abs)); } catch { return null; }
}

/** A local binding never outranks a real declaration, however good the name match is. */
const LOCAL_PENALTY = 10;

const score = (needle, name) => {
  if (name === needle) return 0;
  if (name.toLowerCase() === needle.toLowerCase()) return 1;
  if (name.startsWith(needle)) return 2;
  if (name.toLowerCase().startsWith(needle.toLowerCase())) return 3;
  if (name.toLowerCase().includes(needle.toLowerCase())) return 4;
  return 99;
};

export function find(root, needle, { index, limit = 20 } = {}) {
  const idx = index || loadIndex(root);
  if (!idx) return { hits: [], built: false };
  const candidates = idx.rows.map((r) => ({ ...r, s: score(needle, r.name) + (r.kind === 'local' ? LOCAL_PENALTY : 0) }))
    .filter((r) => r.s < 99)
    .sort((a, b) => a.s - b.s || a.path.localeCompare(b.path) || a.line - b.line);

  const hits = [];
  const rescanned = new Map();
  for (const c of candidates) {
    if (hits.length >= limit) break;
    let fresh = rescanned.get(c.path);
    if (fresh === undefined) { fresh = verifyFile(root, c.path, idx.meta); rescanned.set(c.path, fresh); }
    if (fresh === null) continue;                       // file gone: drop, never report
    if (fresh === 'unchanged') { hits.push(c); continue; }
    // The file moved. Take the answer from the FRESH scan, not from the cache.
    const match = fresh.filter((s) => score(needle, s.name) < 99)
      .sort((a, b) => (score(needle, a.name) + (a.kind === 'local' ? LOCAL_PENALTY : 0))
        - (score(needle, b.name) + (b.kind === 'local' ? LOCAL_PENALTY : 0)))[0];
    if (match) hits.push({ name: match.name, kind: match.kind, path: c.path, line: match.line, restaled: true });
  }
  // De-duplicate: a re-scanned file can be reached through several stale rows.
  const out = [];
  const seen = new Set();
  for (const h of hits) {
    const k = `${h.path}:${h.line}`;
    if (seen.has(k)) continue;
    seen.add(k); out.push(h);
  }
  return { hits: out, built: true };
}

export function outline(root, path) {
  const abs = join(root, path);
  if (!existsSync(abs)) return null;
  const src = readFileSync(abs, 'utf8');
  return { symbols: extractSymbols(src, extname(abs)), lines: src.split('\n').length, bytes: src.length };
}

// ── Rendering ─────────────────────────────────────────────────────────────────────────

const CONTEXT = 12;   // lines of headroom around a hit; a signature plus its body's opening

/**
 * Print the cheap next action, not just the answer.
 *
 * The whole saving is the difference between `Read(file)` and `Read(file, offset, limit)`,
 * and an agent that gets a line number but not the idea will still open the whole file.
 * Measured on this machine's transcripts, a whole-file read averaged ~1,450 tok; a 60-line
 * slice is roughly 500.
 */
export function renderFind(needle, hits, { built }) {
  if (!built) return `no map for this repo yet — run: code-map.mjs build`;
  if (!hits.length) return `no symbol matching "${needle}" — fall back to Grep (this map is regex-based and does miss things)`;
  const L = hits.map((h) => `${h.path}:${h.line}\t${h.kind}\t${h.name}${h.restaled ? '\t(file changed since indexing; line re-verified)' : ''}`);
  const top = hits[0];
  L.push('');
  L.push(`→ Read ${top.path} offset=${Math.max(1, top.line - CONTEXT)} limit=${CONTEXT * 5}`);
  return L.join('\n');
}

export function renderOutline(path, o) {
  if (!o) return `no such file: ${path}`;
  const L = [`${path} — ${o.lines} lines, ${o.symbols.length} symbols`];
  for (const s of o.symbols) L.push(`  ${String(s.line).padStart(5)}  ${s.kind.padEnd(9)} ${s.name}`);
  if (!o.symbols.length) L.push('  (no symbols recognised — this file may be data, or an unsupported language)');
  return L.join('\n');
}

export function renderBrief(root, idx) {
  if (!idx) return 'no map for this repo yet — run: code-map.mjs build';
  const byDir = new Map();
  for (const m of idx.meta.values()) {
    const d = m.path.includes('/') ? m.path.slice(0, m.path.indexOf('/')) : '.';
    const e = byDir.get(d) || { files: 0, symbols: 0 };
    e.files++; e.symbols += m.symbols; byDir.set(d, e);
  }
  const L = [`${idx.meta.size} files, ${idx.rows.length} symbols`, '', 'WHERE THINGS ARE'];
  for (const [d, e] of [...byDir.entries()].sort((a, b) => b[1].symbols - a[1].symbols).slice(0, 12)) {
    L.push(`  ${d.padEnd(24)} ${String(e.symbols).padStart(6)} symbols  ${String(e.files).padStart(4)} files`);
  }
  const big = [...idx.meta.values()].sort((a, b) => b.symbols - a.symbols).slice(0, 8);
  if (big.length) {
    L.push('');
    L.push('DENSEST FILES  (outline these instead of reading them)');
    for (const m of big) L.push(`  ${String(m.symbols).padStart(4)} symbols  ${m.path}`);
  }
  return L.join('\n');
}

// ── The benchmark ─────────────────────────────────────────────────────────────────────

const BYTES_PER_TOKEN = 3.6;
const toks = (b) => b / BYTES_PER_TOKEN;
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);

/**
 * What does a location question cost, with and without this?
 *
 * Deterministic and reproducible: no model, no sampling of a session, just arithmetic over
 * real files. For every symbol in the index it compares the three ways an agent can answer
 * "where/what is X":
 *
 *   naive    Read(file)                       — the whole file
 *   slice    find + Read(file, offset, limit) — the neighbourhood of the symbol
 *   outline  the file's symbol table          — no source at all
 *
 * THE ASSUMPTION, STATED SO IT CAN BE DISAGREED WITH: this is the right comparison when the
 * question is "where is X" or "what is in this file", and the WRONG one when the agent
 * genuinely needs the whole file — to rewrite it, or to reason about code far from the
 * symbol. It measures a substitution that is available, not one that is always correct. The
 * `worse` count below is the honest other half: files small enough that the map costs more
 * than just reading them.
 */
export function bench(root, { index, sample = 4000 } = {}) {
  const idx = index || loadIndex(root);
  if (!idx) return null;
  const naive = [], slice = [], outl = [];
  let worse = 0, considered = 0;
  const cache = new Map();
  const step = Math.max(1, Math.floor(idx.rows.length / sample));

  for (let i = 0; i < idx.rows.length; i += step) {
    const r = idx.rows[i];
    let f = cache.get(r.path);
    if (f === undefined) {
      try {
        const src = readFileSync(join(root, r.path), 'utf8');
        const lines = src.split('\n');
        f = { bytes: src.length, lines, outlineBytes: renderOutline(r.path, { symbols: extractSymbols(src, extname(r.path)), lines: lines.length, bytes: src.length }).length };
      } catch { f = null; }
      cache.set(r.path, f);
    }
    if (!f) continue;
    considered++;
    const start = Math.max(0, r.line - 1 - CONTEXT);
    const sliceBytes = f.lines.slice(start, start + CONTEXT * 5).join('\n').length
      + `${r.path}:${r.line}\t${r.kind}\t${r.name}\n`.length;      // the find output counts too
    naive.push(toks(f.bytes));
    slice.push(toks(sliceBytes));
    outl.push(toks(f.outlineBytes));
    if (sliceBytes >= f.bytes) worse++;
  }
  return { considered, worse, naive, slice, outline: outl };
}

export function renderBench(root, b) {
  if (!b) return 'no map for this repo yet — run: code-map.mjs build';
  const n = (x) => Math.round(x).toLocaleString('en-US');
  const drop = (a, c) => `${Math.round((1 - c / a) * 100)}%`;
  const mN = median(b.naive), mS = median(b.slice), mO = median(b.outline);
  const sum = (xs) => xs.reduce((a, x) => a + x, 0);
  const L = [];
  L.push(`BENCH — ${n(b.considered)} location questions over real files`);
  L.push('');
  L.push(`  ${'answer'.padEnd(22)} ${'median'.padStart(9)} ${'total'.padStart(12)}`);
  L.push(`  ${'Read(whole file)'.padEnd(22)} ${n(mN).padStart(6)} tok ${n(sum(b.naive)).padStart(9)} tok`);
  L.push(`  ${'find + Read(slice)'.padEnd(22)} ${n(mS).padStart(6)} tok ${n(sum(b.slice)).padStart(9)} tok   ${drop(mN, mS)} smaller`);
  L.push(`  ${'outline (no source)'.padEnd(22)} ${n(mO).padStart(6)} tok ${n(sum(b.outline)).padStart(9)} tok   ${drop(mN, mO)} smaller`);
  L.push('');
  L.push(`  the map is WORSE for ${n(b.worse)} of ${n(b.considered)} (${Math.round((b.worse / Math.max(1, b.considered)) * 100)}%) —`);
  L.push('    files small enough that reading them costs less than slicing them.');
  L.push('');
  L.push('  ASSUMPTION: this compares reading a whole file against reading the neighbourhood');
  L.push('  of one symbol. Right for "where/what is X"; WRONG when the whole file is needed.');
  return L.join('\n');
}

// ── Hook management ───────────────────────────────────────────────────────────────────
//
// The hook is the delivery mechanism that measurably works, so installing it must not
// require hand-editing JSON. Three verbs, all on <root>/.claude/settings.json:
//
//   hook install [--min-lines N]   merge our PreToolUse entry in, idempotently
//   hook uninstall                 remove exactly our entry, leave everything else alone
//   hook status                    installed? effective threshold? kill switch?
//
// The merge is non-destructive by construction: parse, remove any previous copy of OUR
// entry (recognised by its command containing code-map-hook.mjs), append the fresh one,
// carry everything else through untouched. Installing twice therefore yields one entry.
// An unparseable settings.json is REFUSED, never overwritten — a config file with a syntax
// error is somebody's work in progress, not ours to delete. Same refusal when `hooks` or
// `hooks.PreToolUse` has an unexpected shape: modifying a structure we do not understand
// is how an installer eats a config.

export const HOOK_MARK = 'code-map-hook.mjs';
const HOOK_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'code-map-hook.mjs');
const settingsPathFor = (root) => join(root, '.claude', 'settings.json');
const isOurs = (h) => !!h && h.type === 'command' && typeof h.command === 'string' && h.command.includes(HOOK_MARK);

function readSettings(root) {
  const path = settingsPathFor(root);
  if (!existsSync(path)) return { path, settings: {} };
  let settings;
  try { settings = JSON.parse(readFileSync(path, 'utf8')); } catch (e) {
    throw new Error(`${path} is not valid JSON (${e.message}) — fix or remove it first; refusing to overwrite`);
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`${path} does not hold a settings object — refusing to overwrite`);
  }
  return { path, settings };
}

/** Strip our hook from every event. Drops an entry or event only if OUR removal emptied it. */
function removeOurs(settings) {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return 0;
  let removed = 0;
  for (const event of Object.keys(hooks)) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    let eventRemoved = 0;
    const kept = entries.filter((e) => {
      if (!e || !Array.isArray(e.hooks)) return true;      // not ours to judge
      const before = e.hooks.length;
      e.hooks = e.hooks.filter((h) => !isOurs(h));
      eventRemoved += before - e.hooks.length;
      return e.hooks.length > 0 || before === e.hooks.length;
    });
    if (eventRemoved) {
      removed += eventRemoved;
      if (kept.length) hooks[event] = kept; else delete hooks[event];
    }
  }
  if (removed && settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  return removed;
}

export function hookCommand({ minLines, hookScript = HOOK_SCRIPT } = {}) {
  return `node "${hookScript}"${minLines ? ` --min-lines ${Math.floor(minLines)}` : ''}`;
}

export function hookInstall(root, { minLines, hookScript } = {}) {
  const { path, settings } = readSettings(root);
  removeOurs(settings);
  if (settings.hooks == null) settings.hooks = {};
  if (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    throw new Error(`"hooks" in ${path} is not an object — refusing to modify it`);
  }
  if (settings.hooks.PreToolUse == null) settings.hooks.PreToolUse = [];
  if (!Array.isArray(settings.hooks.PreToolUse)) {
    throw new Error(`"hooks.PreToolUse" in ${path} is not an array — refusing to modify it`);
  }
  const command = hookCommand({ minLines, hookScript });
  settings.hooks.PreToolUse.push({ matcher: 'Read', hooks: [{ type: 'command', command }] });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  return { path, command };
}

export function hookUninstall(root) {
  const path = settingsPathFor(root);
  if (!existsSync(path)) return { path, removed: 0 };
  const { settings } = readSettings(root);
  const removed = removeOurs(settings);
  if (removed) writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  return { path, removed };
}

/** Same threshold precedence as the hook itself: env (if sane) > installed flag > 300. */
export function hookStatus(root, env = process.env) {
  const path = settingsPathFor(root);
  let command = null;
  if (existsSync(path)) {
    try {
      const settings = JSON.parse(readFileSync(path, 'utf8'));
      for (const entries of Object.values(settings?.hooks || {})) {
        if (!Array.isArray(entries)) continue;
        for (const e of entries) for (const h of (e && Array.isArray(e.hooks) ? e.hooks : [])) {
          if (isOurs(h)) command = h.command;
        }
      }
    } catch { /* unparseable settings reads as not-installed; install/uninstall refuse loudly */ }
  }
  const envMin = Number(env.CODE_MAP_HOOK_MIN_LINES);
  const flagMatch = command ? command.match(/--min-lines\s+(\d+)/) : null;
  const minLines = Number.isFinite(envMin) && envMin > 0 ? envMin
    : flagMatch ? Number(flagMatch[1]) : 300;
  return { installed: !!command, path, command, minLines, disabled: env.CODE_MAP_HOOK === 'off' };
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const value = (x) => { const i = argv.indexOf(x); return i >= 0 ? argv[i + 1] : null; };
  const root = resolve(value('--root') || process.cwd());
  const store = value('--store') || STORE_DIR;
  const positional = argv.slice(1).filter((a, i, arr) => !a.startsWith('--') && !(i > 0 && arr[i - 1].startsWith('--')));

  if (cmd === 'build') {
    const t0 = process.hrtime.bigint();
    const previous = argv.includes('--full') ? null : loadIndex(root, store);
    const idx = buildIndex(root, { previous });
    const dir = saveIndex(root, idx, store);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`code-map: ${idx.rows.length} symbols across ${idx.meta.length} files in ${Math.round(ms)}ms`
      + `${previous ? ` (${idx.scanned} rescanned, ${idx.reused} unchanged)` : ''} -> ${relative(root, dir).split(sep).join('/')}/`);
    process.exit(0);
  }
  if (cmd === 'find') {
    const needle = positional[0];
    if (!needle) { console.error('usage: code-map.mjs find <name>'); process.exit(1); }
    const r = find(root, needle, { index: loadIndex(root, store), limit: Number(value('--limit') || 20) });
    console.log(renderFind(needle, r.hits, r));
    process.exit(r.hits.length ? 0 : 1);
  }
  if (cmd === 'outline') {
    const p = positional[0];
    if (!p) { console.error('usage: code-map.mjs outline <file>'); process.exit(1); }
    const norm = p.replace(/\\/g, '/').replace(`${root.replace(/\\/g, '/')}/`, '');
    console.log(renderOutline(norm, outline(root, norm)));
    process.exit(0);
  }
  if (cmd === 'bench') {
    console.log(renderBench(root, bench(root, { index: loadIndex(root, store) })));
    process.exit(0);
  }
  if (cmd === 'brief' || cmd === 'stats') {
    console.log(renderBrief(root, loadIndex(root, store)));
    process.exit(0);
  }
  if (cmd === 'hook') {
    const sub = positional[0];
    if (sub === 'install') {
      const rawMin = value('--min-lines');
      const minLines = rawMin != null ? Number(rawMin) : undefined;
      if (rawMin != null && (!Number.isFinite(minLines) || minLines <= 0)) {
        console.error('--min-lines must be a positive number');
        process.exit(1);
      }
      const r = hookInstall(root, { minLines });
      console.log(`code-map hook: installed in ${r.path}`);
      console.log(`  ${r.command}`);
      console.log('  per-session off switch: CODE_MAP_HOOK=off · remove: code-map.mjs hook uninstall');
      process.exit(0);
    }
    if (sub === 'uninstall') {
      const r = hookUninstall(root);
      console.log(r.removed
        ? `code-map hook: removed ${r.removed} entr${r.removed > 1 ? 'ies' : 'y'} from ${r.path}`
        : `code-map hook: nothing to remove in ${r.path}`);
      process.exit(0);
    }
    if (sub === 'status') {
      const s = hookStatus(root);
      console.log(`installed:   ${s.installed ? 'yes' : 'no'}  (${s.path})`);
      if (s.command) console.log(`command:     ${s.command}`);
      console.log(`threshold:   ${s.minLines} lines`);
      console.log(`kill switch: ${s.disabled ? 'CODE_MAP_HOOK=off — the hook is DISABLED' : 'not set — active when installed'}`);
      process.exit(0);
    }
    console.error('usage: code-map.mjs hook install [--min-lines N] | uninstall | status  [--root <repo>]');
    process.exit(1);
  }
  console.error('usage: code-map.mjs build|find <name>|outline <file>|brief|bench|hook  [--root <repo>]');
  process.exit(1);
}
