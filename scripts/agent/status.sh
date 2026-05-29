#!/usr/bin/env bash
# One-screen repo state for an agent starting the loop: branch, HEAD, upstream
# delta, working tree, and where to read next.
source "$(dirname -- "$0")/_common.sh"

info "branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
info "head:   $(git log -1 --oneline 2>/dev/null || echo '?')"

up="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
if [ -n "$up" ]; then
  info "vs $up (behind ahead): $(git rev-list --left-right --count "$up"...HEAD 2>/dev/null || echo '? ?')"
else
  skip "no upstream tracking branch (push is human-gated; expected here)"
fi

echo
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then git status --short; else ok "working tree clean"; fi
echo
info "read next: docs/GOAL.md -> docs/ai/REPO_MAP.md -> ROADMAP.md -> tickets/ ; gate with scripts/agent/check.sh"
