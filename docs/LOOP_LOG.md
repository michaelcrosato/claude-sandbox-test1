# LOOP_LOG

High-compression, unvarnished record of every iteration (Axiom 5). Newest first.

---

## 2026-05-22 — Iteration 5: P2 finished — durable delivery queue (lease + crash-safe replay)

**Repo truth at start:** clean main @ `542b0b0`. Baseline re-verified before any change:
`tsc --noEmit` clean, vitest **100/100**, `npm run build` clean, integrity + local gate both
exit 0. Node 24.15 / Vitest 2.1.9. Reconciled GOAL→PROJECT: the Posthorn decision (Iter 1) stands.
The glaring gap: the retry policy + delivery FSM (P1) were **pure islands disconnected from
storage** — nothing scheduled or persisted delivery work, so the product's headline "durable,
no-Redis, crash-safe delivery" wedge was unrealized.

**High-leverage move chosen:** Build the **durable, store-backed `DeliveryQueue`** — the spine that
joins retry-policy + delivery-FSM + persistence into actual reliable delivery. Highest-leverage
because (a) it *is* the differentiating "no Redis, single process, crash-safe" feature; (b) it
connects three previously-disconnected cores; (c) without it P3's HTTP API would have nothing
behind it. Followed the proven `MessageStore` architecture verbatim (interface + in-memory
reference + SQLite + one shared conformance suite) to keep risk low and validation fully in-process.

**Built this tick (`src/queue/`):**
- `delivery-queue.ts` — `DeliveryTask` + `DeliveryQueue` contract (`enqueue`/`claimDue`/`complete`/
  `fail`/`get`), `UnknownDeliveryTaskError` + `StaleLeaseError`, and **shared pure transition
  helpers** (`applyClaim`/`applySuccess`/`applyFailure` + `claimableState`) that defer to the P1
  delivery-state reducer — so the two backends cannot drift. Lease model: each claim mints a fresh
  lease token + visibility timeout; only the token holder may resolve the task.
- `in-memory-queue.ts` — `InMemoryDeliveryQueue`: insertion-ordered map of immutable task
  snapshots; the reference semantics.
- `sqlite-queue.ts` — `SqliteDeliveryQueue` on built-in `node:sqlite` (loaded via `createRequire`,
  same Vite-5 workaround as the store), `STRICT` schema, `claimDue` in a `BEGIN IMMEDIATE` txn
  ordered by `rowid` (atomic across connections; two workers never claim the same task).
- `conformance.ts` — `describeDeliveryQueueContract` + deterministic clock/id/lease-token
  generators; the single behavioural spec both backends run.
- Tests: in-memory + sqlite each run the conformance suite; SQLite adds **crash-safe replay**
  (enqueue→claim→close→reopen→lapsed lease reclaimed under a fresh token, old token rejected),
  terminal-survives-reopen, and file-isolation tests. `src/index.ts` re-exports the queue surfaces.

**Key design decision — at-least-once via lease + visibility timeout.** A lapsed lease (crashed/
stalled worker) makes a `delivering` task claimable again, reclaimed *as pending* so a fresh
attempt starts (the dead attempt still counts). This can double-deliver a stalled worker's task —
which is exactly why every message carries a stable id for receiver-side dedup (Standard Webhooks).
Logged honestly as the deliberate tradeoff. The full per-attempt audit log is deferred (an
observability add-on, distinct from the load-bearing delivery *state* the queue now persists).

**Validation:** `tsc --noEmit` clean (strict). vitest **145/145** (was 100; +45: in-memory queue 21,
sqlite queue 24). `npm run build` clean. **Smoke-tested the built `dist/index.js`** (Sqlite
enqueue→claim→lease-lapse→replay→complete) to prove the `createRequire` path works in production
ESM, not just under Vitest. Integrity + local gate: exit 0. (One tsc fix mid-build: `.all()` returns
`Record<string,…>[]`, so its cast to `TaskRow[]` had to route through `unknown` — `.get()`'s direct
cast does not need this.)

**State:** GREEN → committing to main. P2 complete. Next tick: P2.5 — the delivery *worker* loop
(claim → load message → sign → POST → complete/fail), the injectable, fake-clock-testable I/O driver
that finally makes an end-to-end send real.

---

## 2026-05-22 — Iteration 4: P2 begins — durable, crash-safe SQLite MessageStore + shared conformance

**Repo truth at start:** clean main @ `6984197`. Baseline re-verified before any change:
`tsc --noEmit` clean, vitest **81/81**, `npm run build` clean, integrity + local gate both
exit 0. Node 24.15 / Vitest 2.1.9 / Vite 5.4.21. Roadmap's next item: P2 — a durable
`MessageStore` implementing the P1 interface.

**High-leverage move chosen:** Build the **durable storage backend** + a **shared conformance
suite** that every `MessageStore` must pass. Highest-leverage because it (a) delivers the
product's core "single process, no Redis, durable" wedge, (b) validates the P1 storage seam by
giving it a *second* implementation, and (c) the conformance suite makes the future Postgres
backend trivially verifiable — "matches the reference" becomes a proven fact, not a hope.
Scoped to the store only; the durable queue + delivery-attempt records are deferred to keep
this a small, fully-validatable green unit (mirrors how P1 was split).

