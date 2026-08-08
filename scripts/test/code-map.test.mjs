#!/usr/bin/env node
// code-map.test.mjs — tests for the symbol map and the rediscovery measurement.
//
// The headline property of this tool is not that it is fast or that it saves tokens. It is
// that IT DOES NOT LIE. A location index that is sometimes wrong is worse than no index,
// because an agent acts on it without checking — that is the entire point of having it. So
// the first group below is about one invariant:
//
//     THE INDEX IS A CACHE. THE FILE IS THE SOURCE OF TRUTH. A STALE CACHE PRODUCES A
//     MISS, NEVER A WRONG LOCATION.
//
// Every one of those tests mutates a file AFTER indexing it, which is the only way to tell a
// verified answer apart from a lucky one.
import {
  buildIndex, saveIndex, loadIndex, find, outline, extractSymbols, stripFor, bench, renderFind,
} from '../code-map.mjs';
import { classifySearch, bashNeedle, scanTranscript, measureCorpus, renderTax } from '../code-map-learn.mjs';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, unlinkSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
let ok = 0, fail = 0;
const it = (name, fn) => {
  try { fn(); ok++; if (process.env.VERBOSE) console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); }
};
const itAsync = async (name, fn) => {
  try { await fn(); ok++; if (process.env.VERBOSE) console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'expected truthy'); };
const SB = mkdtempSync(join(tmpdir(), 'code-map-'));

let seq = 0;
function fixture(files) {
  const dir = join(SB, `r${seq++}`);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}
/** Rewrite a file and force a different mtime, the way an editor would. */
function rewrite(dir, rel, body) {
  const p = join(dir, rel);
  writeFileSync(p, body);
  const t = new Date(Date.now() + 4000);
  try { utimesSync(p, t, t); } catch { /* best effort; size usually differs anyway */ }
}
const built = (dir) => { const i = buildIndex(dir); saveIndex(dir, i); return i; };

// ── THE INVARIANT: a stale cache misses, it never lies ────────────────────────────────

it('a symbol that MOVED is reported at its new line, not its indexed one', () => {
  // The single most important test in this file. Without verification the map answers from
  // the cache, is confidently wrong the moment anyone edits above the symbol, and an agent
  // reads the wrong 60 lines and reasons about the wrong code — a failure that looks like
  // the model being stupid rather than the tool being stale.
  const dir = fixture({ 'a.mjs': 'export function target() {}\n' });
  built(dir);
  assert(find(dir, 'target').hits[0].line === 1, 'baseline line should be 1');

  rewrite(dir, 'a.mjs', `${'// padding\n'.repeat(30)}export function target() {}\n`);
  const hit = find(dir, 'target').hits[0];
  assert(hit, 'the symbol was lost after the file changed');
  assert(hit.line === 31, `expected the NEW line 31, got the stale ${hit.line}`);
  assert(hit.restaled, 'the answer should be marked as re-verified after a change');
});

it('a symbol that was DELETED is not reported at all', () => {
  const dir = fixture({ 'a.mjs': 'export function gone() {}\nexport function stays() {}\n' });
  built(dir);
  rewrite(dir, 'a.mjs', 'export function stays() {}\n');
  assert(!find(dir, 'gone').hits.length, 'a deleted symbol was still reported from the cache');
  assert(find(dir, 'stays').hits.length === 1, 'the surviving symbol was lost');
});

it('a file that was DELETED is dropped, not reported', () => {
  const dir = fixture({ 'a.mjs': 'export function orphan() {}\n', 'b.mjs': 'export function kept() {}\n' });
  built(dir);
  unlinkSync(join(dir, 'a.mjs'));
  assert(!find(dir, 'orphan').hits.length, 'a symbol from a deleted file was reported');
  assert(find(dir, 'kept').hits.length === 1, 'an unrelated symbol was lost');
});

it('every reported line actually contains the symbol', () => {
  // A weaker index could return plausible line numbers that drift by one. This checks the
  // contract an agent depends on when it turns `path:line` into `Read(offset, limit)`.
  const dir = fixture({
    'a.mjs': ['// header', '', 'export const alpha = () => 1;', '', 'export function beta() {}', ''].join('\n'),
    'b.py': ['import os', '', 'def gamma():', '    pass', '', 'class Delta:', '    pass'].join('\n'),
  });
  const idx = built(dir);
  for (const r of idx.rows) {
    const line = readFileSync(join(dir, r.path), 'utf8').split('\n')[r.line - 1];
    assert(line.includes(r.name), `${r.path}:${r.line} was indexed as "${r.name}" but that line is ${JSON.stringify(line)}`);
  }
  assert(idx.rows.length >= 4, `expected at least 4 symbols, got ${idx.rows.length}`);
});

