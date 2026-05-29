# TICKET003 — Run compiled-dist smokes in CI

- **Status:** done
- **Priority:** Medium

## Goal
Catch dist-level (end-to-end, compiled-ESM) regressions automatically by running the
`scripts/smoke-*.mjs` suite in CI, not just by hand.

## Context
CI (`.github/workflows/ci.yml`) runs typecheck + test + build, but the ~18 compiled-dist smokes
(`scripts/smoke-*.mjs`) — which boot the real gateway over production ESM and exercise end-to-end
paths the unit tests don't — are manual. A regression that only shows up in `dist/` (e.g. an
export or bin wiring break) would pass CI today. The per-item definition of done already requires
"a compiled-dist smoke for any new end-to-end path," so running them in CI closes the loop.

## Scope
- **In:** a CI job (or step) that runs `npm run build` then executes the smokes; a small
  `scripts/agent/smoke.sh` runner is optional.
- **Out:** `scripts/smoke-postgres.mjs` (needs a Postgres service) — gate it behind a services
  block or skip it in this job. No changes to the smokes' assertions.

## Likely files
`.github/workflows/ci.yml`; optionally `scripts/agent/smoke.sh`, `package.json` (`agent:smoke`).

## Steps
1. Enumerate the non-Postgres smokes (all `scripts/smoke-*.mjs` except `smoke-postgres.mjs`).
2. Add a CI job: checkout → setup-node 24 → `npm ci` → `npm run build` → run each smoke; fail on
   any non-zero exit.
3. Optionally add `smoke-postgres.mjs` as a separate job with a `postgres:16` service +
   `POSTHORN_TEST_PG_URL`.
4. Note: smokes bind `127.0.0.1` and may print a harmless teardown assertion on Windows — CI is
   Linux, so that's moot.

## Acceptance criteria
- [x] A CI job builds and runs every non-Postgres smoke; the job is green on `main`.
- [x] A failing smoke fails the job (verify by temporarily breaking one locally).
- [x] Existing jobs unaffected; total CI time stays reasonable.

## Commands
`npm run build && for f in scripts/smoke-*.mjs; do [ "$f" = scripts/smoke-postgres.mjs ] && continue; node "$f" || exit 1; done`

## Risks
Smoke flakiness or port races in CI. Mitigate by running serially and binding ephemeral ports
(the smokes already use `listen(0)`).

## Notes
Keeps the "build / dry-run / mock-validate everything" posture: real npm publish + registry push
stay human-gated (see `docs/GOAL.md` Exclusions).

## Validation
- Implemented as a `scripts/agent/smoke.sh` runner (builds dist, then runs every non-Postgres
  `scripts/smoke-*.mjs`, failing on the first non-zero exit) called by a new `smoke` CI job.
- `bash scripts/agent/smoke.sh` runs all 15 non-Postgres smokes green locally (incl. the Python
  SDK smoke); the runner is the exact command CI invokes.
- Failure path verified: a temporary always-failing smoke makes the runner exit non-zero and stop.
- `.github/workflows/ci.yml` parses cleanly; the 5 existing jobs are unchanged.
- The literal "green on main" registers on the first CI run after this branch is pushed/merged —
  not performed here (pushing to `main` is human-gated).
