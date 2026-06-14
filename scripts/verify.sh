#!/usr/bin/env bash
# verify.sh — THE gate (plan §7.1). One command, identical for agents and CI.
# Exit code is the only truth. Usage: bash scripts/verify.sh [--e2e]
# Stack-aware: runs whatever gates the repo defines; engine meta-gates always run.
set -u
cd "$(dirname "$0")/.." || exit 1

bash scripts/local-cli-preflight.sh || exit 1

E2E=false
[ "${1:-}" = "--e2e" ] && E2E=true

FAILED=0
step() {
  local name="$1"; shift
  echo ""
  echo "──── verify: $name ────"
  if "$@"; then
    echo "──── $name: OK"
  else
    echo "──── $name: FAILED (exit $?)"
    FAILED=1
  fi
}

has_pkg_script() {
  [ -f package.json ] && node -e "process.exit(require('./package.json').scripts?.['$1'] ? 0 : 1)" 2>/dev/null
}

# Template mode (no product code yet) tolerates missing stack scripts.
# Product mode (src/ exists) treats a missing test or lint script as a FAILURE:
# an autonomous factory must not be able to "pass" by never defining its gates.
PRODUCT_MODE=false
[ -d src ] && PRODUCT_MODE=true

# ---- product/stack gates (auto-detected) ----
if [ -f package.json ]; then
  if has_pkg_script typecheck; then step "typecheck" npm run --silent typecheck
  elif [ -f tsconfig.json ]; then step "typecheck" npx tsc --noEmit; fi

  if has_pkg_script lint; then step "lint" npm run --silent lint
  elif $PRODUCT_MODE; then echo "──── lint: FAILED (product code exists but no lint script is defined)"; FAILED=1
  else echo "(no lint script — template mode skip; becomes a hard gate once src/ exists)"; fi

  if has_pkg_script test; then step "unit tests" npm run --silent test
  elif $PRODUCT_MODE; then echo "──── unit tests: FAILED (product code exists but no test script is defined)"; FAILED=1
  else echo "(no test script — template mode skip; becomes a hard gate once src/ exists)"; fi

  if has_pkg_script build; then step "build" npm run --silent build
  else echo "(no build script — skipping)"; fi

  # Test-coverage guard (security-review finding, PR #15): the test script pins
  # explicit files (Node 20/24 disagree on --test dir/glob handling), so a new
  # test file that nobody wires in must be a hard failure, never a silent skip.
  if $PRODUCT_MODE && has_pkg_script test; then
    TEST_SCRIPT="$(node -e "console.log(require('./package.json').scripts.test || '')")"
    UNWIRED=""
    while IFS= read -r tf; do
      # Every test file must appear by basename — no glob shortcut: a script
      # merely CONTAINING "*.test." would have skipped this guard entirely
      # (security review, PR #16). When a real glob-based runner lands
      # (Phase 1), it replaces this guard rather than weakening it.
      case "$TEST_SCRIPT" in
        *"$(basename "$tf")"*) : ;;
        *) UNWIRED="$UNWIRED $tf" ;;
      esac
    done <<EOF
$(find src -type f \( -name '*.test.js' -o -name '*.spec.js' -o -name '*.test.ts' \) 2>/dev/null)
EOF
    if [ -n "$UNWIRED" ]; then
      echo "──── test coverage guard: FAILED (test files not wired into the npm test script:$UNWIRED)"
      FAILED=1
    else
      echo "──── test coverage guard: OK (every src test file is wired into npm test)"
    fi
  fi
fi
if [ -f Cargo.toml ]; then
  step "cargo check" cargo check --quiet
  step "cargo test" cargo test --quiet
fi
if [ -f pyproject.toml ] && command -v pytest >/dev/null 2>&1; then
  step "pytest" pytest -q
fi

# Placeholder check (F-0011): in an ADOPTED repo (package renamed from the
# template) with product code, leftover <PLACEHOLDER> tokens in operator-facing
# docs are adoption bugs. The template repo itself self-skips by name.
if $PRODUCT_MODE && [ -f package.json ]; then
  PKG_NAME="$(node -e "console.log(require('./package.json').name || '')")"
  if [ "$PKG_NAME" != "ai-operations-template" ]; then
    if grep -nE '<[A-Z][A-Z0-9_]{2,}>' CLAUDE.md AI_OPERATIONS_PLAN.md OPERATOR_GUIDE.md README.md 2>/dev/null; then
      echo "──── placeholder check: FAILED (replace the <PLACEHOLDER> tokens above — see README drop-in step 2)"
      FAILED=1
    else
      echo "──── placeholder check: OK"
    fi
  else
    echo "(placeholder check: template repo — self-skipped; activates after adoption rename)"
  fi
fi

# ---- engine meta-gates (always) ----
step "features.json schema + invariants" npx ts-node scripts/update-state.ts --validate
step "assertion shield" npx ts-node scripts/assertion-shield.ts

# Static analysis on the guardrail layer itself (F-0008): the hooks and gate
# scripts ARE this engine's product surface. biome + shellcheck ship as npm
# devDependencies (hard everywhere); actionlint is CI-hard, local-soft.
step "engine lint (biome)" npx --no-install biome lint scripts
step "shellcheck (hooks + gate scripts)" npx --no-install shellcheck .claude/hooks/*.sh scripts/*.sh
if command -v actionlint >/dev/null 2>&1; then
  step "actionlint (workflows)" actionlint
elif [ "${CI:-}" = "true" ]; then
  echo "──── actionlint: FAILED (required in CI but not installed)"
  FAILED=1
else
  echo "(actionlint not installed locally — enforced in CI)"
fi
step "hook contract tests" "$BASH" scripts/test-hooks.sh

# ---- E2E (opt-in) ----
if $E2E; then
  if has_pkg_script e2e; then
    step "seed" npx ts-node scripts/seed.ts
    step "e2e" npm run --silent e2e
  else
    echo "(--e2e requested but no e2e script defined — counting as failure so it can't be silently skipped)"
    FAILED=1
  fi
fi

echo ""
if [ "$FAILED" -eq 0 ]; then
  # Run signature for audit (ties an evidence log to a commit; CI re-running the
  # real gate on every PR is the hard backstop against forged logs)
  echo "VERIFY-COMMIT: $(git rev-parse HEAD 2>/dev/null || echo no-git) @ $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "VERIFY: PASS (exit 0)"   # update-state.ts --passes parses this exact line
  exit 0
else
  echo "VERIFY: FAIL"
  exit 1
fi
