#!/usr/bin/env bash
# Lint, if a linter is configured. This repo intentionally ships no linter — type
# safety is enforced by tsc (scripts/agent/typecheck.sh) — so this normally skips.
source "$(dirname -- "$0")/_common.sh"

if has_script lint; then
  run_script lint
elif [ -f eslint.config.js ] || [ -f eslint.config.mjs ] || [ -f .eslintrc ] || [ -f .eslintrc.js ] || [ -f .eslintrc.cjs ] || [ -f .eslintrc.json ] || [ -f biome.json ]; then
  if have npx; then info "eslint (via npx)"; npx --no-install eslint .; else skip "linter config present but npx unavailable"; fi
else
  skip "skipped — no linter configured (deliberate; strict tsc is the style gate, see AGENTS.md)"
fi
