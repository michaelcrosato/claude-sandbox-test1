#!/usr/bin/env bash
# Stop hook: no session ends with uncommitted or unpushed work (AI_OPERATIONS_PLAN §6.3).
# Exit 2 = block the stop and tell the agent what to finish. Always allow stop
# when AGENT_STOP exists (operator kill switch must never be fought).
set -u
cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0

[ -f "AGENT_STOP" ] && exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

DIRTY="$(git status --porcelain 2>/dev/null)"
if [ -n "$DIRTY" ]; then
  echo "Stop blocked: uncommitted changes exist. Commit them (and prepend the session's PROGRESS.md block if missing), push, then stop. Dirty files:" >&2
  echo "$DIRTY" | head -20 >&2
  exit 2
fi

# Unpushed commits on the current branch (only when an upstream is configured)
if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  AHEAD="$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)"
  if [ "${AHEAD:-0}" -gt 0 ]; then
    echo "Stop blocked: $AHEAD unpushed commit(s) on $(git branch --show-current). Push the branch so the next session (or a human) can see the work, then stop." >&2
    exit 2
  fi
fi

exit 0
