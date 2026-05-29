#!/usr/bin/env bash
# Check the toolchain is sane before working. Non-zero only on a hard blocker
# (missing/too-old Node); optional tools are reported as skipped, not failures.
source "$(dirname -- "$0")/_common.sh"

rc=0
info "node: $(node -v 2>/dev/null || echo 'NOT FOUND')"
info "npm:  $(npm -v 2>/dev/null || echo 'NOT FOUND')"
info "pm:   $PM"

if have node; then
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$major" -ge 20 ]; then ok "node >= 20 (package.json engines)"; else fail "node $major < 20 (engines requires >=20)"; rc=1; fi
else
  fail "node not installed"; rc=1
fi

if [ -d node_modules ]; then ok "node_modules present"; else skip "node_modules missing — run scripts/agent/bootstrap.sh"; fi

have python3 && info "python3: $(python3 -V 2>&1)" || skip "python3 not found (only for scripts/validate-log-compliance.py)"
have docker  && info "docker: $(docker -v 2>&1)"   || skip "docker not found (only for Postgres-backed tests + image build)"
have pwsh    && info "pwsh present (canonical gate: scripts/local-gate.ps1)" || skip "pwsh not found (the .ps1 gate is pwsh-only; use scripts/agent/check.sh)"

exit "$rc"
