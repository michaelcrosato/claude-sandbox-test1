# Progress Log

> Newest entry first. Each session **prepends** a block: date, feature id, what was done, what was verified (evidence paths), surprises, exact next step. The SessionStart hook injects the top ~50 lines into every new session.

---

## 2026-06-12 — F-0009 done (per-attempt audit log)

**What:** Added `GET /v1/messages/:id/attempts` for tenant-authenticated delivery attempt history. The route returns newest-first attempt rows with attempt number, outcome, timestamp, duration, response status, failure reason, delivery ID, message ID, and endpoint ID; missing and other-tenant messages both return `404`.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0009/verify.log`. Fresh-context evaluator returned PASS. Security reviewer returned APPROVE. Local checks passed: `npm run typecheck`, `npx vitest run tests/messages-http.test.ts`, `npx vitest run tests/messages-http.test.ts tests/worker.test.ts`, `npm test` (77 tests), `npm run lint`, `npm run build`, and `npx ts-node scripts/update-state.ts --validate`.

**Surprises:** Local `bash scripts/verify.sh` still fails only in the known Windows Git Bash hook-fixture environment where native `node` is unavailable; Ubuntu CI is the authoritative full gate and passed.

**Next step:** Merge PR #38 after the final evidence/state commit goes green, then start F-0010 (admin tenant and API-key management) unless a higher-priority unblocked feature appears.

---

## 2026-06-12 — F-0008 done (idempotent message intake)

**What:** Added optional `idempotencyKey` support for `POST /v1/messages`. Same-tenant retries with the same canonical request now return the original accepted message and delivery IDs without creating new fanout; changed retries return `409 idempotency_conflict`. Idempotency keys are tenant-scoped through the existing SQLite uniqueness constraint.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0008/verify.log`. Fresh-context evaluator returned NEEDS_WORK for a raw control-character validation gap, then PASS after the fix and regression test. Security reviewer returned APPROVE. Local checks passed: `npm run typecheck`, `npm test` (73 tests), `npm run build`, `npm run lint`, and `npx ts-node scripts/update-state.ts --validate`.

**Surprises:** Trimming before validation would have allowed leading/trailing control characters in idempotency keys; the parser now rejects control characters in the raw supplied string before trimming.

**Next step:** Merge PR #37 after the final evidence commit goes green, then start F-0009 (per-attempt audit log) or F-0010 if admin provisioning is higher leverage.

---

## 2026-06-12 — F-0007 done (crash-safe retry delivery worker)

**What:** Added the importable delivery worker with SQLite lease claiming, Standard Webhooks signing, success/failure attempt recording, exponential retry scheduling, dead-lettering, timeout handling, and lease reclaim. Endpoint signing-secret persistence now stores recoverable protected material for new endpoints while legacy digest-only rows fail closed instead of sending unsigned traffic. Security review blocked redirect-following and response-body buffering; the worker now sends with redirects disabled and cancels response bodies.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0007/verify.log`. Fresh-context evaluator returned NEEDS_WORK only until CI evidence existed; focused checks were green. Security reviewer returned BLOCK then APPROVE after outbound HTTP hardening. Local checks passed: `npm run typecheck`, `npm test` (69 tests), `npm run build`, `npm run lint`, and `npx ts-node scripts/update-state.ts --validate`.

**Surprises:** The assertion shield correctly blocked replacing a persisted-secret assertion; the implementation kept the historical `sha256:` compatibility prefix while using key-version metadata to distinguish recoverable protected secrets from legacy digest-only rows.

**Next step:** Merge PR #36 after the final evidence commit goes green, then start F-0008 (idempotent message intake).

---

## 2026-06-12 — F-0006 done (message intake and fanout queue)

**What:** Added `POST /v1/messages`, tenant-authenticated message persistence, pending delivery task creation for enabled matching endpoints, and store helpers for message/delivery readback. Security review approved and suggested payload-depth hardening; the JSON validator is now iterative with depth/node caps and regression coverage for deeply nested payloads.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0006/verify.log`. Fresh-context evaluator returned PASS. Security reviewer returned APPROVE. Local checks passed: `npm run typecheck`, `npm test` (58 tests), `npm run build`, `npm run lint`, and `npx ts-node scripts/update-state.ts --validate`.

**Surprises:** CI exposed nondeterministic ordering in fanout tests where random endpoint IDs tied on timestamps; the tests now seed deterministic endpoint timestamps and delivery readback uses insertion order.

**Next step:** Merge PR #35 after the final state commit goes green, then start F-0007 (crash-safe retry delivery worker).

---

## 2026-06-12 — F-0004 done (tenant endpoint management CRUD)

**What:** Added bearer-authenticated endpoint create/list/read/update/delete routes, tenant-scoped API-key auth helpers, endpoint validation, one-time `whsec_` create responses, and protected signing-secret persistence. Security review found SSRF edge cases in trailing-dot hostnames and IPv6 internal literals plus delayed oversized-body responses; all were fixed with regression tests.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0004/verify.log`. Fresh-context evaluator returned NEEDS_WORK then PASS after URL/body hardening. Security reviewer returned BLOCK then APPROVE after the same hardening fixes. Local checks passed: `npm run typecheck`, `npm test` (53 tests), `npm run build`, `npm run lint`, and `npx ts-node scripts/update-state.ts --validate`.

**Surprises:** URL policy needed DNS root-dot normalization and numeric IPv6 range checks; prefix checks alone were not enough.

**Next step:** Merge PR #34 after the final state commit goes green, then start F-0010 (admin tenant and API-key management).

---

## 2026-06-12 — F-0005 done (Standard Webhooks utilities)

**What:** Added dependency-free Standard Webhooks signing and verification utilities with `whsec_` HMAC-SHA256 secrets, raw-body signing, replay-window enforcement, case-insensitive header parsing, and multi-signature rotation support.

**Verified:** GitHub CI passed `verify` and `e2e`; evidence saved at `roadmap/evidence/F-0005/verify.log`. Fresh-context evaluator returned PASS. Security reviewer returned APPROVE. Local checks passed: `npm run typecheck`, `npm test` (47 tests), `npm run build`, `npm run lint`, and `npx ts-node scripts/update-state.ts --validate`.

**Surprises:** Local `bash scripts/verify.sh` still fails in Windows Git Bash for the known native-`node` hook-fixture issue, so Ubuntu CI remains the authoritative full-gate evidence.

**Next step:** Merge PR #33 after the final state commit goes green, then start F-0004 (tenant endpoint management CRUD).

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
