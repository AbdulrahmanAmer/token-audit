# Changelog

All notable changes to Token Audit. Versions follow [semver](https://semver.org/).

## [0.1.0] — 2026-08-08

First release. **Measurement only**, deliberately: it is the fully portable piece, and the
one that makes every later claim in this project falsifiable.

### Added
- `token-audit` skill — reads `~/.claude/projects/**/*.jsonl` and reports where a session's
  tokens went: tool breakdown, shell output by kind, re-read cost, repeated test-output
  share, most expensive files, and cost per commit.
- `/token-audit` slash command.
- `scripts/audit.mjs` — streaming analyzer. `--project`, `--file`, `--list`, `--per-commit`,
  `--json`, `--no-paths`. Node 18+, no dependencies, no network, writes nothing.
- `scripts/check-manifests.mjs` — plugin.json, marketplace.json and the skill frontmatter
  must agree. A marketplace entry pointing at a name the plugin no longer has installs
  nothing, silently.
- `install.sh` — non-plugin install path. Runs the suite first and refuses on failure;
  rewrites `${CLAUDE_PLUGIN_ROOT}` in the installed copy, since a bare skill has no plugin root.
- CI on every push: manifests, syntax, tests, installer shell-check.

### Privacy
- Invariant: no tool-result content, and no command or search text, is ever printed. Bodies
  are measured by length and discarded; commands are reduced to one word from a closed
  vocabulary and discarded.
- 15 tests. A canary is planted in every position a transcript can hold one and asserted
  absent from every output mode. The classifier is separately asserted to be incapable of
  emitting any word outside its fixed vocabulary.
- Mutation-verified: a "sample line" feature, a classifier that echoes its input, and an
  ignored `--no-paths` each turn the suite red.
- File paths are the documented exception, opt-out via `--no-paths`, pinned by a test in
  both directions so the trade cannot be quietly changed.

### Known limits, stated rather than discovered later
- Tokens are **estimated** at 3.6 bytes each. There is no offline tokenizer; ratios are the
  deliverable, not the absolute figures.
- The live session's transcript lags behind — measure across `--per-commit` boundaries
  rather than against the last line.

## Unreleased — planned

- `quiet-tests`: detect a project's test-output convention, propose the quiet-mode patch.
  Highest measured payoff available (1,081 lines → 91 in the home repo), but convention-bound,
  so it advises and patches rather than dropping in.
- `code-index`: config-driven per-file fact table — what it is, its CLI, its imports, who
  breaks if you change it, who checks it, and a `file:line` invariant pointer. Measured
  saving 1–3.4k tokens per fix; it will ship described that way rather than as a headline.
