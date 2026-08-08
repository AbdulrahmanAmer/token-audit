#!/usr/bin/env node
// code-index.test.mjs — tests for the generated fact table.
//
// Written before the generator, against the five defects it shipped during its first
// construction and the one trap that made its first test suite dead. Every test below names
// the defect it exists for, because a test whose reason is not written down is a test the
// next person deletes when it becomes inconvenient.
//
// ── THE TRAP, and why every semantic test here calls build() ──────────────────────────
//
// The first suite for this read the COMMITTED ARTIFACT instead of a fresh build. A mutated
// generator never rewrites the file, so every semantic assertion stayed green and only the
// staleness check went red — a suite that could tell you the file was out of date but not
// that it was wrong. Nothing below reads the committed index except the one test whose
// subject IS the committed index.
import { build, render, stripComments, loadConfig } from '../code-index.mjs';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let ok = 0, fail = 0;
const it = (name, fn) => {
  try { fn(); ok++; if (process.env.VERBOSE) console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name} — ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'expected truthy'); };
const SB = mkdtempSync(join(tmpdir(), 'code-index-'));

let seq = 0;
/** Build a throwaway repo. Files is {relpath: contents}. */
function fixture(files) {
  const dir = join(SB, `r${seq++}`);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}
const factsFor = (index, path) => index.files.find((f) => f.path === path)?.facts || {};
const fact = (index, path, kind) => factsFor(index, path)[kind] || [];

// ── Determinism ───────────────────────────────────────────────────────────────────────

it('two builds of the same tree render byte-identically', () => {
  // This index is meant to sit in a CACHED PROMPT PREFIX. One volatile byte at the top
  // invalidates everything after it, which turns a token saving into a token cost.
  const dir = fixture({
    'a.mjs': "// a.mjs — the first thing\nimport './b.mjs';\nexport const x = 1;\n",
    'b.mjs': '// b.mjs — the second thing\nexport const y = 2;\n',
  });
  const one = render(build({ root: dir }));
  const two = render(build({ root: dir }));
  assert(one === two, 'two builds of an unchanged tree differed');
});

it('the output carries no date, time or absolute path', () => {
  // A generation date is the classic version of this mistake: it looks like provenance and
  // behaves like a cache buster.
  const dir = fixture({ 'a.mjs': '// a.mjs — thing\nexport const x = 1;\n' });
  const out = render(build({ root: dir }));
  assert(!/\d{4}-\d{2}-\d{2}/.test(out), 'the index contains a date');
  assert(!/\d{2}:\d{2}:\d{2}/.test(out), 'the index contains a time');
  assert(!/generated|timestamp/i.test(out), 'the index advertises when it was generated');
  assert(!out.includes(SB) && !/^[A-Za-z]:\\/m.test(out), 'the index contains an absolute path');
});

it('file order and fact order do not depend on the filesystem', () => {
  const dir = fixture({
    'z.mjs': "// z.mjs — last\nimport './m.mjs';\nimport './a.mjs';\n",
    'a.mjs': '// a.mjs — first\nexport const a = 1;\n',
    'm.mjs': '// m.mjs — middle\nexport const m = 1;\n',
  });
  const idx = build({ root: dir });
  const paths = idx.files.map((f) => f.path);
  assert(String(paths) === String([...paths].sort()), `files are not sorted: ${paths}`);
  const uses = fact(idx, 'z.mjs', 'USES');
  assert(String(uses) === String([...uses].sort()), `USES is not sorted: ${uses}`);
});

// ── DEFECT 1: a path named in a COMMENT became a call edge ────────────────────────────

