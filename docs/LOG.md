# Operational Log & System Ledger

## Page 1: Rules of the Log (Specification v1.0)

### 1. Conformance Tier Matrix
- **MUST / REQUIRED**: Mandatory. Failing this item makes the file non-compliant.
- **SHOULD / RECOMMENDED**: Strong recommendation. Valid exceptions can exist, but implications must be understood and noted.
- **MAY / OPTIONAL**: Permissive. Truly optional fields or sections.
- **MUST NOT / SHALL NOT**: Absolute prohibition. Doing this breaks compliance or forensic safety.

### 2. File and Ordering Constraints
- This file (`docs/LOG.md`) **MUST** be the single source of truth for repository history.
- Root-level log files or duplicate files (like `LOOP_LOG.md`) **MUST NOT** exist in the workspace.
- Entries **MUST** be written in **newest-first (reverse-chronological)** order. 
- New entries **MUST** be programmatically prepended immediately below the `== LOG-ANCHOR ==` line.
- Agents and humans **MUST NOT** free-hand rewrite or hand-edit older historical entries.

### 3. Entry Content & Structure Rules
- An entry **MUST** be generated only when product code changes, gate status transitions, or a material architecture decision is made.
- Relational or no-op loop triggers that result in no codebase modification **MUST NOT** log an entry.
- Every entry **MUST** use this strict multiline markdown schema:
  `## YYYY-MM-DDThh:mm · iter-NNNN · STATUS · lowercase-kebab-slug`
  * `- **Baseline:**` (Git SHA and starting state)
  * `- **Move:**` (One sentence defining the loop iteration objective)
  * `- **Changed:**` (Bulleted changes list)
  * `- **Decisions:**` (tradeoffs made, or "none")
  * `- **Validation:**` (Command executed and its precise exit/response text)
  * `- **Notes:**` (**OPTIONAL / MAY** — Sandbox area for agent/human thoughts, commentary, or context)
  * `- **Next:**` (1-3 subsequent engineering paths)

### 4. Status Vocabulary
The `STATUS` token in the header line **MUST** be exactly one of: 
`GREEN` (Passed) | `AMBER` (Caveats) | `RED` (Failed) | `BLOCKED` (Waiting) | `INCIDENT` (System Error) | `ROLLBACK` (Reset).

### 5. Size Hard Boundaries
- Individual text lines **MUST NOT** exceed 2,000 characters (guards against single-line data dumps).
- Lines **SHOULD** wrap at or under 120 characters for clean terminal and diff presentation where practical.
- Entries **SHOULD** target 150–350 words, and **MUST NOT** exceed 500 words unless labeled an `INCIDENT` or `ROLLBACK`.
- This file **MUST** be rotated into monthly archives (`docs/log/YYYY-MM.md`) once it crosses 1,000 lines or 250 KB.

---
== LOG-ANCHOR ==

## 2026-05-25T00:50 · iter-0106 · GREEN · multi-replica-active-active-deploy-guide

- **Baseline:** clean main @ `541cd5b` (iter-0105 bounded the PG pool max + acquisition
  timeout). Verified green first: `tsc --noEmit` 0, `vitest run` 1840 (6 PG-skipped),
  `npm run build` 0; `assert-gate-integrity.ps1` 0.
- **Move:** Write the operator guide for the one capability the entire iter-0103→0105 Postgres
  investment exists to enable but never documented — **running more than one gateway replica
  active/active**. The machinery (deployable PG backend, lock/idle timeouts, bounded pool) is in
  and correct; an operator who set `POSTHORN_DATABASE_URL` still had no instructions for scaling
  out, and the Monitoring section silently assumed a single process.
