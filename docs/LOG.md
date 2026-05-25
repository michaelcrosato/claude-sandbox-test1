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
