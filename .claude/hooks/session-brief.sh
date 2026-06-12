#!/usr/bin/env bash
# SessionStart hook: inject the working state so every fresh context starts oriented
# (AI_OPERATIONS_PLAN §6.3). Must never fail or block — informational only.
set -u
cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0

echo "=== SESSION BRIEF ($(date -u '+%Y-%m-%d %H:%MZ')) ==="

if [ -f "AGENT_STOP" ]; then
  echo "!! AGENT_STOP file present — operator has halted work. Do not start tasks."
fi

echo "--- Recent progress (top of roadmap/PROGRESS.md) ---"
head -50 roadmap/PROGRESS.md 2>/dev/null || echo "(no PROGRESS.md yet)"

echo "--- Last 10 commits ---"
git log --oneline -10 2>/dev/null || echo "(no git history)"

echo "--- Backlog counts (roadmap/features.json) ---"
if command -v node >/dev/null 2>&1 && [ -f roadmap/features.json ]; then
  node -e "const f=require('./roadmap/features.json').features;const c={};f.forEach(x=>c[x.status]=(c[x.status]||0)+1);console.log(JSON.stringify(c), '| passing:', f.filter(x=>x.passes).length + '/' + f.length)" 2>/dev/null || echo "(could not parse)"
else
  echo "(node or features.json unavailable)"
fi

echo "--- Open operator questions ---"
grep -c '^## Q-' roadmap/QUESTIONS.md 2>/dev/null || echo 0

echo "--- Dirty-state audit ---"
DIRTY="$(git status --porcelain 2>/dev/null | head -10)"
[ -n "$DIRTY" ] && { echo "WARNING: uncommitted changes left by a previous session:"; echo "$DIRTY"; } || echo "clean"
git log --branches --not --remotes --oneline 2>/dev/null | head -5 | grep -q . && echo "WARNING: local commits not pushed to any remote exist (git log --branches --not --remotes)"

if [ -f package.json ] && [ -d node_modules ]; then
  npx ts-node scripts/verify-rules.ts 2>/dev/null || true
fi

echo "=== END BRIEF ==="
exit 0
