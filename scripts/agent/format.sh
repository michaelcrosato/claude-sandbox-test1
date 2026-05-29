#!/usr/bin/env bash
# Format-check, if a formatter is configured. This repo ships no formatter, so
# this normally skips. Pass --write to format in place when one is present.
source "$(dirname -- "$0")/_common.sh"

if has_script format; then
  run_script format
elif [ -f .prettierrc ] || [ -f .prettierrc.json ] || [ -f .prettierrc.cjs ] || [ -f .prettierrc.yaml ] || [ -f prettier.config.js ] || [ -f prettier.config.cjs ]; then
  mode="--check"; [ "${1:-}" = "--write" ] && mode="--write"
  if have npx; then info "prettier $mode (via npx)"; npx --no-install prettier "$mode" .; else skip "prettier config present but npx unavailable"; fi
else
  skip "skipped — no formatter configured (deliberate; see AGENTS.md)"
fi