**Engine decision revised — `better-sqlite3` → built-in `node:sqlite`.** Probed the sandbox:
Node 24's `node:sqlite` works with zero deps and no native compile step. This *strengthens* the
"zero-dependency single container" wedge vs. the native `better-sqlite3` originally planned.
PROJECT.md §3 updated.

**Built this tick:**
- `src/storage/message-store.ts` — extracted three shared, pure helpers so backends can't
  drift: `normalizeNewMessage` (intake validation), `isIdempotencyExpired` (the one expiry
  rule, Infinity-safe), `assertValidIdempotencyWindow`, plus shared `DEFAULT_IDEMPOTENCY_WINDOW_MS`.
- `src/storage/in-memory-store.ts` — refactored onto those helpers; behaviour unchanged.
- `src/storage/sqlite-store.ts` — `SqliteMessageStore`: WAL + `synchronous=NORMAL` + FK,
  `STRICT` tables, two-table schema mirroring the in-memory design (`messages` never pruned;
  `idempotency_keys` ages out). `create` runs in a `BEGIN IMMEDIATE` txn so check-then-insert
  is atomic across connections. Adds `close()` and a `size` getter.
- `src/storage/conformance.ts` — `describeMessageStoreContract(label, factory)` + a
  deterministic clock; the single behavioural spec both backends run.
- Test files rewritten to call the conformance suite; SQLite adds a **crash-safe replay** test
  (write to a temp file, close, reopen → message + idempotency binding survive, retry dedups)
  and a file-isolation test. `src/index.ts` re-exports `SqliteMessageStore`.

**Snag + fix (logged honestly):** Vite 5's bundled builtins list predates `node:sqlite`, so a
static `import … from "node:sqlite"` made vite-node strip the prefix and fail to resolve
`sqlite`. `server.deps.external` and a `pre` `resolveId` plugin both failed to stop it. Resolved
by loading the builtin via `createRequire(import.meta.url)("node:sqlite")` — no static specifier
for the bundler to mangle; works identically in the compiled `dist` ESM (smoke-tested). `vitest.config.ts`
left at its clean original.

**Validation:** `tsc --noEmit` clean (strict). vitest **100/100** (was 81; +19: SQLite suite 18
incl. 14 shared-conformance + reopen/isolation, in-memory +1 size test). `npm run build` clean.
Smoke-tested the built `dist/index.js` (Sqlite create→dedup→size→close) to prove the
`createRequire` path works in production, not just under Vitest. Integrity + local gate: exit 0.

**State:** GREEN → committing to main. Next tick: continue P2 — delivery-attempt persistence
(extend the schema/interface) and a durable, store-backed queue with crash-safe replay of
in-flight deliveries.

---

## 2026-05-22 — Iteration 3: P1 finished — idempotent message store + storage seam

