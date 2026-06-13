# GOAL.md

This root file is a compatibility index for agents and humans who look for a
top-level goal file. Do not treat it as machine state.

## Purpose

Posthorn is reliable outbound webhook-delivery infrastructure for SaaS teams:
single-container, SQLite-by-default, Standard Webhooks-compatible, embeddable as
a library, and MIT-licensed.

Non-goals: a general event bus, inbound webhook router, CRM/workflow engine,
multi-protocol destination hub, or a Redis/external-broker dependency in the
core path.

## Current Sources of Truth

- Product architecture and public behavior: [README.md](README.md).
- Agent operating rules: [AGENTS.md](AGENTS.md) -> [CLAUDE.md](CLAUDE.md).
- Operations blueprint: [AI_OPERATIONS_PLAN.md](AI_OPERATIONS_PLAN.md).
- Human-owned priorities: [roadmap/ROADMAP.md](roadmap/ROADMAP.md).
- Machine backlog/state: [roadmap/features.json](roadmap/features.json).
- Operator status and handoff: [roadmap/STATUS.md](roadmap/STATUS.md),
  [roadmap/PROGRESS.md](roadmap/PROGRESS.md), and
  [roadmap/QUESTIONS.md](roadmap/QUESTIONS.md).

## Definition of Done

Every autonomous change must follow the `CLAUDE.md` session protocol: update
state through `npx ts-node scripts/update-state.ts`, preserve evidence under
`roadmap/evidence/`, run `bash scripts/verify.sh`, get fresh evaluation where
required, and record decisions in `roadmap/DECISIONS.md`.

Agents should not use legacy `docs/GOAL.md`, `tickets/`, `docs/ai/REPO_MAP.md`,
or `scripts/agent/*` paths; they are not part of the current checkout.