- **Changed:** New `## Running multiple replicas (active/active)` section in `docs/DEPLOY.md`,
  grounded in a read of how every background loop actually coordinates:
  - Per-subsystem coordination table — worker (`FOR UPDATE SKIP LOCKED` lease, verified
    `postgres-queue.ts:207`), idempotency unique index, endpoint-health fold (transactional
    `SELECT … FOR UPDATE`, `postgres-endpoint-store.ts:251`), fan-out dispatcher (uncoordinated
    but at-least-once / duplicate-safe), pruner (idempotent `DELETE … < cutoff`), monthly quota
    (per-request UTC-month count, no reset job).
  - A Docker-Compose worked example (3 replicas + shared `postgres:16` + nginx `resolver`
    round-robin), a k8s `Deployment` sketch, LB/health-check guidance (`/healthz` is a static
    liveness signal, not a DB probe), and the `replicas × POSTHORN_PG_POOL_MAX ≤ max_connections`
    budget example.
  - **Monitoring a fleet** — the load-bearing nuance: counters are per-replica (sum them), but
    the queue-backed gauges are read from the shared store at scrape time, so every replica
    reports the *same* value — `max without(instance)`, never `sum` (else N× the truth) — plus
    the `monitoring/alerts.yml` adjustments (gauge alerts fire per-replica; failure-rate rule is
    per-replica).
  - TOC fixed (it was also missing the existing PostgreSQL-backend entry) + a forward-ref note
    on the single-process Monitoring intro.
- **Decisions:** Docs-only — verified each operational claim against source rather than asserting
  it; no code change, so no new `POSTHORN_*` var and no config↔docs drift. Chose this over a 5th
  consecutive PG-pool knob (`idleTimeoutMillis`/`maxLifetimeSeconds`, diminishing returns) because
  the undocumented scale-out story blocks *all* multi-replica adoption — the capstone that makes
  the PG investment usable.
- **Validation:** `vitest run src/runtime/config.test.ts` 121/121 (the config↔docs drift guard
  reads the edited DEPLOY.md — every var still documented); `assert-gate-integrity.ps1` 0 (zero
  substrate edits); `validate-log-compliance.py` `[PASS]`. Docs-only: the iter-0105 code baseline
  (tsc 0 · vitest 1840 · build 0) is unchanged and stands.
- **Next:** Optional PG pool `idleTimeoutMillis` / `maxLifetimeSeconds` recycling knobs behind a
  connection-capping proxy; or commit a runnable k8s manifest / Helm values under `deploy/` to
  complement the in-doc sketch.

## 2026-05-25T00:30 · iter-0105 · GREEN · postgres-pool-max-and-connection-acquisition-timeout

- **Baseline:** clean main @ `07ca4f1` (iter-0104 added the per-connection lock +
  idle-in-txn GUC timeouts). Verified green first: `tsc --noEmit` 0, `vitest run`
  1831 (7 PG-skipped), `npm run build` 0.
- **Move:** Bound the shared Postgres pool — the last "wait forever" default on the PG
  path. `createPostgresPool` was a bare `new Pool({ connectionString, options })`: pg's
  default `max: 10` (unsizable — N replicas × 10 can exhaust a small managed Postgres'
  `max_connections`, or starve a single busy replica) and, worse, `connectionTimeoutMillis: 0`
  — a checkout against a *saturated* pool waits **indefinitely**. That is the
  pool-acquisition twin of the infinite `lock_timeout` iter-0104 just closed, and it would
  re-hang the whole gateway under connection starvation *despite* the statement-level timeouts.
