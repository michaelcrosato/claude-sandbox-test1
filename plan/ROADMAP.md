# plan/ROADMAP — Posthorn (Phase 3, 2026-05-29)

The prioritized plan, organized by pillar and phase with DAG dependencies and a full priority
matrix. Self-contained; baseline in [BASELINE.md](BASELINE.md), research in [RESEARCH.md](RESEARCH.md).
Scoring: **Priority = Impact·3 + Fit·2 + Feasibility·2 + Confidence − Risk − Effort** (each 1–5).

## Pillars (status by category)

| Pillar | State | Where |
| --- | --- | --- |
| **Features** | ✅ complete; **frozen** — new product scope is human-authorized only | `docs/GOAL.md` 11-item backlog (shipped) · non-goals in [specs/SPEC-WONTDO](specs/SPEC-WONTDO-non-goals.md) |
| **Infrastructure** | ✅ complete | CI 5 jobs, Node matrix, Docker+OCI, Helm chart, backup/restore (all shipped) |
| **Fixes** | ✅ none open | zero `TODO`/`FIXME`; gate green; `engines` floor corrected (OPP-01) |
| **Quality & Observability** | ✅ complete | machine-readable tests, `/metrics` bounded-label guard, dist smokes in CI, `.d.ts` consumer smoke, flake protocol |
| **Future-proofing** | ▶ ongoing | dependency hygiene, contract-sync, node:sqlite RC tracking — [specs/SPEC-M1](specs/SPEC-M1-steady-state-maintenance.md) |

**Net:** four pillars are done; the only live pillar is Future-proofing/maintenance. The Features
pillar is deliberately frozen — see the honesty note at the bottom.

## Phases

| Phase | Scope | State |
| --- | --- | --- |
| **A · Commercial readiness** | `docs/GOAL.md` 11-item backlog | ✅ DONE (iter-0116…0131) |
| **B · Hardening / agent-readiness** | OPP-01…OPP-13 (absorbed from `.agent/master_plan.md`) | ✅ DONE — [PROGRESS.md](PROGRESS.md) |
| **C · Steady-state maintenance** | gates green · contracts in sync · dep hygiene | ▶ ONGOING — autonomous ([SPEC-M1](specs/SPEC-M1-steady-state-maintenance.md)) |
| **D · Launch** | credential-gated EXCLUSIONS | ⛔ HUMAN-GATED — [SPEC-H1…H4](specs/) |
| **E · Future bets** | asymmetric signing, multi-destination, … | ⛔ HUMAN-AUTHORIZED ONLY — [BACKLOG.md](BACKLOG.md) |

## Forward DAG (only non-done work)

```
C steady-state ───────────── continuous · independent · autonomous (SPEC-M1)
H5 resolve 5 discovery Qs ─▶ shapes go-to-market for ▼
H1 npm-publish readiness ─(human creds)─▶ npm publish (trusted-publishing + provenance)
H2 docker image → registry ─(human creds)        ┐
H3 live Stripe enablement ─(human keys)           ├ independent of one another
H4 hosted demo + domain + trademark ─(human infra)┘
E* future bets ── OFF the DAG until a human authorizes each individually
```

## Priority matrix — Phase B (all SHIPPED; evidence in PROGRESS.md)

| ID | Title | Pri | Tier | Commit |
| --- | --- | --- | --- | --- |
| OPP-01 | `engines.node` → node:sqlite floor | 36 | P0 | `af2fa98` |
| OPP-02 | CI Node LTS matrix | 33 | P1 | `78cf04c` |
| OPP-05 | Document no-linter stance | 29 | P1 | `ebdac6a` |
| OPP-04 | Doc-sync + CHANGELOG | 28 | P1 | `a7dcf61` |
| OPP-06 | Machine-readable gate output | 28 | P1 | `73fb4de` |
| OPP-03 | Dist smokes in CI | 27 | P1 | `471a853` |
| OPP-07 | Document node:sqlite RC + floor | 26 | P1 | `e5b94d7` |
| OPP-08 | `.d.ts` consumer smoke | 26 | P2 | `18005e4` |
| OPP-09 | Worktree workflow doc | 26 | P2 | `a41a797` |
| OPP-10 | `/metrics` bounded-label guard | 22 | P2 | `6fab385` |
| OPP-11 | Reviewer subagent + self-review | 22 | P2 | `04ec017` |
| OPP-13 | Inbound replay-window config | 20 | P3 | `1c91e7b` |
| OPP-12 | Flake protocol documented | 19 | P3 | `e243ff5` |

## Priority matrix — forward items (with reasoning)

| ID | Title | Imp | Fit | Feas | Conf | Risk | Eff | **Pri** | Owner · reasoning |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M1 | Steady-state maintenance | 4 | 5 | 5 | 5 | 1 | 2 | **34** | agent — highest feasible value; keeps the asset healthy without scope change |
| H5 | Resolve 5 discovery questions | 5 | 5 | 2 | 2 | 2 | 3 | **24** | human — highest impact but low feasibility for an agent (strategy, not code) |
| H1 | npm-publish readiness | 4 | 4 | 3 | 3 | 3 | 3 | **24** | human + agent prep — agent can dry-run/draft; publish needs creds |
| H2 | Docker image → registry | 3 | 3 | 2 | 3 | 3 | 2 | **17** | human — build/labels done; push needs registry creds |
| H3 | Live Stripe enablement | 3 | 3 | 2 | 2 | 4 | 3 | **15** | human — provider built+mocked; live keys needed |
| H4 | Hosted demo + domain + trademark | 4 | 3 | 1 | 2 | 4 | 4 | **13** | human — infra/cost/legal |

**Autonomous queue = M1 only.** Everything above it in impact is credential- or decision-gated.

## Honesty note on the Features pillar

This plan does **not** populate the Features pillar with new tasks. That is deliberate, not an
omission: `docs/GOAL.md`'s product boundary plus the accepted "v1.0 feature-complete, harden-only"
directive scope features out, and the 2026 research ([RESEARCH.md](RESEARCH.md)) found every
incumbent gap to be a non-goal rather than a deficiency. Manufacturing feature work to fill the pillar
would be scope creep. New features require explicit human authorization, after which each becomes a
normal spec + a `docs/GOAL.md` backlog entry.
