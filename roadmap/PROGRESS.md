# Progress Log

> Newest entry first. Each session **prepends** a block: date, feature id, what was done, what was verified (evidence paths), surprises, exact next step. The SessionStart hook injects the top ~50 lines into every new session.

---

## 2026-06-12 — F-0003 done (health/readiness HTTP server)

**What:** Added a zero-dependency Node HTTP gateway with `start()`/`stop()`, unauthenticated `/healthz`, storage-backed `/readyz`, and in-memory HTTP integration tests. Security review blocked the first version for malformed request crashes and concurrent-start listener leaks; both were fixed with regression tests. A later review noted failed-listen cleanup, which was also fixed before merge.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0003/verify.log`. Fresh-context evaluator returned PASS. Security reviewer returned APPROVE after the lifecycle hardening fixes. Local checks passed: `npm run typecheck`, `npm test` (26 tests), `npm run build`, `npm run lint`, and `npx ts-node scripts/update-state.ts --validate`.

**Surprises:** Raw malformed request targets can bypass normal `fetch`-level assumptions, so the server now catches URL parse failures and keeps running.

**Next step:** Merge PR #32 after the final state commit goes green, then start F-0005 (Standard Webhooks signing and verification utilities).

---

## 2026-06-12 — F-0002 done (configuration and SQLite storage)

**What:** Added `loadConfig`, documented POSTHORN_* defaults, built the first `node:sqlite` storage layer, and initialized the initial Posthorn tables idempotently. Security review blocked the first endpoint-secret schema, so the schema now separates non-secret headers from secret references and stores signing secrets as protected recoverable fields with key metadata.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0002/verify.log`. Fresh-context evaluator returned PASS after evidence was committed. Security reviewer returned APPROVE after the schema hardening fix. Local checks passed: `npm run typecheck`, `npm test` (18 tests), `npm run build`, `npm run lint`, and `npx ts-node scripts/update-state.ts --validate`.

**Surprises:** The reviewer also spotted two non-blocking quality issues; both were fixed before merge: port values now cap at 65535, and `createGateway(loadConfig(...))` preserves loaded config fields.

**Next step:** Merge PR #31 after the final state commit goes green, then start F-0005 (Standard Webhooks signing and verification utilities) or F-0003 if HTTP serving is the higher leverage next foundation.

---

## 2026-06-12 — F-0001 done (product scaffold)

**What:** Groomed the empty roadmap into 18 machine backlog items, selected F-0001, and added the first Posthorn TypeScript product scaffold with a minimal gateway factory, Vitest test, build script, and README status wording.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0001/verify.log`. Fresh-context evaluator returned PASS, and dependency/security review returned APPROVE. Local product checks also passed: `npm run typecheck`, `npm test`, `npm run build`, `npm run lint`, and `npx ts-node scripts/update-state.ts --validate`.

**Surprises:** `bash scripts/verify.sh` reaches the existing hook contract tests but fails locally because Git Bash can see Windows `npm`/`npx` without a native Bash `node`; CI on Ubuntu is the authoritative full-gate lane for this branch.

**Next step:** Merge PR #30 after the final evidence commit goes green, then start F-0002 (configuration and SQLite storage foundation).

---

## 2026-06-11 — Engine installed (department bootstrap)

**What:** AI operations engine (ai-operations-template drop-in) installed into claude-sandbox-test1 (Posthorn — webhook relay). Engine files copied, placeholders filled, roadmap seeded, PROGRESS/DECISIONS/ROADMAP initialized.

**Verified:** `bash scripts/init.sh` and `bash scripts/verify.sh` both passed — VERIFY: PASS confirmed. Branch `develop` pushed to GitHub with engine commit. Default branch set to `develop`; branch protection applied to `develop` and `main`.

**Next step:** Run `/groom` against the charter (README.md + GOAL.md + roadmap/ROADMAP.md) to decompose the Now/Next/Later bullets into `features.json` entries with acceptance criteria.