it('outline always reads the file, so it cannot be stale at all', () => {
  const dir = fixture({ 'a.mjs': 'export function one() {}\n' });
  built(dir);
  rewrite(dir, 'a.mjs', 'export function one() {}\nexport function two() {}\n');
  const o = outline(dir, 'a.mjs');
  assert(o.symbols.length === 2, `outline used a cache: expected 2 symbols, got ${o.symbols.length}`);
});

// ── Not indexing things that are not code ─────────────────────────────────────────────

it('a symbol named only in a comment or a string is not indexed', () => {
  // The fixture matters more than the assertion here. A line like
  // `// export function ghost() {}` does NOT match `^\s*export` in the first place, so a
  // test built from one passes with comment-stripping REMOVED ENTIRELY and proves nothing —
  // which is exactly what the first version of this test did. The cases below are ones whose
  // RAW line matches the pattern and can only be excluded by the stripper.
  const dir = fixture({
    'a.mjs': [
      '/*',
      'export function ghostInBlock() {}',
      '  ghostMethodInBlock(arg) {',
      '*/',
      '// export function ghostFromComment() {}',
      'const help = "export function ghostFromString() {}";',
      'export function real() {}',
    ].join('\n'),
  });
  const names = built(dir).rows.map((r) => r.name);
  for (const ghost of ['ghostInBlock', 'ghostMethodInBlock', 'ghostFromComment', 'ghostFromString']) {
    assert(!names.includes(ghost), `${ghost} was indexed — the map is partly a reading of prose`);
  }
  assert(names.includes('real'), 'the real export was lost');
});

it('a regex literal containing a quote does not desynchronise the stripper', () => {
  // Same defect, same fix, as code-index.mjs: string state is line-local so the worst case
  // is one wrong line rather than every line after it.
  const dir = fixture({
    'a.mjs': [
      "export const RE = /'(?:[^'\\\\\\n]|\\\\.)*'/;",
      '/*',
      'export function ghost() {}',
      '*/',
      'export function real() {}',
    ].join('\n'),
  });
  const names = built(dir).rows.map((r) => r.name);
  assert(!names.includes('ghost'), 'the stripper desynchronised and indexed a commented-out symbol');
  assert(names.includes('real'), 'the real export after the regex was lost');
});

it('language keywords are never reported as symbols', () => {
  // The looser method/function patterns match `if (x) {` and `while (y) {`. A map whose
  // most common answer to `find if` is a list of every conditional is a map nobody uses
  // twice.
  const dir = fixture({
    'a.mjs': ['class K {', '  if (x) {', '  }', '  while (y) {', '  }', '  realMethod(a) {', '  }', '}'].join('\n'),
  });
  const names = built(dir).rows.map((r) => r.name);
  for (const kw of ['if', 'while', 'for', 'switch', 'catch', 'return']) {
    assert(!names.includes(kw), `"${kw}" was indexed as a symbol`);
  }
  assert(names.includes('realMethod'), 'a real method was missed');
});

it('markdown keeps its # lines, because there comments are content', () => {
  const dir = fixture({ 'r.md': '# Title\n\nsome prose\n\n## Section Two\n' });
  const names = built(dir).rows.map((r) => r.name);
  assert(names.includes('Title') && names.includes('Section Two'), `markdown headings were stripped: ${names}`);
});

it('a declaration inside a python docstring is not a symbol', () => {
  // Docstrings routinely contain example code. Python has no block comment, so without
  // triple-quote handling every `def` in every usage example becomes a symbol, and the map
  // answers "where is X" with a line inside a paragraph of prose.
  const q = '"""';
  const dir = fixture({
    'a.py': ['def real():', `    ${q}`, '    def ghostInDocstring():', '        pass', `    ${q}`, '    return 1'].join('\n'),
  });
  const names = built(dir).rows.map((r) => r.name);
  assert(!names.includes('ghostInDocstring'), 'a def inside a docstring was indexed as a symbol');
  assert(names.includes('real'), 'the real function was lost');
});

it('extractSymbols handles python, go and rust', () => {
  assert(extractSymbols('def handler(req):\n    pass\n', '.py').some((s) => s.name === 'handler'), 'python def missed');
  assert(extractSymbols('class Widget:\n    pass\n', '.py').some((s) => s.name === 'Widget'), 'python class missed');
  assert(extractSymbols('func ServeHTTP(w http.ResponseWriter) {\n}\n', '.go').some((s) => s.name === 'ServeHTTP'), 'go func missed');
  assert(extractSymbols('pub async fn run_job(id: u32) {\n}\n', '.rs').some((s) => s.name === 'run_job'), 'rust fn missed');
  assert(stripFor('.py', 'x = 1  # def ghost():').includes('def ghost') === false, 'python comment not stripped');
});

