#!/usr/bin/env node
// check-manifests.mjs — the two manifests and the skill must agree about what this is.
//
// A plugin repo carries the same facts in three places: plugin.json (what gets installed),
// marketplace.json (what the repo advertises when it is added as a marketplace) and the
// skill's own frontmatter. Nothing makes them agree, and the failure is quiet — a
// marketplace entry pointing at a name the plugin no longer has installs nothing, with no
// error anyone sees until a user reports that the install "did nothing".

import { readFileSync, existsSync } from 'node:fs';
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

// The skill's declared version must match the plugin's, because that is the number a user
// reads back when reporting a bug.
const skillPath = join(ROOT, 'skills', 'token-audit', 'SKILL.md');
if (!existsSync(skillPath)) {
  errors.push('skills/token-audit/SKILL.md is missing — the plugin would install with no skill.');
} else if (plugin) {
  const md = readFileSync(skillPath, 'utf8');
  const m = md.match(/^\s*version:\s*"?([\d.]+)"?\s*$/m);
  if (!m) errors.push('SKILL.md declares no metadata.version');
  else if (m[1] !== plugin.version) {
    errors.push(`SKILL.md version ${m[1]} != plugin.json version ${plugin.version}`);
  }
  if (!/^name:\s*token-audit\s*$/m.test(md)) errors.push('SKILL.md name must be "token-audit"');
}

// Every script the skill and command tell a user to run must exist. A documented flag that
// does not exist is the same class of defect as a broken link, and cheaper to catch here.
for (const rel of ['scripts/audit.mjs', 'scripts/test/run-tests.mjs']) {
  if (!existsSync(join(ROOT, rel))) errors.push(`${rel} is referenced but missing`);
}

if (errors.length) {
  for (const e of errors) console.error(`ERROR ${e}`);
  console.error(`check-manifests: ${errors.length} problem(s)`);
  process.exit(1);
}
console.log(`check-manifests: OK (plugin "${plugin.name}" v${plugin.version}, advertised by its own marketplace)`);
