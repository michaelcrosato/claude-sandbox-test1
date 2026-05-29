#!/usr/bin/env bash
# Type-check only (tsc --noEmit).
source "$(dirname -- "$0")/_common.sh"
run_script typecheck
