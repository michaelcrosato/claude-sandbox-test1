# TICKET004 — Repo map + keep human/agent docs in sync

- **Status:** done
- **Priority:** Medium

## Goal
Give agents a one-screen "where things live" map and establish the rule that the human-facing
and agent-facing docs stay synchronized as the product changes.

## Context
A cold agent otherwise blind-scans `src/` to learn the layout, burning tokens. The repo has a
clean per-subsystem structure (`src/signing`, `src/queue`, `src/worker`, …) that maps cleanly to a
table. Separately, several doc surfaces must agree or tests/readers break: `README.md`,
`.env.example` + `src/runtime/config.ts` + `docs/DEPLOY.md` (config.test.ts enforces env-var
parity), `GET /openapi.json` ← `src/http/openapi.ts` (drift-tested), and the TS/Python SDKs.

## Scope
- **In:** `docs/ai/REPO_MAP.md` (entry points, subsystem table, tests/contracts/config, deploy/CI,
  skip list); a "keep in sync" note captured in `AGENTS.md`/`ROADMAP.md`.
- **Out:** restructuring `src/` (architecture is stable — see ROADMAP Phase 4); generating the map
  automatically.

## Likely files
`docs/ai/REPO_MAP.md`, `AGENTS.md`, `ROADMAP.md`.

## Steps
1. Walk `src/` top-level dirs; one row each with its responsibility.
2. List entry points and mark `src/runtime/config.ts` as the authoritative env parser.
3. Capture the contract/sync surfaces (env-var dual-doc, OpenAPI drift, SDK parity).
4. Point the skip list at `.aiignore` rather than restating it.

## Acceptance criteria
- [x] `docs/ai/REPO_MAP.md` covers entry points, every `src/` subsystem, tests/contracts, deploy/CI.
- [x] Skip list defers to `.aiignore` (single source of truth).
- [x] Sync expectations recorded so a future change to a route/env-var/SDK updates all surfaces.

## Commands
`ls src` · `node -e "console.log(Object.keys(require('./package.json').scripts))"`

## Risks
The map drifts as code moves. Mitigate by keeping it coarse (subsystem-level, not file-level) so it
only changes when a whole subsystem is added or removed.

## Notes
Pairs with `AGENTS.md` (rules + loop). Intentionally coarse-grained to minimize churn.