// ── Determinism and shape ─────────────────────────────────────────────────────────────

it('two builds of an unchanged tree are identical and sorted', () => {
  const dir = fixture({
    'z.mjs': 'export function zeta() {}\n', 'a.mjs': 'export function alpha() {}\n',
    'sub/m.mjs': 'export function mid() {}\n',
  });
  const a = JSON.stringify(buildIndex(dir).rows);
  const b = JSON.stringify(buildIndex(dir).rows);
  assert(a === b, 'two builds of an unchanged tree differed');
  const names = buildIndex(dir).rows.map((r) => r.name);
  assert(String(names) === String([...names].sort()), `rows are not sorted by name: ${names}`);
});

it('find ranks an exact match above a substring match', () => {
  const dir = fixture({
    'a.mjs': 'export function run() {}\n',
    'b.mjs': 'export function runMigrations() {}\n',
    'c.mjs': 'export function prerun() {}\n',
  });
  built(dir);
  assert(find(dir, 'run').hits[0].name === 'run', 'an exact match was not ranked first');
});

it('find prints a slice command with a real offset, not just a line', () => {
  // The entire saving is the difference between Read(file) and Read(file, offset, limit).
  // An agent handed a line number but not the idea still opens the whole file.
  const dir = fixture({ 'a.mjs': `${'// pad\n'.repeat(80)}export function deep() {}\n` });
  built(dir);
  const r = find(dir, 'deep');
  const out = renderFind('deep', r.hits, r);
  assert(/→ Read a\.mjs offset=\d+ limit=\d+/.test(out), `no slice command in the output:\n${out}`);
  const off = Number(out.match(/offset=(\d+)/)[1]);
  assert(off > 1 && off < 81, `the offset should bracket the symbol, got ${off}`);
});

it('a miss says so, and says to fall back to grep', () => {
  const dir = fixture({ 'a.mjs': 'export function only() {}\n' });
  built(dir);
  const r = find(dir, 'nothingLikeThis');
  assert(!r.hits.length, 'invented a hit');
  assert(/Grep/i.test(renderFind('nothingLikeThis', r.hits, r)), 'a miss should send the caller to grep, not leave them stuck');
});

it('bench counts the cases where the map is WORSE than just reading the file', () => {
  // A benchmark that cannot report a loss is marketing. Tiny files are genuinely cheaper to
  // read whole, and the number has to appear next to the headline.
  const dir = fixture({ 'tiny.mjs': 'export function t() {}\n' });
  const b = bench(dir, { index: buildIndex(dir) });
  assert(b.considered === 1, `expected 1 case, got ${b.considered}`);
  assert(b.worse === 1, 'a one-line file should be cheaper to read whole than to slice');
});

// ── The file boundary that stands in for a security boundary ──────────────────────────

it('code-map.mjs cannot read a transcript — it never names the transcript directory', () => {
  // The learning half of this skill reads ~/.claude/projects. The INDEX half must not, and
  // the guarantee is a file boundary: you can audit the transcript-reading surface of the
  // whole plugin by reading one file. A future change that quietly gives the indexer that
  // reach fails here.
  const src = readFileSync(join(HERE, '..', 'code-map.mjs'), 'utf8');
  assert(!/projects/.test(src), 'code-map.mjs references the transcript directory');
  assert(!/homedir|os\.homedir/.test(src), 'code-map.mjs reaches for the home directory');
  assert(!/\.jsonl/.test(src), 'code-map.mjs references transcript files');
});

// ── The measurement half ──────────────────────────────────────────────────────────────

it('classifySearch counts only real location questions as addressable', () => {
  // This classifier decides the honesty of the headline number, so it errs toward "not
  // addressable". Counting regex scans as index-answerable would inflate the claim by about
  // a third, and the claim has to survive someone checking it.
  assert(classifySearch('resolveImport', 'Grep') === 'identifier', 'a bare identifier is a location question');
  assert(classifySearch('**/*.ts', 'Glob') === 'glob', 'a glob is a location question');
  assert(classifySearch('foo|bar', 'Grep') === 'pattern', 'an alternation is a content scan');
  assert(classifySearch('function\\s+x', 'Grep') === 'pattern', 'a regex is a content scan');
  assert(classifySearch('class Foo', 'Grep') === 'pattern', 'a phrase is a content scan');
  assert(classifySearch('ab', 'Grep') === 'pattern', 'too short to be an index key');
  assert(classifySearch('', 'Grep') === 'pattern', 'empty is not a location question');
});

