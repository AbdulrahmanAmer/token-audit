#!/usr/bin/env node
// check-manifests.mjs — the two manifests and the skill must agree about what this is.
//
// A plugin repo carries the same facts in three places: plugin.json (what gets installed),
// marketplace.json (what the repo advertises when it is added as a marketplace) and the
// skill's own frontmatter. Nothing makes them agree, and the failure is quiet — a
// marketplace entry pointing at a name the plugin no longer has installs nothing, with no
// error anyone sees until a user reports that the install "did nothing".

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

const readJson = (rel) => {
  try { return JSON.parse(readFileSync(join(ROOT, rel), 'utf8')); }
  catch (e) { errors.push(`${rel}: ${e.message}`); return null; }
};

const plugin = readJson('.claude-plugin/plugin.json');
const market = readJson('.claude-plugin/marketplace.json');

if (plugin && market) {
  const entry = (market.plugins || []).find((p) => p.name === plugin.name);
  if (!entry) {
    errors.push(
      `marketplace.json advertises [${(market.plugins || []).map((p) => p.name).join(', ') || 'nothing'}] ` +
      `but plugin.json is named "${plugin.name}" — installing from this repo would resolve to nothing.`);
  } else if (entry.source !== './') {
    errors.push(`marketplace entry "${entry.name}" has source "${entry.source}"; this repo IS the plugin, so it must be "./".`);
  }
  for (const field of ['homepage', 'repository']) {
    if (plugin[field] && !/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(plugin[field])) {
      errors.push(`plugin.json ${field} should be the plain repo URL, got "${plugin[field]}"`);
    }
  }
}

// ── Skills ────────────────────────────────────────────────────────────────────────────
//
// Every skill on disk must declare the plugin's version and its own directory name, and must
// be ADVERTISED in the README. Both directions are failures, and both are quiet:
//
//   shipped but not advertised — the user installs a capability nobody tells them about, so
//     it fires unexpectedly and reads as the assistant doing something it was not asked to.
//   advertised but missing — the README documents a skill that does not install. The user
//     asks for it, nothing happens, and the plugin looks broken rather than incomplete.
//
// The README is the register because it is the thing a stranger actually reads before
// installing. A table row there is the advertisement.
const skillsDir = join(ROOT, 'skills');
const onDisk = existsSync(skillsDir)
  ? readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
  : [];

if (!onDisk.length) errors.push('skills/ is empty — the plugin would install with no skill.');

for (const name of onDisk) {
  const skillPath = join(skillsDir, name, 'SKILL.md');
  if (!existsSync(skillPath)) { errors.push(`skills/${name}/ has no SKILL.md`); continue; }
  const md = readFileSync(skillPath, 'utf8');
  const m = md.match(/^\s*version:\s*"?([\d.]+)"?\s*$/m);
  if (!m) errors.push(`skills/${name}/SKILL.md declares no metadata.version`);
  else if (plugin && m[1] !== plugin.version) {
    errors.push(`skills/${name}/SKILL.md version ${m[1]} != plugin.json version ${plugin.version}`);
  }
  // The frontmatter name is what the skill is addressed by; a mismatch with the directory
  // makes it load under a name the docs never mention.
  if (!new RegExp(`^name:\\s*${name}\\s*$`, 'm').test(md)) {
    errors.push(`skills/${name}/SKILL.md name must be "${name}" to match its directory`);
  }
  // A description is what the model matches on. An empty one means the skill never fires.
  const desc = md.match(/^description:\s*(.+)$/m);
  if (!desc || desc[1].trim().length < 40) {
    errors.push(`skills/${name}/SKILL.md needs a description long enough to be matched on`);
  }
}

const readme = existsSync(join(ROOT, 'README.md')) ? readFileSync(join(ROOT, 'README.md'), 'utf8') : '';
for (const name of onDisk) {
  if (!new RegExp(`\`${name}\``).test(readme)) {
    errors.push(`skills/${name}/ ships but README.md never mentions \`${name}\` — a capability nobody is told about.`);
  }
}
// The other direction: the README's skill table listing something that does not exist.
for (const [, advertised] of readme.matchAll(/^\|\s*`([a-z][a-z0-9-]+)`\s*\|/gm)) {
  if (!onDisk.includes(advertised)) {
    errors.push(`README.md advertises skill \`${advertised}\` but skills/${advertised}/ does not exist.`);
  }
}

// ── Referenced scripts ────────────────────────────────────────────────────────────────
//
// Every script a skill or command tells a user to run must exist. A documented flag that
// does not exist is the same class of defect as a broken link, and cheaper to catch here.
// Derived from the skill and command bodies rather than listed, so a new script referenced
// in a new skill is checked without anyone remembering to add it.
const referenced = new Set(['scripts/audit.mjs', 'scripts/test/run-all.mjs']);
const bodies = [
  ...onDisk.map((n) => join(skillsDir, n, 'SKILL.md')),
  ...(existsSync(join(ROOT, 'commands')) ? readdirSync(join(ROOT, 'commands')).map((f) => join(ROOT, 'commands', f)) : []),
].filter(existsSync);
for (const f of bodies) {
  for (const [, rel] of readFileSync(f, 'utf8').matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+\.mjs)/g)) referenced.add(rel);
}
for (const rel of [...referenced].sort()) {
  if (!existsSync(join(ROOT, rel))) errors.push(`${rel} is referenced by a skill or command but missing`);
}

if (errors.length) {
  for (const e of errors) console.error(`ERROR ${e}`);
  console.error(`check-manifests: ${errors.length} problem(s)`);
  process.exit(1);
}
console.log(`check-manifests: OK (plugin "${plugin.name}" v${plugin.version}, advertised by its own marketplace)`);
