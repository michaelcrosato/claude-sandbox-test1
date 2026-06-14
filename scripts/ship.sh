#!/usr/bin/env bash
# ship.sh — watch a PR's checks to terminal, merge ONLY on green (CLAUDE.md §6).
# Hardening: bounded wait for checks to REGISTER post-creation; fail CLOSED if
# none appear (never merge an unchecked PR). Usage: bash scripts/ship.sh <pr#> [--merge]
set -eu

PR=""
MERGE=false
for arg in "$@"; do
  case "$arg" in
    --merge) MERGE=true ;;
    --*) echo "ERROR: unknown flag '$arg'" >&2; exit 1 ;;
    *) if [ -z "$PR" ]; then PR="$arg"; else echo "ERROR: unexpected argument '$arg'" >&2; exit 1; fi ;;
  esac
done
case "$PR" in
  ''|*[!0-9]*) echo "ERROR: a numeric PR number is required. Usage: bash scripts/ship.sh <pr#> [--merge]" >&2; exit 1 ;;
esac
command -v gh >/dev/null 2>&1 || { echo "ERROR: gh (GitHub CLI) not found on PATH." >&2; exit 1; }

# SHIP_REGISTER_TIMEOUT / SHIP_REGISTER_INTERVAL are timing knobs ONLY — a smaller
# value fails closed sooner, never opens a bypass, so no DANGEROUSLY_ prefix.
# Sanitize to non-negative integers; clamp the interval to >=1 so the register
# wait can never busy-spin without advancing toward the timeout (security review).
TIMEOUT="${SHIP_REGISTER_TIMEOUT:-180}"
INTERVAL="${SHIP_REGISTER_INTERVAL:-6}"
case "$TIMEOUT" in ''|*[!0-9]*) TIMEOUT=180 ;; esac
case "$INTERVAL" in ''|*[!0-9]*) INTERVAL=6 ;; esac
if [ "$INTERVAL" -lt 1 ]; then INTERVAL=1; fi

if [ "$MERGE" = true ]; then
  # Fail closed on an empty/errored base too: a transient `gh pr view` failure
  # must never let a master/main-based PR slip through (security review).
  BASE="$(gh pr view "$PR" --json baseRefName --jq .baseRefName 2>/dev/null || echo '')"
  case "$BASE" in
    ''|main|master) echo "ERROR: PR #$PR base is '$BASE' — refusing to merge (need a confirmed non-master/main base; §6)." >&2; exit 1 ;;
  esac
fi

echo "Waiting for checks to register on PR #$PR..."
elapsed=0
registered=false
while :; do
  probe="$(gh pr checks "$PR" 2>&1 || true)"
  if printf '%s' "$probe" | grep -qi 'no checks'; then
    if [ "$elapsed" -ge "$TIMEOUT" ]; then
      echo "No checks registered after ${TIMEOUT}s — refusing to merge an unchecked PR (fail closed)." >&2
      exit 1
    fi
    sleep "$INTERVAL"; elapsed=$((elapsed + INTERVAL)); continue
  fi
  registered=true; break
done
[ "$registered" = true ] || { echo "fail closed" >&2; exit 1; }

echo "Checks registered. Watching to terminal..."
if gh pr checks "$PR" --watch; then
  if [ "$MERGE" = true ]; then
    echo "PR #$PR is green. Merging..."
    gh pr merge "$PR" --merge
  else
    echo "PR #$PR is green. --merge not requested; not merging."
  fi
else
  rc=$?
  echo "PR #$PR checks are not green — not merging." >&2
  exit "$rc"
fi