it('DEFECT 1: a path mentioned in a comment is not an edge', () => {
  // Repo comments cite other files constantly — "see scripts/audit.mjs for the invariant".
  // Counting those made the graph partly a reading of the codebase's own prose, which is
  // worse than an incomplete graph because it is confidently wrong.
  const dir = fixture({
    'a.mjs': [
      '// a.mjs — mentions things it does not use',
      // A COMMENTED-OUT IMPORT is the case that actually bit. Prose citing a path is
      // harmless — it never matches an import pattern in the first place, so a fixture
      // built from prose passes with the stripper REMOVED and proves nothing. This one
      // fails immediately without it.
      "// import { v } from './victim.mjs';",
      "/* import './victim.mjs'; */",
      "import './real.mjs';",
      "export const x = 1; // import './victim.mjs';",
    ].join('\n'),
    'real.mjs': '// real.mjs — actually imported\nexport const r = 1;\n',
    'victim.mjs': '// victim.mjs — only ever mentioned\nexport const v = 1;\n',
  });
  const idx = build({ root: dir });
  assert(!fact(idx, 'a.mjs', 'USES').includes('victim.mjs'), 'a comment mention became a USES edge');
  assert(fact(idx, 'a.mjs', 'USES').includes('real.mjs'), 'the real import was lost');
  assert(!fact(idx, 'victim.mjs', 'IMPORTEDBY').includes('a.mjs'), 'a comment mention became an IMPORTEDBY edge');
});

// ── DEFECT 2: the comment stripper desynchronised on a regex literal ──────────────────

it('DEFECT 2: a regex literal containing a quote does not desynchronise the stripper', () => {
  // The original scanner knew strings but not regexes. On this line it saw the apostrophe
  // inside /'(?:[^'\\\n]|\\.)*'/ as an opening quote that never closed, and from there every
  // later comment in the file was treated as code. The fix is not a better scanner — it is
  // to make the string state LINE-LOCAL, so the worst case is one wrong line instead of a
  // whole file. A real parser is not a defensible dependency for an index.
  const dir = fixture({
    'a.mjs': [
      '// a.mjs — contains the regex that broke the scanner',
      "export const RE = /'(?:[^'\\\\\\n]|\\\\.)*'/;",
      // A commented-out import AFTER the regex line. With string state carried across
      // lines, the unterminated apostrophe inside the regex makes the stripper treat this
      // line as code, and the dead import comes back to life as an edge.
      "// import { v } from './victim.mjs';",
      "import './real.mjs';",
    ].join('\n'),
    'real.mjs': '// real.mjs — real\nexport const r = 1;\n',
    'victim.mjs': '// victim.mjs — mentioned only after the regex line\nexport const v = 1;\n',
  });
  const idx = build({ root: dir });
  assert(!fact(idx, 'a.mjs', 'USES').includes('victim.mjs'),
    'the stripper desynchronised on a regex literal and let a later comment through');
  assert(fact(idx, 'a.mjs', 'USES').includes('real.mjs'), 'the real import after the regex was lost');
});

it('DEFECT 2b: a quote inside a comment does not swallow the rest of the file', () => {
  const dir = fixture({
    'a.mjs': [
      "// a.mjs — don't let this apostrophe open a string",
      "// import { v } from './victim.mjs';",
      "import './real.mjs';",
    ].join('\n'),
    'real.mjs': '// real.mjs — real\nexport const r = 1;\n',
    'victim.mjs': '// victim.mjs — mentioned\nexport const v = 1;\n',
  });
  const idx = build({ root: dir });
  assert(!fact(idx, 'a.mjs', 'USES').includes('victim.mjs'), "an apostrophe in a comment desynchronised the stripper");
  assert(fact(idx, 'a.mjs', 'USES').includes('real.mjs'), 'the real import was lost');
});

it('stripComments keeps strings intact and removes only comments', () => {
  const src = [
    "const a = 'http://not-a-comment';",
    'const b = 1; // gone',
    '/* gone */ const c = 2;',
    'const d = "keep // this";',
  ].join('\n');
  const out = stripComments(src);
  assert(out.includes('http://not-a-comment'), 'a URL inside a string was treated as a comment');
  assert(!out.includes('gone'), 'a comment survived');
  assert(out.includes('keep // this'), 'a comment marker inside a string was stripped');
  assert(out.split('\n').length === src.split('\n').length, 'stripping changed the line count — file:line facts would be wrong');
});

