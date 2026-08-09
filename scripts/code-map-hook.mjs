#!/usr/bin/env node
// code-map-hook.mjs — a PreToolUse hook on Read. This is the part that actually works.
//
// ── Why this exists, and why the skill did not ────────────────────────────────────────
//
// `code-map` shipped as a skill. Measured across 30 runs in which it was installed and
// advertised in the model's own skills listing — under two different descriptions, one of
// which said outright "run this BEFORE reaching for Grep" — it was invoked **zero times**.
//
// The reason is not the wording. A skill needs the model to CHOOSE it, and the model already
// has a tool that answers the question correctly: it reads the file. A hook does not need to
// be chosen. It fires on the call the model was already making.
//
//     34% of every token in a 589-session corpus was a whole-file read.
//     The median whole-file read on a 99k-line repo: 2,794 tok.  Its outline: 190 tok.
//
// So: when the model asks for an entire large source file, hand it the map instead and let it
// come back for the 60 lines it actually wants.
//
// ── The economics, which are not obvious ──────────────────────────────────────────────
//
// This trades one extra round trip for a much smaller read, and that is a good trade only
// because of how the bill is shaped. Measured from real `usage` records:
//
//     cache WRITE  $6.25/MTok   ← what a big file costs when it enters context
//     cache READ   $0.50/MTok   ← what re-sending the conversation costs on the extra turn
//
// A cache read is 12.5x cheaper than a cache write. Avoiding a 19,580-token file read avoids
// an expensive write; the extra turn it costs is billed at the cheap rate. That asymmetry is
// the whole reason this is worth doing, and it is why the threshold below is expressed in
// lines rather than being always-on: below it, the extra turn costs more than the file did.
//
// ── FAIL OPEN, ALWAYS ─────────────────────────────────────────────────────────────────
//
// This sits in front of Read, the most load-bearing tool there is. Every failure path here
// allows the read: unsupported language, unreadable file, no symbols found, small file, any
// thrown error, malformed input. A hook that blocks a read it did not understand would break
// the agent for the sake of a token saving, which is a catastrophically bad trade.
//
//   Disable entirely:  CODE_MAP_HOOK=off
//   Change threshold:  CODE_MAP_HOOK_MIN_LINES=500   (default 300)

import { readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute } from 'node:path';

const MIN_LINES = Number(process.env.CODE_MAP_HOOK_MIN_LINES || 300);
const ALLOW = () => { process.stdout.write('{}'); process.exit(0); };

/** Everything below is best-effort. Any doubt at all -> allow the read. */
async function main() {
  if (process.env.CODE_MAP_HOOK === 'off') return ALLOW();

  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let ev; try { ev = JSON.parse(raw); } catch { return ALLOW(); }

  if (ev.hook_event_name !== 'PreToolUse' || ev.tool_name !== 'Read') return ALLOW();

  const input = ev.tool_input || {};
  // An explicit slice is the behaviour we are trying to encourage. Never interfere with it.
  if (input.offset != null || input.limit != null) return ALLOW();

  const file = input.file_path;
  if (!file || typeof file !== 'string' || !isAbsolute(file)) return ALLOW();

  let src;
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > 2 * 1024 * 1024) return ALLOW();
    src = readFileSync(file, 'utf8');
  } catch { return ALLOW(); }

  const lines = src.split('\n');
  if (lines.length < MIN_LINES) return ALLOW();          // small file: reading it is cheaper

  let symbols;
  try {
    const { extractSymbols } = await import('./code-map.mjs');
    symbols = extractSymbols(src, extname(file));
  } catch { return ALLOW(); }

  // No symbols means this is data, prose, or a language the extractor does not know. The
  // outline would be worse than useless, so get out of the way.
  if (!symbols || symbols.length < 3) return ALLOW();

  const shown = symbols.slice(0, 200);
  const table = shown.map((s) => `${String(s.line).padStart(5)}  ${s.kind.padEnd(9)} ${s.name}`).join('\n');
  const approxWhole = Math.round(src.length / 3.6);

  const reason = [
    `Reading this whole file costs ~${approxWhole.toLocaleString()} tokens (${lines.length} lines).`,
    `Here is its structure instead — every symbol with its line number:`,
    '',
    table,
    shown.length < symbols.length ? `  … ${symbols.length - shown.length} more` : '',
    '',
    'Call Read again with `offset` and `limit` around the line you need — 60 lines is usually',
    'plenty. If you genuinely need the entire file, call Read again with `offset: 1` and a',
    `\`limit\` of ${lines.length} and it will be served in full.`,
  ].filter(Boolean).join('\n');

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

main().catch(ALLOW);
