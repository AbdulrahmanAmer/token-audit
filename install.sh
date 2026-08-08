#!/usr/bin/env bash
# install.sh — install Token Audit without the plugin system.
#
# The supported path is `/plugin marketplace add AbdulrahmanAmer/token-audit` inside Claude
# Code; this script exists for the cases that route does not cover — an older CLI, a machine
# where plugins are managed centrally, or someone who wants the skill and not the command.
#
# It copies the skill into ~/.claude/skills/token-audit/ and carries the scripts with it, so
# the skill works standalone. Nothing is fetched: whatever is in this checkout is what gets
# installed, which is the whole supply chain.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}/token-audit"

command -v node >/dev/null 2>&1 || { echo "node is required (18+)"; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || { echo "node 18+ is required; found $(node -v)"; exit 1; }

# Verified before installing, not after. An installer that reports success and leaves a
# broken tool is worse than one that refuses.
echo "Running the test suite before installing…"
node "$SRC/scripts/test/run-tests.mjs" >/dev/null || { echo "tests failed — refusing to install"; exit 1; }
node "$SRC/scripts/check-manifests.mjs" >/dev/null || { echo "manifests disagree — refusing to install"; exit 1; }

mkdir -p "$DEST/scripts/test"
cp "$SRC/skills/token-audit/SKILL.md" "$DEST/SKILL.md"
cp "$SRC/scripts/audit.mjs" "$SRC/scripts/check-manifests.mjs" "$DEST/scripts/"
cp "$SRC/scripts/test/run-tests.mjs" "$DEST/scripts/test/"
cp "$SRC/LICENSE" "$DEST/LICENSE"

# The skill body addresses scripts as ${CLAUDE_PLUGIN_ROOT}/scripts/…, which only resolves
# when the plugin system loads it. Installed as a bare skill there is no plugin root, so the
# copy is rewritten to point at where the files actually landed. Rewriting the INSTALLED copy
# and never the source keeps the repo canonical for the plugin path.
sed -i.bak "s|\${CLAUDE_PLUGIN_ROOT}|$DEST|g" "$DEST/SKILL.md" && rm -f "$DEST/SKILL.md.bak"

echo "Installed to $DEST"
echo
echo "Try it:  node $DEST/scripts/audit.mjs --list"
echo "In Claude Code, ask: \"where did this session's tokens go?\""
