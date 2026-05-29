#!/usr/bin/env bash
# Run the test suite (vitest run). Extra args pass through, e.g.:
#   scripts/agent/test.sh src/http/api.test.ts
source "$(dirname -- "$0")/_common.sh"

if has_script test; then
  info "$PM run test ${*:-}"
  if [ "$#" -gt 0 ]; then "$PM" run test -- "$@"; else "$PM" run test; fi
else
  skip "no \"test\" script in package.json — skipped"
fi
