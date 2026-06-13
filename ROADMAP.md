# ROADMAP

This root file is an index for repository orientation. The live planning file is
[roadmap/ROADMAP.md](roadmap/ROADMAP.md); the machine backlog is
[roadmap/features.json](roadmap/features.json).

## Current Control Plane

- Agent entrypoint: [AGENTS.md](AGENTS.md), which points every agent to
  [CLAUDE.md](CLAUDE.md).
- Operations blueprint: [AI_OPERATIONS_PLAN.md](AI_OPERATIONS_PLAN.md).
- Operator guide: [OPERATOR_GUIDE.md](OPERATOR_GUIDE.md).
- Current status: [roadmap/STATUS.md](roadmap/STATUS.md).
- Progress log and decisions: [roadmap/PROGRESS.md](roadmap/PROGRESS.md) and
  [roadmap/DECISIONS.md](roadmap/DECISIONS.md).

## Working Loop

Agents follow `CLAUDE.md`: read durable state, choose the next valid backlog
item if one exists, branch from `origin/develop`, verify with
`bash scripts/verify.sh`, save evidence, get review, open a PR to `develop`, and
record the result.

When no backlog item is buildable, the repo's idle path is the `/groom`,
`/downtime`, `/kaizen`, and `/status` skill flow described under `.claude/`.

## Maintenance Checks

- Validate state: `npx ts-node scripts/update-state.ts --validate`.
- Run the full local gate: `bash scripts/verify.sh`.
- Re-verify live AI/tooling/model/pricing claims when required by the freshness
  rule in `CLAUDE.md`.

Do not follow older references to `docs/GOAL.md`, `tickets/`,
`docs/ai/REPO_MAP.md`, `scripts/agent/*`, or `scripts/local-gate.ps1`; those
paths are not present in this repository's current operating system.
