# ROADMAP

Phased plan for keeping Posthorn AFK-maintainable by autonomous agents. Canonical goal +
backlog: [docs/GOAL.md](docs/GOAL.md). Agent loop + rules: [AGENTS.md](AGENTS.md).

## Assessment (2026-05-28)

- **Product:** v1.0 feature-complete. The 11-item commercial-readiness backlog in `docs/GOAL.md`
  is done (through iter-0131); `docs/PARITY.md` is the code-verified competitor matrix with every
  codeable gap closed.
- **Health:** gates green — `npm run typecheck` clean, `npm test` 2063 passing / 6 Postgres files
  skipped, `npm run build` succeeds. Zero `TODO`/`FIXME` in `src`. CI runs 5 jobs (type/test/build,
  docker image, helm lint+template, `npm pack` readiness, dependency audit).
- **Gap this roadmap closes:** the repo was AFK-ready for its *bespoke* loop (`docs/AXIOMS.md`,
  `docs/AGENT-LOOP.md`, the pwsh gate) but lacked portable, tool-agnostic agent entry points. Now
  added: `AGENTS.md`, this file, `docs/ai/REPO_MAP.md`, `.aiignore`, `scripts/agent/*`, `tickets/`.
- **Remaining for a public launch:** only credential-gated items — human-only; see *Exclusions* in
  `docs/GOAL.md`.

## Phases

| Phase | State | Work |
| --- | --- | --- |
| 0 · Stabilize | done | Gates green; working tree clean; `main` green. |
| 1 · Tooling / deps | done | `scripts/agent/*` + `npm run agent:check` + `.aiignore` (TICKET001). Linter/formatter stance decided explicitly in TICKET005. |
| 2 · Docs / repo-map | done | `AGENTS.md`, `ROADMAP.md`, `docs/ai/REPO_MAP.md`, root `GOAL.md`/`CLAUDE.md` pointers (TICKET001, TICKET004). Keep README · OpenAPI · DEPLOY · SDK types synchronized as the product changes. |
| 3 · Bugs / tests | ongoing | Fixed the README admin-token minimum (TICKET002); the compiled-dist smokes now run in CI (TICKET003). |
| 4 · Modularity | n/a | Architecture is stable and well-factored (per-subsystem dirs, three conformant store backends). Do not refactor without a concrete reason. |
| 5 · Features | human-gated | Backlog complete; new product scope is a human-supervised strategy decision (`docs/GOAL.md`). |
| 6 · CI | strong | Already comprehensive; the compiled-dist smoke job landed (TICKET003). |

## Work to tickets

| Ticket | Title | Priority | Status |
| --- | --- | --- | --- |
| [TICKET001](tickets/TICKET001.md) | Agent scaffolding (scripts, .aiignore, AGENTS/ROADMAP/REPO_MAP, pointers) | High | done |
| [TICKET002](tickets/TICKET002.md) | Fix README admin-token minimum (32 → 16) | High | done |
| [TICKET003](tickets/TICKET003.md) | Run compiled-dist smokes in CI | Medium | done |
| [TICKET004](tickets/TICKET004.md) | Repo map + keep human/agent docs in sync | Medium | done |
| [TICKET005](tickets/TICKET005.md) | Decide & document the no-linter/-formatter stance | Low | done |

## Risks / blockers

- **Credential-gated EXCLUSIONS** (`docs/GOAL.md`) — npm publish, registry image push, live
  Stripe, domain purchase, hosted demo, trademark. Human-only; never attempt unattended.
- **Hash-protected substrate** — the 5 files in `scripts/manifest.txt` plus the auto-managed
  `docs/LOG.md`. Never edit; `assert-gate-integrity.ps1` verifies the hashes.
- **Windows-primary dev** — the canonical gate is pwsh (`scripts/local-gate.ps1`); the
  `scripts/agent/*.sh` suite needs git-bash on Windows. `npm run agent:check` works in any shell.

## Maintenance loop

Per iteration: `bash scripts/agent/status.sh` → read `docs/GOAL.md` + `ROADMAP.md` +
`docs/ai/REPO_MAP.md` + the top ticket → pick one unblocked ticket → mark in-progress → change →
`bash scripts/agent/check.sh` → update docs + ticket → file follow-ups → summarize. Full loop +
rules: [AGENTS.md](AGENTS.md).
