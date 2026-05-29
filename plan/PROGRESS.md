# plan/PROGRESS — completion ledger (2026-05-29)

Live verification this session + the commit map proving both backlogs shipped. Git history is the
source of truth (`docs/LOG.md` rotates entries to `docs/log/` archives).

## Gate — verified this session (ground truth, real commands)

- `npm run agent:check` → **exit 0** (typecheck clean · `vitest run` · `npm run build`).
- **Run 1:** 60 files passed / 6 skipped, **2049/2068** tests, **1× tinypool `Worker exited
  unexpectedly`** with **0 failed assertions** — the documented teardown flake, not a regression.
- **Run 2** (re-run per the AGENTS.md protocol): **61 files passed / 6 skipped, 2068/2068 tests, 0
  errors, 21.4s.** The flake did not reproduce → the suite is genuinely green.
- The 6 skipped files are Postgres-gated (require `POSTHORN_TEST_PG_URL`; Docker `postgres:16`).
- `package.json` `version` = `1.0.0`; zero `TODO`/`FIXME` in `src` (per ROADMAP assessment).

## Phase A — commercial readiness (docs/GOAL.md 11-item backlog): ✅ done

`bc2d25f` (iter-0116) adopted the directive; iters 0117–0131 delivered it 1:1:

| # | Backlog item | Iter / commit |
| --- | --- | --- |
| 1 | v1.0 release engineering (CHANGELOG, npm-pack guard, community health files) | 0117 `3bfbf80` |
| 2 | CI hardening (docker build, pack readiness, dep audit, OCI labels) | 0118 `8222a3d` |
| 3 | Plan catalog + entitlements (free/pro/scale) | 0119 `9fa71b5` |
| 4 | Billing behind flags (Noop default, Stripe over injected transport) | 0120 `31068d7` |
| 5 | Self-serve signup seam (opt-in, 404 until enabled) | 0121 `5d44c43` |
| 6 | Kubernetes Helm chart `deploy/helm/posthorn` | 0122 `279f2f3` |
| 7 | Python SDK + expanded end-user CLI | 0124 `581f7a7`, 0123 `f480613` |
| 8 | Static docs + landing site | 0125 `15e1305` |
| 9 | Throughput benchmark + BENCHMARKS.md | 0126 `2ee2dc4` |
| 10 | Backup/restore (SQLite online backup + pg_dump path) | 0127 `6ff8c97` |
| 11 | Incumbent-parity sweep + close codeable gaps | 0128 `fb347e9`, 0129 `37ef723`, 0130 `4c2845a`, 0131 `565f669` |

## Phase B — hardening backlog (.agent/master_plan.md OPP-01…13): ✅ all 13 shipped

| OPP | Title | Commit |
| --- | --- | --- |
| 01 | `engines.node` → node:sqlite floor (>=22.13.0) | `af2fa98` |
| 02 | CI Node LTS matrix (22.13, 24) | `78cf04c` |
| 03 | compiled-dist smokes in CI (TICKET003) | `471a853` |
| 04 | doc-sync + package-lock/CHANGELOG sync | `a7dcf61` (+ ongoing doc commits) |
| 05 | document no-linter/-formatter stance (TICKET005) | `ebdac6a` |
| 06 | machine-readable test output (`test:json`) | `73fb4de` |
| 07 | document node:sqlite pre-stable status + Node floor | `e5b94d7` |
| 08 | type-check published `.d.ts` under default consumer tsconfig | `18005e4` |
| 09 | git-worktree workflow for parallel/risky ticks | `a41a797` |
| 10 | guard `/metrics` labels stay a closed, bounded set | `6fab385` |
| 11 | optional code-reviewer subagent + self-review step | `04ec017` |
| 12 | document the vitest worker-teardown flake + re-run protocol | `e243ff5` |
| 13 | make Stripe webhook signature tolerance configurable | `1c91e7b` |

Capstone: `aea3d82` — refreshed `/ROADMAP.md` health snapshot to the verified gate state.

## Forward

- **Phase C** steady-state maintenance — ▶ ongoing, autonomous ([specs/SPEC-M1](specs/SPEC-M1-steady-state-maintenance.md)).
- **Phase D** launch (npm publish, registry, live Stripe, hosted demo, domain/trademark) — ⛔
  human-gated ([specs/SPEC-H1…H4](specs/)).
- **Phase H5** the 5 discovery questions — ⛔ open human strategy ([specs/SPEC-H5](specs/SPEC-H5-resolve-discovery-questions.md)).
- **Non-goals** — explicitly deferred ([specs/SPEC-WONTDO](specs/SPEC-WONTDO-non-goals.md), [BACKLOG.md](BACKLOG.md)).
