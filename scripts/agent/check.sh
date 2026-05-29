#!/usr/bin/env bash
# The definition-of-done gate (docs/GOAL.md): typecheck + test + build.
# Exits non-zero on the first real failure. This is the portable mirror of the
# canonical (pwsh) scripts/local-gate.ps1 — the .ps1 gate stays authoritative on
# Windows; CI (.github/workflows/ci.yml) runs the same three steps.
source "$(dirname -- "$0")/_common.sh"

info "gate: typecheck -> test -> build"
run_script typecheck
run_script test
run_script build
ok "gate green: typecheck + test + build"
