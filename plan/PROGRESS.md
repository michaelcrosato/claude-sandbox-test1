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

## Execution / completion run — 2026-05-29 (`/goal`: execute plan/ to completion)

Every autonomously-executable spec was run to completion with real commands; the credential-gated
remainder is prepped to the maximum and blocked on a human. Ground truth this run:

| Check | Command | Result |
| --- | --- | --- |
| DoD gate | `npm run agent:check` | **exit 0** · 61 files · **2068/2068** tests · 0 errors · build clean |
| Dep audit | `npm audit --omit=dev` | **0 vulnerabilities** |
| Code hygiene | grep `TODO\|FIXME\|HACK\|XXX\|@deprecated` in `src` | **0 matches** |
| Publish tarball | `npm pack --dry-run` | `posthorn-1.0.0.tgz` · 171 files · dist `.js`+`.d.ts`+bin · no test/map files |
| Docs site | `npm run build:site` | `SITE_BUILD_OK` · 4 files → `site/` |
| Container | `docker build` + `docker inspect` | **exit 0** · 7 OCI labels correct (`version=1.0.0`) |
| Postgres backend | `POSTHORN_TEST_PG_URL=… npm test` (Docker `postgres:16`) | **exit 0** · 67/67 files · **2358/2358** tests (the 6 PG-gated files run, not skipped) |

### Per-spec terminal status

| Spec | Lane | Status | Note |
| --- | --- | --- | --- |
| SPEC-M1 steady-state maintenance | agent | ✅ **complete** (steady state) | gate green on **both** backends (SQLite 2068/2068; Postgres 2358/2358) · audit 0 · 0 TODO · contract drift tests green — no open maintenance need |
| SPEC-H1 npm-publish readiness | human + agent-prep | ✅ prep + **OIDC `publish.yml` added** · ⛔ publish blocked | tarball verified, secret-less trusted-publishing workflow committed (dormant); needs npm-side trusted-publisher + a release tag (env has no npm auth — `ENEEDAUTH`) |
| SPEC-H2 docker → registry | human + agent-prep | ✅ prep done · ⛔ blocked | image builds + labels correct; registry **push** needs human creds |
| SPEC-H3 live Stripe | human + agent-prep | ✅ prep done · ⛔ blocked | flag-gated provider + mock tests green; **live keys** needed |
| SPEC-H4 hosted demo + domain | human | ✅ artifacts build · ⛔ blocked | site builds, helm renders in CI; infra/domain/trademark are human |
| SPEC-H5 5 discovery questions | human → **delegated** | ✅ **DECIDED 2026-05-29** | recorded in `docs/GOAL.md` › "Discovery Decisions" (name=Posthorn · self-host-first · meter messages · Docker-first · npm+image+landing); reversible |
| SPEC-WONTDO non-goals | — | n/a | not implemented, by design |

**Completion statement.** The autonomous lane (SPEC-M1) is at steady state — verified on **both**
store backends (SQLite 2068/2068, and Postgres 2358/2358 against a throwaway Docker `postgres:16`,
since torn down) — and the agent-doable prep for H1/H2/H3/H4 is verified by real commands. **No
further task is executable without a human providing credentials/decisions** (the `docs/GOAL.md`
EXCLUSIONS); attempting them is out of scope by hard rule. "Not to stop" is honored by completing
everything executable — not by crossing the EXCLUSION boundary, inventing features, or pushing to
`main`.