- **Changed:**
  - `db/postgres.ts`: `createPostgresPool(url, { max?, connectionTimeoutMillis? })`. `max`
    defaults to new `DEFAULT_PG_POOL_MAX` (10 = pg's own default, so unset is a no-op);
    `connectionTimeoutMillis` defaults to fixed `POSTGRES_CONNECTION_TIMEOUT_MS` (10 s),
    bounding both new-connection establishment and the saturated-pool queue wait.
    Positive-int / non-negative-finite `RangeError` guards.
  - `config.ts`: new `POSTHORN_PG_POOL_MAX` → `databasePoolMax` (int ≥ 1, default 10),
    threaded into the pool at both creation sites — `gateway.ts` composition root and
    `main.ts` admin CLI. `index.ts` exports `DEFAULT_PG_POOL_MAX` + `PostgresPoolOptions`.
  - Docs: `.env.example` + a DEPLOY.md table row & "Connection pool sizing" note (the
    config↔docs drift guard enforces both).
- **Decisions:** Pool *max* is an operator var (a genuine per-deploy capacity call against the
  shared server budget); the acquisition *timeout* is a fixed safety bound (a constant, not an
  env var — same call as iter-0104's GUC timeouts, keeping the config↔docs surface to one new
  var). `connectionTimeoutMillis` stays an injectable option only so a test can prove fast-fail
  without the 10 s production wait.
- **Validation:** `tsc` 0; `vitest run` **1840** (6 PG-skipped files; +3 ungated pool-config
  tests now run in the gate, +4 config). Against live Docker Postgres 16: `postgres.test.ts`
  6/6 — incl. a new `max:1` saturation test proving a checkout fails with `timeout exceeded
  when trying to connect` in ~250 ms, never hangs — and gateway PG e2e 21/21;
  `smoke-postgres.mjs` on the compiled `dist` **9/9**. `npm run build` 0;
  `assert-gate-integrity.ps1` 0 (zero substrate edits); `validate-log-compliance.py` `[PASS]`.
- **Next:** `idleTimeoutMillis` / `maxLifetimeSeconds` pool knobs for connection recycling
  behind a transient-NAT proxy; or the DEPLOY.md active/active topology guide.

## 2026-05-25T00:15 · iter-0104 · GREEN · postgres-lock-and-idle-txn-timeouts

- **Baseline:** clean main @ `d682435` (iter-0103 wired the PG backend into the gateway).
  Verified green first: `tsc --noEmit` 0, `vitest run` 1831 (6 PG-skipped), `npm run build` 0.
- **Move:** Give the freshly-deployable Postgres backend the connection-level safety
  timeouts that the multi-replica path it exists for actually needs — the analogue of
  the SQLite busy-timeout added in iter-0102. `createPostgresPool` was a bare
  `new Pool({ connectionString })`, and Postgres defaults both `lock_timeout` and
  `idle_in_transaction_session_timeout` to *infinite*. The PG queue's single-task
  mutators (`complete`/`fail`/`retry`/`cancel`/`postpone`) take a plain `FOR UPDATE`
  (no `SKIP LOCKED`), so a manual API `retry`/`cancel` colliding with a worker's `fail`
  on the same row would block **forever**, pinning a pooled connection; a session left
  idle mid-`BEGIN` would hold its row locks forever, blocking every other replica.
- **Changed:**
  - `db/postgres.ts`: new `POSTGRES_LOCK_TIMEOUT_MS` (5 s, matching the SQLite
    busy-timeout) and `POSTGRES_IDLE_IN_TXN_TIMEOUT_MS` (10 s), applied to every pooled
    connection via the `-c …` startup `options` parameter — set at handshake, so no
    statement ever runs before the timeouts and there is no extra round-trip.
  - `db/postgres.test.ts` (new, PG-gated): asserts both GUCs reach the backend
    (`pg_settings`), and a real two-client `FOR UPDATE` contention test proving the
    blocked statement is cancelled with `55P03` within the bound — never hangs.
  - `DEPLOY.md`: "Concurrency safety timeouts" note in the PostgreSQL backend section.
- **Decisions:** Startup `options` param, not a `pool.on('connect')` SET — empirically
  the SET path emits pg's `client.query()`-while-busy DeprecationWarning (removed in
  pg@9) and races the first query; `options` is race-free and future-proof. Fixed
  constants, not new `POSTHORN_*` vars (same call as iter-0102's busy-timeout — keeps
  them off the config↔docs drift surface). **No `statement_timeout`**: the data pruner's
  bulk `DELETE`s can legitimately run long; both chosen timeouts fire only on a *blocked*
  or *stalled* statement, never on one making progress.
- **Validation:** `tsc` 0; `vitest run` **1831** (7 PG-skipped, +1 file). Against live
  Docker Postgres 16: full `vitest run` **2105/2105**, 0 skipped (incl. the 2 new tests).
  `npm run build` 0; `scripts/smoke-postgres.mjs` on the compiled `dist` vs real PG
  **9/9**. `assert-gate-integrity.ps1` 0 (zero substrate edits); `validate-log-compliance.py` `[PASS]`.
- **Next:** A `POSTHORN_PG_POOL_MAX` knob (the pool currently uses pg's default max 10,
  likely too low for a busy multi-replica deploy); or a DEPLOY.md active/active topology
  guide for the PG horizontal-scale path.