// ── DEFECT 3: a register naming every file became a caller of every file ──────────────

it('DEFECT 3: a file naming most of the tree is a manifest, not a caller', () => {
  const files = { 'register.mjs': '// register.mjs — names everything\n' };
  for (let i = 0; i < 10; i++) files[`m${i}.mjs`] = `// m${i}.mjs — a module\nexport const v = ${i};\n`;
  files['register.mjs'] += [...Array(10)].map((_, i) => `import './m${i}.mjs';`).join('\n');
  const idx = build({ root: fixture(files) });
  assert(!fact(idx, 'm3.mjs', 'IMPORTEDBY').includes('register.mjs'),
    'a register naming every file was reported as a caller of every file — the blast radius of every file becomes "everything", which is the same as saying nothing');
  assert(factsFor(idx, 'register.mjs').MANIFEST, 'the register was not labelled a manifest');
});

it('DEFECT 3b: the manifest ratio is taken against the ELIGIBLE set, not the whole tree', () => {
  // Same register, same 3 eligible modules — but the tree is padded with files the index
  // does not cover (docs, fixtures, data). Against the WHOLE tree the register names a small
  // minority and slips through as a caller; against the ELIGIBLE set it is plainly a
  // manifest. Getting this denominator wrong is how defect 3 comes back.
  const files = {
    'register.mjs': "// register.mjs — names everything eligible\nimport './m0.mjs';\nimport './m1.mjs';\nimport './m2.mjs';\n",
    'm0.mjs': '// m0.mjs — a\nexport const a = 1;\n',
    'm1.mjs': '// m1.mjs — b\nexport const b = 1;\n',
    'm2.mjs': '// m2.mjs — c\nexport const c = 1;\n',
  };
  for (let i = 0; i < 40; i++) files[`docs/note${i}.md`] = `not code ${i}\n`;
  const idx = build({ root: fixture(files) });
  assert(idx.eligibleCount === 4, `eligible set should be the 4 indexed files, got ${idx.eligibleCount}`);
  assert(factsFor(idx, 'register.mjs').MANIFEST,
    'the ratio was taken against the whole tree, so the register slipped through as a caller');
});

it('a file importing a normal number of modules is NOT a manifest', () => {
  const files = { 'a.mjs': "// a.mjs — normal\nimport './m0.mjs';\n" };
  for (let i = 0; i < 10; i++) files[`m${i}.mjs`] = `// m${i}.mjs — mod\nexport const v = ${i};\n`;
  const idx = build({ root: fixture(files) });
  assert(!factsFor(idx, 'a.mjs').MANIFEST, 'a normal importer was suppressed as a manifest');
  assert(fact(idx, 'm0.mjs', 'IMPORTEDBY').includes('a.mjs'), 'a real edge was suppressed');
});

// ── DEFECT 4: test files were excluded from the caller set ────────────────────────────

it('DEFECT 4: test files are in the caller set', () => {
  // Tests are the group that BREAKS FIRST when you change an export. Excluding them
  // reported the most reliable early-warning callers in the repo as absent — the blast
  // radius said "nothing depends on this" about a function with four tests on it.
  const dir = fixture({
    'lib.mjs': '// lib.mjs — the thing under test\nexport const f = () => 1;\n',
    'test/lib.test.mjs': "// lib.test.mjs — tests lib\nimport { f } from '../lib.mjs';\nf();\n",
  });
  const idx = build({ root: dir });
  assert(fact(idx, 'lib.mjs', 'IMPORTEDBY').includes('test/lib.test.mjs'),
    'a test file was excluded from the caller set — the group that breaks first, reported as absent');
  assert(fact(idx, 'lib.mjs', 'GUARD').includes('test/lib.test.mjs'), 'the test was not recorded as a guard');
});

// ── DEFECT 5: a spawn target must be executable ───────────────────────────────────────

