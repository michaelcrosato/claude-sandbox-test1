# SPEC-M1 — Steady-state maintenance (the only autonomous lane)

- **Owner:** agent · **Phase:** C · **Status:** ongoing · **Effort:** continuous, small per tick
- **Authorized by:** `docs/GOAL.md` bounded-maintenance set + `AGENTS.md` "Proceed autonomously".

## Description

The product backlogs (A and B) are complete; there are **no feature tasks**. The standing autonomous
work is to keep the repo healthy without changing scope: keep gates green, keep contract surfaces in
sync, make small localized fixes with an obvious validation path, and keep dependency hygiene.

## In scope (each its own small, gate-green commit)

- Keep `npm run agent:check` green; if a real regression lands, fix it minimally.
- Keep cross-surface docs honest: `README` ↔ `GET /openapi.json` (`src/http/openapi.ts`) ↔
  `docs/DEPLOY.md` ↔ SDKs ↔ `CHANGELOG.md`. (OpenAPI drift + env-var dual-doc tests already enforce
  the machine-checkable parts.)
- Dead-code / comment cleanup; fix typos; tighten a test that's flaky for a real reason.
- Dependency hygiene: keep `package-lock.json` synced; review `npm audit --omit=dev` (currently 0);
  bump devDeps deliberately, one PR-sized commit each, gate green. **Default to NO new runtime deps.**
- Refresh `docs/PARITY.md` / research notes if a competitor or spec materially changes (research, not
  feature work).

## Acceptance criteria

- After every tick: `npm run typecheck` clean, `vitest run` green (re-run once if only the documented
  tinypool flake appears), `npm run build` succeeds.
- No schema / public-interface / dependency-removal / storage / deployment / architecture change
  unless an authorized item requires it.
- Commit is conventional, explicitly staged, **no co-author trailer, no `(iter-NNNN)` suffix**, no
  `docs/LOG.md` edit; not pushed/merged to `main` without a human ask.

## Test strategy

`npm run agent:check` as the gate; targeted `bash scripts/agent/test.sh <file>` first for a touched
area; relevant `scripts/smoke-*.mjs` if an end-to-end path is involved.

## Out of scope

Any product feature, the BACKLOG non-goals, the credential-gated EXCLUSIONS, answering the 5
discovery questions, refactors without a concrete evidenced reason.
