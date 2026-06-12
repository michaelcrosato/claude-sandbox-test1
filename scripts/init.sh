#!/usr/bin/env bash
# init.sh — bootstrap the dev environment (plan §3). Idempotent; also the cloud
# environment's setup script. Safe to re-run any time.
set -eu
cd "$(dirname "$0")/.."

echo "[init] installing dependencies…"
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi

echo "[init] marking hook/gate scripts executable…"
chmod +x .claude/hooks/*.sh scripts/*.sh 2>/dev/null || true

# Git pre-commit hook: assertion shield (plan §6.3). Skipped in CI (CI runs it directly).
if [ -d .git ] && [ -z "${CI:-}" ]; then
  echo "[init] installing git pre-commit hook (assertion shield)…"
  mkdir -p .git/hooks
  cat > .git/hooks/pre-commit <<'HOOK'
#!/usr/bin/env bash
npx ts-node scripts/assertion-shield.ts
HOOK
  chmod +x .git/hooks/pre-commit
fi

echo "[init] done. Run: bash scripts/verify.sh"