**Repo truth at start:** clean main @ `d2f06f8`. Baseline re-verified before any change:
`tsc --noEmit` clean, vitest **60/60**, `npm run build` clean, integrity gate + local gate
both exit 0. Node 24 / vitest 2.1.9. Strict tsconfig confirmed (`exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `verbatimModuleSyntax`). Roadmap's open P1 items: idempotency/dedup
keys + in-memory store behind a storage interface.

**High-leverage move chosen:** Build the **persistence seam** — the `MessageStore` interface +
its in-memory reference implementation + idempotent intake. Highest-leverage because it is the
load-bearing contract every later phase depends on: P2 (SQLite/Postgres) just implements the
same interface, and P3's HTTP handlers await it. Kept to message *intake* (not delivery-attempt
records, deferred to P2) to stay one small, fully-validatable green unit.

**Built this tick (`src/storage/`):**
- `message-store.ts` — `Message`/`NewMessage`/`CreateMessageResult` types, the async
  `MessageStore` interface (async so one contract spans sync better-sqlite3 *and* async
  Postgres), `IdempotencyConflictError`, a pure **length-prefixed** `messageFingerprint`
  (so `("ab","c")` ≠ `("a","bc")`), and the default `createMessageId` (144-bit base64url).
- `in-memory-store.ts` — `InMemoryMessageStore`: idempotent `create` (dedup on key → returns
  original w/ `deduplicated:true`; **conflict** on same-key/different-fingerprint → throws;
  **TTL** binding expiry, default 24h, `Infinity` = never), `get`, `getByIdempotencyKey`.
  Clock + id generator injected for determinism (matches signer/delivery convention). The
  message map is never pruned on expiry — only the key→id index ages out (Axiom 3 in spirit).
  Both surfaces re-exported from `src/index.ts`.

**Validation:** `tsc --noEmit` clean (strict). vitest **81/81** (was 60; +21: 6 fingerprint/
id/error, 15 store incl. conflict + TTL-boundary + Infinity-window + construction guard).
`npm run build` clean. Integrity gate + local gate: exit 0. git status: only `src/index.ts`,
new `src/storage/`, README, PROJECT.md (dist/ gitignored).

**State:** GREEN → committing to main. P1 complete. Next tick: P2 — a SQLite `MessageStore`
implementing this interface, then delivery-attempt persistence + a durable store-backed queue.

---

## 2026-05-22 — Iteration 2: P1 delivery decision core (retry + state machine)

**Repo truth at start:** clean main @ `671bfff`. P0 (signer/verifier) green, 23 tests.
Baseline re-verified before touching anything: `tsc --noEmit` clean, vitest 23/23,
integrity gate + local gate both exit 0. Node 24.15. `docs/GOAL.md` already resolved by
`docs/PROJECT.md` (Posthorn). Roadmap's next item: P1 delivery core.

**High-leverage move chosen:** Build the **delivery decision core** — the cohesive,
fully-deterministic heart of "reliable" delivery. Scoped to retry/backoff + state machine +
dead-letter (one logical unit: "what happens when an attempt resolves"). Deliberately
deferred idempotency/dedup + storage interface to the next tick to keep this commit a small,
fully-validatable green unit rather than a P1 blob.

**Built this tick (`src/delivery/`):**
- `retry-policy.ts` — immutable `RetryPolicy` (ordered inter-attempt delays). Builders:
  `fixedSchedule`, `exponentialBackoff` (base/factor/cap, validated). `DEFAULT_RETRY_POLICY`
  = Svix-like 7-retry / 8-attempt schedule (5s→…→10h, ~28h). `planNextAttempt` is the pure
  decision fn; jitter is opt-in with an **injectable RNG** so scheduling stays reproducible.
- `delivery-state.ts` — pure FSM `pending → delivering → succeeded`, failures routed through
  the policy back to `pending` (with `nextAttemptAt`) or to terminal `dead_letter` on
  exhaustion. Illegal transitions throw `DeliveryStateError` (no silent no-ops). Helpers
  `isTerminal` / `isDeliverable` for worker scheduling. Both surfaces re-exported from
  `src/index.ts`.

**Validation:** `tsc --noEmit` clean (strict, `exactOptionalPropertyTypes` +
`noUncheckedIndexedAccess`). vitest **60/60** (was 23; +37: 23 retry, 14 state). `npm run
build` clean. Integrity gate + local gate: exit 0. git status: only README, PROJECT.md,
index.ts, and new `src/delivery/` (dist/ correctly gitignored).

**State:** GREEN → committing to main. Next tick: finish P1 — idempotency/dedup keys + the
in-memory store behind a storage interface (sets up P2 SQLite).

---

## 2026-05-22 — Iteration 1: Project decided + foundation seeded

**Repo truth at start:** 1 commit (infra seed). `docs/GOAL.md` still open ("find a software
project to build"). `LOOP_LOG.md` empty. Dangling uncommitted improvement to
`run-autonomous-loop.ps1` (adds real engine-invocation param). Frozen gate
(`local-gate.ps1`) only checks git-cleanliness + conflict markers; manifest protects
AXIOMS + both gate scripts (cannot/should-not modify).

**High-leverage move chosen:** Resolve the GOAL's open decision — it blocks every future
build tick. Did the GOAL-mandated GitHub check + market research, then locked a decision
and seeded a validated foundation.

**GitHub check (`github.com/michaelcrosato`):** existing repos `salesforce-lite-crm` (TS),
`AC1` (Python), `agy-sandbox` (JS). CRM space is taken → avoided.

**Decision:** Build **Posthorn** (working name) — open-core, Standard Webhooks-compliant
**reliable webhook delivery infrastructure**. Rationale, market/competition/pricing analysis,
and roadmap in `docs/PROJECT.md`. Picked because it is the best intersection of the GOAL's
two filters: near-fully-deterministic logic (max autonomous buildability + test-verifiable →
keeps main green) AND high-profit open-core with expensive, ops-heavy incumbents (Svix
$490/mo + PG/Redis). Wedge: single container, **no Redis**, SQLite default, MIT, library mode.

**Stack:** TypeScript/Node — confirmed by probing sandbox (Node 24/npm/pnpm/Docker present,
**no Go**); also matches the human's TS ecosystem.

**Built this tick (P0):** TS scaffold (package.json, tsconfig strict, vitest, MIT LICENSE,
README, .gitignore) + first core module: spec-compliant HMAC signer/verifier
(`src/signing/webhook-signature.ts`) with `sign`/`verify`/`generateSecret`, replay window,
key-rotation multi-signature support.

**Validation:** `tsc --noEmit` clean (strict). `vitest` 23/23 pass, **including the canonical
Standard Webhooks reference vector** (proves byte-for-byte spec compliance). local-gate +
integrity gate: pass. Note: 5 moderate npm-audit advisories in dev deps (vitest/esbuild
chain) — tracked, not blocking; revisit in a tooling tick.

**State:** GREEN → committed to main. Next tick: P1 delivery core (retry/backoff schedule,
delivery state machine, idempotency, dead-letter) — all pure/deterministic.
