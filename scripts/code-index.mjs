#!/usr/bin/env node
// code-index.mjs — one line per fact: what must I know about this file without opening it?
//
//   node scripts/code-index.mjs             # write the index
//   node scripts/code-index.mjs --check     # fail if the committed index is stale (CI)
//   node scripts/code-index.mjs --stdout    # print it, write nothing
//   node scripts/code-index.mjs --config <f>
//
// ── What this is worth, stated honestly ───────────────────────────────────────────────
//
// Measured saving in its home repo was 1-3.4k tokens per fix, n=1, with a real confound:
// the code was already in context for most of those fixes, so some of that saving is
// attributable to the index and some is not. It is NOT the headline of this project. The
// measurement skill is. This is a modest, reliable saving on a specific shape of question —
// "who breaks if I change this" — that is otherwise answered by reading four files.
//
// ── TWO PROPERTIES, OR IT COSTS MORE THAN IT SAVES ────────────────────────────────────
//
// 1. DETERMINISTIC. Sorted lists, nothing from the clock, nothing from filesystem order, and
//    NO GENERATION DATE. This is meant to sit in a cached prompt prefix; one volatile byte
//    at the top invalidates every token after it, turning a saving into a cost. A generation
//    date is the classic version of this mistake — it looks like provenance and behaves like
//    a cache buster.
//
// 2. DERIVED, NEVER AUTHORED. Nobody edits the index. `--check` in CI is what makes that
//    true rather than aspirational; without it the file drifts and becomes a confident liar.
//
// ── It is config-driven, and that is the whole design ─────────────────────────────────
//
// Roughly 10% of a generator like this binds to a repo's house conventions — the header
// format, the argv dispatch shape, where the guard register lives, how the codebase writes
// emphasis in comments — and that 10% is where all the value is. Hard-coding it produces a
// tool that works beautifully in one repository. See code-index.config.json.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── Configuration ─────────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG = {
  include: ['.mjs', '.js', '.cjs', '.ts', '.mts'],
  exclude: ['node_modules', '.git', 'dist', 'build', 'target', 'coverage', 'vendor'],
  output: 'CODE-INDEX.txt',
  // `// name.ext — what it is`. An em dash, because a hyphen appears in ordinary prose and
  // would claim the first commented line of any file as its description.
  header: { pattern: '^\\s*(?://|#)\\s*\\S+\\s+[—-]{1,2}\\s+(.+?)\\s*$', maxLines: 6 },
  // A file has a CLI only if it reads argv. Otherwise every library mentioning a flag in a
  // help string acquires an imaginary command surface.
  cli: { argvPattern: 'process\\.argv', flagPattern: '--[a-z][a-z0-9-]*' },
  // Emphasis convention: three or more consecutive SHOUTED words inside a comment. This is
  // the house style for "do not undo this without reading why".
  why: { pattern: '\\b([A-Z][A-Z0-9\'’-]*(?:\\s+[A-Z][A-Z0-9\'’-]*){2,})\\b', max: 2 },
  guard: { patterns: ['(^|/)tests?/', '\\.test\\.', '\\.spec\\.', '(^|/)check-', '(^|/)\\.github/'] },
  // Above this share of the ELIGIBLE files, a file is a register and not a caller.
  manifestThreshold: 0.5,
  spawn: { callPattern: '\\b(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\\b' },
};

export function loadConfig(root, file) {
  const path = file ? resolve(file) : join(root, 'code-index.config.json');
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };
  const user = JSON.parse(readFileSync(path, 'utf8'));
  return { ...DEFAULT_CONFIG, ...user, header: { ...DEFAULT_CONFIG.header, ...user.header },
    cli: { ...DEFAULT_CONFIG.cli, ...user.cli }, why: { ...DEFAULT_CONFIG.why, ...user.why },
    guard: { ...DEFAULT_CONFIG.guard, ...user.guard }, spawn: { ...DEFAULT_CONFIG.spawn, ...user.spawn } };
}

// ── The comment stripper ──────────────────────────────────────────────────────────────