## 2026-05-24T23:59 · iter-0103 · GREEN · wire-postgres-backend-into-the-gateway

- **Baseline:** clean main @ `f4710f2` (iter-0102). Verified green first:
  `tsc --noEmit` 0, `vitest run` 1823, `npm run build` 0.
- **Move:** Make the long-advertised "Postgres optional" backend *actually deployable*.
  The six `Postgres*Store`s were implemented and conformant, but the gateway composition
  root + config could only ever open SQLite — an operator had no way to *select*
  Postgres, so a headline wedge ("none (SQLite) / PG optional") was unreachable. First
  proved the foundation: spun up Docker Postgres 16 and ran all six PG conformance
  suites — **270/270 pass** (the store layer was genuinely byte-for-byte conformant,
  just unwired).
- **Changed:**
  - `config.ts`: new `POSTHORN_DATABASE_URL` (`databaseUrl`) — a validated
    `postgres:`/`postgresql:` URL selects the PG backend; unset = SQLite (default).
  - `gateway.ts`: extracted `openStoreBackend(config)`, the *only* place the backend is
    chosen — the PG branch opens one shared `pg.Pool` + the six PG stores. `start()` now
    `await`s an async `initialize()` (PG schema DDL; no-op for SQLite) before listening;
    `stop()` `await`s `dispose()` (close SQLite handles / drain the pool). Started-log
    gains `backend`; the credential-bearing PG URL is never logged.
  - `main.ts`: the `admin` CLI opens a `PostgresAppStore` on the same DB when the URL is
    set, so CLI and gateway can't provision into different stores.
  - Docs: `POSTHORN_DATABASE_URL` in `.env.example` + a `DEPLOY.md` "PostgreSQL backend"
    section (the config↔docs drift guard enforces both).
- **Decisions:** Backend chosen by *presence of the connection URL* (the `DATABASE_URL`
  convention), not a separate enum — one var, no invalid states. No cross-store FKs in
  the PG schemas, so `initialize()` order is free. The pool is owned by the composition
  root (one shared pool; PG slots are precious); `dataDir` is unused on PG.
- **Validation:** `tsc` 0; `vitest run` **1831** (+8 config tests; 6 PG files still skip
  without a DB). With a live Postgres: +2 PG-gated gateway e2e tests (boot→schema→
  deliver→**verify**; restart-persistence on the shared DB) pass. `npm run build` 0. New
  `scripts/smoke-postgres.mjs` on the compiled `dist` vs real PG: **9/9** — proving the
  `pg` CJS-in-ESM interop under the real Node loader. Admin CLI verified cross-process on
  PG. `assert-gate-integrity.ps1` 0 (zero substrate edits); `validate-log-compliance.py`
  `[PASS]`.
- **Notes:** Hit the known flaky tinypool "Worker exited unexpectedly" on two full runs;
  a re-run was clean 1831/1831 (not red).
- **Next:** Postgres `lock_timeout`/`statement_timeout` for parity with the SQLite
  busy-timeout; or a DEPLOY.md multi-replica active/active topology guide for the new PG
  horizontal-scale path.

## 2026-05-24T23:55 · iter-0102 · GREEN · sqlite-busy-timeout-for-multi-process-contention

- **Baseline:** clean main @ `f5930ab` (iter-0101 log rotation). Verified green first:
  `tsc --noEmit` 0, `vitest run` 1819, `npm run build` 0.
- **Move:** Close the one conspicuous gap in the SQLite connection setup — no `busy_timeout`.
  `node:sqlite` defaults it to 0, so a write that loses a lock race fails *immediately* with
  `SQLITE_BUSY` ("database is locked") rather than waiting. Posthorn's own single process never
  contends (one synchronous connection per store file), but the product *supports* concurrent
  multi-process access: the `posthorn admin` CLI opens the same `apps.db` while the gateway runs
  (`resolveLocations`), rolling deploys briefly overlap two containers on the shared data dir, and
  online backup tooling (`.backup`, Litestream) takes locks — there the loser failed spuriously.