it('DEFECT 5: a shebang-less library named as a grep needle is not a spawn edge', () => {
  // Nine of 25 spawn edges in the original run pointed at libraries that cannot be executed,
  // every one produced by a TEST naming the path as a grep needle. Shape cannot tell a
  // needle from an argument. Executability can: a file with no shebang was never spawned.
  const dir = fixture({
    'runner.mjs': [
      '#!/usr/bin/env node',
      '// runner.mjs — spawns things',
      "import { spawnSync } from 'node:child_process';",
      "spawnSync('node', ['tool.mjs']);",
      "spawnSync('rg', ['lib.mjs', 'src/']);",
      '',
    ].join('\n'),
    'tool.mjs': '#!/usr/bin/env node\n// tool.mjs — executable\nconsole.log(1);\n',
    'lib.mjs': '// lib.mjs — a library, no shebang, cannot be spawned\nexport const l = 1;\n',
  });
  const idx = build({ root: dir });
  assert(fact(idx, 'tool.mjs', 'SPAWNEDBY').includes('runner.mjs'), 'a real spawn edge was lost');
  assert(!fact(idx, 'lib.mjs', 'SPAWNEDBY').includes('runner.mjs'),
    'a shebang-less library named as a grep needle became a spawn edge');
});

it('DEFECT 5b: a path inside a sentence is not a spawn edge', () => {
  // `"run tools/x/gen.mjs to rebuild"` is a message addressed to a HUMAN. Requiring the
  // string literal to be whitespace-free end to end is what separates an argument from
  // prose, and it costs nothing: no real argv entry has a space in it by accident.
  const dir = fixture({
    'runner.mjs': [
      '#!/usr/bin/env node',
      '// runner.mjs — prints advice',
      "import { spawnSync } from 'node:child_process';",
      'console.log("run tool.mjs to rebuild the index");',
      "spawnSync('node', ['other.mjs']);",
      '',
    ].join('\n'),
    'tool.mjs': '#!/usr/bin/env node\n// tool.mjs — executable but only ever mentioned\nconsole.log(1);\n',
    'other.mjs': '#!/usr/bin/env node\n// other.mjs — genuinely spawned\nconsole.log(2);\n',
  });
  const idx = build({ root: dir });
  assert(!fact(idx, 'tool.mjs', 'SPAWNEDBY').includes('runner.mjs'),
    'a path inside an English sentence became a spawn edge');
  assert(fact(idx, 'other.mjs', 'SPAWNEDBY').includes('runner.mjs'), 'the real spawn edge was lost');
});

it('DEFECT 5c: an import specifier is not a spawn edge', () => {
  // Found by running the generator on this repository and reading the result. A file that
  // both imports an executable module and spawns something turned every import into a spawn
  // — a second, wrong copy of the USES graph, wearing a different label.
  const dir = fixture({
    'test/test.mjs': [
      '#!/usr/bin/env node',
      '// test.mjs — imports one thing and spawns another',
      "import { f } from '../lib/tool.mjs';",
      "import { spawnSync } from 'node:child_process';",
      "spawnSync('node', ['../other.mjs']);",
      'f();',
    ].join('\n'),
    'lib/tool.mjs': '#!/usr/bin/env node\n// tool.mjs — executable AND imported\nexport const f = () => 1;\n',
    'other.mjs': '#!/usr/bin/env node\n// other.mjs — actually spawned\nconsole.log(1);\n',
  });
  const idx = build({ root: dir });
  assert(!fact(idx, 'lib/tool.mjs', 'SPAWNEDBY').includes('test/test.mjs'),
    'an import specifier became a spawn edge — SPAWNEDBY is now a wrong copy of USES');
  assert(fact(idx, 'lib/tool.mjs', 'IMPORTEDBY').includes('test/test.mjs'), 'the import edge was lost');
  assert(fact(idx, 'other.mjs', 'SPAWNEDBY').includes('test/test.mjs'), 'the real spawn edge was lost');
});

