# plan/ — Posthorn execution plan (authoritative · self-contained)

Generated **2026-05-29**. This directory is the **single source of truth for the execution loop**:
start here, work its specs, track progress in [PROGRESS.md](PROGRESS.md). It is **self-contained** —
it carries its own baseline ([BASELINE.md](BASELINE.md)) and research ([RESEARCH.md](RESEARCH.md))
and needs no other document to be actionable.

## What to read, in order

1. [BASELINE.md](BASELINE.md) — what Posthorn is + verified current state (Phase 1).
2. [RESEARCH.md](RESEARCH.md) — external context, 2026 best practices, sources (Phase 2).
3. [ROADMAP.md](ROADMAP.md) — pillars, phases, DAG, priority matrix (Phase 3).
4. [specs/](specs/) — one atomic spec per task; pick the top unblocked one.
5. [EXECUTION_GOAL.md](EXECUTION_GOAL.md) — the self-contained `/goal` that drives this plan (Phase 4).

## Operating constraints this plan incorporates (fixed; enforced by tooling)

`plan/` is the authority for **what to work on**. It runs **within** constraints it neither needs nor
is able to override — they are the physics, not a competing plan:

- [`docs/AXIOMS.md`](../docs/AXIOMS.md) + [`docs/AGENT-LOOP.md`](../docs/AGENT-LOOP.md) — invariants,
  **hash-protected**; `scripts/assert-gate-integrity.ps1` verifies their SHA-256s. No plan edits them.
- [`docs/GOAL.md`](../docs/GOAL.md) — product boundary, per-item Definition of Done, credential-gated
  EXCLUSIONS. This plan adopts that boundary as its scope.
- [`docs/LOG.md`](../docs/LOG.md) — harness-managed; never hand-edited.

This file is a **snapshot dated 2026-05-29**; if it ever diverges from those constraints, the
constraints win and `plan/` must be refreshed.

## Single-line status

Posthorn is **v1.0 feature-complete and fully hardened** — verified this session: `npm run
agent:check` **exit 0**, **2068/2068** tests green, build clean. Both prior backlogs are shipped
([PROGRESS.md](PROGRESS.md)). The active execution queue is **steady-state maintenance**
([specs/SPEC-M1](specs/SPEC-M1-steady-state-maintenance.md)); every higher-impact item is
**human-gated** ([specs/SPEC-H1…H5](specs/)).

## Supersedes

This plan supersedes and absorbs [`.agent/master_plan.md`](../.agent/master_plan.md) (2026-05-28),
whose OPP-01…OPP-13 hardening backlog is now fully shipped (see [PROGRESS.md](PROGRESS.md)). That file
is retained as the historical predecessor.

## Disposition

Uncommitted in the working tree. Adding a new top-level control plane is a **repo-scope decision for
the human** — I will not commit new scope autonomously. On your word I'll commit it (recommended path:
as `plan/` or relocated under `docs/plan/`).
