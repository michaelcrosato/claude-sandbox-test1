# GOAL.md

> **The canonical goal lives in [docs/GOAL.md](docs/GOAL.md)** — it is the lifecycle gate the
> autonomous loop reads (`CURRENT_STATE`, the ordered backlog, the per-item definition of done,
> and the credential-gated exclusions). This root file is a thin pointer so the goal is
> discoverable from the repo root. **Do not fork it — edit docs/GOAL.md.**

**Purpose.** Posthorn — reliable outbound webhook-delivery infrastructure for SaaS teams:
single-container, SQLite-by-default (no Redis), [Standard Webhooks](https://www.standardwebhooks.com/)-compliant,
embeddable as a library, MIT-licensed.

**Current state.** v1.0 feature-complete: the 11-item commercial-readiness backlog in
[docs/GOAL.md](docs/GOAL.md) is done, and [docs/PARITY.md](docs/PARITY.md) is the code-verified
competitor matrix with every codeable gap closed. Gates are green (`typecheck`, ~2060 tests,
`build`). Everything left for a public release is **credential-gated and human-only** (see
*Exclusions* in docs/GOAL.md).

**Non-goals.** General event bus, inbound webhook routing, CRM/workflow engine, multi-protocol
destination hub, or any dependency on Redis / an external broker in the core path.

**Definition of done (every change).** `npm run typecheck` clean · `npm test` green ·
`npm run build` succeeds — plus the route/store/env-var/smoke rules in docs/GOAL.md. Gate with
`bash scripts/agent/check.sh` (or `npm run agent:check`).

**Start here:** agents → [AGENTS.md](AGENTS.md) · humans → [README.md](README.md) · plan &
tickets → [ROADMAP.md](ROADMAP.md), [tickets/](tickets/) · repo map → [docs/ai/REPO_MAP.md](docs/ai/REPO_MAP.md).