it('DEFECT 5d: a file COPIED is not a file SPAWNED', () => {
  // Also found by reading the generator's output for this repo: quiet-tests.mjs copies
  // quiet.mjs into a target repo. Same literal, same executable target, entirely different
  // edge — and "who runs this" answering "the thing that copies it" is a wrong answer to
  // the one question SPAWNEDBY exists to answer.
  const dir = fixture({
    'copier.mjs': [
      '#!/usr/bin/env node',
      '// copier.mjs — copies one file, spawns another',
      "import { copyFileSync } from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      "copyFileSync(join(HERE, 'payload.mjs'), dest);",
      "spawnSync('node', ['runner.mjs']);",
    ].join('\n'),
    'payload.mjs': '#!/usr/bin/env node\n// payload.mjs — copied, never run here\nconsole.log(1);\n',
    'runner.mjs': '#!/usr/bin/env node\n// runner.mjs — genuinely spawned\nconsole.log(2);\n',
  });
  const idx = build({ root: dir });
  assert(!fact(idx, 'payload.mjs', 'SPAWNEDBY').includes('copier.mjs'), 'a copied file was reported as spawned');
  assert(fact(idx, 'runner.mjs', 'SPAWNEDBY').includes('copier.mjs'), 'the real spawn edge was lost');
});

it('CLI ignores a flag-shaped regex literal, and guards get no CLI at all', () => {
  // Found the same way. `/--dry-run/.test(cmd)` is a file INSPECTING a flag, not accepting
  // one, and the first version advertised a flag that does not exist. A generated fact table
  // that invents a command surface is worse than no table: it is wrong in the register of
  // something checked.
  const dir = fixture({
    'cli.mjs': [
      '#!/usr/bin/env node',
      '// cli.mjs — a real command line',
      'const argv = process.argv.slice(2);',
      "if (argv.includes('--json')) {}",
      'if (/--dry-run/.test(other)) {}',
      '',
    ].join('\n'),
    'test/cli.test.mjs': [
      '#!/usr/bin/env node',
      '// cli.test.mjs — builds a CLI fixture, and therefore looks like a CLI',
      "const fixture = \"const argv = process.argv; argv.includes('--check')\";",
      '',
    ].join('\n'),
  });
  const idx = build({ root: dir });
  assert(String(fact(idx, 'cli.mjs', 'CLI')) === '--json', `a regex literal became a flag: ${fact(idx, 'cli.mjs', 'CLI')}`);
  assert(fact(idx, 'test/cli.test.mjs', 'CLI').length === 0, 'a test fixture was reported as a command surface');
});

// ── The fact kinds ────────────────────────────────────────────────────────────────────

it('IS comes from the file\'s own header, and is config-driven', () => {
  const dir = fixture({ 'a.mjs': '#!/usr/bin/env node\n// a.mjs — what this file is\nexport const x = 1;\n' });
  assert(fact(build({ root: dir }), 'a.mjs', 'IS')[0] === 'what this file is', 'IS was not read from the header');
  // ~10% of a generator like this binds to house conventions, and that 10% is where all the
  // value is. So the header shape is configuration, not a constant.
  const dir2 = fixture({ 'a.mjs': '# a.mjs: what this file is\nexport const x = 1;\n' });
  const idx2 = build({ root: dir2, header: { pattern: '^#\\s*\\S+:\\s*(.+)$' } });
  assert(fact(idx2, 'a.mjs', 'IS')[0] === 'what this file is', 'a configured header shape was not honoured');
});

it('CLI comes from the argv dispatch, not from every string in the file', () => {
  const dir = fixture({
    'cli.mjs': [
      '#!/usr/bin/env node',
      '// cli.mjs — a command line',
      'const argv = process.argv.slice(2);',
      "if (argv.includes('--json')) {}",
      "if (argv.includes('--check')) {}",
      '',
    ].join('\n'),
    'lib.mjs': "// lib.mjs — mentions --json but has no argv dispatch\nexport const help = '--json prints json';\n",
  });
  const idx = build({ root: dir });
  assert(String(fact(idx, 'cli.mjs', 'CLI')) === '--check,--json', `expected sorted flags, got ${fact(idx, 'cli.mjs', 'CLI')}`);
  assert(fact(idx, 'lib.mjs', 'CLI').length === 0, 'a library with no argv dispatch was given a CLI surface');
});

