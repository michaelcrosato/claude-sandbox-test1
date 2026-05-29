# SPEC-H5 — Resolve the 5 discovery questions (HUMAN STRATEGY)

- **Owner:** human · **Phase:** gates D · **Status:** open
- These are the open strategy questions in [`docs/GOAL.md`](../../docs/GOAL.md) "Non-Blocking
  Discovery Questions". **Must not be answered in code by an agent.**

## The questions (verbatim intent)

1. **Public name** — keep "Posthorn" or rename before npm/repo/package publication?
2. **First commercial path** — hosted cloud, paid self-host support, or enterprise licensing?
3. **Metering unit** — accepted messages, delivery attempts, active endpoints, or a blended unit?
4. **First deploy target to polish** — Docker Compose, Kubernetes, npm library embedding, or managed cloud?
5. **Minimum public-launch bar** — npm package, Docker image, hosted demo, landing page, or all four?

## Why they're blocking

- Q1 gates [SPEC-H1](SPEC-H1-npm-publish-readiness.md) (package name) and
  [SPEC-H2/H4](.) (image path, domain).
- Q3 gates [SPEC-H3](SPEC-H3-stripe-live-enablement.md) (what the plan catalog meters).
- Q4/Q5 shape which launch artifacts to prioritize polishing under [SPEC-M1](SPEC-M1-steady-state-maintenance.md).

## Acceptance criteria

A human records decisions (in `docs/GOAL.md` or a decision doc). Only then do the dependent H-specs
become actionable, and only the non-credentialed prep parts are ever the agent's.

## Out of scope

Agent guessing/encoding answers; any code change that presupposes an answer (e.g. renaming the
package, hard-coding a metering unit).