it('bashNeedle finds the needle only in an actual search command', () => {
  assert(bashNeedle('rg "resolveImport" src/') === 'resolveImport', 'quoted needle missed');
  assert(bashNeedle('grep -n foo lib/') === 'foo', 'bare needle missed');
  assert(bashNeedle('npm test') === null, 'a test run was treated as a search');
  assert(bashNeedle('git status') === null, 'a git command was treated as a search');
});

const CANARY = 'sk-ant-CANARY-search-text-must-never-print-7b2e';
const use = (id, name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const res = (id, text) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });

await itAsync('the tax report never prints search text, in any mode', async () => {
  // token-audit's invariant applies here too: this file opens transcripts, and a transcript
  // holds whatever was in the window. `tax` reports counts and byte totals — it has no
  // reason to print a pattern and no code path that can.
  const p = join(SB, 'poisoned.jsonl');
  writeFileSync(p, [
    use('s1', 'Grep', { pattern: CANARY }), res('s1', `matched ${CANARY} in 4 files`),
    use('s2', 'Bash', { command: `rg "${CANARY}" src/` }), res('s2', 'src/x.ts:1'),
    use('s3', 'Glob', { pattern: `**/${CANARY}.ts` }), res('s3', 'nothing'),
    use('r1', 'Read', { file_path: '/repo/a.ts' }), res('r1', 'x'.repeat(500)),
    '{ torn line',
  ].join('\n'));
  const { totals } = await measureCorpus([{ path: p, project: 'proj', size: 1 }]);
  const out = renderTax(totals) + JSON.stringify(totals);
  assert(!out.includes(CANARY), 'THE TAX REPORT PRINTED SEARCH TEXT');
  assert(!out.includes('sk-ant'), 'a credential-shaped fragment reached the output');
  assert(totals.searchCalls === 3, `expected 3 searches counted, got ${totals.searchCalls}`);
});

await itAsync('scanTranscript separates whole-file reads from partial ones', async () => {
  const p = join(SB, 'reads.jsonl');
  writeFileSync(p, [
    use('a', 'Read', { file_path: '/r/a.ts' }), res('a', 'x'.repeat(1000)),
    use('b', 'Read', { file_path: '/r/a.ts' }), res('b', 'x'.repeat(1000)),
    use('c', 'Read', { file_path: '/r/b.ts', offset: 10, limit: 40 }), res('c', 'y'.repeat(100)),
  ].join('\n'));
  const r = await scanTranscript(p);
  assert(r.readCalls === 3, `expected 3 reads, got ${r.readCalls}`);
  assert(r.wholeFileReads === 2, `expected 2 whole-file reads, got ${r.wholeFileReads}`);
  assert(r.withinRereadBytes === 1000, `expected 1000 re-read bytes, got ${r.withinRereadBytes}`);
  assert(r.distinctFilesRead === 2, `expected 2 distinct files, got ${r.distinctFilesRead}`);
});

await itAsync('a file read in a LATER session counts as cross-session rediscovery', async () => {
  // This is the number the whole skill is justified by, so it is pinned against a
  // hand-built two-session fixture rather than against itself.
  const s1 = join(SB, 's1.jsonl'); const s2 = join(SB, 's2.jsonl');
  writeFileSync(s1, [use('a', 'Read', { file_path: '/r/shared.ts' }), res('a', 'x'.repeat(900))].join('\n'));
  writeFileSync(s2, [use('b', 'Read', { file_path: '/r/shared.ts' }), res('b', 'x'.repeat(900))].join('\n'));
  const { totals } = await measureCorpus([
    { path: s1, project: 'p', size: 1 }, { path: s2, project: 'p', size: 1 },
  ]);
  assert(totals.crossReadBytes === 900, `expected 900 bytes of cross-session re-read, got ${totals.crossReadBytes}`);
  // A different project must NOT share the ledger: two repos that both have a `config.ts`
  // are not rediscovering each other's file.
  const { totals: t2 } = await measureCorpus([
    { path: s1, project: 'p', size: 1 }, { path: s2, project: 'OTHER', size: 1 },
  ]);
  assert(t2.crossReadBytes === 0, 'cross-session re-reads leaked across project boundaries');
});

rmSync(SB, { recursive: true, force: true });
console.log(`\ncode-map tests: ${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