/**
 * Remove comments, keep strings, and NEVER change the line count.
 *
 * LINE-BASED AND STATELESS ACROSS LINES, on purpose. The original version tracked string
 * state across the whole file and desynchronised on a regex literal containing a quote —
 *
 *     /'(?:[^'\\\n]|\\.)*'/
 *
 * — where the apostrophe read as an opening quote that never closed, and from that point on
 * every comment in the file was handed back as code. The fix is not a better scanner. A
 * scanner that knows strings but not regexes will always have a case like this, and a real
 * parser is not a defensible dependency for an index. So string state is reset at every
 * newline: the worst case becomes ONE wrong line instead of an entire file, and the failure
 * is local, visible, and bounded.
 *
 * The line count is preserved because WHY facts are `file:line` pointers, and an index that
 * cites the wrong line is worse than one that cites nothing.
 */
export function stripComments(source) {
  const out = [];
  let inBlock = false;
  for (const line of source.split('\n')) {
    let res = '';
    let quote = null;              // reset every line — see above
    for (let i = 0; i < line.length; i++) {
      const c = line[i], next = line[i + 1];
      if (inBlock) { if (c === '*' && next === '/') { inBlock = false; i++; } continue; }
      if (quote) {
        if (c === '\\') { i++; continue; }
        if (c === quote) quote = null;
        res += c;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; res += c; continue; }
      if (c === '/' && next === '/') break;                       // rest of the line is comment
      if (c === '/' && next === '*') { inBlock = true; i++; continue; }
      res += c;
    }
    out.push(res);
  }
  return out.join('\n');
}

// ── Walking ───────────────────────────────────────────────────────────────────────────

/** Sorted at every level: filesystem order must never reach the output. */
function walk(root, cfg, dir = root, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (cfg.exclude.some((x) => e.name === x)) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) walk(root, cfg, abs, out);
    else if (e.isFile() && cfg.include.includes(extname(e.name))) out.push(abs);
  }
  return out;
}

const rel = (root, abs) => relative(root, abs).replace(/\\/g, '/');

// ── Extraction ────────────────────────────────────────────────────────────────────────

function resolveImport(fromRel, spec, byPath) {
  if (!spec.startsWith('.')) return null;                       // a package, not our code
  const base = join(dirname(fromRel), spec).replace(/\\/g, '/');
  for (const cand of [base, `${base}.mjs`, `${base}.js`, `${base}.ts`, `${base}/index.mjs`, `${base}/index.js`]) {
    if (byPath.has(cand)) return cand;
  }
  return null;
}

/**
 * `spawnSync(node, ['run-tests.mjs'])` names a file by BASENAME, from a directory computed at
 * runtime. Resolved only when the basename is unambiguous across the eligible set: two files
 * called `index.mjs` make the reference genuinely undecidable, and guessing between them
 * would put a confident wrong edge in a table whose entire value is that you can trust it
 * without checking.
 */