it('DEFINES lists exported names, sorted', () => {
  const dir = fixture({
    'a.mjs': [
      '// a.mjs — exports things',
      'export const zeta = 1;',
      'export function alpha() {}',
      'export class Mid {}',
      'const private_ = 2;',
      '',
    ].join('\n'),
  });
  const d = fact(build({ root: dir }), 'a.mjs', 'DEFINES');
  assert(String(d) === 'Mid,alpha,zeta', `expected sorted exports, got ${d}`);
  assert(!d.includes('private_'), 'a non-exported name was reported as defined');
});

it('DEFINES ignores exports written inside string and template fixtures', () => {
  // Found by reading this generator's output for its own repository: a test file that builds
  // fixtures writes real source inside strings, and scanning that as code made other files'
  // fixture names the test file's exports. Template literals are the door that stayed open
  // after quoted strings were closed — and a fixture is far more likely to be a template.
  const dir = fixture({
    'suite.test.mjs': [
      '// suite.test.mjs — builds fixtures out of source text',
      "const a = 'export const fromQuoted = 1;';",
      'const b = `export const fromTemplate = ${n};`;',
      'export const realExport = 1;',
      '',
    ].join('\n'),
  });
  const d = fact(build({ root: dir }), 'suite.test.mjs', 'DEFINES');
  assert(String(d) === 'realExport', `fixture text leaked into DEFINES: ${d}`);
});

it('WHY points at a file:line of a load-bearing invariant in the file\'s own comments', () => {
  const dir = fixture({
    'a.mjs': [
      '// a.mjs — has an invariant',
      '//',
      '//     NO TOOL-RESULT CONTENT IS EVER PRINTED',
      '//',
      'export const x = 1;',
    ].join('\n'),
  });
  const why = fact(build({ root: dir }), 'a.mjs', 'WHY');
  assert(why.length === 1, `expected one invariant, got ${why.length}`);
  assert(why[0].startsWith('a.mjs:3'), `expected a file:line pointer at line 3, got ${why[0]}`);
});

it('GUARD names who checks a file', () => {
  const dir = fixture({
    'lib.mjs': '// lib.mjs — checked\nexport const f = 1;\n',
    'test/lib.test.mjs': "// lib.test.mjs — the test\nimport { f } from '../lib.mjs';\n",
  });
  assert(fact(build({ root: dir }), 'lib.mjs', 'GUARD').includes('test/lib.test.mjs'), 'the guard was not found');
});

// ── --check, against a FRESH build ────────────────────────────────────────────────────

it('the committed index matches a fresh build of this repository', () => {
  // The ONLY test here that touches the committed artifact, because the artifact is its
  // subject. Everything else asserts against build() — see the note at the top of this file.
  const expected = render(build({ root: REPO, ...loadConfig(REPO) }));
  const path = join(REPO, 'CODE-INDEX.txt');
  assert(existsSync(path), 'CODE-INDEX.txt is missing — run `node scripts/code-index.mjs`');
  const actual = readFileSync(path, 'utf8');
  assert(actual === expected, 'CODE-INDEX.txt is stale — run `node scripts/code-index.mjs` and commit the result');
});

it('a changed tree produces a changed index — the staleness check can actually fail', () => {
  // A staleness check that cannot go red is decoration. This proves the comparison has teeth
  // before anyone relies on it in CI.
  const dir = fixture({ 'a.mjs': '// a.mjs — one\nexport const x = 1;\n' });
  const before = render(build({ root: dir }));
  writeFileSync(join(dir, 'b.mjs'), '// b.mjs — two\nexport const y = 2;\n');
  assert(render(build({ root: dir })) !== before, 'adding a file did not change the index');
});

rmSync(SB, { recursive: true, force: true });
console.log(`\ncode-index tests: ${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
