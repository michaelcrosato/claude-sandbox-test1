#!/usr/bin/env bash
# Shared helpers for scripts/agent/*.sh. Sourced, not executed directly.
# Provides: cd-to-repo-root, package-manager detection ($PM), log helpers,
# have(), and run_script() (runs a package.json script, or skips if absent).
set -euo pipefail

# Move to the repo root (two levels up from scripts/agent/) so every script is
# CWD-independent.
cd "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"

if [ -t 1 ]; then
  c_reset=$'\033[0m'; c_red=$'\033[31m'; c_grn=$'\033[32m'; c_ylw=$'\033[33m'; c_dim=$'\033[2m'
else
  c_reset=''; c_red=''; c_grn=''; c_ylw=''; c_dim=''
fi
info() { printf '%s» %s%s\n' "$c_dim" "$*" "$c_reset"; }
ok()   { printf '%s✓ %s%s\n'  "$c_grn" "$*" "$c_reset"; }
skip() { printf '%s- %s%s\n'  "$c_ylw" "$*" "$c_reset"; }
fail() { printf '%s✗ %s%s\n'  "$c_red" "$*" "$c_reset" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }

detect_pm() {
  if   [ -f pnpm-lock.yaml ]; then echo pnpm
  elif [ -f yarn.lock ];      then echo yarn
  else echo npm; fi
}
PM="$(detect_pm)"

# Has a named package.json script?  (0 = yes)
has_script() { node -e "process.exit((((require('./package.json').scripts)||{})['$1'])?0:1)" 2>/dev/null; }

# Run a package.json script by name; skip (not fail) when it isn't defined.
run_script() {
  local name="$1"
  if has_script "$name"; then
    info "$PM run $name"
    "$PM" run "$name"
  else
    skip "no \"$name\" script in package.json — skipped"
  fi
}