function uniqueByBasename(lit, byPath) {
  if (lit.includes('/')) return null;
  const hits = [...byPath.keys()].filter((p) => p.endsWith(`/${lit}`) || p === lit);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * A string literal whose CLOSING quote matches its opening one.
 *
 * `/['"]([^'"]*)['"]/` looks equivalent and is not: scanning `f('--file') && g('--json')` it
 * happily pairs the closing quote of one literal with the opening quote of the next and
 * hands back the CODE BETWEEN THEM as a string. That is how a flag written in a regex —
 * `/--dry-run/` — ended up advertised as a command-line option audit.mjs does not accept.
 */
// Backticks included. A test fixture is far more likely to be a template literal than a
// quoted string, and leaving them out let `` `export const v = ${i};` `` count as an export
// of the test file — the same false fact, arriving by the one door left open.
const STRING_RE = /(['"`])((?:\\.|(?!\1)[^\\])*?)\1/gs;

/**
 * Blank out the CONTENTS of string literals, keeping the quotes and the line count.
 *
 * A test file that builds a fixture writes real source inside a string:
 *
 *     'a.mjs': 'export const zeta = 1;'
 *
 * Scanned as code, that made `zeta` an export of the TEST FILE. The index then answered
 * "what does this file define" with a list of names from other files' fixtures — a fact
 * that is wrong, generated, and sorted, which is the most persuasive way to be wrong.
 * DEFINES reads this view; imports read the real one, since a specifier IS its string.
 */
const blankStrings = (code) => code.replace(STRING_RE, (_, q) => q + q);

const IMPORT_RE = /(?:^|[\s;{(=])(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;{(=])import\s*\(\s*['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

export function build(userConfig = {}) {
  const root = resolve(userConfig.root || '.');
  const cfg = { ...DEFAULT_CONFIG, ...userConfig,
    header: { ...DEFAULT_CONFIG.header, ...userConfig.header },
    cli: { ...DEFAULT_CONFIG.cli, ...userConfig.cli },
    why: { ...DEFAULT_CONFIG.why, ...userConfig.why },
    guard: { ...DEFAULT_CONFIG.guard, ...userConfig.guard },
    spawn: { ...DEFAULT_CONFIG.spawn, ...userConfig.spawn } };

  const paths = walk(root, cfg).map((a) => rel(root, a)).sort();
  const byPath = new Map();
  for (const p of paths) {
    let raw; try { raw = readFileSync(join(root, p), 'utf8'); } catch { continue; }
    byPath.set(p, {
      raw,
      code: stripComments(raw),
      // Executable means: it has a shebang. This is the only reliable, cheap signal that a
      // file can be the target of a spawn. See SPAWNEDBY below.
      executable: /^#!/.test(raw),
    });
  }

  // The ELIGIBLE set is the files this index covers — not every file in the tree. The
  // manifest ratio is taken against THIS, and taking it against the whole tree is how a
  // register slips back through as a caller of everything (defect 3 returning by the back
  // door): pad a repo with docs and fixtures and the register suddenly names a "minority".
  const eligible = [...byPath.keys()];
  const eligibleCount = eligible.length;
  const manifestLimit = Math.max(2, Math.floor(eligibleCount * cfg.manifestThreshold));

  const headerRe = new RegExp(cfg.header.pattern);
  const argvRe = new RegExp(cfg.cli.argvPattern);
  const flagRe = new RegExp(cfg.cli.flagPattern, 'g');
  const whyRe = new RegExp(cfg.why.pattern);
  const spawnCallRe = new RegExp(cfg.spawn.callPattern);
  const guardRes = cfg.guard.patterns.map((p) => new RegExp(p));

  const facts = new Map(eligible.map((p) => [p, {
    IS: [], CLI: [], USES: [], IMPORTEDBY: [], SPAWNEDBY: [], GUARD: [], DEFINES: [], WHY: [],
  }]));

  const manifests = new Set();

  // ── Pass 1: everything derivable from a file alone ──────────────────────────────────
  for (const [p, f] of byPath) {
    const F = facts.get(p);

    // IS — from the file's own header, within the first few lines only. A description found
    // 200 lines down is a section heading, not a statement of what the file is.
    for (const line of f.raw.split('\n').slice(0, cfg.header.maxLines)) {
      const m = line.match(headerRe);
      if (m) { F.IS = [m[1]]; break; }
    }

    // CLI — only for files that actually read argv, and only flags appearing as STRING
    // LITERALS. Matching flag-shaped text anywhere in the code picks up regex literals:
    // audit.mjs tests `/--dry-run/` against a git command and does not accept `--dry-run`,
    // so the first version of this advertised a flag that does not exist.
    //
    // Guards are excluded outright. A test file that builds a CLI fixture reads argv and
    // quotes flags, and reporting its "command surface" states something false about the
    // codebase in the confident register of a generated fact.
    const isGuardFile = guardRes.some((re) => re.test(p));
    if (argvRe.test(f.code) && !isGuardFile) {
      const flags = new Set();
      for (const [, , lit] of f.code.matchAll(STRING_RE)) {
        for (const flag of lit.match(flagRe) || []) flags.add(flag);
      }
      F.CLI = [...flags].sort();
    }

    // DEFINES — exported names, read from the string-blanked view. See blankStrings().
    const defs = new Set();
    const noStr = blankStrings(f.code);
    for (const [, name] of noStr.matchAll(/export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) defs.add(name);
    for (const [, names] of noStr.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (const part of names.split(',')) {
        const n = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (n && /^[A-Za-z_$][\w$]*$/.test(n)) defs.add(n);
      }
    }
    if (/export\s+default\b/.test(f.code)) defs.add('default');
    F.DEFINES = [...defs].sort();

    // WHY — a file:line pointer to a load-bearing invariant in the file's OWN comments.
    // Read from the raw source, since the subject is precisely the comments the rest of this
    // generator throws away.
    const lines = f.raw.split('\n');
    const stripped = f.code.split('\n');
    for (let i = 0; i < lines.length && F.WHY.length < cfg.why.max; i++) {
      // A comment line is one the stripper emptied. Deriving it this way instead of matching
      // `//` again means the two views can never disagree about what is a comment.
      if (stripped[i]?.trim()) continue;
      const m = lines[i].match(whyRe);
      if (m && m[1].length >= 12) F.WHY.push(`${p}:${i + 1} ${m[1].trim()}`);
    }
  }

  // ── Pass 2: edges. Comments are gone by construction — pass 1 read `code`, not `raw` ──
  for (const [p, f] of byPath) {
    const uses = new Set();
    for (const re of [IMPORT_RE, BARE_IMPORT_RE]) {
      re.lastIndex = 0;
      for (const m of f.code.matchAll(re)) {
        const spec = m[1] || m[2] || m[3];
        const target = spec && resolveImport(p, spec, byPath);
        if (target && target !== p) uses.add(target);
      }
    }

    // Spawn targets. Four conditions, and every one of them removes a class of false edge
    // that the first construction of this shipped:
    const spawns = new Set();
    if (spawnCallRe.test(f.code)) {
      const codeLines = f.code.split('\n');
      const spawnText = codeLines.filter((l) => spawnCallRe.test(l)).join('\n');
      for (let i = 0; i < codeLines.length; i++) {
        // A literal only counts if it REACHES a spawn call: either it sits on the spawn line
        // itself, or it is assigned to a name that appears in one. Without this, the
        // file-level "does this file spawn anything" gate lets every path-shaped literal in
        // a spawning file become an edge — which is how `join(dir, 'quiet.mjs')` inside a
        // patch RENDERER became "quiet.mjs is spawned by quiet-tests.mjs".
        //
        // Deliberately conservative: a path that reaches a spawn through a loop variable or
        // a second function is NOT found. SPAWNEDBY under-reports rather than inventing, and
        // the README says so. A missing edge costs you one grep; a wrong edge costs you the
        // trust that makes the whole table worth reading.
        const assigned = codeLines[i].match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
        const reaches = spawnCallRe.test(codeLines[i])
          || (assigned && new RegExp(`\\b${assigned[1]}\\b`).test(spawnText));
        if (!reaches) continue;
        // (a) NOT AN IMPORT SPECIFIER. `import … from '../audit.mjs'` names an executable
        //     file in a file that also spawns things, and counting it turns every import
        //     into a spawn — a second, wrong copy of the USES graph.
        if (/^\s*(?:import|export)\b|require\s*\(/.test(codeLines[i])) continue;
        // (b) NOT A FILESYSTEM CALL. `copyFileSync(join(HERE, 'quiet.mjs'), …)` copies a
        //     file; it does not run it. Same literal, entirely different edge.
        if (/\b(readFile|writeFile|copyFile|appendFile|unlink|stat|mkdir|rm)[A-Za-z]*\s*\(/.test(codeLines[i])) continue;
        for (const m of codeLines[i].matchAll(/['"]([^'"\s]+)['"]/g)) {
          // (c) WHITESPACE-FREE, END TO END. `"run tools/x/gen.mjs to rebuild"` is a sentence
          //     addressed to a human, not an argv entry. No real argument has a space in it
          //     by accident, so this costs nothing and removes all of the prose.
          const lit = m[1];
          if (!/\.(m?js|cjs|ts|sh|py)$/.test(lit)) continue;
          const target = resolveImport(p, lit.startsWith('.') ? lit : `./${lit}`, byPath)
            || (byPath.has(lit) ? lit : null)
            || uniqueByBasename(lit, byPath);
          // (d) THE TARGET MUST BE EXECUTABLE. Nine of 25 spawn edges in the original run
          //     pointed at shebang-less libraries, every one produced by a test naming the
          //     path as a grep NEEDLE. Shape cannot tell a needle from an argument;
          //     executability can — a file with no shebang was never spawned by anyone.
          if (target && target !== p && byPath.get(target)?.executable) spawns.add(target);
        }
      }
    }

    // A file naming more than half the eligible population is a REGISTER, not a caller. Left
    // in, it makes the blast radius of every file "everything", which is the same amount of
    // information as saying nothing — while looking like a thorough answer.
    if (uses.size + spawns.size > manifestLimit) {
      manifests.add(p);
      facts.get(p).MANIFEST = ['names most of the tree — treated as a register, not a caller'];
      continue;
    }

    facts.get(p).USES = [...uses].sort();
    // Test files are DELIBERATELY in the caller set. They are the group that breaks first
    // when an export changes; excluding them reported the most reliable early warning in the
    // repo as absent — "nothing depends on this" about a function with four tests on it.
    for (const t of uses) facts.get(t).IMPORTEDBY.push(p);
    for (const t of spawns) facts.get(t).SPAWNEDBY.push(p);

    const isGuard = guardRes.some((re) => re.test(p));
    if (isGuard) for (const t of [...uses, ...spawns]) facts.get(t).GUARD.push(p);
  }

  for (const F of facts.values()) {
    F.IMPORTEDBY.sort(); F.SPAWNEDBY.sort();
    F.GUARD = [...new Set(F.GUARD)].sort();
  }

  return {
    files: eligible.sort().map((p) => ({ path: p, facts: facts.get(p) })),
    eligibleCount,
    manifests: [...manifests].sort(),
  };
}

// ── Rendering ─────────────────────────────────────────────────────────────────────────

const ORDER = ['IS', 'CLI', 'DEFINES', 'USES', 'IMPORTEDBY', 'SPAWNEDBY', 'GUARD', 'MANIFEST', 'WHY'];

/**
 * One line per fact, greppable, and with NO header carrying a date, a version or a count of
 * anything volatile. The two comment lines at the top are constant text.
 */
export function render(index) {
  const L = [
    '# CODE-INDEX — derived by scripts/code-index.mjs. Do not edit; re-run it.',
    '# One line per fact: <path> <KIND> <value>. Sorted and deterministic by construction.',
    '',
  ];
  for (const { path, facts } of index.files) {
    for (const kind of ORDER) {
      const v = facts[kind];
      if (!v || !v.length) continue;
      if (kind === 'WHY') for (const w of v) L.push(`${path}\tWHY\t${w}`);
      else L.push(`${path}\t${kind}\t${v.join(' ')}`);
    }
  }
  return `${L.join('\n')}\n`;
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(n);
  const value = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };

  const root = resolve(value('--root') || process.cwd());
  const cfg = loadConfig(root, value('--config'));
  const out = render(build({ root, ...cfg }));
  const target = join(root, cfg.output);

  if (flag('--stdout')) { process.stdout.write(out); process.exit(0); }

  if (flag('--check')) {
    const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
    if (current === out) { console.log(`code-index: OK (${cfg.output} matches a fresh build)`); process.exit(0); }
    console.error(current === null
      ? `code-index: ${cfg.output} is missing — run: node scripts/code-index.mjs`
      : `code-index: ${cfg.output} is STALE — run: node scripts/code-index.mjs`);
    process.exit(1);
  }

  writeFileSync(target, out);
  console.log(`code-index: wrote ${cfg.output} (${out.split('\n').length - 1} facts across ${build({ root, ...cfg }).files.length} files)`);
}