- **Changed:**
  - New `src/db/sqlite.ts`: `SQLITE_BUSY_TIMEOUT_MS` (5 s) + `applyConnectionPragmas(db,{foreignKeys?})`
    — single source of truth for the WAL + synchronous=NORMAL + busy-timeout opening sequence the six
    stores each duplicated inline; foreign-key enforcement stays opt-in per store.
  - Refactored all six SQLite stores (apps, endpoints, messages, attempts, event-types, queue) onto
    the helper. Behaviour-preserving: WAL/synchronous unchanged; FK passed `true` exactly where each
    store set it before (node:sqlite already defaults FK on, so the three that omitted it are
    unaffected); the only new effect is the busy-timeout.
  - `src/db/sqlite.test.ts` (+4) and a `docs/DEPLOY.md` note beside the online-backup guidance.
- **Decisions:** Hard-coded constant, not a new `POSTHORN_*` env var — it belongs with the other
  non-tunable durability pragmas and avoids the config/doc-drift surface for a value operators never
  need to change. 5 s is the standard server-SQLite recommendation; the synchronous event-loop block
  is bounded and only paid under real, rare contention. No public API/SDK/OpenAPI change — the helper
  is internal to the store layer (not re-exported from `index.ts`).
- **Validation:** `tsc --noEmit` 0; `vitest run` **1823** (+4; 53 files, 6 PG-skipped, no flaky
  exit) — incl. the file-backed restart-persistence integration test exercising the new pragmas
  through the real composition root; `npm run build` 0; `assert-gate-integrity.ps1` 0 (zero
  substrate edits); `validate-log-compliance.py` `[PASS]`.
- **Next:** Mirror the failure-reason column onto the admin dashboard message-detail deliveries
  (`dashboard/views.ts`) for parity with the tenant view; or review a Postgres-side `lock_timeout`
  for the optional PG backend.

## 2026-05-24T23:45 · iter-0101 · GREEN · rotate-canonical-log-into-monthly-archive

- **Baseline:** clean main @ `2ebfab1` (iter-0100 tenant failure-reason column). `docs/LOG.md`
  stood at 994 lines / 83 KB — under the 250 KB ceiling but one product entry short of the
  1,000-line rotation boundary the last three ticks flagged (iter-0098/0099/0100 Notes).
- **Move:** Pre-emptively rotate the active ledger before the next code entry crosses the cap, so
  every commit lands a compliant, lean `docs/LOG.md` (Axiom 2 / checklist step 6 state hygiene).
- **Changed:**
  - Moved the 25 canonical-schema entries (`iter-0076`–`iter-0100`) verbatim out of `docs/LOG.md`
    into `docs/log/2026-05.md`, the existing monthly archive, placed **above** the legacy `LOOP_LOG`
    section so the file stays globally newest-first across both schema generations.
  - Rewrote the archive's provenance banner to describe both generations it now holds (canonical
    0076–0100 on top, legacy 1–75 below) and to record that the canonical block rotated here
    at iter-0101.
  - `docs/LOG.md` now carries only the Page-1 rules header, the `== LOG-ANCHOR ==`, and this entry.
- **Decisions:** Archived rather than truncated — Axiom 3: every prior entry is preserved intact,
  just relocated (no entry was rewritten; only the archive's own banner prose changed). Reused the
  `docs/log/YYYY-MM.md` monthly path the substrate documents and iter-0076 established, since all of
  2026-05's history belongs in one month archive. Started the active log "fresh" (header + anchor +
  newest entry) mirroring iter-0076, as the rules mandate no minimum retained-entry count and the
  full history is one `cat` away.
- **Validation:** `python scripts/validate-log-compliance.py` → `[PASS]` (anchor present, sole
  entry heading well-formed, no duplicate id, no >2000-char line); `pwsh
  scripts/assert-gate-integrity.ps1` → 0 (zero substrate edits). Docs-only: the iter-0100 green
  code baseline (tsc 0 · vitest 1819/1819 · build 0) is unchanged and still stands.
- **Notes:** The validator does not itself enforce the line cap; this rotation honors doctrine rule
  #5 and checklist step 6 proactively so the active ledger never lands oversized.
- **Next:** SQLite `busy_timeout` hardening so multi-process access (the `posthorn admin` CLI on
  `apps.db`, rolling-deploy file overlap, online backup tooling) waits briefly instead of failing
  with "database is locked"; or mirror the failure-reason column onto the admin dashboard.
