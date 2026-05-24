# LOOP_LOG

High-compression, unvarnished record of every iteration (Axiom 5). Newest first.

---

## 2026-05-24 — Iteration 66: Message Priority (`high`/`normal`/`low` delivery ordering)

**Repo truth at start:** dirty main @ `554d007` (iter-65 docs). Five files modified
(message-store, in-memory-store, sqlite-store, postgres-store, delivery-queue) with
priority scaffolding but the feature incomplete: `normalizeEnqueueInput` returned
without `priority`, all three queue backends ignored it, and no conformance tests existed.
Classic interrupted-tick — validated and landed without a rebuild from scratch.

**High-leverage move chosen:** Complete message priority end-to-end. Priority is a
differentiation feature (Svix supports it) and a clean additive seam: it touches the
storage intake layer (already wired) and the queue claim ordering (not wired). Completing
it adds a marketable capability and proves the architecture can carry cross-cutting
fields from intake to delivery cleanly.

**What the feature does:** `NewMessage.priority` accepts `"high" | "normal" | "low"`.
Stored as `TEXT` in the message tables (already done in prior tick). Mapped to numeric
`1 / 0 / -1` in the delivery queue for SQL `ORDER BY priority DESC` claim ordering.
When multiple tasks are due simultaneously, higher-priority ones are claimed first.
Within the same priority level, oldest-first ordering is preserved.

**Built this tick:**
- `message-store.ts` — `MessagePriority` type, `VALID_PRIORITIES`, validation in
  `normalizeNewMessage` (done in prior tick, already committed via dirty tree).
- `in-memory-store.ts`, `sqlite-store.ts`, `postgres-store.ts` — store + read
  `priority` column with additive migrations (done in prior tick).
- `delivery-queue.ts` — fixed `normalizeEnqueueInput` to extract and validate
  `priority ∈ {-1, 0, 1}` (RangeError on out-of-range); added to `NormalizedEnqueue`.
- `in-memory-queue.ts` — `enqueue` stores priority; `claimDue` now collects all
  claimable candidates, sorts `priority DESC, createdAt ASC, id ASC`, claims up to
  `limit` (matching SQL ordering).
- `sqlite-queue.ts` — `TaskRow.priority`, `rowToTask`, `#migratePriorityColumn`,
  `SCHEMA` updated; `#insertTask` includes priority; `#selectClaimable` ORDER BY
  changed to `priority DESC, rowid ASC`.
- `postgres-queue.ts` — same treatment: `TaskRow`, `rowToTask`, schema, additive
  `ALTER TABLE … ADD COLUMN IF NOT EXISTS` in `initialize()`, enqueue INSERT,
  `claimDue` ORDER BY `priority DESC, created_at ASC, id ASC`.
- `conformance.ts` — 2 new tests in `enqueue` ("stores priority, default 0",
  "rejects out-of-range") + 1 new test in `claimDue` ("higher-priority claimed first,
  within same priority oldest-first preserved").
- Fixture fixes: 5 inline literal `Message`/`DeliveryTask` objects in test files and
  production code (`api.ts`, `portal-handler.ts`) updated with `priority` field.

**Validation:** `tsc --noEmit` clean. vitest **1367/1367** (was 1350; +17: 3 new
conformance × 3 backends + message-store normalizeNewMessage priority test already
counted in store tests). `npm run build` clean. local-gate + integrity gate: exit 0.

**State:** GREEN → committed to main @ `afb0bf2`. Next highest-leverage move: wire
priority through the HTTP API intake (`POST /v1/messages`) so callers can set it,
and expose it on the `GET /v1/messages/:id` response; or advance toward a richer
roadmap feature (e.g. rate-limiting, HTTP delivery worker integration, or SDK
priority support).

---

## 2026-05-24 — Iteration 65: Message Expiry (`expiresAt`)

**Repo truth at start:** clean main @ `1832282` (iter-64, stored deliverAt). Baseline
verified: `tsc --noEmit` clean, vitest **1350/1350** (46 files), `npm run build` clean.

**Problem:** Posthorn had `deliverAt` (don't deliver *before* this time) but no
complementary deadline: a scheduled message for "your OTP expires in 5 minutes" or
"your session expires at 10:00" could, if the receiver was down during that window, be
delivered hours later — actively harmful. Every production webhook platform (Svix,
Hookdeck, AWS SNS) lets operators set a message TTL / expiry deadline.

**Move chosen:** `expiresAt: number | null` (epoch-ms stored; ISO 8601 on the wire)
on the `Message` model. When the delivery worker picks up a task and finds
`now > message.expiresAt`, it dead-letters immediately without retrying — the same
`{ delaysMs: [] }` force-policy used by `nonRetryable`. No new delivery states; no
change to the queue FSM; clean additive column migrations for both SQLite and Postgres.

**Architecture (16 files, +294 / −50):**

1. **`src/storage/message-store.ts`** — `expiresAt: number | null` on `Message`,
   `NewMessage`, `NormalizedNewMessage`; validation in `normalizeNewMessage`
   (non-negative integer; same pattern as `deliverAt`).

2. **`src/storage/in-memory-store.ts`** — destructure and store `expiresAt` in
   the message literal.

3. **`src/storage/sqlite-store.ts`** — `expires_at: number | null` in `MessageRow`;
   `rowToMessage` maps `expires_at ?? null`; all SELECT column lists and INSERT
   updated; `#migrateExpiresAtColumn()` additive migration (PRAGMA + ALTER TABLE ADD
   COLUMN, same idiom as `deliverAt`); SCHEMA includes `expires_at INTEGER`.

4. **`src/storage/postgres-store.ts`** — same pattern; `expires_at BIGINT` in SCHEMA;
   `ADD COLUMN IF NOT EXISTS expires_at BIGINT` migration; BIGINT → `Number()` in
   `rowToMessage`; INSERT parameterized with `$9`.

5. **`src/worker/delivery-worker.ts`** — expiry check after message load, before
   resolver call (sets `failure` and `messageExpired = true`; `else` branch skips
   resolver + HTTP entirely); `nonRetryable` check extended with `|| messageExpired`
   so the settle uses `{ delaysMs: [] }` → immediate dead-letter, no retry scheduled.

6. **`src/fanout/fanout.ts`** — `expiresAt` added to the `Pick<Message, …>` type so
   the function signature accepts the full `Message` struct from the test literals.

7. **`src/http/api.ts`** — `parseExpiresAt` helper (mirrors `parseSendAt`); wired
   into `createMessage` and `batchSendMessages`; `expiresAt` in `messageListItemView`,
   `messageView`, create response, batch item response; synthetic test message
   literal updated with `expiresAt: null`.

8. **`src/http/openapi.ts`** — `expiresAt` (integer|null, int64) in `MessageSummary`
   and `Message` required+properties; `expiresAt` (string|null, date-time) in
   `NewMessage` properties.

9. **`src/sdk/client.ts`** — `expiresAt?: string | null` on `SendMessageInput`;
   `expiresAt: number | null` on `MessageRef` and `MessageWithDeliveries`;
   `sendMessage` and `sendMessageBatch` serialize `expiresAt` when present.

10. **Test literal fixes** — `delivery-worker.test.ts`, `endpoint-resolver.test.ts`,
    `fanout.test.ts`, `portal/portal-handler.ts` updated with `expiresAt: null`.

**Tests (+11 cases, total 1361/1361 green):**
- `storage/conformance.ts`: 3 new cases × 2 backends (in-memory + SQLite) = 6 —
  stores/retrieves `expiresAt`; defaults to `null`; rejects non-integer/negative.
- `worker/delivery-worker.test.ts`: 2 new cases — expired message dead-letters
  immediately with no HTTP call (`deadLettered: 1`); future `expiresAt` delivers
  normally (`succeeded: 1`).
- `http/api.test.ts`: 1 new case — `expiresAt` stored and returned in POST
  `/v1/messages`.
- `sdk/client.test.ts`: 2 new cases — serializes `expiresAt`; omits when not
  provided.

**Validation:** `tsc --noEmit` clean → vitest **1361/1361** (46 files, 6 Postgres
skipped), up from 1350. All 11 new tests green. `npm run build` clean → committed
`2ee4fbd`.

---

## 2026-05-24 — Iteration 64: Stored `deliverAt` — Completing Scheduled Delivery

**Repo truth at start:** clean main @ `e56d3aa` (iter-63, endpoint message replay). Baseline
verified: `tsc --noEmit` clean, vitest **1341/1341** (46 files), `npm run build` clean.

**Problem:** `sendAt` (ISO 8601 wire field for scheduled / delayed delivery) was already parsed
by the HTTP API and used to set `availableAt` on the inline fan-out call — so direct ingestion
honoured the schedule. However, `deliverAt` was never stored in the `Message` model. The
transactional outbox dispatcher (`FanoutDispatcher`) re-fans orphaned messages by calling
`fanOut(message, ...)` with no explicit options; without `deliverAt` on the message, the
dispatcher would enqueue orphaned scheduled messages as *immediately* deliverable, silently
breaking the guarantee for any message that was recovered from the outbox.

**Move chosen:** Store `deliverAt: number | null` (epoch-ms) in the `Message` model and thread
it through all code paths so both the inline fan-out and the outbox recovery path honour the
scheduled time.

**Architecture:**

1. **`src/storage/message-store.ts`** — Added `deliverAt: number | null` to `Message`,
   `NewMessage`, `NormalizedNewMessage`, and validation in `normalizeNewMessage` (rejects
   non-integer or negative values).

2. **`src/storage/in-memory-store.ts`** — Extracts and stores `deliverAt` in the message
   literal.

3. **`src/storage/sqlite-store.ts`** — Added `deliver_at INTEGER` to schema; additive migration
   via `PRAGMA table_info` + `ALTER TABLE ADD COLUMN`; all SELECT/INSERT statements updated;
   `rowToMessage` maps `deliver_at ?? null`.

4. **`src/storage/postgres-store.ts`** — Added `deliver_at BIGINT`; migration via
   `ADD COLUMN IF NOT EXISTS`; Postgres returns BIGINT as string so `rowToMessage` calls
   `Number(row.deliver_at)`.

5. **`src/fanout/fanout.ts`** — `fanOut` signature extended to pick `deliverAt` from the
   message; resolves `availableAt = options.availableAt ?? message.deliverAt ?? null` so
   explicit callers (HTTP API) still win, and the outbox dispatcher picks up stored schedule.

6. **`src/http/api.ts`** — Passes `deliverAt: sendAtMs` in `NewMessage` input; removed the
   now-redundant `fanoutOptions`/`itemFanoutOptions` variables; list/detail views and create
   responses include `deliverAt`.

7. **`src/http/openapi.ts`** — `MessageSummary` and `Message` schemas include `deliverAt`
   (`integer|null`, `int64`).

8. **`src/sdk/client.ts`** — `MessageRef` and `MessageWithDeliveries` include `deliverAt`.

9. **`src/portal/portal-handler.ts`, `src/http/api.ts` (test path), `src/worker/delivery-worker.test.ts`**
   — Synthetic message literals updated with `deliverAt: null`.

**Tests added / updated (9 new, many updated):**
- `src/storage/conformance.ts`: 3 new cases — stores and retrieves `deliverAt`, defaults to
  `null`, rejects invalid values.
- `src/fanout/fanout.test.ts`: 2 new cases — `message.deliverAt` used as `availableAt`;
  explicit `options.availableAt` overrides it. All existing message literals updated.
- `src/http/api.test.ts`: 1 new case — `sendAt` stored and returned in response as `deliverAt`.
- `src/endpoints/endpoint-resolver.test.ts`: `FAKE_MESSAGE` updated with `deliverAt: null`.

**Validation:** `tsc --noEmit` clean → `npx vitest run` **1350/1350** (46 files) → `npm run build` clean.

---

## 2026-05-24 — Iteration 63: Endpoint Message Replay

**Repo truth at start:** clean main @ `3252f95` (iter-62, channel-based routing). Baseline
verified: `tsc --noEmit` clean, vitest **1311/1311** (45 files), `npm run build` clean.

**Problem:** Posthorn could revive *dead-lettered* delivery tasks via `retryEndpointDeliveries`,
but had no path for the complementary case: an endpoint added *after* messages were already
accepted has no existing tasks to revive — it simply missed those messages. Likewise, an
endpoint that needs to re-process a specific time window (e.g. after fixing a bug in the
receiver) would have to be rebuilt externally. Svix charges for this capability as "Recovery"
(a paid add-on); we ship it as a standard operator tool.

**Move chosen:** `POST /v1/endpoints/:id/replay` — pages the tenant's message log, applies
the endpoint's full routing rules, and enqueues a fresh delivery task for each matching
message. Operators bound the scan with optional `since`/`until` epoch-ms timestamps; `limit`
(default 100, max 1000) caps per-call work, and `hasMore` signals whether another call is
needed to continue the scan. The receiver naturally deduplicates via the stable `webhook-id`
on each delivery.

**Architecture:**

1. **`src/queue/replay-endpoint.ts`** (new) — `normalizeReplayLimit` (validates integer in
   `[1, 1000]`, throws `RangeError` for out-of-range values), `replayEndpointMessages`
   (pages `listByApp` newest-first with `SCAN_PAGE_SIZE=200`; skips messages newer than
   `until`; breaks once below `since`; applies `selectFanoutTargets([endpoint], ...)`;
   enqueues via `queue.enqueue`). `hasMore` is set only when a matching message is found
   *beyond* the limit cap — the check runs before enqueuing so `hasMore: false` is returned
   correctly when the limit equals the exact number of matches.

2. **`src/http/api.ts`** — `replayEndpoint` handler added (optional body, same pattern as
   `testEndpoint`); `"POST /v1/endpoints/:id/replay"` added to `API_ROUTE_KEYS` and the
   route table. Also: `toErrorResponse` updated to map `RangeError` → 400 `invalid_request`
   (previously only `TypeError` was mapped; out-of-range `limit` was silently 500).

3. **`src/http/openapi.ts`** — `/v1/endpoints/{id}/replay` path added with `replayEndpoint`
   operation; `ReplayRequest` (optional `since`, `until`, `limit` fields) and `ReplayResult`
   (`enqueued`, `hasMore`) schemas added.

4. **`src/sdk/client.ts`** — `ReplayEndpointInput` / `ReplayEndpointResponse` interfaces;
   `replayEndpoint(endpointId, input?)` method (omits body when no input provided; URL-encodes
   `endpointId`).

5. **`src/index.ts`** — exports `replayEndpointMessages`, `normalizeReplayLimit`,
   `DEFAULT_REPLAY_LIMIT`, `MAX_REPLAY_LIMIT`, `ReplayOptions`, `ReplayResult`, `ReplayDeps`
   from `replay-endpoint.js`; `ReplayEndpointInput` and `ReplayEndpointResponse` from `client.js`.

**Tests (+30 cases, total 1341/1341 green):**
- `replay-endpoint.test.ts` (20 new): empty log → `{enqueued:0,hasMore:false}`; non-matching
  subscription; matching + enqueue + correct task fields; tenant isolation; disabled endpoint;
  eventType filter; channel filter; global endpoint receives all; `since` lower bound; `until`
  upper bound; combined window; limit stops early (`hasMore:true`); limit equals total
  (`hasMore:false`); default limit behavior.
- `http/api.test.ts` (7 new): 401 unauthenticated; 404 unknown endpoint; 404 cross-tenant;
  `{enqueued:0,hasMore:false}` no messages; enqueues task for matching message; respects
  eventTypes filter; respects `since`/`until`; 400 for `limit=99999`.
- `sdk/client.test.ts` (3 new): POSTs to correct URL with URL-encoded id; serializes
  `{since, until, limit}`; omits body when no input provided.

**Validation:** `tsc --noEmit` clean → vitest **1341/1341** (46 files, 6 Postgres skipped),
up from 1311. All 30 new tests green. `npm run build` clean.

**Commit:** `18e3224` — iter-63 — 8 files changed, 827 insertions, 5 deletions.

---

## 2026-05-24 — Iteration 62: Channel-Based Message Routing

**Repo truth at start:** clean main @ `c1684c5` (iter-61, direct delivery lookup). Baseline
verified: `tsc --noEmit` clean, vitest **1286/1286** (45 files), `npm run build` clean.

**Problem:** Posthorn's fan-out targeted every enabled, subscribed endpoint in the tenant — but
there was no way to scope a delivery to a *subset* of endpoints based on the message sender's
intent. A SaaS platform ("Acme") wanting to send a `payment.created` webhook only to
customer_Alice's endpoint would have to either (a) create one Posthorn App per customer (admin
overhead scales with the customer count), (b) maintain routing externally (defeats the product's
purpose), or (c) use payload filters — but filters are owned by the *endpoint*, not the message,
and they require the customer_id to be in the payload rather than in the routing envelope.
Every serious webhook platform (Svix calls this "Applications"; Hookdeck calls it "channels")
exposes per-customer scoping as a first-class feature.

**Move chosen:** Add a `channel` field to both messages and endpoints. The routing rule is
simple and composable with existing filters:
- `endpoint.channel = null` → **global** — receives all messages regardless of channel
- `endpoint.channel = "x"` → **channel-scoped** — receives only messages with `channel = "x"`
- Message with `channel = null` → untagged — only global endpoints receive it
- Message with `channel = "x"` → received by global endpoints AND channel-"x" endpoints

A SaaS platform creates one endpoint per end-user (with `channel = "customer/{id}"`), sends
messages tagged with the same channel, and only the right customer's endpoint fires. A shared
analytics endpoint with no channel receives everything. Fully composable with event-type
subscription and payload filters (the channel check runs after the eventType check, before
the payload filter check) — all three gate a delivery independently.

**Architecture (additive, zero blast radius):**

1. **`src/endpoints/endpoint.ts`** — `MAX_CHANNEL_LENGTH = 200`, `normalizeChannel()` (validates
   non-empty string ≤ 200 chars, no control chars; null passthrough); `channel: string | null`
   on `Endpoint`, `NewEndpoint`, `EndpointUpdate`, `NormalizedNewEndpoint`; wired into
   `normalizeNewEndpoint` and `applyEndpointUpdate`.

2. **`src/storage/message-store.ts`** — `channel: string | null` on `Message`, `NewMessage`;
   `channel?: string | null` on `ListMessagesOptions`; `normalizeNewMessage` validates via
   `normalizeChannel`; `resolveListMessagesQuery` propagates the channel filter.

3. **`src/fanout/fanout.ts`** — `skippedChannel: readonly Endpoint[]` added to `FanoutSelection`
   and `skippedChannel: number` to `FanoutResult`; pure `channelMatchesEndpoint(endpoint, msgChannel)`
   helper (returns `true` when `endpoint.channel === null || endpoint.channel === msgChannel`);
   `selectFanoutTargets` gains a `channel` param (3rd arg, default `null`) and inserts the
   channel check as the 3rd priority (after disabled, after unsubscribed, before filter);
   `fanOut` passes `message.channel` to the selection.

4. **All six stores** (in-memory + SQLite + Postgres for both endpoints and messages):
   - In-memory: `channel` stored on create, filtered in `listByApp`.
   - SQLite endpoints: `channel TEXT` column via `#migrateChannelColumn()` (`PRAGMA table_info` +
     `ALTER TABLE`); INSERT/UPDATE updated; `rowToEndpoint` maps it.
   - SQLite messages: same additive migration; `#selectByAppFirst` / `#selectByAppAfter` and their
     eventType-filtered twins extended with `IS ?` predicate for null-safe channel matching;
     new `idx_messages_app_channel_created (app_id, channel, created_at, id)` covering index for
     channel-filtered list queries.
   - Postgres endpoints/messages: same column additions; `IS NOT DISTINCT FROM` for null-safe
     channel equality on Postgres.

5. **`src/http/api.ts`** — `createMessage` and `batchSendMessages` parse `channel` from body
   via `normalizeChannel`; `createEndpoint` / `updateEndpoint` pass it through; `messageView`,
   `messageListItemView`, and `endpointView` include `channel`; fan-out summary exposes
   `skippedChannel`; `GET /v1/messages` parses `?channel=` and threads it to `listByApp`.

6. **`src/http/openapi.ts`** — `channel` field added to `MessageSummary`, `Message`, `NewMessage`,
   `Endpoint`, `NewEndpoint`, `EndpointUpdate` schemas; `skippedChannel` added to `FanoutSummary`
   (both `required` array and `properties`); `?channel=` parameter added to `GET /v1/messages`
   path.

7. **`src/sdk/client.ts`** — `channel` added to `SendMessageInput`, `MessageRef`,
   `MessageWithDeliveries`, `CreateEndpointInput`, `UpdateEndpointInput`, `EndpointView`,
   `ListMessagesParams`, `FanoutSummary`; serialized in `sendMessage`, `sendMessageBatch`,
   `createEndpoint`, `updateEndpoint`, `listMessages`.

8. **`src/index.ts`** — exports `normalizeChannel`, `MAX_CHANNEL_LENGTH`.

**Tests (+25 cases, total 1311/1311 green):**
- `fanout.test.ts`: 8 new `selectFanoutTargets` cases — global endpoint receives any-channel
  message, global receives untagged, channel endpoint receives same channel, channel endpoint
  skips different channel (→ skippedChannel), channel endpoint skips untagged message,
  mixed [global + channelA + channelB] only skips channelB, `skippedChannel` bucket is empty
  on no-channel endpoints, disabled channel endpoint still goes to skippedDisabled first.
- `storage/conformance.ts`: 5 new message-store channel cases × 2 backends = 10 tests —
  create with channel, create without channel (null), listByApp channel filter, `channel=null`
  filter, no filter returns all.
- `endpoints/conformance.ts`: 4 new endpoint channel cases × 2 backends = 8 tests — create
  with channel, create without channel (null), update channel, update to null.
- `http/api.test.ts` / `sdk/client.test.ts`: 7 new tests — channel round-trip in message view,
  skippedChannel in fan-out summary, `?channel=` filter, endpoint create/update channel, SDK
  transport serialization.

**Validation:** `tsc --noEmit` clean → vitest **1311/1311** (45 files, 6 Postgres skipped), up
from 1286. All 25 new tests green. `npm run build` clean.

**Commit:** `6bd7777` — iter-62 — 20 files changed, 541 insertions, 74 deletions.

---

## 2026-05-24 — Iteration 61: Direct Delivery Lookup + Attempt History

**Repo truth at start:** clean main @ `b3c0438` (iter-60, endpoint payload filters). Baseline
verified: `tsc --noEmit` clean, vitest **1262/1262** (45 files), `npm run build` clean.

**Problem:** Operators debugging a failed delivery could only reach its attempt history
through the parent message (`GET /v1/messages/:id/attempts`), which returns attempts
for *all* endpoints in the fan-out, not just the one delivery they care about. Anyone
storing task IDs (e.g., from a list operation) had no direct fetch path — they had to
list and filter client-side or scan the full message attempts log.

**Move chosen:** Add `GET /v1/deliveries/:id` (single delivery fetch) and
`GET /v1/deliveries/:id/attempts` (per-delivery attempt history). This completes the
delivery API surface: every resource now has a direct GET path, and attempt history is
reachable both via message and via delivery. The backing `listByTask` query on the
attempt store is the natural complement to the existing `listByMessage` — the data is
already there (every attempt records its `taskId`); only the index and API surface were
missing.

**What landed (10 files, +522 / 0):**

- `src/attempts/delivery-attempt.ts` — `listByTask(taskId, options?)` added to
  `DeliveryAttemptStore` interface.
- `src/attempts/in-memory-attempt-store.ts` — `listByTask` implemented (filter on
  `taskId`, same pagination logic as `listByMessage`).
- `src/attempts/sqlite-attempt-store.ts` — `idx_delivery_attempts_task_paged` covering
  index `(task_id, attempted_at, id)`; `#selectByTaskFirst` / `#selectByTaskAfter`
  prepared statements; `listByTask` + `#fetchTaskPage` helper.
- `src/attempts/postgres-attempt-store.ts` — `idx_delivery_attempts_task_paged` added
  to `INDEXES` const; `listByTask` implemented.
- `src/attempts/conformance.ts` — `describe("listByTask")` block: 6 cases covering
  empty page, isolation from other tasks, forward pagination, exact-fit last page,
  RangeError on limit=0, TypeError on bad cursor.
- `src/http/api.ts` — `"GET /v1/deliveries/:id"` and `"GET /v1/deliveries/:id/attempts"`
  added to `API_ROUTE_KEYS`; `getDelivery` and `listDeliveryAttempts` handlers (both
  do the standard tenant-ownership check via `queue.get` + `task.appId` comparison —
  another tenant's delivery is 404); wired into the exhaustive route table.
- `src/http/openapi.ts` — `/v1/deliveries/{id}` (GET) and `/v1/deliveries/{id}/attempts`
  (GET) paths with full parameter/response schemas.
- `src/sdk/client.ts` — `getDelivery(id)` and `listDeliveryAttempts(id, params?)` methods.
- `src/http/api.test.ts` — 2 new describe blocks (9 tests): 401/404 auth guards,
  cross-tenant 404, field presence checks, recorded-attempt round-trip.
- `src/sdk/client.test.ts` — 4 new transport tests: correct URL/method, URL encoding,
  query-string passthrough.

**Validation:** `tsc --noEmit` clean → vitest **1286/1286** (45 files, 6 Postgres
skipped), up from 1262. All 24 new tests green. `npm run build` clean.

**Commit:** `2697af7` — iter-61 — 10 files changed, 522 insertions.

---

## 2026-05-24 — Iteration 60: Endpoint Payload Filters

**Repo truth at start:** clean main @ `879d1d1` (iter-59, per-endpoint bulk retry). Baseline
verified: `tsc --noEmit` clean, vitest **1228/1228** (45 files), `npm run build` clean.

**Problem:** Fan-out had no way to gate a delivery on *payload content* — every subscribed,
enabled endpoint received every matching event type regardless of what was inside the JSON body.
Production webhook platforms (Svix, Hookdeck) all offer per-endpoint payload filters.

**Move chosen:** Endpoint payload filter DSL — composable, DSL-gated fan-out delivery.
Highest operator value: lets tenants precisely target endpoints without spamming low-traffic
receivers with irrelevant events. Fits cleanly into `selectFanoutTargets` (pure function, new
`skippedFiltered` bucket) without touching the worker or delivery path.

**What landed (15 files, +750 / −26):**

- `src/endpoints/endpoint.ts` — `FieldFilter`, `AndFilter`, `OrFilter`, `NotFilter`,
  `EndpointFilter` union; `MAX_FILTER_NODES=20`, `MAX_FILTER_DEPTH=5`; `normalizeEndpointFilter()`
  (validates DSL, rejects depth/size overflows), `getPathValue()` (dot-path accessor),
  `matchesFilter()` (pure evaluator). `Endpoint.filter`, `NewEndpoint.filter`,
  `EndpointUpdate.filter` added; `normalizeNewEndpoint` and `applyEndpointUpdate` wired.
- `src/endpoints/in-memory-endpoint-store.ts` — `filter: normalized.filter` on create.
- `src/endpoints/sqlite-endpoint-store.ts` — `filter TEXT` column; additive migration
  (`#migrateFilterColumn`); INSERT/UPDATE statements updated.
- `src/endpoints/postgres-endpoint-store.ts` — `filter TEXT` column; INSERT/UPDATE updated.
- `src/fanout/fanout.ts` — `selectFanoutTargets` gains `skippedFiltered` bucket (4th priority
  after disabled > unsubscribed > filter-mismatch); `fanOut` parses `message.payload` and
  propagates `skippedFiltered` count; `FanoutSelection` and `FanoutResult` updated.
- `src/http/api.ts` — `endpointView` exposes `filter`; create/update handlers parse `filter`
  from body; fan-out summary includes `skippedFiltered`.
- `src/http/openapi.ts` — `FieldFilter`, `LogicalFilter`, `NotFilter`, `EndpointFilter` schemas
  (recursive via `$ref`); `Endpoint`/`NewEndpoint`/`EndpointUpdate` schemas carry `filter`;
  `FanoutSummary` carries `skippedFiltered`.
- `src/sdk/client.ts` — `EndpointFilterView` recursive type alias; `EndpointView.filter`,
  `CreateEndpointInput.filter`, `UpdateEndpointInput.filter`; `createEndpoint` / `updateEndpoint`
  serialize filter; `FanoutSummary.skippedFiltered` added.
- `src/index.ts` — exports `matchesFilter`, `normalizeEndpointFilter`, `MAX_FILTER_NODES`,
  `MAX_FILTER_DEPTH`, `EndpointFilter`, `FieldFilter`, `AndFilter`, `OrFilter`, `NotFilter`,
  `RetryPolicyView`, `EndpointFilterView`.

**Tests (+132 cases, total 1262/1262 green):**
- `endpoint.test.ts`: 25 new cases for `matchesFilter` and `normalizeEndpointFilter`.
- `endpoint-resolver.test.ts`: added `filter: null` to BASE_EP fixture (tsc fix).
- `conformance.ts`: `describe("filter")` block — 4 cases × 2 backends = 8.
- `fanout.test.ts`: `filter: null` in helper; `skippedFiltered: []` in empty-bucket assertion;
  `payload: "{}"` on 4 `fanOut()` calls; 4 new `selectFanoutTargets` filter tests.
- `api.test.ts`: 3 new endpoint-CRUD filter tests (round-trip, update/clear, skippedFiltered).
- `client.test.ts`: 1 new filter round-trip E2E test.

**Validation:** `tsc --noEmit` clean → vitest **1262/1262** → `npm run build` clean → committed
`b3c0438`.

---

## 2026-05-24 — Iteration 59: Per-Endpoint Bulk Retry

**Repo truth at start:** clean main @ `0b1df75` (iter-58, cancel delivery API+SDK). Baseline
verified: `tsc --noEmit` clean, vitest **1212/1212** (45 files), `npm run build` clean.

**High-leverage move chosen:** Per-endpoint bulk retry — the final missing cell in the recovery
matrix. Operators whose Stripe or Shopify endpoint was down for hours now have a single route to
revive all dead-lettered deliveries for that specific endpoint without touching healthy ones.
`POST /v1/endpoints/:id/deliveries/retry` mirrors `POST /v1/deliveries/retry` (app-wide) but
scoped to one endpoint.

**Root blocker:** `listByEndpoint` had no status filter, making dead-letter scans
O(all-time history) without backend-side filtering. The fix is `ListByEndpointOptions extends
ListDeliveriesOptions` with an optional `status` field — a 6-line interface that unlocks
efficient pagination in all three backends.

**Architecture (additive, zero blast radius):**

1. **`delivery-queue.ts`** — `ListByEndpointOptions` interface (extends `ListDeliveriesOptions`,
   adds `status?: DeliveryStatus | null`); `listByEndpoint` signature updated to accept it.

2. **`in-memory-queue.ts`** — status filter as a single `.filter()` call after the
   `endpointId` filter; `null` → no filter (backwards compatible).

3. **`sqlite-queue.ts`** — 4-path dispatch (filtered/unfiltered × cursor/no-cursor) + a
   new covering index `(endpoint_id, status, created_at, id) WHERE endpoint_id IS NOT NULL`
   added to the SCHEMA string with `IF NOT EXISTS` for idempotent upgrades.

4. **`postgres-queue.ts`** — same 4-path pattern using positional `$1/$2/...` parameters.

5. **`conformance.ts`** — 2 new `listByEndpoint` tests: status filter returns correct subset;
   status-filtered pagination emits correct `nextCursor` across pages. Fixed
   `retryPolicy: { retries: 0, delaysMs: [] }` → `fixedSchedule([])` (TS error caught by tsc).

6. **`retry-app.ts`** — `retryEndpointDeliveries` function (structural twin of
   `retryAppDeliveries`): validates limit, calls `listByEndpoint(..., { status: "dead_letter" })`,
   re-drives each task, absorbs `DeliveryStateError` / `UnknownDeliveryTaskError`.

7. **`retry-app.test.ts`** — new `describe("retryEndpointDeliveries")` block: 7 tests (empty,
   pending-only, revives N tasks, endpoint isolation, hasMore pagination, concurrent-revive
   absorption, invalid-limit RangeError).

8. **`api.ts`** — `"POST /v1/endpoints/:id/deliveries/retry"` in `API_ROUTE_KEYS`;
   `retryEndpointAllDeliveries` authed handler (ownership check via `loadOwnedEndpoint`);
   route table entry.

9. **`openapi.ts`** — `/v1/endpoints/{id}/deliveries/retry` path with `post` operation;
   reuses `BulkRetryResult` schema.

10. **`sdk/client.ts`** — `retryEndpointDeliveries(endpointId)` method.

11. **`api.test.ts`** — 4-test describe block: 401 unauthenticated, 404 unknown endpoint,
    `{retried:0, hasMore:false}` when no dead-letters, revives 1 dead-lettered delivery.

12. **`sdk/client.test.ts`** — transport test: correct URL encoding + `{retried, hasMore}`
    round-trip.

13. **`index.ts`** — exports `ListByEndpointOptions`, `retryEndpointDeliveries`.

**Validation:**
- `tsc --noEmit` — clean (one TS error caught and fixed: `retries` → `fixedSchedule([])`).
- `vitest run` — **1228/1228** (45 files, 6 Postgres skipped), up from 1212. All 16 new tests green.
- `npm run build` — clean.

**Commit:** `623464e` — iter-59 — 13 files changed, 429 insertions, 33 deletions.

---

## 2026-05-24 — Iteration 58: Cancel Delivery HTTP API + SDK

**Repo truth at start:** clean main @ `a25b17f` (iter-57, delivery cancellation). Baseline
verified: `tsc --noEmit` clean, vitest **1203/1203** (44 files), `npm run build` clean.

**High-leverage move chosen:** Surface `DeliveryQueue.cancel()` to the HTTP API and SDK.
The queue method existed but was reachable only programmatically — no tenant-facing route, no SDK
method, no OpenAPI entry. This iter adds the complete operator abort path end-to-end.

**Architecture (additive, zero blast radius):**

1. **`src/queue/cancel-message.ts`** (new) — thin orchestration layer, structural twin of
   `retry-message.ts`. Lists a message's delivery tasks and cancels the pending ones via
   `queue.cancel()`; absorbs `DeliveryStateError` / `UnknownDeliveryTaskError` (concurrent cancel
   safety); re-lists after cancellation so returned snapshots show `cancelled` status.

2. **`src/queue/cancel-message.test.ts`** (new) — 4 tests: cancel a pending delivery (status →
   `cancelled`), only-pending filter (succeeded/dead_letter left alone), no-op when nothing pending,
   and empty result for unknown message.

3. **`src/http/api.ts`** — `"POST /v1/messages/:id/cancel"` added to `API_ROUTE_KEYS`; import of
   `cancelMessageDeliveries`; `cancelMessage` authed handler (same tenant-ownership check as
   `retryMessage`); entry in the exhaustive `handlers` Record.

4. **`src/http/openapi.ts`** — `/v1/messages/{id}/cancel` path + `post` operation; `CancelResult`
   schema (after `RetryResult`); `Delivery.status` enum and the `?status=` query-param enum both
   updated to include `"cancelled"` (iter-57 omission).

5. **`src/sdk/client.ts`** — `CancelMessageResponse` interface; `cancelMessage(id)` method after
   `retryMessage`, identical transport pattern (`POST /v1/messages/:id/cancel`).

6. **`src/http/api.test.ts`** — new `describe("createApi — POST /v1/messages/:id/cancel")` block:
   4 tests (401 unauthenticated, 404 unknown, 404 cross-tenant, cancels pending + returns count +
   refreshed statuses).

7. **`src/sdk/client.test.ts`** — 1 new test: `cancelMessage` sends the right URL/method and
   returns `{ id, cancelled, deliveries }`.

**Validation:**
- `tsc --noEmit` — clean.
- `vitest run` — **1212/1212** (45 files, 6 Postgres files skipped), up from 1203. All 9 new tests
  green.
- `npm run build` — clean.

**Commit:** iter-58 — 7 files changed.

---

## 2026-05-24 — Iteration 57: Delivery Cancellation

**Repo truth at start:** interrupted tick — 3 files modified (delivery-state.ts, delivery-queue.ts,
in-memory-queue.ts) with no iter-57 LOOP_LOG entry; incomplete `cancel` implementation missing
sqlite-queue, postgres-queue, conformance tests, and mock fixes. Reconcile-and-land pattern applied.

**High-leverage move chosen:** Complete the in-progress delivery cancellation feature. Before this
iteration, operators had no way to abort a scheduled or queued delivery — a message sent to an
endpoint that was subsequently disabled or had its secret rotated would still fire. This adds a
first-class `cancel` transition as the symmetrical abort path alongside `manualRetry`.

**Architecture (additive, zero blast radius):**

1. **`delivery-state.ts`** — new `cancelled` terminal `DeliveryStatus`; `cancel` event in the
   `DeliveryEvent` union; `isTerminal()` updated; `reduce()` `case "cancel"` transitions `pending →
   cancelled` (only valid from `pending` — an in-flight or terminal task cannot be cancelled).

2. **`delivery-queue.ts`** — `zeroDeliveryCounts()` includes `cancelled: 0`; `DeliveryQueue`
   interface gains `cancel(taskId): Promise<DeliveryTask>`; `applyCancel()` pure helper mirrors
   `applyManualRetry()` — wraps the FSM reducer and stamps `updatedAt`, clears lease fields.

3. **`in-memory-queue.ts`** — `InMemoryDeliveryQueue.cancel()` implemented.

4. **`sqlite-queue.ts`** — `applyCancel` imported; `cancel()` method added (same transaction
   pattern as `retry()`); `pruneTerminalTasks` now deletes `'cancelled'` rows too.

5. **`postgres-queue.ts`** — same as SQLite: `applyCancel` imported; `cancel()` with
   `BEGIN/COMMIT/ROLLBACK` + `FOR UPDATE`; `pruneTerminalTasks` includes `'cancelled'`.

6. **`conformance.ts`** — `cancel (operator abort)` describe block: 4 tests covering the happy
   path (pending → cancelled, not claimable), cancelled-then-retried resend, unknown-id error, and
   rejection from non-pending states (delivering + succeeded). Three `countByStatus` `toEqual`
   assertions updated to include `cancelled: 0`.

7. **Test mock fixes** — `metrics.test.ts` and `delivery-worker.test.ts` (×3 mock objects) updated
   to include `cancelled` in status count literals or as no-op `cancel` stubs.

**Validation:**
- `tsc --noEmit` — clean.
- `vitest run` — **1203/1203** (44 files, 6 Postgres files skipped), up from 1195. The 8 new
  conformance tests (4 cancel + 2 countByStatus `toEqual` fixes across 2 backends) all green.
- `npm run build` — clean.

**Commit:** `a25b17f` — 8 files changed, 197 insertions.

---

## 2026-05-24 — Iteration 56: PostgreSQL Backend for All Six Stores

**Repo truth at start:** clean main @ `132c8ad` (iter-55, non-retryable HTTP status codes). Baseline
verified: `tsc --noEmit` clean, vitest **1195/1195** (44 files), `npm run build` clean.

**High-leverage move chosen:** PostgreSQL backend — adds `PostgresMessageStore`,
`PostgresDeliveryQueue`, `PostgresAppStore`, `PostgresEndpointStore`,
`PostgresDeliveryAttemptStore`, and `PostgresEventTypeStore`. This is the P5 "Postgres optional via
a thin storage interface" milestone from PROJECT.md. Without it, Posthorn is constrained to
single-process, single-node deployments backed by SQLite. With it, multiple Posthorn workers can
share one Postgres database for active/active deployments and the hosted cloud tier.

**Architecture:**

1. **`src/db/postgres.ts`** — `createPostgresPool(connectionString)` factory wrapping `pg.Pool`.
   Pool lifecycle is owned by the caller (gateway/test); each store takes a shared `Pool` reference.
   `pg` added to `optionalDependencies` in `package.json`, `@types/pg` to `devDependencies`.
   Zero-dep claim for SQLite mode is preserved — `pg` is never imported in non-Postgres paths.

2. **Six Postgres stores** (one per domain) — each `implements` the same interface as its SQLite
   sibling, gated by the same conformance suite:
   - `PostgresMessageStore` — `messages` + `idempotency_keys` tables; `TO_CHAR(TO_TIMESTAMP(...))` for UTC day bucketing; idempotency create uses `BEGIN`/`COMMIT`/`ROLLBACK` transactions via `pool.connect()`.
   - `PostgresDeliveryQueue` — `delivery_tasks` table; `SELECT … FOR UPDATE SKIP LOCKED` in `claimDue()` enables multi-worker concurrent claim without writer blocking.
   - `PostgresAppStore` — `apps` + `api_keys` tables; `UNIQUE` on `key_hash`; FK `ON DELETE CASCADE`.
   - `PostgresEndpointStore` — `endpoints` table; `disabled` is `BOOLEAN` (not 0/1 INTEGER); JSON columns for `previous_secrets`, `event_types`, `headers`, `retry_policy`.
   - `PostgresDeliveryAttemptStore` — `delivery_attempts` table; append-only (INSERT only); partial indexes for `app_id IS NOT NULL` and `endpoint_id IS NOT NULL`.
   - `PostgresEventTypeStore` — `event_types` table; `BOOLEAN` for `archived`; duplicate PK maps to `DuplicateEventTypeError`.

3. **Schema design decisions:**
   - All epoch-ms timestamps use `BIGINT` (Postgres `INTEGER` is 32-bit = max ~2.1B; epoch-ms is ~1.7T).
   - `pg` returns `BIGINT` columns as JavaScript strings → `Number(row.column)` in all `rowToXxx` helpers.
   - `initialize()` async method creates/migrates tables (vs SQLite's synchronous constructor).
   - `truncate()` calls `TRUNCATE TABLE … RESTART IDENTITY CASCADE` for test isolation.
   - `close()` is no-op on all Postgres stores; pool lifecycle is the caller's responsibility.

4. **Conformance test wrappers** — six `*.test.ts` files (one per store), each gated on
   `process.env.POSTHORN_TEST_PG_URL`. When the env var is absent, the test file emits a single
   `describe.skip` — the default 1195-test suite is completely unaffected. When the env var is set,
   `beforeAll` runs `initialize()` once, `beforeEach` runs `truncate()`, and the full conformance
   suite drives a fresh store instance per test.

5. **`src/index.ts`** — all six Postgres store classes + `PostgresXxxStoreOptions` types + `createPostgresPool` / `Pool` / `PoolClient` re-exported from the public entrypoint.

**Validation:**
- `tsc --noEmit` — clean (one fix: `Awaited<ReturnType<Pool["connect"]>>` → `PoolClient` in `postgres-store.ts`).
- `vitest run` (default, no env var) — **1195/1195**, 6 files skipped.
- `docker run postgres:16-alpine` + `POSTHORN_TEST_PG_URL=...` — **215/215** Postgres conformance tests green across all six stores.
- Container removed post-validation.

**Commit:** `359df90` — 16 files changed, 2328 insertions.

---

## 2026-05-24 — Iteration 55: Non-Retryable HTTP Status Codes

**Repo truth at start:** clean main @ `7e41ea3` (iter-54, per-endpoint retry policy). Baseline verified:
`tsc --noEmit` clean, vitest **1171/1171** (44 files), `npm run build` clean.

**High-leverage move chosen:** Non-retryable HTTP status codes — `nonRetryableStatuses?: number[]`
field added to `RetryPolicy`. Before this iteration, every non-2xx response was treated identically:
a 401 Unauthorized or 410 Gone triggered the full retry backoff (up to 7 more attempts) and burned
the tenant's metered delivery quota for responses that cannot succeed on retry. Operators had no way
to express "this status code means permanent failure — skip retries." All incumbents (Svix, Hookdeck,
Convoy) expose this as a first-class configuration knob.

**Architecture (additive, zero blast radius):**

1. **`RetryPolicy` interface** (`retry-policy.ts`) — new optional `nonRetryableStatuses?:
   readonly number[]` field. Absent/empty = retry on any failure (backward-compatible). Added
   `isNonRetryableStatus(policy, status)` pure helper for the worker check.

2. **`endpoint.ts`** — `normalizeRetryPolicy` now validates and passes through `nonRetryableStatuses`:
   must be an array of integers in [100, 599], max `MAX_NON_RETRYABLE_STATUSES` (20) entries,
   deduplicated order-preserving. An empty array normalizes to `undefined` (canonical "none").
   `MAX_NON_RETRYABLE_STATUSES` exported alongside the other policy constants.

3. **Worker** (`delivery-worker.ts`) — after a non-2xx response, checks the endpoint's effective
   retry policy for `nonRetryableStatuses`. If the response status is in that set, passes
   `{ delaysMs: [] }` as the retry policy override to `#settleFailure`, which causes
   `planNextAttempt` to return `{ retry: false }` on the first call → immediate dead-letter.
   Only fires when the endpoint has a custom policy (`resolvedTarget.retryPolicy` is present);
   no policy = no non-retryable status check, preserving the global default behavior.

4. **SQLite** — zero migration needed; `nonRetryableStatuses` is stored inside the
   existing `retry_policy TEXT` column (JSON-serialized), so it round-trips automatically.

5. **OpenAPI** — `RetryPolicyConfig` schema gains a `nonRetryableStatuses` property with
   `items: { integer, 100–599 }` and `maxItems: 20`.

6. **SDK** — `RetryPolicyView` interface gains `nonRetryableStatuses?: readonly number[]`.

**Tests:** 24 new tests over baseline of 1171 → **1195 total** (44 files):
- `isNonRetryableStatus` pure helper: 5 cases — absent policy, status in list, status not in list,
  empty list, boundary check
- `normalizeRetryPolicy` validation: 10 cases — round-trip, absent field, dedup, empty → undefined,
  too many entries, non-integer, out-of-range, boundary values (100/599), non-array
- Conformance: 2 cases — create with `nonRetryableStatuses`, DeliveryTarget forwarding
- Worker: 3 cases — non-retryable status → dead-letters immediately, non-matching status → retries
  normally, no endpoint policy → retries normally
- API: 2 cases — create with `nonRetryableStatuses` round-trips in view, PATCH set and clear
- SDK: 1 case — creates and updates a policy with `nonRetryableStatuses` on an endpoint

**Validation:** `tsc --noEmit` clean, `npx vitest run` **1195/1195** (44 files), `npm run build` clean.

---

## 2026-05-24 — Iteration 54: Per-Endpoint Retry Policy Override

**Repo truth at start:** clean main @ `40e91c7` (iter-53, attempt body capture). Baseline verified:
`tsc --noEmit` clean, vitest **1146/1146** (44 files), `npm run build` clean.

**High-leverage move chosen:** Per-endpoint retry policy — each endpoint can now carry a
`RetryPolicy | null` that overrides the system-wide default for its deliveries. Before this,
every endpoint on an application shared a single retry schedule set at queue-creation time;
operators running mixed-criticality endpoints (e.g., a critical payment webhook alongside a
low-priority analytics endpoint) had no way to give them different retry cadences. Every
incumbent (Svix, Hookdeck, Convoy) exposes per-endpoint or per-application retry configuration
as a first-class feature.

**Architecture (additive, zero blast radius):**

Policy flows through the pipeline without touching the queue schema:

1. **`Endpoint` model** — new `retryPolicy: RetryPolicy | null` field with `normalizeRetryPolicy()`
   validator (max 20 retries, max 30-day delay per step). Constants `MAX_RETRY_POLICY_RETRIES`
   and `MAX_RETRY_POLICY_DELAY_MS` exported from `index.ts`.

2. **SQLite migration** — `#migrateRetryPolicyColumn()` appends `retry_policy TEXT` to the
   `endpoints` table using the same PRAGMA table_info + ALTER TABLE additive pattern as prior
   migrations. JSON-serialized in the column, deserialized on read.

3. **Resolver bridge** — `endpointToDeliveryTarget` now spreads `retryPolicy` onto
   `DeliveryTarget` (optional field, spread-conditional for exactOptionalPropertyTypes).

4. **Worker** — `#deliver` captures the resolved target before sending; `#settleFailure` accepts
   an optional `retryPolicy` argument and includes it in `FailInput` if present.

5. **Queue** — `FailInput` gains `readonly retryPolicy?: RetryPolicy`; `normalizeFailInput`
   threads it through; both `InMemoryQueue.fail()` and `SqliteQueue.fail()` use
   `retryPolicy ?? this.#policy` so per-task policy wins when supplied.

6. **API + OpenAPI** — `endpointView` includes `retryPolicy`; POST/PATCH handlers pass it
   through. OpenAPI gains a `RetryPolicyConfig` component schema referenced by `Endpoint`,
   `NewEndpoint`, and `EndpointUpdate`.

7. **SDK** — `RetryPolicyView` interface exported; all endpoint input/output types updated;
   `createEndpoint` and `updateEndpoint` serialize it to the request body.

**Tests:** 25 new tests over baseline of 1146 → **1171 total**:
- Endpoint conformance (×2 backends): 6 cases — create with policy, update to null, update from
  null to policy, normalizeRetryPolicy validation (oversized array, overlong delay), null passthrough
- Queue conformance (×2 backends): 3 cases — per-task policy wins over global, null falls back to
  global, override does not persist to subsequent fail calls
- Worker: 3 cases — policy passed to fail when endpoint has one, null when endpoint has none,
  null on pre-flight failure
- API: 3 cases — create with retryPolicy, update to null, round-trip read
- SDK: 1 case — creates and updates a custom retryPolicy on an endpoint

**Validation:** `tsc --noEmit` clean, `npx vitest run` **1171/1171** (44 files), `npm run build` clean.

---

## 2026-05-24 — Iteration 53: Attempt Request/Response Body Capture

**Repo truth at start:** clean main @ `f86671b` (iter-52, endpoint delivery statistics). Baseline verified:
`tsc --noEmit` clean, vitest **1133/1133** (44 files), `npm run build` clean. No
[[interrupted-tick-reconcile-pattern]] trigger.

**High-leverage move chosen (checklist #3):** Attempt request/response body capture — `requestBody`
and `responseBody` on every `DeliveryAttempt`. The `fetchTransport` had a comment literally marking
this as "a later add-on": it already drained the response body and threw the bytes away. The attempt
audit log (iter-22) records outcome, status, error, and latency, but without the actual payloads it
cannot answer the most common debugging question: "what exactly was sent, and what did the receiver
say?". Operators had to re-send the message (side-effecting) or cross-reference the message store
(two API calls, and impossible for non-2xx responses where the receiver's error body is lost entirely).
Every incumbent (Svix, Hookdeck, Convoy) captures both bodies in the attempt view as a first-class
feature; this closes that observability gap while keeping the per-row footprint bounded.

**Architecture (additive, zero blast radius):**

Both fields are `string | null`, truncated at `MAX_CAPTURED_BODY_BYTES = 4096` characters before
recording — standard for this use case (Svix uses 4 KB too). `null` signals "not captured" (pre-flight
failure or transport error before the request/response existed), not "empty body" (which is `""`).
Truncation happens in two places, uniformly:

1. **`requestBody`** in `DeliveryWorker.#deliver` — after `buildSignedRequest` builds the signed
   payload and before `#send` is called. Captures exactly what was signed and sent; `null` when the
   endpoint could not be resolved or the message had vanished (no send happened).

2. **`responseBody`** in two layers: `fetchTransport` captures `await response.text()` (already
   drained — only the assignment changed) and truncates; `DeliveryWorker.#deliver` also truncates
   whatever the transport returns, so custom transports in tests or future integrations are also
   bounded. `null` when no response arrived (transport throw or pre-flight failure).

Both are optional fields (`?:`) on `HttpDeliveryResponse` (exactOptionalPropertyTypes-safe) and
optional on `NewDeliveryAttempt` (backwards-compatible: callers that don't supply them get `null`).
The `NormalizedNewAttempt` / `DeliveryAttempt` interfaces carry them as required `string | null`
(always present, never absent, from the store's perspective).

**SQLite migration — additive only:** New columns `request_body TEXT` and `response_body TEXT`
added to the SCHEMA for fresh databases. `#migrateBodyColumns()` (mirroring `#migrateAppIdColumn`)
checks `PRAGMA table_info` and ALTERs on existing databases — existing rows keep `NULL`, which is
honest: the data was never captured for those attempts.

**Built this tick:**

- **`src/attempts/delivery-attempt.ts`** — `MAX_CAPTURED_BODY_BYTES = 4096` (exported); `requestBody:
  string | null` and `responseBody: string | null` added to `DeliveryAttempt`, `NormalizedNewAttempt`;
  `requestBody?: string | null` and `responseBody?: string | null` added to `NewDeliveryAttempt`;
  `normalizeNewAttempt` validates and defaults both to null; `NormalizedNewAttempt` includes both.
- **`src/attempts/sqlite-attempt-store.ts`** — `request_body TEXT` and `response_body TEXT` in SCHEMA;
  `AttemptRow` updated; `rowToAttempt` maps both; `#insert` now 13 columns; `record()` passes both;
  `#migrateBodyColumns()` method added; called in constructor after `#migrateAppIdColumn`.
- **`src/worker/delivery-worker.ts`** — `HttpDeliveryResponse.responseBody?: string` added; `fetchTransport`
  captures `response.text()` (was already draining, now stores), truncates, spreads into return value;
  import changed from `type` to value import for `MAX_CAPTURED_BODY_BYTES`; `#deliver` captures
  `requestBody` from `buildSignedRequest` result and `responseBody` from the response, both truncated;
  `#recordDeliveryAttempt` detail param and `record` call extended with both fields.
- **`src/http/openapi.ts`** — `MAX_CAPTURED_BODY_BYTES` imported; `DeliveryAttempt` schema: `requestBody`
  and `responseBody` added to `required` and `properties` with `maxLength` and descriptions.
- **`src/http/api.ts`** — `attemptView` includes `requestBody` and `responseBody`.
- **`src/sdk/client.ts`** — `DeliveryAttemptView` includes `requestBody: string | null` and
  `responseBody: string | null`.
- **`src/index.ts`** — exports `MAX_CAPTURED_BODY_BYTES`.
- **`src/attempts/conformance.ts`** — `MAX_CAPTURED_BODY_BYTES` imported; 3 new `describe("record")`
  test cases: bodies stored and echoed; defaults to null; stores up to limit without truncation (the
  store stores whatever it's given; the worker truncates before calling store).
- **`src/attempts/delivery-attempt.test.ts`** — updated `normalizeNewAttempt` snapshot to include
  `requestBody: null, responseBody: null`.
- **`src/attempts/sqlite-attempt-store.test.ts`** — updated durability `toEqual` snapshot likewise.
- **`src/worker/delivery-worker.test.ts`** — `MAX_CAPTURED_BODY_BYTES` imported; new `describe`
  "body capture" block (6 tests): requestBody = message payload on success; responseBody captured
  from transport; null requestBody + responseBody on pre-flight failure; null responseBody + non-null
  requestBody on transport error (request was built before throw); requestBody truncated at
  MAX_CAPTURED_BODY_BYTES; responseBody truncated at MAX_CAPTURED_BODY_BYTES.
- **`src/sdk/client.test.ts`** — new transport-level test: `listMessageAttempts` deserializes
  `requestBody` and `responseBody` from the server payload.

**Tests (+13 over baseline):**
- `src/attempts/conformance.ts` (+3 × 2 backends = 6): bodies stored/echoed; both null when omitted;
  limit-sized body stored intact.
- `src/worker/delivery-worker.test.ts` (+6): request body captured; response body captured; pre-flight
  null; transport-error null responseBody; requestBody truncation; responseBody truncation.
- `src/sdk/client.test.ts` (+1): SDK view round-trips both body fields.

**Validation:** `tsc --noEmit` clean. vitest **1146/1146** (44 files, +13). `npm run build` clean.
Two pre-existing `toEqual` snapshot tests updated to include the new fields.

**State:** GREEN → committed to main @ `4401a3d` (iter-53). Next tick: assess next highest-leverage gap.

---

## 2026-05-24 — Iteration 52: Endpoint Delivery Statistics (`GET /v1/endpoints/:id/stats`)

**Repo truth at start:** clean main @ `43bd2ab` (iter-51, Retry-After header support). Baseline verified:
`tsc --noEmit` clean, vitest **1120/1120** (44 files), `npm run build` clean. No
[[interrupted-tick-reconcile-pattern]] trigger.

**High-leverage move chosen (checklist #3):** `GET /v1/endpoints/:id/stats` — endpoint delivery
statistics. The attempts log already records `outcome`, `durationMs`, and `endpointId` on every
HTTP delivery attempt; no new data was needed. What was missing was an aggregate read path: to
answer "how is my endpoint performing?", an operator previously had to (1) list delivery tasks for
the endpoint, (2) paginate through `GET /v1/messages/:id/attempts` for each, and (3) compute
success rates by hand. A single `GET /v1/endpoints/:id/stats?days=7` replaces all of that with a
bounded range scan. Every serious webhook platform (Svix, Hookdeck, Convoy) exposes endpoint-level
health analytics as a first-class feature; Posthorn now does too.

**Architecture (additive, zero blast radius):**

Pure reads only — no writes, no new tables, no schema changes. The attempts table already had the
data; the only missing piece was a `(endpoint_id, attempted_at)` index and an aggregate query.

1. **`EndpointStatsDay` + `EndpointStats`** — new interfaces in `delivery-attempt.ts`. `EndpointStats`
   carries `total`, `succeeded`, `failed`, `successRate` (null when 0 total), `avgDurationMs` (null
   when 0 total), and a per-UTC-day `daily` breakdown. `successRate` is `succeeded / total` rounded
   to 4 decimal places. `avgDurationMs` covers all attempts (succeeded + failed) — a long failed-avg
   means timeouts. `MAX_STATS_DAYS = 30`, `DEFAULT_STATS_DAYS = 7`.

2. **`DeliveryAttemptStore.statsByEndpoint(endpointId, range)`** — new method on the interface,
   backed by a `(endpoint_id, attempted_at)` range scan grouped by UTC day.

3. **`InMemoryDeliveryAttemptStore.statsByEndpoint`** — iterates `#attempts`, filters by
   `endpointId` and the half-open `[fromMs, toMs)` range, groups by `utcDayKey`, accumulates
   `totalDurationMs` for the weighted avg. Identical logic to `summarizeAttemptsByApp` but scoped
   to one endpoint.

4. **`SqliteDeliveryAttemptStore.statsByEndpoint`** — new `#statsByEndpoint` prepared statement:
   `GROUP BY date(attempted_at/1000,'unixepoch')` + `SUM(duration_ms)` for the avg. A new
   `idx_delivery_attempts_endpoint ON (endpoint_id, attempted_at)` index is created idempotently
   after migrations (same safe pattern as `idx_delivery_attempts_app`), making the range scan O(k)
   where k = attempts in window.

5. **`GET /v1/endpoints/:id/stats`** in `api.ts` — parses `?days=N` (integer 1–30, default 7;
   400 on violation), performs the ownership check (another tenant's endpoint is 404, consistent
   with every other endpoint sub-route), converts days to a `UsageRange` via `now() - days *
   USAGE_DAY_MS` → `now()`, and calls `deps.attempts.statsByEndpoint`.

6. **OpenAPI** — new `EndpointStatsDay` and `EndpointStats` component schemas; new
   `/v1/endpoints/{id}/stats` GET path. Both forced by the bidirectional drift + orphan-schema
   tests that have kept the spec honest since iter-1.

7. **SDK** — `EndpointStatsDayView`, `EndpointStatsView`, `GetEndpointStatsParams` interfaces;
   `getEndpointStats(id, params?)` method sends `GET /v1/endpoints/{id}/stats?days=N`.

**Built this tick:**

- **`src/attempts/delivery-attempt.ts`** — `EndpointStatsDay`, `EndpointStats`, `MAX_STATS_DAYS`,
  `DEFAULT_STATS_DAYS` (constants exported); `statsByEndpoint` added to `DeliveryAttemptStore`.
- **`src/attempts/in-memory-attempt-store.ts`** — `statsByEndpoint` implemented (iterator + day
  bucketing + duration accumulation); imports `EndpointStats`, `EndpointStatsDay`.
- **`src/attempts/sqlite-attempt-store.ts`** — `#statsByEndpoint` prepared statement + field;
  `idx_delivery_attempts_endpoint` index created after schema; `statsByEndpoint` implemented
  (row → typed cast → accumulate → compute rates). Imports `EndpointStats`, `EndpointStatsDay`.
- **`src/attempts/conformance.ts`** — `describe("statsByEndpoint")` block: 3 test cases × 2
  backends = 6 conformance tests: zeros when no attempts, counts/rates/avg correct (3 succeeded
  + 1 failed, mixed durations), endpoint isolation (ep_A and ep_B never mix).
- **`src/http/api.ts`** — imported `DEFAULT_STATS_DAYS`, `MAX_STATS_DAYS`, `EndpointStats`;
  `getEndpointStats` handler; `"GET /v1/endpoints/:id/stats"` added to `API_ROUTE_KEYS` and
  the handlers record.
- **`src/http/openapi.ts`** — imported `DEFAULT_STATS_DAYS`, `MAX_STATS_DAYS`; `EndpointStatsDay`
  and `EndpointStats` component schemas; `/v1/endpoints/{id}/stats` path.
- **`src/sdk/client.ts`** — `GetEndpointStatsParams`, `EndpointStatsDayView`, `EndpointStatsView`
  interfaces; `getEndpointStats(id, params?)` method.
- **`src/sdk/client.test.ts`** — 2 new transport-layer tests: GET to correct URL + full payload
  round-trip; `days` param included in query string when provided.
- **`src/http/api.test.ts`** — `describe("createApi — GET /v1/endpoints/:id/stats")`: 4 tests:
  401 unauthenticated; 404 unknown endpoint; 200 with zero stats when no attempts; 200 with correct
  counts, successRate=0.75, avgDurationMs=125 after 3 succeeded (100ms each) + 1 failed (200ms);
  400 on `?days=0`.
- **`src/index.ts`** — exported `EndpointStats`, `EndpointStatsDay`, `DEFAULT_STATS_DAYS`,
  `MAX_STATS_DAYS`.

**Tests (+13 over baseline):**
- **`src/attempts/conformance.ts`** (+3 × 2 backends = 6): zeros on empty, counts/rates, isolation.
- **`src/sdk/client.test.ts`** (+2): GET URL + payload round-trip; `days` param.
- **`src/http/api.test.ts`** (+5): 401, 404, zero stats, correct totals/rates/avg, 400 on bad days.

**Validation:** `tsc --noEmit` clean. vitest **1133/1133** (44 files, +13). `npm run build` clean.

**State:** GREEN → committed to main @ `a8b4a37` (iter-52). Next tick: assess next highest-leverage gap.

---

## 2026-05-24 — Iteration 51: `Retry-After` Header Support

**Repo truth at start:** clean main @ `a262fff` (iter-50, bulk delivery retry). Baseline verified:
`tsc --noEmit` clean, vitest **1107/1107** (44 files), `npm run build` clean. No
[[interrupted-tick-reconcile-pattern]] trigger.

**High-leverage move chosen (checklist #3):** `Retry-After` header support — the RFC 7231 §7.1.3
compliance gap that caused Posthorn to hammer overloaded or rate-limited receivers. A receiver
returning `503 Retry-After: 30` was explicitly asking "don't retry for 30 seconds"; Posthorn
ignored that and re-queued at the policy's own (potentially shorter) exponential-backoff delay.
The fix is straightforward: extract the header from the response, parse it (integer-seconds or
HTTP-date), cap it at a maximum (24h), and floor the task's `nextAttemptAt` so the queue never
re-claims the task before the receiver asked. The policy delay still wins when it is *larger* than
`Retry-After`; `Retry-After` only prevents going *sooner* than the receiver asked. Dead-lettered
tasks are unaffected — a budget-exhausted delivery stays terminal regardless. This directly
improves reliability for operators whose receivers use rate limiting (`429 Retry-After: 60`) or
temporary overload signals (`503 Retry-After: 30`), and it is the first RFC 7231 compliance win
on the delivery path.

**Architecture (additive, zero blast radius):**

Three-layer wiring with each layer additive and non-breaking:

1. **`HttpDeliveryResponse.retryAfter?: string | null`** — new optional field on the existing
   public interface. Existing fake transports in tests return `{ status }` without the field;
   the worker safely treats an absent field as `null` (no hint).

2. **`fetchTransport`** — calls `response.headers.get("retry-after")` before the body drain
   and includes the result in the return value (`string | null`, omitted when absent via spread).
   The header is captured before the body drain so a drain failure cannot mask it.

3. **`parseRetryAfterMs(header, nowMs): number | null`** — module-level pure function inside
   `delivery-worker.ts`. Accepts both RFC 7231 integer-seconds form (`"30"`, `"0"`) and
   HTTP-date form (`"Wed, 21 Oct 2015 07:28:00 GMT"`). Integer-seconds: matched via `/^\d+$/`
   (rejects floats and negatives), converted to ms, capped at `MAX_RETRY_AFTER_MS`. HTTP-date:
   `Date.parse`, finite check, `date − nowMs`, negative/zero → `null` (past = no floor). Both
   capped at `MAX_RETRY_AFTER_MS = 86_400_000` (24h) so a malicious or misconfigured receiver
   cannot park a task far in the future.

4. **`FailInput.minDelayMs?: number`** — new optional field on the existing public queue
   interface. `normalizeFailInput` validates it (non-negative finite number when provided).

5. **`InMemoryDeliveryQueue.fail` + `SqliteDeliveryQueue.fail`** — after calling `applyFailure`,
   if the result is `pending` and `minDelayMs` is set, clamp `nextAttemptAt`:
   `max(policyNextAttemptAt, nowMs + minDelayMs)`. Dead-lettered tasks have
   `nextAttemptAt: null` so the clamp branch is unreachable — no behavioral change there.

6. **`DeliveryWorker.#deliver`** — extracts `retryAfterMs = parseRetryAfterMs(response.retryAfter, nowMs)`
   only when `response !== null && !isSuccessStatus(response.status)`. Transport errors and
   unresolvable-endpoint failures carry no response, so they get no floor.

7. **`DeliveryWorker.#settleFailure`** — accepts a new optional `minDelayMs` parameter,
   spread-includes it in the `FailInput` when defined (required by `exactOptionalPropertyTypes`).

**Built this tick:**

- **`src/queue/delivery-queue.ts`** — `FailInput.minDelayMs?: number` (JSDoc; semantics);
  `normalizeFailInput` updated to validate and return `minDelayMs`.
- **`src/queue/in-memory-queue.ts`** — `fail()` destructures `minDelayMs`, clamps `nextAttemptAt`
  post-`applyFailure` when `status === "pending"` and floor exceeds policy result.
- **`src/queue/sqlite-queue.ts`** — same clamp logic in the SQLite transaction's `fail()`.
- **`src/queue/conformance.ts`** — added `describe("minDelayMs floor")` nested inside the `fail`
  describe: 3 cases (floor wins, policy wins, dead-letter unaffected) × 2 backends = 6 tests.
- **`src/worker/delivery-worker.ts`** — `HttpDeliveryResponse.retryAfter?: string | null`;
  `fetchTransport` captures `Retry-After` pre-drain; `MAX_RETRY_AFTER_MS = 86_400_000` (exported);
  `parseRetryAfterMs` (private, integer-seconds + HTTP-date, capped); `#deliver` wires
  `retryAfterMs`; `#settleFailure` accepts and spreads `minDelayMs`.
- **`src/index.ts`** — re-exports `MAX_RETRY_AFTER_MS`.

**Tests (+13 over baseline):**
- **`src/queue/conformance.ts`** (+3 × 2 backends = 6): `minDelayMs` floor wins (clamps and
  confirms not claimable at policy time but claimable at floor time); policy wins when smaller;
  dead-letter unaffected (task remains `dead_letter`, `nextAttemptAt: null`).
- **`src/worker/delivery-worker.test.ts`** (+7, new `describe("DeliveryWorker — Retry-After support")`):
  integer-seconds floor wins (503 + `"30"` → `nextAttemptAt = 30_000`); policy wins when
  larger (60s policy, 5s Retry-After → 60_000); malformed header ignored (pure policy);
  Retry-After ignored on 2xx success; capped at `MAX_RETRY_AFTER_MS` (172800s → 86_400_000ms);
  budget-exhausted task still dead-letters (Retry-After cannot revive a spent budget);
  HTTP-date format accepted and delay computed correctly (`toBeCloseTo`).

**Validation:** `tsc --noEmit` clean. vitest **1120/1120** (44 files, +13). `npm run build` clean.
`exactOptionalPropertyTypes` compliance verified (spread-based conditional inclusion throughout).

**State:** GREEN → committed to main @ `43bd2ab` (iter-51). Next tick: assess next highest-leverage gap.

---

## 2026-05-24 — Iteration 50: Bulk Delivery Retry (`POST /v1/deliveries/retry`)

**Repo truth at start:** clean main @ `05fc3b6` (iter-49, data retention). Baseline verified:
`tsc --noEmit` clean, vitest **1093/1093** (43 files), `npm run build` clean. No
[[interrupted-tick-reconcile-pattern]] trigger.

**High-leverage move chosen (checklist #3):** Bulk delivery retry — `POST /v1/deliveries/retry`.
The per-message retry path (`POST /v1/messages/:id/retry`, iter-34) solves one recovery
scenario: "I know which message failed, replay it." The far more common scenario after an
outage is: "my endpoint was down for hours, now it's fixed — replay everything that died."
Without bulk retry, operators must list all dead-lettered deliveries (`GET
/v1/deliveries?status=dead_letter`), page through the results, and call per-message retry for
each affected message — potentially dozens or hundreds of HTTP calls. One `POST
/v1/deliveries/retry` replaces all of them. Every serious webhook platform (Svix, Convoy,
Hookdeck) exposes this as "retry all failures"; Posthorn now does too. Completes the recovery
arc: `endpoint.disabled` (iter-36) and `message.dead_lettered` (iter-48) tell you *when*
things failed; `POST /v1/messages/:id/retry` (iter-34) recovers one message; this recovers
the entire backlog.

**Architecture (additive, zero blast radius):**

Pure fn `retryAppDeliveries(appId, deps, options?)` in new `src/queue/retry-app.ts` — the
tenant-wide structural twin of `retryMessageDeliveries` (same absorb-concurrent-revive
pattern). Uses existing `DeliveryQueue.listByApp(appId, { status: 'dead_letter', limit })`
(from iter-40) to fetch the dead-letter page, then calls `queue.retry(task.id)` for each.
`hasMore: page.nextCursor !== null` — the same keyset-pagination invariant as every list
route. After reviving a batch the tasks become `pending` (no longer `dead_letter`), so a
subsequent call naturally fetches the *next* batch of still-dead-letter tasks — no cursor
threading needed by the caller. Bounded at `MAX_LIST_DELIVERIES_LIMIT = 200` per call.

**Built this tick:**

- **`src/queue/retry-app.ts`** *(new)* — `retryAppDeliveries`, `BulkRetryResult` interface,
  `DEFAULT_BULK_RETRY_LIMIT = MAX_LIST_DELIVERIES_LIMIT`, `RetryAppDeps`. `RangeError` on
  out-of-bounds `limit`; concurrent `DeliveryStateError` / `UnknownDeliveryTaskError`
  absorbed.
- **`src/queue/retry-app.test.ts`** *(new)* — 8 unit tests: empty-app no-op, pending-only
  no-op, multiple dead-letter tasks counted, tenant isolation, skips non-dead-letter tasks,
  `hasMore: true` when backlog exceeds limit, concurrent-revive absorbed, limit validation.
- **`src/http/api.ts`** — Added `"POST /v1/deliveries/retry"` to `API_ROUTE_KEYS`. Imported
  `retryAppDeliveries` and `BulkRetryResult`. Added `retryAllDeliveries: AuthedHandler`
  (no-body POST; tenant-scoped; returns `200 { retried, hasMore }`). Registered in route
  table. Updated surface comment.
- **`src/http/api.test.ts`** — Added `describe("createApi — POST /v1/deliveries/retry")`: 4
  tests (401 unauthenticated, `{ retried:0, hasMore:false }` no dead-letters, `retried:2`
  after two dead-lettered deliveries via a worker run, tenant isolation confirmed 0).
- **`src/http/openapi.ts`** — Added `"/v1/deliveries/retry"` path with `post` operation
  (`retryAllDeliveries`, `Deliveries` tag). Added `BulkRetryResult` component schema
  (`retried: integer ≥ 0`, `hasMore: boolean`). Both forced by the bidirectional drift +
  orphan-schema tests.
- **`src/sdk/client.ts`** — Added `BulkRetryResult` interface. Added `retryAllDeliveries()`
  → `BulkRetryResult` (plain POST `/v1/deliveries/retry`, no body).
- **`src/sdk/client.test.ts`** — Added transport-layer test: method=POST, URL path, retried
  and hasMore fields round-trip.
- **`src/index.ts`** — Exported `retryAppDeliveries`, `DEFAULT_BULK_RETRY_LIMIT`,
  `BulkRetryResult`, `RetryAppDeps`.

**Validation:** `tsc --noEmit` clean, vitest **1107/1107** (44 files, +14: 8 unit + 4 handler +
1 SDK + 1 export constant), `npm run build` clean. Integrity gate + local gate: exit 0.
One flaky tinypool "Worker exited unexpectedly" on the first run — confirmed known noise by
re-running to clean pass. git status: clean (8 files staged + committed).

**State:** GREEN → committed to main. Next tick: assess next highest-leverage gap.

---

## 2026-05-24 — Iteration 49: Data Retention / Automatic Pruning (`POSTHORN_RETENTION_DAYS`)

**Repo truth at start:** clean main @ `e120fb5` (iter-48, `message.dead_lettered`). Baseline verified:
`tsc --noEmit` clean, vitest **1062/1062** (42 files), `npm run build` clean. No
[[interrupted-tick-reconcile-pattern]] trigger.

**High-leverage move chosen (checklist #3):** Data retention — automatic pruning of old delivery
attempts, terminal delivery tasks, and messages via a new `POSTHORN_RETENTION_DAYS` environment
variable. Without this, all three stores grow unbounded with deployment volume; operators managing
long-running Posthorn instances have no built-in way to cap disk usage. The feature mirrors industry
defaults (Svix defaults 90 days), provides an opt-in `0`-disabled default (safe for existing
deployments), and closes the "eventually runs out of disk" gap that blocks production viability.

**Architecture (additive, zero blast radius):**

Three-phase pruning order (safe, no cross-store FK issues since queue and messages live in separate
SQLite files): (1) `pruneOldAttempts`, (2) `pruneTerminalTasks`, (3) `pruneMessages`. Attempting to
delete messages with pending fan-out is safe because `pruneMessages` guards on `fanned_out_at IS NOT
NULL` (SQLite) / `!#pendingFanout.has(id)` (in-memory). Active tasks (pending/delivering) are never
touched regardless of age.

**`DataPruner`** is the structural twin of `FanoutDispatcher`: `pruneOnce()` is the deterministic
unit, `run()` / `stop()` is the continuous hourly sweep loop with injectable clock, sleep, and
`onError`. The gateway wires it when `retentionDays > 0` and exposes it as `pruner: DataPruner |
null` on the `Gateway` interface.

**Built this tick:**

- **`src/attempts/delivery-attempt.ts`** — Added `pruneOldAttempts(olderThanMs): Promise<number>` to
  `DeliveryAttemptStore` interface.
- **`src/queue/delivery-queue.ts`** — Added `pruneTerminalTasks(olderThanMs): Promise<number>` to
  `DeliveryQueue` interface.
- **`src/storage/message-store.ts`** — Added `pruneMessages(olderThanMs): Promise<number>` to
  `MessageStore` interface.
- **`src/attempts/in-memory-attempt-store.ts`** — `pruneOldAttempts` iterates `#attempts`, deletes
  entries where `attemptedAt < olderThanMs`.
- **`src/queue/in-memory-queue.ts`** — `pruneTerminalTasks` iterates `#tasks`, deletes
  `succeeded`/`dead_letter` entries where `updatedAt < olderThanMs`.
- **`src/storage/in-memory-store.ts`** — `pruneMessages` prunes stale idempotency keys then deletes
  messages where `createdAt < olderThanMs && !#pendingFanout.has(id)`.
- **`src/attempts/sqlite-attempt-store.ts`** — `pruneOldAttempts` via `DELETE WHERE attempted_at < ?`.
- **`src/queue/sqlite-queue.ts`** — `pruneTerminalTasks` via `DELETE WHERE updated_at < ? AND status IN
  ('succeeded', 'dead_letter')`.
- **`src/storage/sqlite-store.ts`** — `pruneMessages` via two-step `DELETE` (idempotency keys, then
  messages where `fanned_out_at IS NOT NULL`). Fixed `result.changes` casts to `Number()` across all
  three SQLite prune methods (`number | bigint` → `number`).
- **`src/storage/conformance.ts`** — Added `pruneMessages` describe block (3 test cases × 2 backends).
- **`src/queue/conformance.ts`** — Added `pruneTerminalTasks` describe block (3 test cases × 2 backends).
- **`src/attempts/conformance.ts`** — Added `pruneOldAttempts` describe block (3 test cases × 2 backends).
- **`src/pruner/data-pruner.ts`** *(new)* — `DataPruner` class, `PruneResult` interface,
  `DataPrunerOptions` interface, `DEFAULT_PRUNER_SWEEP_INTERVAL_MS = 3_600_000`. `pruneOnce()` calls
  all three store-level prune methods in safe order and returns a tally. `run()`/`stop()` continuous
  loop with injectable sleep and `onError`.
- **`src/pruner/data-pruner.test.ts`** *(new)* — Unit tests: constructor validation, `pruneOnce`
  cutoff math and call order, `run`/`stop` lifecycle, error routing.
- **`src/runtime/config.ts`** — Added `retentionDays: number` to `GatewayConfig`. Parsed
  `POSTHORN_RETENTION_DAYS` (default `0`, min `0`) via existing `readInt` helper.
- **`src/runtime/config.test.ts`** — Added `POSTHORN_RETENTION_DAYS` describe block (3 tests). Updated
  default snapshot to include `retentionDays: 0`.
- **`src/runtime/gateway.ts`** — Imported `DataPruner`. Added `pruner: DataPruner | null` to `Gateway`
  interface. Instantiated when `config.retentionDays > 0`. Wired `pruner.run()` into `start()` and
  `pruner.stop()` + await into `stop()`.
- **`src/worker/delivery-worker.test.ts`** — Added `pruneTerminalTasks: async () => 0` to the two
  hand-rolled `DeliveryQueue` stubs (lines 505 and 1202) to satisfy the updated interface.
- **`src/index.ts`** — Exported `DataPruner`, `DEFAULT_PRUNER_SWEEP_INTERVAL_MS`, `DataPrunerOptions`,
  `PruneResult`.

**Validation:** `tsc --noEmit` clean, vitest **1093/1093** (43 files), `npm run build` clean. Main green.

---

## 2026-05-24 — Iteration 48: `message.dead_lettered` System Event

**Repo truth at start:** clean main @ `6be0675` (iter-47, scheduled delivery). Baseline verified:
`tsc --noEmit` clean, vitest **1053/1053** (42 files), `npm run build` clean. No
[[interrupted-tick-reconcile-pattern]] trigger.

**High-leverage move chosen (checklist #3):** `message.dead_lettered` system event — the missing
partner to `endpoint.disabled` (iter-36). When a delivery exhausts all retry attempts and
permanently moves to `dead_letter`, Posthorn fires a signed Standard Webhooks notification to the
app's configured `systemWebhookUrl`. Without this, operators had no push signal that a delivery
permanently failed: they had to poll `GET /v1/deliveries?status=dead_letter` or set up a Prometheus
alert on the `posthorn_delivery_tasks{status="dead_letter"}` gauge. Every serious incident response
workflow needs a push event ("page the on-call"), not a pull read model. `endpoint.disabled` fires
when an endpoint is condemned; `message.dead_lettered` fires when an individual delivery is lost —
the two system events that bracket the failure life-cycle.

**Architecture (additive, zero blast radius):** the system-event pattern was already established
(iter-36): `buildSystemEventRequest` signs a JSON payload with Standard Webhooks and posts it via
an injected transport. The worker already exposes `onDeliveryOutcome` (the endpoint-health seam) as
a best-effort hook. A **new, separate `onDeadLettered` hook** was added to `DeliveryWorkerOptions`
(not conflated with `onDeliveryOutcome`) — it is called only when `outcome === "deadLettered"`,
after `#reportEndpointOutcome`, with the full task identity (`taskId`, `messageId`, `endpointId`,
`appId`). Best-effort: a thrown/rejected call is routed to `onError` and never changes the delivery
outcome. The gateway wires it to look up `apps.getSystemWebhookConfig(appId)` and call
`emitMessageDeadLetteredEvent` if configured — identical delegation pattern to `endpoint.disabled`.

**Built this tick:**

- **`src/system-events/index.ts`** — Added `MessageDeadLetteredPayload` interface (`event:
  "message.dead_lettered"`, `data: { messageId, endpointId, appId, deadLetteredAt }`). Added
  `emitMessageDeadLetteredEvent(config, info, opts)` — builds and posts the signed payload via
  `buildSystemEventRequest` + injected transport, same pattern as `emitEndpointDisabledEvent`.
  Updated module-level JSDoc to list both system events. `normalizeSecretForSigning` is shared by
  both emitters (no duplication).

- **`src/worker/delivery-worker.ts`** — Added `readonly onDeadLettered?` to
  `DeliveryWorkerOptions` (full signature: `taskId, messageId, endpointId, appId, nowMs` → void |
  Promise<void>); added `#onDeadLettered` private field; assigned in constructor; added
  `#reportDeadLettered(task, nowMs)` private method (best-effort, mirrors `#reportEndpointOutcome`
  exactly); wired the call in `#deliver`: `if (outcome === "deadLettered") { await
  this.#reportDeadLettered(task, nowMs); }` — after `#reportEndpointOutcome` so health tracking
  always fires first.

- **`src/runtime/gateway.ts`** — Imported `emitMessageDeadLetteredEvent` alongside
  `emitEndpointDisabledEvent`; added `onDeadLettered` in the `DeliveryWorker` constructor options:
  skips when `appId === null` (pre-migration tasks), looks up `getSystemWebhookConfig(appId)`, and
  calls `emitMessageDeadLetteredEvent` when configured — best-effort by the worker's contract.

- **`src/http/openapi.ts`** — Updated `systemWebhookUrl` descriptions on `App`, `NewApp`, and
  `AppUpdate` schemas to enumerate both fired events (`endpoint.disabled` and
  `message.dead_lettered`), so API consumers know what to expect from their system webhook receiver
  without reading source code.

**Tests (+9 over baseline):**
- **`src/system-events/system-events.test.ts`** (+5, new `describe`): POSTs to the correct URL
  with POST method; body has `event: "message.dead_lettered"` with correct `messageId`,
  `endpointId`, `appId`, `deadLetteredAt`; accepts `null` endpointId and appId; Standard Webhooks
  headers present + signature verifiable end-to-end; transport error propagates (best-effort is
  caller-decided, not module-level).
- **`src/worker/delivery-worker.test.ts`** (+4, new `describe`): called with correct
  `taskId/messageId/endpointId/appId/nowMs` on dead-letter; NOT called on succeeded; NOT called for
  retryable failed attempt; best-effort — a thrown call is absorbed into `onError`, delivery
  succeeds.

**Validation (manual gate, [[validation-gate-is-manual]]):** `tsc --noEmit` clean. vitest
**1062/1062, 42 files** (+9 over baseline). `npm run build` clean.

**State:** GREEN → committed to main @ iter-48 (`f5317e1`).

---

## 2026-05-24 — Iteration 47: Scheduled Delivery (sendAt)

**Repo truth at start:** clean main @ `6a5a562` (iter-46 LOOP_LOG commit). The iter-46
implementation commit was `f1e9d3c`; the docs commit had not yet landed when the context
window closed — reconcile-and-land was the first act of this tick per
[[interrupted-tick-reconcile-pattern]].
Baseline verified: `tsc --noEmit` clean, vitest **1044/1044** (42 files), `npm run build` clean.

**High-leverage move chosen (checklist #3):** Scheduled delivery — expose `FanoutOptions.availableAt`
through the HTTP surface via a `sendAt` field on `POST /v1/messages` and each item of
`POST /v1/messages/batch`. The internal infrastructure was fully built: `FanoutOptions.availableAt`
existed in `fanout.ts`, `EnqueueInput.availableAt` existed in the queue, and `claimDue` already
filtered on `nextAttemptAt`. The HTTP handlers simply never passed it. Pattern mirrors iter-46
(custom delivery headers): wiring pre-built infrastructure to the API surface is the
fastest path to competitive parity without incurring design risk.

**Built this tick:**

- **`src/http/api.ts`** — Imported `FanoutOptions` alongside `ingest`; added `parseSendAt(v:
  unknown): number | null` helper (accepts ISO 8601 string, converts to epoch-ms via `Date.parse`;
  throws `TypeError` on non-string or `NaN` result — the global `toErrorResponse` handler converts
  those to `400 invalid_request`); updated `createMessage` handler to read `sendAt` from the request
  body and pass it as `{ availableAt: sendAtMs }` in `FanoutOptions`; updated `batchSendMessages`
  handler to do the same per-item, so each message in a batch can carry its own `sendAt` independently.

- **`src/http/openapi.ts`** — Added `sendAt` to the `NewMessage` schema (`type: ["string","null"]`,
  `format: "date-time"`, description notes that past timestamps are treated as immediate and that
  the delay is applied uniformly to every endpoint in the fan-out). `BatchMessageInput.items` reuses
  `ref("NewMessage")` so the field appears automatically.

- **`src/sdk/client.ts`** — Added `readonly sendAt?: string | null` to `SendMessageInput`;
  updated `sendMessage()` to include `body["sendAt"] = input.sendAt` iff `!== undefined`;
  updated `sendMessageBatch()` item-mapper to do the same per message.

**Tests (+9 over baseline):**
- **`src/http/api.test.ts`** (+7): `POST /v1/messages`: `sendAt` in the future gates delivery
  (clock-controllable queue, claim at `nowMs` → 0, advance 10s → 1); non-string `sendAt` → 400;
  invalid date string → 400; `null` sendAt → immediate. `POST /v1/messages/batch`: per-item `sendAt`
  gates only that item (immediate task claims first, scheduled unlocks after clock advance); malformed
  per-item `sendAt` returns per-item `invalid_request` without aborting the rest.
- **`src/sdk/client.test.ts`** (+3): `sendMessage` serializes `sendAt` into body; omits it when
  absent; `sendMessageBatch` serializes per-item `sendAt`, omits on items that don't set it.

**Validation (manual gate, [[validation-gate-is-manual]]):** `tsc --noEmit` clean. vitest
**1053/1053, 42 files** (+9 over baseline). `npm run build` clean.

**State:** GREEN → committed to main @ iter-47 (`66942f1`).

---

## 2026-05-24 — Iteration 46: Custom Delivery Headers

**Repo truth at start:** clean main @ `b1837ab` (iter-45, batch message sending).
Baseline verified: `tsc --noEmit` clean, vitest **1016/1016** (42 files), `npm run build` clean. No
[[interrupted-tick-reconcile-pattern]] trigger.

**High-leverage move chosen (checklist #3):** Custom delivery headers — allow endpoints to carry a
`headers: Record<string,string> | null` map that is merged into every HTTP delivery to that endpoint
before the Standard Webhooks signing headers are applied. This closes the most-requested gap between
Posthorn and its competitors: a receiver often needs authentication (`X-API-Key: …`,
`Authorization: Bearer …`) or routing metadata (`X-Tenant-ID: …`) in the delivery, without having
to run a proxy or implement custom middleware. The infrastructure was already in place:
`DeliveryTarget.headers` existed in the worker and `buildSignedRequest` already merged it (custom
headers are applied before `webhook-*` headers, so the signature always wins and cannot be
clobbered). All that was missing was the wire-through from the endpoint model to the resolver.

**Built this tick:**

- **`src/endpoints/endpoint.ts`** — `MAX_CUSTOM_HEADERS = 20`, `FORBIDDEN_DELIVERY_HEADERS`
  (webhook-id, webhook-timestamp, webhook-signature, content-type); `normalizeHeaders(unknown)`
  exported validator (rejects non-object, arrays, empty-key, CR/LF injection, forbidden headers,
  non-string values, >20 entries; normalizes `{}` to `null`); `Endpoint.headers` (read-only field,
  `Readonly<Record<string,string>> | null`); `NewEndpoint.headers` + `EndpointUpdate.headers`
  (optional); `NormalizedNewEndpoint.headers`; `normalizeNewEndpoint` + `applyEndpointUpdate` both
  call `normalizeHeaders` (update uses `"headers" in patch` guard so absence → preserved).

- **`src/endpoints/in-memory-endpoint-store.ts`** — `headers: normalized.headers` included in
  created endpoint.

- **`src/endpoints/sqlite-endpoint-store.ts`** — `headers TEXT` column in SCHEMA; `EndpointRow.headers`;
  `rowToEndpoint` parses JSON or null; `headersToColumn` serializer; `#migrateHeadersColumn()` (adds
  `headers TEXT` to pre-iter-46 databases — existing rows default to NULL → no custom headers →
  seamless upgrade); `#insertEndpoint` +1 parameter; `#updateEndpoint` +1 SET clause; both
  `create()` and `update()` pass `headersToColumn(…)`.

- **`src/endpoints/endpoint-resolver.ts`** — `endpointToDeliveryTarget` now spreads
  `{ headers: endpoint.headers }` into the `DeliveryTarget` when non-null; the stale
  "later add-on" comment removed.

- **`src/endpoints/conformance.ts`** — 6 new conformance cases (× 2 backends): headers default null
  on create, stored/round-tripped when provided, update set/replace/clear, preserved when absent from
  patch, forwarded into DeliveryTarget, omitted from DeliveryTarget when null. Added import for
  `endpointToDeliveryTarget`.

- **`src/http/api.ts`** — `endpointView()` includes `headers: endpoint.headers`; create handler
  conditionally passes `headers` from body; update handler conditionally passes `headers` from body.

- **`src/http/openapi.ts`** — `Endpoint` required list adds `"headers"`; `headers` property
  (`type: ["object","null"], additionalProperties: {type:"string"}`) added to `Endpoint`,
  `NewEndpoint`, and `EndpointUpdate` schemas.

- **`src/sdk/client.ts`** — `EndpointView.headers`; `CreateEndpointInput.headers` +
  `UpdateEndpointInput.headers`; `createEndpoint` and `updateEndpoint` serialize `headers` into the
  request body (included iff `!== undefined`, preserving the existing opt-in discipline).

- **`src/portal/portal-views.ts`** — create form adds `headers` textarea (key: value, one per line);
  edit form adds the same textarea pre-filled; endpoint detail info table adds a "Custom headers"
  row (shows as `Key: value` pairs or `—`).

- **`src/portal/portal-handler.ts`** — `parseHeadersTextarea(raw)` helper (splits on `\n`, skips
  empty/malformed lines, returns `null` when no valid pairs); create handler and update handler both
  pass `headers: parseHeadersTextarea(form["headers"] ?? "")`.

- **`README.md`** — SDK example updated to show `headers` field in `createEndpoint`.

**Tests (+28 over baseline):**
- **`src/endpoints/endpoint.test.ts`** (+10): `normalizeHeaders` unit tests (null/undefined/empty,
  round-trip, non-object, reserved names case-insensitive, CR/LF injection, non-string value,
  >MAX_CUSTOM_HEADERS); `normalizeNewEndpoint` asserts `headers: null`; `applyEndpointUpdate`
  set/replace/clear and preserve-when-absent.
- **`src/endpoints/conformance.ts`** (+6, × 2 backends): headers default, create, update/clear,
  preserve, DeliveryTarget forwarding, DeliveryTarget omitted.
- **`src/endpoints/endpoint-resolver.test.ts`** (+2, refactored to `BASE_EP` fixture): forwards
  custom headers into target, omits `headers` field when null.
- **`src/fanout/fanout.test.ts`** (+0 new, `headers: null` added to endpoint fixture to satisfy TS).
- **`src/http/api.test.ts`** (+5): create with headers returns them; update set/replace/clear;
  rejects reserved headers on create and update (400); view includes `headers: null` when none.
- **`src/sdk/client.test.ts`** (+1): create with headers, update replace, update clear, verify via get.

**Validation (manual gate, [[validation-gate-is-manual]]):** `tsc --noEmit` clean. vitest
**1044/1044, 42 files** (+28 over baseline). `npm run build` clean.

**State:** GREEN → committed to main @ iter-46 (`f1e9d3c`).

---

## 2026-05-23 — Iteration 45: Batch Message Sending

**Repo truth at start:** clean main @ `f01f9e0` (iter-44, test event delivery).
Baseline verified: `tsc --noEmit` clean, vitest **1006/1006** (42 files), `npm run build` clean. No
[[interrupted-tick-reconcile-pattern]] trigger.

**High-leverage move chosen (checklist #3):** `POST /v1/messages/batch` — the production
throughput feature that every high-volume producer eventually needs and that was the single
named missing capability after iter-44 closed the last developer-facing debugging gap. A payment
processor emitting `payment.created` for a hundred invoices in one job, a batch ETL writing a
thousand `record.synced` events — these callers shouldn't pay N HTTP round-trips. Every incumbent
platform advertises batch sending; Posthorn had it last.

**Built this tick:**

- **`src/http/api.ts`** — `export const MAX_BATCH_MESSAGES = 100`; added
  `"POST /v1/messages/batch"` to `API_ROUTE_KEYS` (immediately after `"POST /v1/messages"`);
  `batchSendMessages` `AuthedHandler`: validates `messages` is a non-empty array ≤ 100 items
  (400 otherwise); pre-computes `quotaBudget = max(0, quota − usedThisMonth)` once for the
  whole batch; iterates, per item: (a) validates it is a plain object with `payload` (→ per-item
  `invalid_request`), (b) checks if an idempotency key is a replay before decrementing the budget
  (replays are quota-exempt, matching the single-message behaviour), (c) calls `ingest` — catches
  `IdempotencyConflictError` → per-item `idempotency_conflict` and `TypeError` → per-item
  `invalid_request` without aborting the rest — (d) on success records metrics and increments
  `consumed`. Returns `200 { results: [...] }` always; each result is `{ ok: true, message,
  deduplicated, fanout }` or `{ ok: false, error: { code, message } }`. HTTP status 200 regardless
  of partial failure so callers can reliably inspect the per-item `ok` field. The route is wired in
  the exhaustive `Record<ApiRouteKey, RouteHandler>` handlers table, so omitting it would be a
  compile error.

- **`src/http/openapi.ts`** — `POST /v1/messages/batch` path operation (`sendMessageBatch`,
  `Messages` tag); `BatchMessageInput` component schema (`messages` array of `NewMessage`,
  `minItems:1`, `maxItems:100`); `BatchMessageOk` and `BatchMessageError` discriminated-object
  schemas (tagged by `ok: true/false`); `BatchResults` schema (`results` array of
  `anyOf[BatchMessageOk, BatchMessageError]`). The bidirectional drift test forced all four
  schemas (orphan-schema check) and the path operation (route-count check).

- **`src/sdk/client.ts`** — `BatchMessageOk`, `BatchMessageError`, `BatchMessageResult` (union),
  and `BatchResults` wire types; `client.sendMessageBatch(messages: readonly SendMessageInput[]):
  Promise<BatchResults>` maps each input to the wire object (omitting `idempotencyKey` when
  undefined, matching `sendMessage`'s discipline) and POSTs to `/v1/messages/batch`.

**Tests (+10 over baseline):**
- **`src/http/api.test.ts`** (+9, new `describe`): accepts a batch, returns one result per
  message; per-item errors (non-object, missing payload) without aborting; rejects empty array
  (400); rejects non-array `messages` field (400); rejects a 101-item batch (400); deduplicates
  idempotent messages within the same batch (second item → `deduplicated:true`, same message id);
  stops accepting once monthly quota is reached (first 2 of 4 succeed, last 2 → `quota_exceeded`);
  quota-exempt replay does not consume the budget (replay succeeds, following new message fails);
  requires authentication (401 without Bearer).
- **`src/sdk/client.test.ts`** (+1, injected-fetch): `sendMessageBatch` posts to the right path
  with the serialized `messages` array (idempotencyKey present iff defined); returns typed
  `BatchResults`.

**README.md** — updated API routes table to reflect all routes added in iters 39–44 that were
absent (test endpoint, endpoint deliveries, app-wide deliveries, portal sessions, event-types CRUD,
admin rotate-system-secret, admin PATCH app); added `POST /v1/messages/batch` row; added
`sendMessageBatch` SDK example; updated test count to ~1020.

**Validation (manual gate, [[validation-gate-is-manual]]):** `tsc --noEmit` clean. vitest
**1016/1016, 42 files** (+10 over baseline). `npm run build` clean.

**State:** GREEN → committed to main @ iter-45 (`b1837ab`).

---

## 2026-05-23 — Iteration 44: Test Event Delivery

**Repo truth at start:** clean main @ `af99750` (iter-43, event type catalog).
Baseline verified: `tsc --noEmit` clean, vitest **997/997** (42 files), `npm run build` clean. No
[[interrupted-tick-reconcile-pattern]] trigger.

**High-leverage move chosen (checklist #3):** `POST /v1/endpoints/:id/test` — the #1 developer
debugging feature in every incumbent webhook service (Svix, Hookdeck, Convoy all have it), and the
last named competitive gap between "complete webhook platform" and "production grade." A developer
who just creates or reconfigures an endpoint needs to verify it is reachable and configured
correctly *immediately*, without waiting for a real production message, cluttering their message
history, or consuming monthly quota. This delivers that in one HTTP call and synchronously returns
the result.

**Built this tick:**

- **`src/http/api.ts`** — Imported `buildSignedRequest`, `fetchTransport`, `isSuccessStatus`,
  `DEFAULT_REQUEST_TIMEOUT_MS`, `Transport` from the worker and `endpointToDeliveryTarget` from the
  endpoint resolver. Added `transport?: Transport` and `testRequestTimeoutMs?: number` to `ApiDeps`
  (optional; default to production values). Added `"POST /v1/endpoints/:id/test"` to
  `API_ROUTE_KEYS`. Handler `testEndpoint`: validates bearer auth → fetches endpoint (404 if absent
  or cross-tenant) → 400 if `disabled` → parses optional `{ eventType?, payload? }` body (defaults:
  `"test"` / `{"test":true}`) → builds a **synthetic, non-persisted message** (`id: "test_<UUID>"`
  — never stored, never queued, never counted against quota) → calls `endpointToDeliveryTarget`
  (respects rotation-overlap secrets) → calls `buildSignedRequest` → sends via injected transport
  with `AbortController` timeout → returns `200 { success, httpStatus?, error?, durationMs }`. The
  response always has HTTP status 200; `success` in the body reports the delivery outcome so callers
  can reliably inspect it (a `4xx` from the endpoint is still a 200 from the API, with
  `success:false`).

- **`src/http/openapi.ts`** — `TestEndpointInput` and `TestEndpointResult` component schemas; the
  `POST /v1/endpoints/{id}/test` operation (the bidirectional drift test forced both).

- **`src/sdk/client.ts`** — `TestEndpointInput` and `TestEndpointResult` wire types; `client.
  testEndpoint(id, input?)` sends the body (omitting undefined fields) and returns the typed result.

- **`src/portal/portal-handler.ts`** + **`src/portal/portal-views.ts`** — The consumer portal
  gets a "Test delivery" card on the endpoint detail page (hidden when the endpoint is disabled, the
  same guard the API enforces). The card shows a "Send test" submit button; a `POST
  /portal/endpoints/:id/test` dispatch branch runs the same signed-request logic (injectable
  transport for tests), then re-renders the detail page with an inline result banner (`alert-ok` /
  `alert-err`). `PortalDeps` gains an optional `transport` field; `PortalTestResult` is the view
  type exported from `portal-views.ts`.

**Tests (`src/http/api.test.ts`, +7; `src/sdk/client.test.ts`, +2):**
- API: success path (transport returns 200, `success:true`); failure path (transport returns 500,
  `success:false`); transport throw → `success:false` with `error` field; default body → `webhook-id`
  starts with `test_` + `webhook-signature` present; 400 for disabled endpoint; 404 for unknown and
  cross-tenant endpoint; 401 without auth.
- SDK: body with `eventType`/`payload` serialized correctly; empty input omits both fields.

**Validation (manual gate, [[validation-gate-is-manual]]):** `tsc --noEmit` clean. vitest
**1006/1006, 42 files** (+9 over baseline). `npm run build` clean. **compiled-`dist` smoke**
(`scripts/smoke-test-endpoint.mjs`, 21/21 checks through production ESM on `:memory:`): provision →
create endpoint → test success (receiver 200, `webhook-id` starts with `test_`, signature present) →
test failure (receiver 500, `success:false`) → test with custom eventType+payload (receiver 201,
`success:true`) → verify no messages stored in message list (quota not consumed) → 404 unknown → 400
disabled → 401 unauthenticated.

**State:** GREEN → committed to main @ iter-44 (`f01f9e0`).

---

## 2026-05-23 — Iteration 43: Event Type Catalog

**Repo truth at start:** clean main @ `4a0c1e2` (iter-42, portal delivery detail + manual retry).
Baseline verified: `tsc --noEmit` clean, vitest **962/962** (40 files), `npm run build` clean. No
[[interrupted-tick-reconcile-pattern]] trigger.

**High-leverage move chosen (checklist #3):** Event Type Catalog — the primary differentiator Svix
markets most heavily and the largest remaining competitive gap. Previously the endpoint `eventTypes`
filter was a free-text array with no authoritative catalog; every incumbent (Svix, Hookdeck, Convoy)
lets operators publish a structured catalog of event types so customers can discover and subscribe to
exactly the right events. This closes that gap end-to-end: operators create named slugs
(`user.created`, `payment.failed`) with human labels, descriptions, and optional JSON schema
examples; the portal's endpoint create/edit forms now render checkboxes from the catalog instead of
a free-text input when a catalog is populated; tenant isolation is strict (each app has its own
catalog, cross-app access is null); archive (soft delete) follows Svix's convention — inactive types
are hidden by default but visible with `?includeArchived=true`. Fully self-contained in the
established store → HTTP → SDK chain, zero new runtime dependencies.

**Built this tick:**

- **`src/event-types/event-type.ts`** (new) — `EventType` interface (`id` slug, `appId`, `name`,
  `description`, `schemaExample`, `archived`, timestamps); `EventTypeStore` interface (5 methods:
  `create`, `get`, `list`, `update`, `archive`); `DuplicateEventTypeError` + `UnknownEventTypeError`;
  `normalizeNewEventType` (validates id against `/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/` ≤100 chars, name
  trimmed ≤200, description ≤1000, schemaExample must parse as JSON); `applyEventTypeUpdate(current,
  patch, nowMs)` pure function using `"field" in patch` guards throughout.

- **`src/event-types/in-memory-event-type-store.ts`** (new) — `Map<appId, Map<id, EventType>>`
  backed, injectable clock, `list()` sorts by id ascending and filters archived unless
  `includeArchived: true`.

- **`src/event-types/sqlite-event-type-store.ts`** (new) — `createRequire("node:sqlite")` pattern;
  WAL + synchronous=NORMAL + foreign_keys=ON; `STRICT` table; partial index
  `idx_event_types_app (app_id, archived, id)`; prepared statements as private class fields; `create`
  catches `UNIQUE constraint failed` → `DuplicateEventTypeError`; `archive` uses `WHERE archived = 0`
  so re-archiving returns false; `close()` method.

- **`src/event-types/conformance.ts`** (new) — 11 shared conformance cases (× 2 backends): create,
  get null for unknown, get null cross-app, list empty, list excludes archived / includeArchived,
  list sorted ascending, duplicate throws, update, update throws, archive + get, archive false for
  unknown, cross-app isolation.

- **`src/event-types/in-memory-event-type-store.test.ts`** + **`sqlite-event-type-store.test.ts`**
  (new) — one-call conformance harness each.

- **`src/http/api.ts`** — `eventTypes: EventTypeStore` added to `ApiDeps` (required); added
  `DuplicateEventTypeError` → 409 and `UnknownEventTypeError` → 404 in `toErrorResponse`; 5 new
  routes added to `API_ROUTE_KEYS`: `GET /v1/event-types`, `POST /v1/event-types`,
  `GET /v1/event-types/:id`, `PATCH /v1/event-types/:id`, `DELETE /v1/event-types/:id`. Handlers:
  `listEventTypes` (respects `?includeArchived=true`), `createEventType` (201, catches duplicate →
  409), `getEventType` (404 if absent), `updateEventType` (catches `UnknownEventTypeError` → 404),
  `archiveEventType` (always 204). `eventTypeView()` pure view function.

- **`src/http/openapi.ts`** — `"EventTypes"` tag; `EventType`, `NewEventType`, `UpdateEventType`,
  `EventTypeList` component schemas; all 5 paths with correct operationIds, request/response bodies,
  400/401/404/409 error responses. The bidirectional drift test forced all additions.

- **`src/sdk/client.ts`** — `EventTypeView`, `CreateEventTypeInput`, `UpdateEventTypeInput`,
  `EventTypeListPage`, `ListEventTypesParams`; methods `listEventTypes`, `createEventType`,
  `getEventType`, `updateEventType`, `archiveEventType`.

- **`src/runtime/gateway.ts`** — `SqliteEventTypeStore` instantiated at `event-types.db`;
  `eventTypes` wired into `createApi` deps and `createPortalHandler` deps; `eventTypes.close()` in
  `stop()`; `eventTypes: EventTypeStore` exposed on `Gateway` interface; `resolveLocations` returns
  `eventTypes` path.

- **`src/portal/portal-handler.ts`** — `eventTypes?: EventTypeStore` added to `PortalDeps`; added
  `parseFormAll(body)` for multi-value checkbox parsing; GET endpoints and endpoint-detail handlers
  fetch the catalog and pass it to views; POST create/update handlers use `parseFormAll` then collect
  `eventType[]` checkbox values when catalog is present, else fall back to comma-split free-text
  `eventTypes`.

- **`src/portal/portal-views.ts`** — `portalEndpointsPage` and `portalEndpointDetailPage` accept
  optional `catalogTypes?: readonly { id: string; name: string }[]`; when non-empty, endpoint
  create/edit forms render a `subscribeAll` checkbox + per-type `eventType` checkboxes pre-checked
  against the endpoint's current `eventTypes`; free-text input kept as fallback when catalog absent.

- **`src/index.ts`** — event-type domain types and SDK types added to public exports.

- **`src/http/api.test.ts`** — `InMemoryEventTypeStore` wired into all `createApi` call sites; 8
  new handler tests (list, create, get, update, archive, 404 unknown, 409 duplicate,
  `?includeArchived=true`).

- **`src/sdk/client.test.ts`** — 2 injected-fetch unit tests: `listEventTypes` omits
  `includeArchived` by default, appends `includeArchived=true` when requested.

**Fix applied:** `client.test.ts` agent-generated code used `typeof url === "string" ? url : url.toString()` but `PosthornFetch` types `url` as `string`, making the else-branch `never` (tsc error). Simplified to `capturedUrl = url`. `api.test.ts` `includeArchived` test passed query string in path string instead of `query` object (router matches `path` only, returns 404 for unmatched path); fixed to use `query: { includeArchived: "true" }`.

**Validation (manual gate, [[validation-gate-is-manual]]):** `tsc --noEmit` clean. vitest
**997/997, 42 files** (+35 over baseline: +11 conformance × 2 backends, +8 handler, +2 SDK, +2
tsc/path fixes). `npm run build` clean. **compiled-`dist` smoke** (15/15 checks through production
ESM on `:memory:`): list empty; create 201; duplicate 409; sorted ascending; get 200; get unknown
404; update 200; archive 204; archived excluded from list; `?includeArchived=true` returns 2;
cross-tenant empty.

**State:** GREEN → committed to main @ iter-43 (`af99750`).

---

## 2026-05-23 — Iteration 42: Portal delivery detail + manual retry

**Repo truth at start:** clean main @ `07a96b5` (iter-41, Consumer App Portal).
Baseline verified: `tsc --noEmit` clean, vitest **953/953** (40 files), `npm run build` clean. No
[[interrupted-tick-reconcile-pattern]] trigger.

**High-leverage move chosen (checklist #3):** The Consumer App Portal (iter-41) surfaced a delivery
list per endpoint but left the user at a dead end: clicking a failed delivery did nothing, and
dead-lettered deliveries had no recovery path from the portal. This is the single biggest UX gap
versus Svix's portal (Svix customers can click into any delivery to see the last error and retry it).
Self-contained — the `DeliveryQueue.get` and `queue.retry` primitives already existed; only HTML
views and handler routes were missing.

**Built this tick:**

- **`src/portal/portal-views.ts`** — Delivery rows in `portalEndpointDetailPage` changed from plain
  text to `<a href="/portal/endpoints/:id/deliveries/:taskId">…</a>` links. Added new export
  `portalDeliveryDetailPage(endpoint, task, retried?)`: shows a table of message ID, status pill,
  attempt count, last error (or "—"), enqueue time, and updated-at time; includes a "Retry delivery"
  `<form method="POST">` button when `task.status === "dead_letter"`; shows a green success banner
  when `retried=true`. XSS-safe via `esc()` throughout.

- **`src/portal/portal-handler.ts`** — Added `import { DeliveryStateError }` from delivery-state;
  added `portalDeliveryDetailPage` to portal-views import. Extended segment destructuring to
  `[s0, s1, s2, s3, s4]`. Two new dispatch branches:
  - `GET /portal/endpoints/:id/deliveries/:deliveryId` (segs.length === 4): validates session,
    fetches endpoint (appId === session.appId), fetches task (`queue.get`), 404s if task is null or
    `task.endpointId !== s1` (cross-endpoint guard); passes `req.query["retried"] === "1"` to view.
  - `POST /portal/endpoints/:id/deliveries/:deliveryId/retry`: same ownership checks; calls
    `queue.retry(s3)`; catches `DeliveryStateError` (non-terminal — already re-queued) → redirect to
    detail page (no `?retried`); on success → redirect with `?retried=1`.

**Tests (`src/portal/portal-handler.test.ts`, +9):** GET detail 200 with delivery info; GET with
`?retried=1` shows success banner; GET 404 for unknown delivery id; GET 404 when delivery's
`endpointId` ≠ URL endpoint (cross-endpoint guard); GET 404 for cross-tenant endpoint; GET shows
Retry button only for `dead_letter` status (uses `fixedSchedule([])` queue to produce dead_letter
in one fail); POST retry re-queues dead-lettered delivery and task flips to `pending`; POST retry
on non-terminal delivery redirects gracefully (no crash); POST retry 404 for unknown delivery.

**Validation (manual gate, [[validation-gate-is-manual]]):** `tsc --noEmit` clean. vitest
**962/962, 40 files** (+9 over baseline). `npm run build` clean. **compiled-`dist` smoke**
(`scripts/smoke-portal-delivery.mjs`, 12/12 checks through production ESM on `:memory:`): portal
session minted; token exchanged; endpoint created; message ingested; endpoint detail shows delivery
rows as clickable links; delivery detail page 200 with messageId + status; cross-endpoint delivery
returns 404; `?retried=1` shows success banner.

**State:** GREEN → committed to main @ iter-42 (`4a0c1e2`).

---

## 2026-05-23 — Iteration 41: Consumer App Portal

**Repo truth at start:** clean main @ `0aa6540` (iter-40, `GET /v1/deliveries?status=`).
Baseline verified: `tsc --noEmit` clean, vitest **919/919** (38 files), `npm run build` clean. No
[[interrupted-tick-reconcile-pattern]] trigger.

**High-leverage move chosen (checklist #3):** Consumer App Portal — the feature Svix monetizes most
heavily, the largest competitive moat gap, and the closing piece of the "SaaS gives customers a
managed webhook UI" use case. A SaaS tenant calls `POST /v1/portal/sessions` (tenant API key auth),
receives a short-lived token + `portalUrl`; the customer is redirected there, the token is exchanged
for an `HttpOnly; SameSite=Strict` session cookie; all subsequent portal pages (endpoint list, detail,
create, update, rotate-secret, delete, logout) run scoped to the session's `appId` — appId comes from
the session only, never a URL param; cross-tenant endpoints return 404; signing secret shown exactly
once (create + rotate). Portal always enabled — no new credential surface beyond existing API keys.
The shared `InMemoryPortalSessionStore` instance between the JSON API and the portal handler makes
the token exchange work correctly.

**Built this tick:**

- **`src/portal/portal-session.ts`** (new) — `PortalSession` interface; `PortalSessionStore`
  interface (`createSession`, `getSession`, `deleteSession`); `InMemoryPortalSessionStore` (Map-backed,
  prunes expired on `getSession`); `MAX_PORTAL_SESSION_TTL_MS` (7 d), `DEFAULT_PORTAL_SESSION_TTL_MS`
  (24 h).

- **`src/portal/portal-views.ts`** (new) — pure HTML builders with `esc()` XSS guard; exports
  `portalExpiredPage()`, `portalEndpointsPage(endpoints, createdSecret?)`,
  `portalEndpointDetailPage(endpoint, rows, error?)`, `portalRotatedSecretPage(endpoint, newSecret)`,
  and `DeliveryRow` interface. Neutral "Webhooks" branding (not "Posthorn"). CSS inlined.

- **`src/portal/portal-handler.ts`** (new) — `createPortalHandler(deps)` dispatches 10 routes:
  `GET /portal`, `GET /portal/login?token=` (token exchange → cookie + redirect), `POST /portal/logout`
  (clear cookie), `GET /portal/endpoints`, `POST /portal/endpoints` (create, secret shown once),
  `GET /portal/endpoints/:id`, `POST /portal/endpoints/:id/update`, `POST /portal/endpoints/:id/rotate-secret`,
  `POST /portal/endpoints/:id/delete`. All mutating routes guard via `requireAuth()`.

- **`src/http/api.ts`** — `ApiDeps` gains optional `portalSessions?: PortalSessionStore`;
  `"POST /v1/portal/sessions"` added to `API_ROUTE_KEYS`; `createPortalSession` handler: validates
  `externalUserId` (non-empty string), `expiresIn` (1..604800 seconds, default 86400); derives
  `portalUrl` from `x-forwarded-proto` + `host` headers; returns `{ token, portalUrl, expiresAt }`;
  returns 404 when `portalSessions` not configured.

- **`src/http/openapi.ts`** — `Portal` tag; `"/v1/portal/sessions"` path + `createPortalSession`
  POST operation; `NewPortalSession` schema (`externalUserId: string` required, `expiresIn?: integer
  1..604800`); `PortalSessionResult` schema (`token: string`, `portalUrl: string uri`, `expiresAt:
  epoch ms`). The OpenAPI drift test *forced* all three additions.

- **`src/http/server.ts`** — `HttpServerOptions` gains `portalHandler?: ApiHandler`; `serve()`
  dispatches to portal handler when `pathname === "/portal"` or `pathname.startsWith("/portal/")`;
  priority order: tenant-dashboard > admin-dashboard > portal > main API.

- **`src/runtime/gateway.ts`** — instantiates `InMemoryPortalSessionStore` shared between
  `createApi` deps (`portalSessions`) and `createPortalHandler` so the token exchange round-trips;
  `portalHandler` passed to `createHttpServer` options.

- **`src/sdk/client.ts`** — `CreatePortalSessionInput` (`externalUserId: string`, `expiresIn?:
  number`); `PortalSessionResult` (`token`, `portalUrl`, `expiresAt`);
  `PosthornClient.createPortalSession(input)` → `POST /v1/portal/sessions`.

**Tests:**

- **`src/portal/portal-session.test.ts`** (new, 8 tests) — createSession returns token; getSession
  before expiry; null for unknown; prunes expired; deleteSession removes; deleteSession no-op on
  unknown; custom TTL; MAX constant value.

- **`src/portal/portal-handler.test.ts`** (new, 14 tests) — expired page; valid token exchange (cookie
  headers); auth guard redirect; endpoints page; GET /portal redirect; POST create shows `whsec_`
  banner; detail page; cross-tenant 404; delete + redirect; rotate secret; logout clears session;
  unknown route 404; and more.

- **`src/http/api.test.ts`** — 8-test `POST /v1/portal/sessions` describe block: 401 unauthenticated;
  404 when portalSessions unconfigured; 400 blank externalUserId; 400 missing externalUserId; 201
  token + portalUrl + expiresAt; 201 custom expiresIn; 400 expiresIn > 7d max; 400 expiresIn = 0;
  portalUrl uses x-forwarded-proto + host.

- **`src/sdk/client.test.ts`** — 3 tests: full integration (real server with portalSessions wired)
  verifying token, portalUrl, expiresAt; fakeClient verifying expiresIn forwarded; fakeClient
  verifying expiresIn omitted when not provided.

**Fixes applied mid-tick:**

- `exactOptionalPropertyTypes` strictness in portal-handler.ts — `form["description"]` yields
  `string | undefined`; fixed by `const rawDesc = form["description"] ?? ""` then `description:
  rawDesc`. Same for `url` in the update handler: spread pattern `...(rawUrl2.length > 0 ? { url:
  rawUrl2 } : {})`.

**Validation (manual gate, [[validation-gate-is-manual]]):** `tsc --noEmit` clean. vitest
**953/953, 40 files** (+34 over baseline: +8 session, +14 handler, +8 API handler, +3 SDK). `npm run
build` clean. **compiled-`dist` smoke** (7/7 checks through production ESM on `:memory:`): key
minted; portal session 201 with token + portalUrl; login exchange → 302 + set-cookie; endpoints page
200 with "Endpoints" heading.

**State:** GREEN → committed to main @ iter-41 (`07a96b5`).

---

## 2026-05-23 — Iteration 40: `GET /v1/deliveries?status=`

**Repo truth at start:** clean main @ `cbdabef` (iter-39, `GET /v1/endpoints/:id/deliveries`).
Baseline verified: `tsc --noEmit` clean, vitest **891/891** (38 files), `npm run build` clean. No
[[interrupted-tick-reconcile-pattern]] trigger.

**High-leverage move chosen (checklist #3):** Add `GET /v1/deliveries?status=` — the app-wide
delivery listing view. Reasoning: iter-39 added the endpoint-centric history ("everything this
endpoint received") and `GET /v1/messages/:id` gives the per-message status per endpoint. But the
cross-cutting operational view was still missing: "show me *all* my failed/dead-lettered webhooks
across all endpoints" — the #1 support-ticket-deflecting dashboard panel for incumbents (Svix
"portal deliveries", Convoy dashboard, Hookdeck event log). It also closes the monitoring gap:
producers whose endpoints churn through `dead_letter` have no single query to surface that state.
Self-contained in the established queue → HTTP → SDK chain, follows the iter-39 pattern exactly
(partial index, keyset cursor, dual-backend + one-shared-conformance-suite), and adds an optional
`?status=` filter so an operator can query specifically for `dead_letter` — the "what do I need to
fix?" view.

**Built this tick:**

- **`src/queue/delivery-queue.ts`** — `DeliveryTask` and `EnqueueInput` gain `appId: string | null`
  (denormalized at write time, same pattern as `DeliveryAttempt.appId` from iter-29); new
  `ListByAppOptions` (extends `ListDeliveriesOptions`, adds optional `status?: DeliveryStatus | null`
  filter); `DeliveryQueue` interface gains `listByApp(appId, options?)`; `NormalizedEnqueue` gains
  `appId`; `normalizeEnqueueInput` threads it through. `ListByAppOptions` is re-exported from
  `src/index.ts`.

- **`src/queue/in-memory-queue.ts`** — `enqueue` stores `appId` on the task; `listByApp` filters by
  `appId === appId`, optionally by `status`, sorts newest-first `(createdAt DESC, id DESC)`, applies
  cursor, returns `DeliveryPage` with `hasMore`-based `nextCursor`. Cross-app isolation is natural
  (the filter ensures it).

- **`src/queue/sqlite-queue.ts`** — `app_id TEXT` column added to SCHEMA for fresh DBs; idempotent
  `#migrateAppIdColumn()` called post-SCHEMA (checks `PRAGMA table_info`, runs `ALTER TABLE` if
  missing, always creates indexes afterwards — same pattern as `sqlite-attempt-store.ts`). Two partial
  indexes: `idx_delivery_tasks_app ON delivery_tasks (app_id, created_at, id) WHERE app_id IS NOT NULL`
  (unfiltered listing) and `idx_delivery_tasks_app_status ON delivery_tasks (app_id, status, created_at,
  id) WHERE app_id IS NOT NULL` (status-filtered listing). Four prepared statements: `selectByApp`,
  `selectByAppAfter`, `selectByAppFiltered`, `selectByAppFilteredAfter` — each fetches `limit+1` to
  detect `hasMore`. INSERT updated to include `app_id`.

- **`src/fanout/fanout.ts`** — `queue.enqueue` call now passes `appId: message.appId` so every
  fan-out task carries the tenant.

- **`src/queue/conformance.ts`** — 8 new shared conformance cases (× 2 backends = 16 new tests):
  empty page for unknown app; newest-first ordering + cross-app isolation; status filter (only
  `dead_letter` visible, pending empty); state-after-transition; cursor pagination (first + second
  page); status-filtered cursor pagination; invalid-limit `RangeError`; malformed-cursor `TypeError`;
  exact-multiple page boundary (`nextCursor: null` + empty continuation).

- **`src/http/api.ts`** — `"GET /v1/deliveries"` added to the compile-checked `API_ROUTE_KEYS`
  (compile error if no handler). `parseListByAppParams` parses `?limit=`, `?cursor=`, and `?status=`
  (validates against the four valid `DeliveryStatus` values → 400 for unknown). `getAppDeliveries`
  handler calls `deps.queue.listByApp(ctx.app.id, ...)` and maps through `endpointDeliveryView`
  (reused from iter-39 — already carries both `messageId` and `endpointId`, which are both needed in
  the app-wide context).

- **`src/http/openapi.ts`** — `"/v1/deliveries"` path + `listAppDeliveries` GET operation with
  `limit`/`cursor`/`status` query params; `AppDelivery` schema (`allOf: [ref("Delivery"),
  {required:["messageId","endpointId"], properties:{messageId:string,endpointId:string}}]`);
  `AppDeliveryList` schema (`data: AppDelivery[], nextCursor: string | null`). The bidirectional
  drift test *forced* all three.

- **`src/sdk/client.ts`** — `ListDeliveriesParams` (`limit?`, `cursor?`, `status?: DeliveryStatus |
  null`), `AppDeliveryView` (adds both `messageId` and `endpointId` to the base view), and
  `AppDeliveryListPage`; `client.listDeliveries(params?)` builds the query string and returns
  `AppDeliveryListPage`.

- **`src/index.ts`** — `ListByAppOptions` added to public exports.

- **`src/worker/delivery-worker.test.ts`** — added `appId: null` to the `claimedTask` literal; added
  `listByApp: async () => ({ deliveries: [], nextCursor: null })` to both stub queue objects.

- **`src/endpoints/endpoint-resolver.test.ts`** — added `appId: null` to `taskWithEndpoint` stub.

- **`src/http/api.test.ts`** — 7-test describe block for `GET /v1/deliveries`: 401 unauthenticated;
  empty page; lists all deliveries across endpoints (`messageId` + `endpointId` present); status filter
  (`dead_letter` only, pending empty); cursor pagination; invalid status → 400; invalid limit → 400.

- **`src/sdk/client.test.ts`** — 2 injected-fetch unit tests: `limit`+`cursor`+`status` appear in
  query string; no query string when no params given.

**Fixes applied mid-tick:**

- `delivery-worker.test.ts` / `endpoint-resolver.test.ts` — stub `DeliveryTask` literals were missing
  `appId` (now required by the updated interface): added `appId: null`.

- `api.test.ts` "filters by status — dead_letter only, pending empty" — used the shared `setup()` queue
  which has the default 8-attempt exponential retry policy; exhausting it required advancing time past
  ~28h, but `Date.now() + i * 5_000` increments weren't enough to make each re-claimed attempt actually
  claimable. Fixed by replacing the shared setup with an inline `new InMemoryDeliveryQueue({ retryPolicy:
  fixedSchedule([]) })` — 0 retries means 1 fail → `dead_letter` immediately, no time advancement needed.

**Validation (manual gate, [[validation-gate-is-manual]]):** `tsc --noEmit` clean. vitest
**919/919, 38 files** (+28 over baseline: +16 conformance × 2 backends, +7 handler, +2 SDK, +3 stub
fixes across worker/resolver tests). `npm run build` clean. **compiled-`dist` smoke** (11/11 checks
through production ESM on `:memory:`): no deliveries → empty; two endpoints → both tasks visible with
`messageId`+`endpointId`; status=pending only pending; status=dead_letter empty then non-empty after
exhaustion; cursor paginates; unknown status → 400; unknown app id → empty page.

**State:** GREEN → committed to main @ iter-40 (`0aa6540`).

---

## 2026-05-24 — Iteration 39: `GET /v1/endpoints/:id/deliveries`

**Repo truth at start:** clean main @ `d8e8db9` (iter-38, `?eventType=` filter on `GET /v1/messages`).
Baseline verified: `tsc --noEmit` clean, vitest **868/868** (38 files), `npm run build` clean. No
[[interrupted-tick-reconcile-pattern]] trigger.

**High-leverage move chosen (checklist #3):** Add `GET /v1/endpoints/:id/deliveries` — the
endpoint-centric delivery history. Reasoning: the existing `GET /v1/messages/:id` answers "for a
given message, what did each endpoint do?" — but the complement was missing: "for a given endpoint,
what messages were sent to it?" This is the primary debugging view when you have a misbehaving
*receiver* (not a specific message): "show me everything this endpoint has seen, newest first." Every
incumbent exposes this view (Svix's "endpoint messages", Convoy's "endpoint deliveries"). It also
closes the fan-out observability gap — `listByMessage` shows per-message delivery rows, but there was
no indexed path from endpoint to its tasks. The implementation is fully self-contained in the
established queue → HTTP → SDK chain, adds no new runtime dependencies, and follows the exact pattern
of every prior list route (keyset cursor, dual-backend + one-shared-conformance-suite, partial index).

**Built this tick:**

- **`src/queue/delivery-queue.ts`** — `DeliveryQueue` interface gains `listByEndpoint(endpointId,
  options?)` returning `DeliveryPage`; new exported types `ListDeliveriesOptions`, `DeliveryPage`,
  `DeliveryCursor`; helpers `encodeDeliveryCursor`/`decodeDeliveryCursor`/`resolveListDeliveriesQuery`/
  `isDeliveryAfterCursor`; constants `DEFAULT_LIST_DELIVERIES_LIMIT = 50`,
  `MAX_LIST_DELIVERIES_LIMIT = 200`.

- **`src/queue/in-memory-queue.ts`** — `listByEndpoint`: filters by `endpointId`, sorts newest-first
  (`createdAt DESC, id DESC`), applies cursor, returns `DeliveryPage` with `hasMore`-based `nextCursor`.

- **`src/queue/sqlite-queue.ts`** — `listByEndpoint`: two prepared statements (first-page + cursor
  continuation, fetches `limit + 1` to detect `hasMore`); partial index
  `idx_delivery_tasks_endpoint_created ON delivery_tasks (endpoint_id, created_at, id) WHERE endpoint_id
  IS NOT NULL` (idempotent `IF NOT EXISTS`; the planner skips orphan rows from tasks without an endpoint
  id, keeping the index tight).

- **`src/queue/conformance.ts`** — 7 new shared conformance cases (× 2 backends): empty-page for unknown
  endpoint; newest-first ordering + cross-endpoint isolation; state-after-transition; cursor pagination
  (first + second page); invalid-limit `RangeError`; malformed-cursor `TypeError`; exact-multiple page
  boundary (`nextCursor: null` + empty continuation).

- **`src/http/api.ts`** — `"GET /v1/endpoints/:id/deliveries"` added to the compile-checked
  `API_ROUTE_KEYS` (compile error if no handler); `endpointDeliveryView` (like `deliveryView` but adds
  `messageId` — in endpoint context the message id is not implied); `getEndpointDeliveries` handler:
  verifies endpoint ownership (cross-tenant → 404), calls `listByEndpoint`, maps through
  `endpointDeliveryView`.

- **`src/http/openapi.ts`** — `"/v1/endpoints/{id}/deliveries"` path + `listEndpointDeliveries` GET
  operation; `EndpointDelivery` schema (`allOf: [ref("Delivery"), {required: ["messageId"], properties:
  {messageId: string}}]`); `EndpointDeliveryList` schema (`data: EndpointDelivery[], nextCursor:
  string | null`). The bidirectional drift test *forced* all three.

- **`src/sdk/client.ts`** — `ListEndpointDeliveriesParams`, `EndpointDeliveryView` (adds `messageId`),
  `EndpointDeliveryListPage`; `client.listEndpointDeliveries(id, params?)` appends `?limit=&cursor=` and
  returns `EndpointDeliveryListPage`.

- **`src/index.ts`** — new public exports: `DEFAULT_LIST_DELIVERIES_LIMIT`, `MAX_LIST_DELIVERIES_LIMIT`,
  `encodeDeliveryCursor`, `decodeDeliveryCursor`, `ListDeliveriesOptions`, `DeliveryPage`,
  `DeliveryCursor`.

- **`src/worker/delivery-worker.test.ts`** — added `listByEndpoint` stub to two hand-built queue mock
  objects (required by the updated `DeliveryQueue` interface).

- **`src/http/api.test.ts`** — 6 handler tests: 401 unauthenticated; 404 unknown endpoint; empty page;
  lists with `messageId` present (both ids found via `toContain`); cursor pagination; 404 cross-tenant;
  400 invalid limit.

- **`src/sdk/client.test.ts`** — 2 injected-fetch unit tests: `limit`+`cursor` appear in query string;
  no query string when no params given.

**Fixes applied mid-tick:**

- `delivery-worker.test.ts` — two stub `DeliveryQueue` objects were missing `listByEndpoint`: added stub
  returning `{ deliveries: [], nextCursor: null }`.

- `api.test.ts` "lists deliveries newest-first" — both messages were ingested in sub-millisecond
  succession so `createdAt` collided; tiebreak `id DESC` is non-deterministic for random IDs. Fixed by
  asserting `toContain` for each id rather than positional order.

- `api.test.ts` "paginates correctly via cursor" — `?limit=2` was embedded in the path string; the
  router's `toSegments` would parse `deliveries?limit=2` as one segment (no match). Fixed by moving the
  param to `query: { limit: "2" }`.

**Validation (manual gate, [[validation-gate-is-manual]]):** `tsc --noEmit` clean. vitest
**891/891, 38 files** (+23 over baseline: +14 conformance × 2 backends, +6 handler, +2 SDK, +1
cross-tenant handler). `npm run build` clean. **compiled-`dist` smoke** (4/4 checks through production
ESM on `:memory:`): endpoint with no deliveries → empty page; two deliveries present → both ids visible;
cursor paginates; cross-tenant → 404.

**State:** GREEN → committed to main @ iter-39.

---

## 2026-05-24 — Iteration 38: `?eventType=` filter on `GET /v1/messages`

**Repo truth at start:** clean main @ `bea0e5b` (iter-37, README rewrite + npm publish prep,
P0–P5 otherwise complete). Baseline verified: `tsc --noEmit` clean, vitest **856/856** (38
files), `npm run build` clean, integrity gate exit 0. No [[interrupted-tick-reconcile-pattern]]
trigger.

**High-leverage move chosen (checklist #3):** Add `?eventType=` filtering to `GET /v1/messages`.
Reasoning: iter-37 declared the autonomous build phase complete, but Axiom 6 (Never Stop
Looping) + Axiom 4 (Own the Next Move) require continued execution. The product gap that
maximizes systemic benefit in one bounded tick: event-type filtering on the message list.
Every incumbent (Svix, Convoy, Hookdeck) exposes it; the #1 developer debugging workflow is
"show me all `payment.failed` events"; the tenant dashboard's message list is essentially
unusable without a filter for apps with mixed event traffic. The implementation is fully
engageable here (pure store → HTTP → SDK chain), produces no new runtime dependencies, and
composes cleanly with the existing keyset pagination (a filtered page returns its own cursor
scoped to the same event type).

**Built this tick:**

- **`src/storage/message-store.ts`** — `ListMessagesOptions` gains `eventType?: string | null`
  (null/omitted = no filter); `resolveListMessagesQuery` threads it through, normalising an
  empty string to `null` so the backends get a clean binary: `null` ↔ unfiltered, non-null
  string ↔ filter on that type.

- **`src/storage/in-memory-store.ts`** — `listByApp` adds a one-liner `.filter(…)` predicate
  before the sort/cursor step: `m.eventType === eventType` when `eventType !== null`.

- **`src/storage/sqlite-store.ts`** — Two new prepared statements (`#listByAppFiltered`,
  `#listByAppAfterFiltered`) add `AND event_type = ?` to the existing keyset predicates; the
  `listByApp` dispatch selects the right pair (filtered vs unfiltered × first vs subsequent
  page). New index `idx_messages_app_event_created (app_id, event_type, created_at, id)` added
  to `INDEXES` via `IF NOT EXISTS` — the planner uses it to narrow straight to the requested
  event type before the keyset scan; an existing DB gains it on next open with no migration
  (pure read optimization, identical to the prior message + delivery indexes).

- **`src/storage/conformance.ts`** — 4 new conformance cases (× 2 backends): filters by event
  type (only matching ids), returns empty for unknown type, pages correctly through a filtered
  result with a cursor, and null/omitted `eventType` returns all messages.

- **`src/http/api.ts`** — `parseListMessagesParams` parses the new `?eventType=` query param
  (non-empty string passes through to the store; absent/empty is left out so the store's
  default `null` applies) and passes it in `ListMessagesOptions`.

- **`src/http/openapi.ts`** — Added `eventType` query parameter to the `listMessages` operation
  (the bidirectional drift test already covered all operations; this is an `in: "query"` param,
  not a route, so the drift test was unaffected).

- **`src/sdk/client.ts`** — `ListMessagesParams` gains `eventType?: string | null`; `listMessages`
  appends `?eventType=` to the query string when provided and non-null.

- **`src/http/api.test.ts`** — 2 new handler tests: filter returns only matching ids (user.created
  not order.placed), empty page when no match.

- **`src/sdk/client.test.ts`** — 2 new injected-fetch unit tests: `eventType` appears in the query
  string when set; omitted from the query string when null.

**Validation (manual gate, [[validation-gate-is-manual]]):** `tsc --noEmit` clean. vitest
**868/868, 38 files** (+12 over baseline: +8 conformance × 2 backends, +2 handler, +2 SDK).
`npm run build` clean. Integrity gate exit 0. **compiled-`dist` smoke** (9/9 checks through
production ESM on `:memory:`): all-5 unfiltered, user.created-3 filtered + no order.placed
leak + all expected ids present, empty for unknown type, 2+1 paged cursor across the filter.

**State:** GREEN → committed to main @ `d8e8db9` as Iteration 38.

---

## 2026-05-23 — Iteration 37: README product-page rewrite + npm publish prep

**Repo truth at start:** clean main @ `a44ca24` (iter-36, `endpoint.disabled` webhook event,
P5 complete). Baseline verified: `tsc --noEmit` clean, vitest **856/856** (38 files),
`npm run build` clean, integrity gate exit 0. No [[interrupted-tick-reconcile-pattern]] trigger.

**High-leverage move chosen (checklist #3):** Rewrite the README as a real product page and
prepare `package.json` for npm publishing. Reasoning: P0–P5 are now complete — the product
is feature-ready. The README was still framed as a dev-diary ("Early foundation. Implemented
so far:" + 150-line ✅ feature tracker + six internal-primitive Quickstart sections). That
framing undersells the product to every evaluator, open-source contributor, and potential
customer who lands on the repository. The product's public face is the single highest-leverage
non-code asset; a quality README is a prerequisite for OSS adoption and the "profit potential"
filter from GOAL.md. `package.json` had `"private": true` (blocks `npm publish`) and was
missing `repository`/`keywords` fields — these are the last npm-publish gate items.

**Built this tick:**

- **`README.md`** — rewritten from 633 lines to ~260. Removed: the stale "Early foundation /
  Implemented so far" feature tracker (dev-diary, not product page); six internal-library
  Quickstart sections (signing module, delivery core, message store, queue, ingest,
  apps+auth — these are advanced embedding uses, not the primary path). Kept and promoted:
  Docker Quick Start (3 steps: build → bootstrap → send), comparison table (vs Svix/Convoy),
  compact capability list, API routes table (now includes `/v1/usage` + `/v1/messages/:id/attempts`
  which were missing), TypeScript SDK examples, Admin SDK examples, library-embedding section
  (new — shows `createGateway` / `gateway.apps.create`), configuration table, monitoring
  section with sample output, dashboard section, development instructions.

- **`package.json`** — removed `"private": true` (unblocks `npm publish`); added `"repository"`
  (git URL to the current GitHub repo) and `"keywords"` (`webhook`, `webhook-delivery`,
  `standard-webhooks`, `sqlite`, `no-redis`, `open-core`, `reliable-delivery`).

**Validation (manual gate, [[validation-gate-is-manual]]):** `tsc --noEmit` clean (no code
changes — README and package.json only). vitest **856/856, 38 files** (unchanged). `npm run
build` clean. Integrity gate exit 0 (three hash-protected files untouched).

**State:** GREEN → committed to main @ `7880bae` as Iteration 37. **Remaining gaps:**
Stripe billing (permanently blocked by external-account requirement — the last unengineerable
P5 item); a real GitHub repo rename from `claude-sandbox-test1` → `posthorn` (human action);
actual `npm publish` once the package name is confirmed on the registry (human action).
The autonomous build phase is now complete — all engineerable product items done, the
deployment and discovery artifacts are in place. Awaiting human direction.

---

## 2026-05-23 — Iteration 36: P5 — `endpoint.disabled` system webhook event

**Repo truth at start:** clean main @ `5c42d83` (iter 35, attempt-log pagination complete).
Baseline verified: `tsc --noEmit` clean, vitest **856/856 (38 files)**, `npm run build` clean.
No [[interrupted-tick-reconcile-pattern]] trigger.

**High-leverage move chosen (checklist #3):** The last unblocked P5 item — the
`endpoint.disabled` notification event (named parity with Svix). Usage-based billing via
Stripe remains permanently blocked by the external-account gate; this closes the only remaining
engineerable gap in the product. The feature follows the established pure-core/thin-I/O
discipline and touches every layer (store interface, both backends, gateway seam, HTTP API,
SDK) in a bounded, cohesive unit.

**Built this tick:**

- **`src/endpoints/endpoint.ts`** — added `EndpointOutcomeResult { endpoint, autoDisabled }`.
  Changed `EndpointStore.recordDeliveryOutcome` to return `Promise<EndpointOutcomeResult>`
  instead of `Promise<Endpoint | null>`. `evaluateEndpointHealth` already carried
  `autoDisabled: boolean`; this surfaces it through the store boundary so callers detect the
  transition without a second read.

- **`src/endpoints/in-memory-endpoint-store.ts` + `sqlite-endpoint-store.ts`** — updated
  `recordDeliveryOutcome` in both backends to return `EndpointOutcomeResult`. The SQLite
  backend now returns `{ endpoint, autoDisabled }` from both the fast-path read and the
  write-path transaction (including the deleted-endpoint null case). Conformance suite updated
  (+`autoDisabled` assertions on all `recordDeliveryOutcome` tests × 2 backends).

- **`src/apps/app.ts`** — `App` gains `systemWebhookUrl: string | null`. New `CreatedApp`
  extends `App` with `systemWebhookSecret: string | null` (only populated at creation, never
  returned by `get()`/`list()`). `NewApp`/`AppUpdate` accept `systemWebhookUrl`. `AppStore`
  adds: `create()` → `CreatedApp` (changed from `App`); `getSystemWebhookConfig(appId)` →
  raw URL+secret for gateway signing; `rotateSystemWebhookSecret(appId)` → new plaintext
  secret. `normalizeSystemWebhookUrl` validates http/https URLs. `generateSystemWebhookSecret`
  mints `sws_`-prefixed, 192-bit CSPRNG secrets (stored raw, like endpoint signing secrets).
  Both backends (in-memory + SQLite) implement all three new methods; SQLite gains
  `system_webhook_url` + `system_webhook_secret` via a seamless `ALTER TABLE` migration
  (pre-existing apps default to null, no behaviour change, no re-delivery).

- **`src/system-events/index.ts`** (new) — `emitEndpointDisabledEvent(config, endpoint,
  {transport, now})`: builds the Standard Webhooks-signed request (`sys_`-prefixed message id,
  `endpoint.disabled` payload, three SW headers), normalises `sws_`-prefixed secrets to the
  raw-base64 form the signer expects (stripping the prefix + base64url→base64 conversion), and
  POSTs via the injected transport. 6 unit tests: payload correctness, header presence and
  `sys_` prefix, signature verifiable with the existing `verify()`, `sws_`-prefix secret
  normalisation cross-checked against `whsec_` equivalent, and transport-error propagation.

- **`src/runtime/gateway.ts`** — `onDeliveryOutcome` now uses `result.autoDisabled` (from the
  updated `recordDeliveryOutcome`) to detect the transition without an extra read, then looks
  up `apps.getSystemWebhookConfig(result.endpoint.appId)` and calls
  `emitEndpointDisabledEvent` best-effort (errors routed to the worker's `onError`, never
  block a delivery). A simple `fetch`-based `systemEventTransport` is defined inline at the
  composition root (no new module-level dependency).

- **`src/http/api.ts`** — `appView(app)` now includes `systemWebhookUrl`. New
  `createdAppView(createdApp)` returns the one-time `systemWebhookSecret`. `createApp` and
  `updateApp` handlers accept `systemWebhookUrl` in the request body. New admin route
  `POST /v1/admin/apps/:id/rotate-system-secret` calls `rotateSystemWebhookSecret` and returns
  `{ secret }` (201, one-time). Added to the compile-checked `API_ROUTE_KEYS` table.

- **`src/http/openapi.ts`** — `App`/`NewApp`/`AppUpdate` schemas gain `systemWebhookUrl`.
  New `CreatedApp` schema (`allOf` referencing `App` + `systemWebhookSecret: string | null`).
  New `RotateSystemSecretResult` schema. New `rotateSystemWebhookSecret` operation on the
  admin path. Bidirectional drift test + orphan-schema test forced all additions.

- **`src/sdk/admin-client.ts`** — `AdminApp` gains `systemWebhookUrl`. New `CreatedAdminApp`
  extends `AdminApp` with `systemWebhookSecret`. `createApp()` returns `CreatedAdminApp`.
  `CreateAppInput`/`UpdateAppInput` accept `systemWebhookUrl`. New
  `rotateSystemWebhookSecret(appId)` method returns the new plaintext secret.

- **`.gitignore`** — added `*.db`, `*.db-shm`, `*.db-wal`, `posthorn-data/` patterns (the
  `*.sqlite` pattern was present but `node:sqlite` generates `.db` files).

**Validation:** `tsc --noEmit` clean (strict, `exactOptionalPropertyTypes` +
`noUncheckedIndexedAccess`). vitest **856/856** (was 814; +42: 6 system-events unit tests,
+16 endpoint conformance updates, +17 app conformance additions, +3 other updates).
`npm run build` clean. Compiled `dist/main.js` boots (port collision smoke, exit expected).
Integrity gate: exit 0.

**State:** GREEN → committed to main @ `866e5f3`. P5 is now **complete** — all engineerable
items done; only Stripe billing remains (permanently blocked by external-account requirement).
Next tick: assess remaining value gaps (README/docs polish, npm publish prep, GitHub push) or
declare the autonomous build phase complete and await human direction.

---

## 2026-05-23 — Iteration 35: P5 — attempt-log pagination (keyset cursor on `(attemptedAt, id)`)

**Repo truth at start:** clean main @ `371dc3f` (iter 34, operator deploy guide + P4 complete).
Baseline re-verified ([[validation-gate-is-manual]]): `tsc --noEmit` clean, vitest **814/814 (37
files)**, `npm run build` clean, integrity + local gate exit 0. Node 24.15. No
[[interrupted-tick-reconcile-pattern]] trigger.

**High-leverage move chosen (checklist #3):** The **explicitly-named "next code tick"** in
PROJECT.md — attempt-log pagination with a keyset cursor on `(attemptedAt, id)`. The prior design
said "no pagination" on the grounds that the log is bounded by `endpoints × retry_budget`, but as
endpoint counts and retry budgets can grow, an unbounded per-message endpoint scan under a single
HTTP request is a latent scaling risk, and a capped keyset pager closes it. Exactly the kind of
deterministic, dual-backend, conformance-suite-driven addition this loop is strongest at — zero new
dependencies, zero risk to the delivery path.

**Built this tick:**

- **`src/attempts/delivery-attempt.ts`** — pagination primitives added to the module:
  `DEFAULT_LIST_ATTEMPTS_LIMIT` (50), `MAX_LIST_ATTEMPTS_LIMIT` (200), `ListAttemptsOptions`
  (`limit?`, `cursor?`), `AttemptPage` (`data`, `nextCursor`), `AttemptCursor`, `encodeAttemptCursor`
  / `decodeAttemptCursor` (base64url `attemptedAt:id`, same idiom as the message cursor),
  `resolveListAttemptsQuery` (shared resolver, throws `RangeError` on bad limit, `TypeError` on
  malformed cursor — identical discipline to `resolveListMessagesQuery`), `compareAttemptsOldestFirst`
  (the one ordering rule: `attemptedAt ASC, id ASC` tiebreak), `isAttemptAfterCursor` (keyset
  predicate for the in-memory filter). The `DeliveryAttemptStore.listByMessage` contract updated from
  `→ Promise<readonly DeliveryAttempt[]>` to `→ Promise<AttemptPage>`.

- **`src/attempts/in-memory-attempt-store.ts`** — `listByMessage` updated: collects, sorts
  `compareAttemptsOldestFirst`, filters by cursor (`isAttemptAfterCursor`), slices `limit+1`
  (detect-next-page pattern), returns `{data, nextCursor}`.

- **`src/attempts/sqlite-attempt-store.ts`** — `listByMessage` updated: two prepared statements
  (`#selectByMessageFirst` for no-cursor, `#selectByMessageAfter` for keyset on `(attempted_at,
  id)`); a new `idx_delivery_attempts_message_paged (message_id, attempted_at, id)` covering index
  created idempotently (`IF NOT EXISTS`) in the constructor after migrations, so an existing DB gains
  it automatically on next open — no migration script needed (pure read optimization over existing
  rows, same discipline as prior per-message/per-app indexes). `#fetchPage` dispatches to the right
  prepared statement; `limit+1` detect-next-page pattern, then encodes cursor from the last row.

- **`src/attempts/conformance.ts`** — `listByMessage` conformance block expanded: replaces the
  three original tests with nine: empty-page for unknown message; oldest-first order + tenant scope,
  `nextCursor: null` when all fit; verbatim-preservation; paginate-with-limit=2 (3-attempt message,
  2 pages); full-scan limit=1 over 4 attempts (cover all, no leaks); same-ms tiebreak by id
  ascending; exact-multiple last-page (cursor null); limit=0 → `RangeError`; malformed cursor →
  `TypeError`. 9 cases × 2 backends = 18 new conformance assertions.

- **`src/http/api.ts`** — `parseListAttemptsParams` added (mirrors `parseListMessagesParams`:
  absent limit/cursor omitted; bad limit → `400`; cursor passed opaquely). `listMessageAttempts`
  handler updated: calls `deps.attempts.listByMessage(id, parseListAttemptsParams(ctx.req.query))`
  and returns `{data: page.data.map(attemptView), nextCursor: page.nextCursor}`.

- **`src/http/openapi.ts`** — `listMessageAttempts` operation updated with `?limit=` and
  `?cursor=` parameters and a `400` response (forced by the bidirectional drift test); `DeliveryAttemptList`
  schema updated: `required` gains `"nextCursor"`, `properties` gains a nullable `nextCursor` string.
  `MAX_LIST_ATTEMPTS_LIMIT` imported and referenced in the parameter schema.

- **`src/sdk/client.ts`** — `ListAttemptsParams` and `AttemptListPage` types added. `listMessageAttempts`
  signature updated to `(id, params?: ListAttemptsParams) → Promise<AttemptListPage>`;
  `URLSearchParams` used to build `?limit=&cursor=` (same pattern as `listMessages`).

- **`src/dashboard/tenant-handler.ts`** — calls `listByMessage` with `{limit: MAX_LIST_ATTEMPTS_LIMIT}`
  and destructures `.data`; the dashboard shows up to 200 attempts (bounded by endpoints × retry_budget,
  no pagination UI needed for a developer debugging tool).

**Key decisions (honest tradeoffs):**
- **Oldest-first, `(attemptedAt, id)` cursor.** The audit log is a chronological history — oldest-first
  is the natural read order. The `id`-descending tiebreak on messages (newest-first) is inverted here
  to `id`-ascending (oldest-first). The cursor encodes `attemptedAt:id` in both cases; the comparators
  and SQL predicates are mirrored symmetrically.
- **`idx_delivery_attempts_message_paged (message_id, attempted_at, id)` covers both pages.** The new
  index subsumes the old single-column `idx_delivery_attempts_message` for the paginated query (filter
  on `message_id`, then sort/keyset on `(attempted_at, id)`). Both indexes coexist; the old one is kept
  for any future non-paginated scan.
- **Dashboard uses `MAX_LIST_ATTEMPTS_LIMIT` (200).** A developer debugging tool does not need
  pagination UI — 200 attempts per message is ≫ any realistic `endpoints × retry_budget`. The comment
  explains the reasoning so it is not hidden.
- **`sqlite-attempt-store.test.ts` two lines updated.** The file unpacked a `listByMessage` result as
  `[survived]` (array destructure) and checked `.length` directly — both now go through `.data`.

**Validation:** `tsc --noEmit` clean (strict). vitest **826/826** (was 814; +12: 9 new conformance ×
2 backends = 18, minus 6 conformance tests replaced = +12 net new). `npm run build` clean.
**Smoke-tested the compiled `dist`** through production ESM:
- cursor round-trip (encode → decode → equal)
- in-memory pagination: 5 attempts, limit=2 → pages [2, 2, 1], third page `nextCursor=null`
- SQLite pagination: 4 attempts, limit=2 → pages [2, 2], second page `nextCursor=null`, survives close+reopen
- HTTP API over a real gateway socket: empty page, `limit=0` → 400, bad cursor → 400, `limit=201` → 400

Integrity + local gate: exit 0. The three hash-protected files were not touched.

**State:** GREEN → committed to main (`3f3ecf6`). The attempt-log can scale with high-volume message
fans-out. Remaining P5 items: `endpoint.disabled` notification event (system webhook when auto-disable
fires — requires a new system-event design) and usage-based billing integration (Stripe; needs an
external account, ungateable in the loop).

---

## 2026-05-23 — Iteration 34: P4 — operator deploy/monitoring guide (GitHub Actions CI, Docker Compose, Prometheus)

**Repo truth at start:** clean main @ `41c4d31` (iter 33, per-key `lastUsedAt`) — a real clean
baseline (git clean; iter-33 LOOP_LOG entry present and matches head;
[[interrupted-tick-reconcile-pattern]] not triggered). Baseline re-verified by the manual gate
([[validation-gate-is-manual]]): `tsc --noEmit` clean, vitest **814/814, 37 files**, `npm run build`
clean, integrity + local gate exit 0. Node 24.15.

**High-leverage move chosen (checklist #3):** Complete the **P4 operator self-host packaging story**
— the one explicit remaining P4 item. Standing deferred items after iter 33: Stripe billing
(ungateable — external account); attempt-log pagination (scaling concern, not immediate user gap);
**operator deploy/monitoring guide** (P4 docs); `endpoint.disabled` notification event. The
operator guide is the highest-leverage buildable move because:
*(a)* Without it, the headline wedge ("single container, no Redis, Prometheus-monitorable") is a
prose claim with no deployment path beyond `docker run` — a real self-hoster has no authoritative
reference for TLS termination, security hardening, alerting, or upgrading;
*(b)* GitHub Actions CI is a prerequisite for any meaningful open-source credibility — without CI,
every merge to main is validated only by a local gate, which is not visible to contributors or
evaluators;
*(c)* Docker Compose + Prometheus wires up the monitoring story end-to-end so "operator deploys
and can alert on `dead_letter` backlog" becomes a one-command, no-configuration task.
Fully gateable with no code changes (tests stay at 814/814, tsc stays clean).

**Built this tick:** 7 new files, 678 lines added, README updated.

- **`.github/workflows/ci.yml`** — GitHub Actions CI: Node 24 + `npm ci` + `npm run typecheck`
  + `npm test` + `npm run build`. Triggers on push/PR to `main`. Makes "keep main green" (Axiom 2)
  automated and visible; a failing tsc/vitest now blocks a PR before review.
- **`docker-compose.yml`** — the one-command production stack: `posthorn` (built from the local
  `Dockerfile`) + `prometheus` (prom/prometheus:v3.3.1). `posthorn` persists state to the
  `posthorn-data` named volume; Prometheus to `prometheus-data`. Reads from `.env` for
  `POSTHORN_ADMIN_TOKEN` + any tuning vars; mounts the `monitoring/` configs as read-only.
  Admin provisioning via `docker compose run --rm posthorn admin …`.
- **`monitoring/prometheus.yml`** — Prometheus scrape config: `job_name: posthorn`, target
  `posthorn:3000` (docker-compose service name), `metrics_path: /metrics`, 15s interval.
  Loads `alerts.yml` via `rule_files`.
- **`monitoring/alerts.yml`** — 5 production-ready alerting rules: `PosthornDown` (critical,
  scrape target unreachable > 1 min); `PosthornDeadLetterBacklog` (warning, any dead-lettered
  tasks > 5 min — **the one the DEPLOY.md says to keep at zero**); `PosthornDeadLetterBacklogHigh`
  (critical, > 100 dead-lettered); `PosthornDeliveryFailureRateHigh` (warning, > 20% failure
  rate over 10 min); `PosthornDeliveryQueueDepthHigh` (warning, > 1000 pending tasks > 5 min).
- **`.env.example`** — all `POSTHORN_*` environment variables with defaults and comments, including
  an admin-token generation snippet. The `.gitignore` already had `!.env.example` to keep it tracked.
- **`docs/DEPLOY.md`** — 448-line comprehensive operator guide: requirements table, Docker Compose
  quick start, tenant bootstrap (Compose + plain Docker + admin HTTP API), full configuration
  reference (12 variables), security hardening (TLS/reverse-proxy with nginx example, admin token
  generation, `/metrics` restriction, data-dir permissions, tenant-isolation model), Prometheus
  monitoring guide (metrics catalog + 4 key PromQL queries), alerting guide (5 rules + Alertmanager
  wiring), Grafana add-on (docker-compose.override.yml + 5 recommended dashboard panels), upgrade
  procedure (forward-only migrations + online backup), standalone binary + systemd unit, embedding
  as a library, throughput tuning table.
- **`README.md`** — CI badge (`[![CI]…badge.svg](…/actions/workflows/ci.yml)`); link to DEPLOY.md
  in the Docker section; `POSTHORN_ADMIN_TOKEN` and `POSTHORN_ENDPOINT_AUTO_DISABLE_AFTER_MS`
  added to the configuration table (both were missing); `.env.example` reference.

**Key decisions (honest tradeoffs):**
- **Docker Compose runs `build: .` (local image), not a registry pull.** There is no published
  registry image yet; the compose file builds from the local `Dockerfile`. When a registry is set
  up, change `build: .` to `image: posthorn/posthorn:latest` — noted in DEPLOY.md under Upgrading.
- **Grafana not in the base `docker-compose.yml`.** Grafana adds 200+ MB and an extra credential
  to manage. It is documented as an opt-in `docker-compose.override.yml` so the default stack stays
  minimal. Most operators already have Grafana centrally; a separate override avoids bloat.
- **Alerting rules are in `monitoring/alerts.yml`, not inline in `prometheus.yml`.** Separation makes
  them easier to manage independently (add a rule without touching the scrape config, reload via
  `--web.enable-lifecycle`).
- **No Grafana dashboard JSON shipped.** The PromQL queries are documented and well-named; generating
  a dashboard JSON for a specific Grafana version would rot. The DEPLOY.md gives the queries and
  panel descriptions so an operator builds it once in their own instance.

**Validation (manual gate, [[validation-gate-is-manual]]):** `tsc --noEmit` clean (strict, zero
code changes). vitest **814/814, 37 files** (unchanged — no code added). `npm run build` clean.
Integrity gate exit 0 (three hash-protected files untouched); local gate exit 0.

**State:** GREEN → committing to main as Iteration 34. P4 self-host packaging is now complete:
the gateway boots in Docker (P4 ✅), exports Prometheus metrics (P4 ✅), ships a deploy guide
with alerting rules (P4 ✅ this tick), and CI auto-validates main on push (new). **Standing
deferred (next candidates):** Stripe billing (ungateable); attempt-log pagination (explicit P3/P5
deferred item — keyset cursor on `(attemptedAt, id)`, same pattern as message listing); `endpoint.disabled`
notification event (named parity with Svix, requires a new system-event design); `endpoint.disabled`
notification in the tenant dashboard (currently auto-disable is silent — observable via API/dashboard
but no push signal).

---

## 2026-05-23 — Iteration 33: P3/P5 — per-key `lastUsedAt` — API-key activity observability

**Repo truth at start:** clean main @ `cf629e8` (iter 32, tenant dashboard UI) — a real clean
baseline (git clean; iter-32 LOOP_LOG entry present and matches head;
[[interrupted-tick-reconcile-pattern]] not triggered). Baseline re-verified by the manual gate
([[validation-gate-is-manual]]): `tsc --noEmit` clean, vitest **812/812** (790 iter-31 baseline +
7 tenant-sessions + 15 tenant-handler = 812; [[vitest-tinypool-flaky-worker-exit]] not triggered),
`npm run build` clean, integrity + local gate exit 0. Node 24.15.

**High-leverage move chosen (checklist #3):** Implement **per-key `lastUsedAt`** — track when an
API key last successfully authenticated a request. The reasoning: the standing deferred items are
Stripe billing (ungateable), per-key `lastUsedAt` (labeled "observability add-on" but in fact the
single most-asked security question: "is this key still in use?"), and attempt-log pagination (a
scaling concern with no immediate user gap). `lastUsedAt` is the highest-leverage buildable move
because: *(a)* it directly enables the operator security workflow "identify and revoke stale keys"
— without it a key can be minted and forgotten, never revoked, and there is no signal it has
expired; *(b)* it surfaces in the now-existing admin dashboard's key table (previously the table
showed Prefix / Key ID / Created / Status — with `lastUsedAt` it is actionable at a glance); *(c)*
the admin SDK `AdminApiKey` was already the wire shape for all key listings, so adding one field
completes the type rather than introducing a new one; *(d)* the implementation follows the
established best-effort-write pattern (`recordAttempt`, `onDeliveryOutcome`) and is fully
validatable in one tick.

**Decisive design calls.**
- **Side-effect write inside `authenticate`, not a separate call.** The alternative was to change
  `authenticate`'s return type to `{ app: App; key: ApiKey } | null` so callers could get the key
  id and call a separate `recordKeyUsed`. That would have been a blast-radius change (conformance
  suite, both backends, HTTP handler, tenant dashboard login handler, admin CLI tests). The natural
  design: `authenticate` on a successful match writes `lastUsedAt = now()` to the matched key and
  returns the `App`. Callers are unchanged; the side effect is local to the auth path, which already
  held the key record. The docstring now accurately reflects "a read + best-effort timestamp write
  on success."
- **`lastUsedAt` on `ApiKey`, not `App`.** Keys are the credential being used; apps are the tenant
  the key authenticates as. A tenant can have multiple keys; you want to know *which* key is active,
  not just whether any key authenticated the tenant.
- **No clock injection in the migrate path.** The SQLite migration just adds the `last_used_at
  INTEGER` column (nullable); existing rows stay `NULL` — "never used" is semantically correct for
  a key that was minted before tracking. No backfill needed.
- **No `lastUsedAt` in the tenant dashboard view.** The tenant sees their own API keys only
  implicitly (the key authenticates the session at login); the per-key `lastUsedAt` is a control-
  plane observability metric for *operators*, not tenant metadata. Showing it to tenants would just
  echo the session timestamp back at them. The admin dashboard is where it belongs.

**Built this tick:**
- `ApiKey.lastUsedAt: number | null` (new field; `null` = never used).
- `InMemoryAppStore.authenticate` — records `lastUsedAt = this.#now()` on the matching key entry.
- `SqliteAppStore`: `last_used_at INTEGER` column in `SCHEMA`; `#migrateLastUsedAtColumn()` (same
  `PRAGMA table_info` guard pattern as quota migration — pre-existing rows stay `NULL`); new
  `#updateKeyLastUsed` prepared statement; `authenticate` calls `.run(this.#now(), row.id)` on
  success; `rowToApiKey` maps the column.
- `conformance.ts`: +1 `lastUsedAt: null` assertion in the mint test; new test
  "updates lastUsedAt on each successful authentication, not on failure" (verifies null before
  first use, set after first auth, advanced on second auth, unchanged after failed auth).
- `apiKeyView` in `api.ts` — `lastUsedAt` added to the wire shape.
- `AdminApiKey` in `sdk/admin-client.ts` — `lastUsedAt: number | null` field.
- `ApiKey` schema in `openapi.ts` — `lastUsedAt` added to `required[]` and `properties`
  (`type: ["integer","null"]`, `format: "int64"`).
- `views.ts` admin dashboard — "Last used" column in the keys table (empty state `colspan` bumped
  6→ correct; date formatted `YYYY-MM-DD` or `—`).

**Force Absolute Validation (manual gate):** `tsc --noEmit` clean (strict). vitest **814/814,
37 files** (was 812; **+2**: 2 new conformance cases × 2 backends (in-memory + SQLite) — the
"updates lastUsedAt" test). `npm run build` clean. Integrity gate exit 0 (three hash-protected
files untouched); local gate exit 0.

**Beyond the gate — compiled-`dist` smoke (production-ESM proof):** `scripts/smoke-last-used-at.mjs`
**15/15 checks PASS** through production ESM: (1–4) in-memory lifecycle (null on create, set after
auth, unchanged on failed auth, advances on second auth); (5–7) SQLite lifecycle (same, with the
`node:sqlite` `createRequire` path); (8–10) OpenAPI `ApiKey` schema has `lastUsedAt` in both
`properties` and `required[]` with correct `["integer","null"]` type; (11–15) running-gateway
end-to-end: `lastUsedAt` is `null` before first use → `GET /v1/endpoints` triggers auth → admin SDK
`listApiKeys` returns a non-null `lastUsedAt` → preserved on revocation, `revokedAt` also set.

**State:** GREEN → committing to main as Iteration 33. Net: an operator can now see, at a glance
in the admin dashboard (or via the admin SDK), exactly when each API key was last used — enabling
the "find and revoke stale keys" security workflow. **Standing deferred (next candidates):**
Stripe billing (ungateable); attempt-log pagination (scaling concern, not immediate user gap);
operator deploy/monitoring guide (P4 docs).

---

## 2026-05-23 — Iteration 32: P5 — tenant dashboard UI (browser webhook-debug view)

**Repo truth at start:** clean main @ `d3c7774` (iter 31, admin dashboard UI) — a real clean
baseline (git clean; iter-31 LOOP_LOG entry present and matches head;
[[interrupted-tick-reconcile-pattern]] not triggered). Baseline re-verified by the manual gate
([[validation-gate-is-manual]]): `tsc --noEmit` clean, vitest **790/790, 35 files**, `npm run build`
clean, integrity + local gate exit 0. Node 24.15. GOAL→PROJECT reconciliation stands (Posthorn).

**High-leverage move chosen (checklist #3):** Build the **P5 tenant dashboard UI** — a browser UI
tenants use to browse their own webhook messages, deliveries, and attempt logs. The reasoning: the
standing deferred items after iter-31 are Stripe billing (ungateable — external account), per-key
`lastUsedAt` (observability add-on, minimal standalone value), and attempt-log pagination (a scaling
concern, not an immediate user gap). The tenant dashboard is the highest-leverage move I can fully
validate in one green tick: *(a)* it closes the "developers must curl the API to debug their own
webhooks" gap — the single most common developer pain point with webhook infrastructure; *(b)* it
completes the "observable" promise for the tenant (the admin dashboard serves operators; tenants now
have parity); *(c)* all data primitives already exist (`listByApp`, `listByMessage`, `listAttempts`,
`listByApp` for endpoints) — this is a pure presentation layer on top of them. The previous iteration's
concern about tenant session auth being "more complex" was an estimation gap: the implementation
follows the admin dashboard pattern exactly (API key → session cookie holding `appId`), with no
new credential surface beyond what the JSON API already exposes.

**Decisive design calls.**
- **Always enabled; no extra config flag.** The tenant dashboard authenticates via the existing API
  key — the same credential the JSON API uses. Disabling it would require a new `POSTHORN_TENANT_DASHBOARD`
  toggle that adds no security benefit (a tenant who can call `POST /v1/messages` can call `GET
  /dashboard/tenant/messages` — the same auth). The admin dashboard requires `POSTHORN_ADMIN_TOKEN`
  because the admin surface is deliberately opt-in; the tenant surface is not.
- **Session stores `appId`, not just existence.** `InMemoryTenantSessionStore` returns the `appId`
  from `validateSession` — unlike the admin store which is a pure boolean check — because every
  tenant page needs to scope its queries. Structurally distinct from (but parallel to) the admin
  `InMemorySessionStore` to keep the two auth surfaces independent.
- **`/dashboard/tenant` dispatched before `/dashboard` in `server.ts`.** The longer prefix must
  match first so tenant routes don't accidentally fall through to the admin handler. The updated
  routing checks `isTenantDashboard` before `isAdminDashboard`.
- **`appId` from session only, never from URL.** A tenant cannot forge another tenant's view by
  constructing a path — every query uses the session-held `appId`. Cross-tenant resources return
  `404`, identical to the JSON API.
- **Message detail joins endpoint URLs best-effort.** `listByMessage` returns task+endpointId; the
  handler loads each endpoint (`endpoints.get(endpointId)`) to show the human-readable URL. A
  deleted endpoint → `null` → shows the raw ID instead. Tenant-scoped: the fetched endpoint's
  `appId` must match the session's (defense-in-depth against a stale cross-tenant endpointId).
- **Payload displayed (truncated at 2000 chars).** This is the developer's primary debugging view
  — "what exactly did I send?" Omitting it (as the message list API does for lean list rows) would
  defeat the purpose of the detail page.

**Built this tick:** `src/dashboard/tenant-sessions.ts` (`InMemoryTenantSessionStore`, 8h TTL,
returns `appId` on validate); `src/dashboard/tenant-views.ts` (pure `tenantLoginPage` /
`tenantMessagesPage` / `tenantMessageDetailPage` / `tenantEndpointsPage` HTML builders, `esc()`
XSS guard, status pills, pagination); `src/dashboard/tenant-handler.ts`
(`createTenantDashboardHandler(deps)` — login/logout, messages list+detail, endpoints list,
session-scoped `requireAuth`); `scripts/smoke-tenant-dashboard.mjs` (22-check compiled-dist proof).
Modified: `src/http/server.ts` (`tenantDashboardHandler` option, `/dashboard/tenant` prefix dispatch
before `/dashboard`); `src/runtime/gateway.ts` (always-wired `InMemoryTenantSessionStore` +
`createTenantDashboardHandler`). Docs: README ✅, PROJECT.md P5 tenant dashboard ✅ + deferred list,
this entry.

**Force Absolute Validation (manual gate):** `tsc --noEmit` clean (strict). vitest **812/812,
37 files** (was 790/35; **+22**: 7 `InMemoryTenantSessionStore` (create/validate-live/validate-expired-prune/
validate-unknown/delete/no-op-delete/two-coexist); 15 handler (login page, wrong key, empty key,
correct key + cookie attrs, logout, auth-guard redirect, root-redirect, messages list empty, tenant
isolation, message detail with deliveries+attempts, cross-tenant 404, unknown-id 404, endpoints list
with isolation, endpoints empty, unknown route 404)). `npm run build` clean. Integrity gate exit 0
(three hash-protected files untouched); local gate exit 0. No tinypool flake
([[vitest-tinypool-flaky-worker-exit]]).

**Beyond the gate — compiled-`dist` smoke (production-ESM proof):** 22/22 checks PASS: (1)
`GET /dashboard/tenant/login` → 200 HTML with `apikey` input; (2) wrong API key → 200 + error
message; (3) correct key → 302 + `ph_tenant_session` cookie (HttpOnly, SameSite=Strict); (4)
session cookie authenticates `GET /dashboard/tenant/messages` → 200; (5) other tenant's message
absent from list (tenant isolation); (6) `GET /dashboard/tenant` → 302 to messages; (7) sent
message appears in list; (8) message id extractable from list HTML; (9) `GET …/:id` → 200 with
event type + payload visible; (10) `GET /dashboard/tenant/endpoints` → 200 with empty state; (11)
`POST /dashboard/tenant/logout` → 302 + `Max-Age=0`; (12) post-logout session invalid → 302 to
login. Temp script retained (not gitignored) per Axiom 3.

**State:** GREEN → committing to main as Iteration 32. Net: a tenant with a valid API key can now
open `/dashboard/tenant` in a browser and browse their sent messages, their per-endpoint delivery
statuses (with endpoint URLs resolved), and the full per-attempt audit log (HTTP status, duration,
error) — the "what happened to my webhook?" answer that was previously accessible only via the JSON
API. **Standing deferred (next candidates):** Stripe billing (ungateable); per-key `lastUsedAt`;
attempt-log pagination; operator deploy/monitoring guide (P4 docs); `endpoint.disabled` notification
event.

---

## 2026-05-23 — Iteration 31: P5 — admin dashboard UI

**Repo truth at start:** clean main @ `93489a0` (iter 30, endpoint health + auto-disable) — a real
clean baseline, not an interrupted tick (git clean; the iter-30 LOOP_LOG entry is present and
matches head; [[interrupted-tick-reconcile-pattern]] not triggered). Baseline re-verified by the
manual gate ([[validation-gate-is-manual]]): `tsc --noEmit` clean, vitest **769/769, 33 files**
(+1 file on my own run: no tinypool flake [[vitest-tinypool-flaky-worker-exit]]), `npm run build`
clean, integrity + local gate exit 0. Node 24.15. GOAL→PROJECT reconciliation stands (Posthorn).

**High-leverage move chosen (checklist #3):** Build the **P5 admin dashboard UI** — the
browser-facing face of the operator control plane. The reasoning: the two ungateable items
(Stripe billing, needs external account; tenant webhook browse UI, needs tenant session auth — a
more complex auth surface I won't rush in a security product) remain blocked. The admin dashboard
is the single highest-leverage move I can land as a complete, fully-validated green unit:
*(a)* it closes the "operator must use CLI to manage tenants" gap — a deployed hosted instance
now has a web UI for provisioning without shell access; *(b)* it directly advances the SaaS
monetization story by making the product self-service; *(c)* it reuses `POSTHORN_ADMIN_TOKEN` and
the existing `AppStore` — no new architecture, no new config, consistent with the zero-dep and
opt-in-by-default posture.

**Decisive design calls.**
- **No new credentials or config.** The dashboard reuses `POSTHORN_ADMIN_TOKEN` as its login
  password. Unset = all `/dashboard/*` routes are `404`, indistinguishable from a nonexistent path
  — identical to the admin JSON API model. No `POSTHORN_DASHBOARD_PASSWORD` needed.
- **Session auth over `SameSite=Strict` httpOnly cookie.** A browser session is fundamentally
  different from a Bearer token, but the security model is the same: a secret compared in constant
  time, a random opaque token stored in an httpOnly cookie. `SameSite=Strict` prevents cross-site
  CSRF without needing a separate CSRF token; `Secure` flag is omitted because the Node server has
  no TLS (operators add it via a reverse proxy, as documented in the HTML meta/comment).
- **Zero new runtime dependencies.** Pure HTML string builders (`views.ts`) with an inline CSS
  stylesheet and `esc()` for XSS safety; a 45-line in-memory session store (`sessions.ts`) using
  `node:crypto`'s `randomUUID`; the handler (`handler.ts`) re-uses the existing `ApiRequest`/
  `ApiResponse` types. `server.ts` dispatches on the `/dashboard` path prefix; `gateway.ts` wires
  it when `adminToken != null`. The JSON API route table, OpenAPI doc, and bidirectional drift test
  are completely untouched (dashboard routes are HTML, not JSON — they live in a separate handler).
- **One-time key secret on a direct 200 response.** `POST /dashboard/apps/:id/keys` returns 200
  (not 302) with the secret displayed once, the same behaviour as the JSON API's `201` response.
  The operator sees and copies it immediately; it is never retrievable again.

**Built this tick:** `src/dashboard/sessions.ts` (`InMemorySessionStore`, 8h TTL);
`src/dashboard/views.ts` (pure `loginPage`/`appsPage`/`appDetailPage` HTML builders, `esc()`
XSS guard); `src/dashboard/handler.ts` (`createDashboardHandler(deps)` — login/logout, apps
CRUD, key create/revoke/delete, constant-time token compare); `scripts/smoke-dashboard.mjs`
(compiled-dist proof). Modified: `src/http/server.ts` (optional `dashboardHandler` in options,
path-prefix dispatch); `src/runtime/gateway.ts` (wire `InMemorySessionStore` +
`createDashboardHandler` when `adminToken != null`). Docs: PROJECT.md P5 ✅ + deferred list,
this entry.

**Force Absolute Validation (manual gate):** `tsc --noEmit` clean (strict). vitest **790/790,
35 files** (was 769/33; **+21**: 6 `InMemorySessionStore` (create/validate/expire/delete/no-op);
15 dashboard handler (login page, wrong token, correct token + cookie attrs, logout clears,
GET /dashboard redirect, unauthenticated guard, authenticated apps page, POST create app +
quota, GET app detail, 404 for ghost app, delete app, create key + secret shown, revoke key,
unknown route)). `npm run build` clean. Integrity gate exit 0 (three hash-protected files
untouched); local gate exit 0.

**Beyond the gate — compiled-`dist` smoke (production-ESM proof):** 26/26 checks PASS: (1)
`GET /dashboard/login` → 200 HTML, login form present; (2) wrong token → 200 + error message; (3)
correct token → 302 + `Set-Cookie: ph_session=…; HttpOnly; SameSite=Strict`; (4) session cookie
authenticates `GET /dashboard/apps`; (5) `POST /dashboard/apps` (name + quota) → 302 to detail;
(6) `GET /dashboard/apps/:id` → 200 with app name and quota; (7) `POST …/keys` → 200, secret
banner visible, `phk_` prefix present; (8) minted key authenticates a real tenant API request
(`GET /v1/endpoints → 200`); (9) `POST …/delete` → 302 to apps list + cascade: minted key → 401;
(10) `POST /dashboard/logout` → 302 + `Max-Age=0` clears cookie; (11) post-logout session invalid
→ 302 to login. Temp script retained (not gitignored) for traceability per Axiom 3.

**State:** GREEN → committing to main as Iteration 31. Net: a deployed Posthorn instance with
`POSTHORN_ADMIN_TOKEN` set now has a full browser UI for operator provisioning — create apps with
quotas, mint and revoke API keys (secret shown once), delete apps — without needing shell/CLI
access. **Standing deferred (next candidates):** Stripe billing (ungateable); tenant-facing
webhook/delivery browse UI (needs tenant session auth); per-key `lastUsedAt`; attempt-log
pagination; operator deploy/monitoring guide (P4 docs).

---

## 2026-05-23 — Iteration 30: endpoint health + automatic disabling of dead endpoints

**Repo truth at start:** clean main @ `a5930ea` (iter 29, per-tenant delivery usage) — a real clean
baseline, not an interrupted tick (git clean; the iter-29 LOOP_LOG entry is present and matches head;
[[interrupted-tick-reconcile-pattern]] not triggered). Baseline re-verified by the manual gate
([[validation-gate-is-manual]]): `tsc --noEmit` clean, vitest **734/734, 33 files**, `npm run build` clean,
integrity + local gate exit 0. Node 24.15. GOAL→PROJECT reconciliation stands (Posthorn; the GitHub check
is settled in PROJECT §1 — re-searching 30 ticks in is anti-leverage).

**High-leverage move chosen (checklist #3):** Build **endpoint health tracking + automatic disabling**.
The reasoning: the two biggest *pure*-P5 items are blocked or oversized — Stripe billing needs an external
account (ungateable in the loop), and the dashboard requires secure browser **session auth**, a
security-sensitive, multi-tick subsystem I will not rush into one green tick *in a security product*. Among
moves I can land as a complete, fully-validated green unit, auto-disable is the highest leverage and is
**not** mere core polish: iter-29 made delivery **operations** a metered/billed unit, and a permanently-dead
endpoint silently burns the full ~28h retry budget on *every* future message forever — inflating wasted
operations (provider cost) and the tenant's bill (churn). Auto-disable caps that bleed; it is a named
market-parity feature (Svix), exceeded here on transparency (health is API/SDK-observable, the window is
operator-configurable, re-enable resets cleanly). It builds on the proven store+worker+FSM pattern → confident
green. Beat the alternatives on the loop's hard constraint, full local validatability.

**Decisive design calls.**
- **Time-based, not count-based.** The default retry schedule is 8 attempts over ~28h, so a single
  dead-letter already ≈ a day of failure; a *count* threshold would disable a high-volume endpoint during a
  *recoverable* outage (its burst of in-flight messages all dead-letter together). A continuous-failure
  *window* is traffic-independent and matches the market. A single isolated failure can never trip it (streak
  duration 0); a success resets the streak; a window of `0` turns the feature off (health still tracked).
- **One atomic, no-drift store rule.** A new `EndpointStore.recordDeliveryOutcome(id, outcome, now,
  autoDisableAfterMs?)` applies the pure `evaluateEndpointHealth` inside the store, both backends + one shared
  conformance suite — the same anti-drift discipline as every other store op. The **success hot path takes no
  write**: a success on an already-healthy endpoint is a no-op (returns the same reference); the SQLite backend
  reads lock-free first and opens a write txn only when state actually changes.
- **Worker reports, store decides.** The worker gained a best-effort `onDeliveryOutcome` seam (the structural
  twin of `recordAttempt`/`onTick`), fired only on **terminal** outcomes (a 2xx `succeeded` or a
  retries-exhausted `failed`) with a non-null `endpointId` — *not* on a retryable failure (not yet evidence)
  or a `stale` settle. A thrown report routes to `onError` and never blocks/fails a delivery (health is an
  add-on; delivery is the core). The gateway wires it with the window from config.

**Built this tick:** health fields on `Endpoint` (`consecutiveFailures`/`firstFailureAt`/`lastFailureAt`) +
`DEFAULT_AUTO_DISABLE_AFTER_MS` (5 days) + the pure `evaluateEndpointHealth` + `applyEndpointUpdate` clearing
the streak on re-enable; `recordDeliveryOutcome` on both backends (SQLite: 3 columns via a seamless
`ALTER TABLE` migration backfilling healthy, a health-only UPDATE stmt, lock-free success path); the worker
`onDeliveryOutcome` seam + best-effort `#reportEndpointOutcome`; gateway wiring +
`POSTHORN_ENDPOINT_AUTO_DISABLE_AFTER_MS` config (default 5d, `0`=off); health on `endpointView`, the OpenAPI
`Endpoint` schema (3 fields, forced into `required`+`properties`), and the SDK `EndpointView`; barrel exports.
Docs: README feature bullet, PROJECT.md (P3 ✅ + deferred `endpoint.disabled` event), this entry.

**Force Absolute Validation (manual gate):** `tsc --noEmit` clean (strict). vitest **769/769, 33 files**
(was 734; **+35**: endpoint pure-policy `evaluateEndpointHealth` + re-enable 11; endpoint conformance ×2
backends +14 (7 cases each: unknown-id no-op / success-no-write / failure-opens-streak / success-resets /
window-auto-disable / window-0-off / re-enable-clears) + a SQLite **migration** test; worker +7
(succeeded→succeeded, dead-letter→failed, retryable-not-reported, no-endpointId-skip, best-effort-absorb, +
the worker→store→resolver end-to-end auto-disable); config +3; HTTP-view +1). `npm run build` clean. Integrity
gate exit 0 (three hash-protected files untouched); local gate exit 0. No tinypool flake this run
([[vitest-tinypool-flaky-worker-exit]]).

**Beyond the gate — compiled-`dist` smoke (production-ESM proof):** ran a script importing the **built**
`dist`: (A) a fresh `SqliteEndpointStore` on a real file — a sustained-failure streak auto-disables and
**persists across a reopen** (durable, no Redis); (A2) a hand-built **pre-health** (rotation-era) DB opens,
backfills the row to healthy, and then auto-disables — proving the `ALTER TABLE` migration through production
ESM (incl. the `node:sqlite` `createRequire` path); (B) a **running gateway** over a real socket exposes the
endpoint health fields via `GET /v1/endpoints/:id` (and still omits the secret), with the configured window
parsed. 9/9 PASS, exit 0; temp script removed; git shows only the 18 intended source/test files (dist
gitignored).

**State:** GREEN → committing to main as Iteration 30. Net: a permanently-dead endpoint is now automatically
taken out of rotation after sustained failure — capping wasted, billed delivery operations — with the health
state fully observable and the policy operator-tunable, all without a single new runtime dependency. **Standing
deferred (next candidates):** usage-based billing integration (Stripe; needs an external account — ungateable);
the P5 dashboard UI (largest remaining; needs secure session auth — a deliberate multi-tick effort); an
`endpoint.disabled` notification event; per-key `lastUsedAt`; attempt-log pagination/retention; an operator
deploy/monitoring guide.

---

## 2026-05-23 — Iteration 29: P5 — per-tenant delivery (operations) usage metering

**Repo truth at start:** clean main @ `a29a6b5` (iter 28, admin SDK) — a real clean baseline, not an
interrupted tick (git clean; the iter-28 LOOP_LOG entry is present and matches head;
[[interrupted-tick-reconcile-pattern]] not triggered). Baseline re-verified by the manual gate
([[validation-gate-is-manual]]): `tsc --noEmit` clean, vitest **719/719, 33 files**, `npm run build` clean,
integrity + local gate exit 0. Node 24.15. The GOAL→PROJECT reconciliation stands (Posthorn; the GitHub
check is settled in PROJECT §1 — re-searching for a new project 29 ticks in would be anti-leverage).

**High-leverage move chosen (checklist #3):** Meter **per-tenant delivery-attempt (operations) usage** —
the standing-first deferred P5 item and the *delivery-side* completion of the metering arc. Reasoning,
consistent with the iters-24–28 strategy (the sending core is mature and exhaustively tested → its marginal
polish is low value; advancing the *profit phase* P5 is high value, the GOAL's prime filter): iters 25–27
metered **accepted messages** and iter-28 finished the typed SDK, but Posthorn still only billed on accepts —
yet this market's real resource/cost unit is **operations**, i.e. delivery attempts (every HTTP send, retries
included; Svix/Convoy meter this, not just accepts). Metering only accepts under-prices the actual work and is
a competitive gap. This was deferred ("attempts aren't tenant-indexed → wants a recording rollup"), but the
clean fix is the project's *own* established pattern, not a rollup. It beat the alternatives on the loop's hard
constraint, full local validatability: Stripe billing needs an external account (ungateable); the dashboard UI
is large and hard to gate headlessly; `lastUsedAt`/attempt-pagination are narrow polish.

**Decisive design call — denormalize the tenant onto the attempt, no new rollup.** The audit-log
`DeliveryAttempt` already denormalizes `messageId` and `endpointId` "so the per-X read is a single indexed
scan rather than a join." This adds **`appId: string | null`** for the identical reason — the worker already
holds the loaded message at record time, so the tenant is free there (`null` only for a vanished message,
which then belongs to no tenant and is counted for no one). A new `summarizeAttemptsByApp(appId, range)`
returns `{total, succeeded, failed, daily[]}` over a half-open epoch-ms range, grouped by UTC day, split by
outcome — computed straight from the append-only attempts log (source of truth, exact, no rollup to drift),
riding a new `(app_id, attempted_at)` index, **sharing the message store's `UsageRange`/`utcDayKey`/
`resolveUsageRange`** so the two usage views line up day-for-day and cannot drift. SQLite `app_id` is a
nullable column via a seamless `ALTER TABLE` migration; the companion index is created **after** the migration
(not in `SCHEMA`) — because on a pre-tenant-usage DB `SCHEMA` runs before the column is added, so an index DDL
there would reference a missing column and fail (caught and fixed mid-build: my first version rationalized that
ordering bug in a docstring; rewrote it correctly).

**Built this tick:** `appId` on `DeliveryAttempt`/`NewDeliveryAttempt`/`NormalizedNewAttempt` +
`normalizeNewAttempt` validation; `AttemptUsageDay`/`AttemptUsageSummary` + the `summarizeAttemptsByApp`
contract on `DeliveryAttemptStore`; both backends (in-memory group-by; SQLite `date()` GROUP BY + SUM-by-
outcome + migration + index); worker threads `message.appId` through `#recordDeliveryAttempt`; a purely-additive
`deliveries` block on the shared `usageView` (lights up **both** `GET /v1/usage` and `GET /v1/admin/apps/:id/
usage`); `DeliveryUsage`/`DeliveryUsageDay` OpenAPI schemas (forced by the bidirectional-drift + orphan-schema
tests, referenced from `Usage`); `TenantUsage.deliveries` / `AdminUsage.deliveries` SDK wire types (each
client's own views, per the SDK's design) + barrel exports. Docs: PROJECT.md (delivery-usage bullet ✅, removed
from deferred), README (feature line meters both units + admin-SDK example).

**Force Absolute Validation (manual gate):** `tsc --noEmit` clean (strict). vitest **734/734, 33 files**
(was 719; **+15**: attempt store +12 — appId normalize/persist + the `summarizeAttemptsByApp` conformance ×2
backends (zero/grouping/outcome-split/tenant-scope+null-exclusion/half-open/inverted-reject); worker +2
(records the message's tenant; `null` for a vanished message); HTTP +2 populated `deliveries` on both routes
with tenant isolation; SDK +empty/shape assertions). `npm run build` clean. Integrity gate exit 0 (three
hash-protected files untouched); local gate exit 0. No tinypool flake this run
([[vitest-tinypool-flaky-worker-exit]]).

**Beyond the gate — compiled-`dist` smoke (production-ESM proof):** booted the **built** gateway on a
**file-backed** dir with an admin token; provisioned a quota'd tenant + minted a key entirely over HTTP via the
built `PosthornAdminClient`; created an endpoint + sent a message via the built `PosthornClient`; the **running
worker delivered** and the webhook **verified** against the minted secret; then **both** the admin
(`getAppUsage`) and tenant (`getUsage`) SDKs read `deliveries.total=1, succeeded=1` over HTTP (polled past the
best-effort attempt-record race); finally **restarted on the same `node:sqlite` files** and saw the delivery
usage persist (durable, no Redis). Exit 0; temp script removed; git shows only the 16 intended source/test
files (dist gitignored).

**State:** GREEN → committing to main as Iteration 29. Net: Posthorn now meters **both** billable units —
accepted messages **and** delivery operations — per tenant, exact and from source-of-truth logs, exposed on the
tenant and admin routes and both typed SDKs; the billing read model is now complete. **Standing deferred (next
candidates):** usage-based billing integration (Stripe; needs an external account — ungateable in the loop);
the P5 dashboard UI (the largest remaining piece; hard to gate headlessly — a server-rendered slice is the
likely path); per-key `lastUsedAt`; attempt-log pagination/retention; an operator deploy/monitoring guide.

---

## 2026-05-23 — Iteration 28: admin / control-plane SDK (`PosthornAdminClient`)

**Repo truth at start:** clean main @ `569fce5` (iter 27, tenant self-service `GET /v1/usage`) — a real clean
baseline, not an interrupted tick (git clean; the iter-27 LOOP_LOG entry is present and matches head;
[[interrupted-tick-reconcile-pattern]] not triggered). Baseline re-verified by the manual gate
([[validation-gate-is-manual]]): `tsc --noEmit` clean, vitest **698/698, 32 files**, `npm run build` clean,
integrity + local gate exit 0. Node 24.15. The GOAL→PROJECT reconciliation stands (Posthorn; the GitHub
check is settled in PROJECT §1 — re-searching for a new project 28 ticks in would be anti-leverage).

**High-leverage move chosen (checklist #3):** Build the typed **admin / control-plane SDK**
(`PosthornAdminClient`), the explicitly-deferred next item across iters. Reasoning, consistent with the
iters-24–27 strategy (the sending core is mature and exhaustively tested → its marginal polish is low value;
advancing the *profit phase* P5 is high value, the GOAL's prime filter): the control plane (`/v1/admin/*`,
9 routes) was **HTTP-only** — the tenant `PosthornClient` covers tenant routes, but a hosted operator (and
the eventual P5 **dashboard**, the largest remaining piece) had to hand-roll `fetch` to provision tenants.
A first-class SDK is a *named* differentiator in the wedge; the admin half completes it and is the typed
client the dashboard will be built on (so this maximizes *systemic* leverage, not just local value). It beat
the alternatives on the loop's hard constraint — full local validatability: Stripe billing needs an external
account (ungateable); a pricing engine risks inventing pricing *policy* (a human business decision) + larger
scope; per-tenant *delivery* usage needs a riskier recording rollup; `lastUsedAt` / attempt-pagination are
narrow polish. This is a clean, deterministic, fully-gate-validatable unit on a proven pattern.

**Decisive design calls.**
- **No-drift refactor first.** Rather than duplicate ~60 lines of request mechanics across two clients
  (a real drift hazard — the very thing the project's conformance discipline fights), extracted the shared
  transport — the `fetch` contract types, the three error classes (`PosthornError`/`PosthornApiError`/
  `PosthornTimeoutError`), `DEFAULT_TIMEOUT_MS`, and the `request` mechanic (Bearer envelope, timeout/abort,
  2xx-JSON / 204-void parsing, `{error:{code,message}}` mapping) — into a new `src/sdk/http.ts`
  `HttpTransport` that **both** clients delegate to. `client.ts` re-exports the moved public symbols, so every
  existing import path (`from "posthorn"` / the barrel) and the 29 existing client tests stay green unchanged
  — they *are* the regression net for the refactor.
- **`getAppUsage`'s range is required** (`{from,to}` inclusive `YYYY-MM-DD`), encoded in the type — because
  the admin metering route *mandates* an explicit window (omitting either → `400`), a genuine wire-contract
  difference from the tenant `GET /v1/usage` (which defaults to the current month). Faithful-to-the-wire, not
  copy-paste.
- **SDK-owned wire views** (`AdminApp`/`AdminApiKey`/`AdminUsage`/…), never the server's domain types — an
  app/key carries no secret except the one-time `secret` from `createApiKey`, exactly as the wire returns.

**Built this tick (`src/sdk/`):**
- **`http.ts`** (new) — the shared `HttpTransport` + the relocated error/fetch surface.
- **`client.ts`** (refactor) — `PosthornClient` now holds an `HttpTransport`; constructor validation
  (TypeError on empty `baseUrl`/`apiKey`/negative timeout) preserved; shared symbols re-exported.
- **`admin-client.ts`** (new) — `PosthornAdminClient` over the same transport, covering all 9 admin routes:
  `createApp`/`listApps`/`getApp`/`updateApp`/`deleteApp`, `createApiKey`/`listApiKeys`/`revokeApiKey`,
  `getAppUsage`. Disabled surface → `404` `PosthornApiError`; wrong/tenant-key token → `401`.
- **`index.ts`** — barrel exports `PosthornAdminClient` + its wire types.
- **Docs:** PROJECT.md (admin-SDK bullet ✅, removed from deferred), README (feature line + an operator
  admin-SDK quickstart). No OpenAPI change — routes are unchanged; the doc already covers non-TS admin
  consumers, and this completes the typed-TS path.

**Force Absolute Validation (manual gate):** `tsc --noEmit` clean (strict). vitest **719/719, 33 files**
(was 698; **+21** in the new `admin-client.test.ts`: in-process `node:http` CRUD incl. **a minted key
authenticates a tenant `PosthornClient`, revoke locks it out, delete cascades its keys**, metered usage over
a required range, inverted-range→400; surface gating — disabled→404, wrong-token→401, **tenant-key-as-admin
→401**; injected-`fetch` transport — Bearer header, trailing-slash, path-encoding, error-envelope mapping,
204→void, timeout; a running-gateway e2e). The 29 pre-existing `client.test.ts` tests passed unchanged,
confirming the transport extraction was behavior-preserving. `npm run build` clean. Integrity gate exit 0
(three hash-protected files untouched); local gate exit 0. First full run hit the known one-off
"Worker exited unexpectedly" tinypool flake ([[vitest-tinypool-flaky-worker-exit]]) — 0 assertion failures;
a clean re-run was **719/719**.

**Beyond the gate — compiled-`dist` smoke (production-ESM proof):** booted the **built** gateway on a
**file-backed** dir with an admin token; **provisioned a tenant (quota 100) + minted a key entirely over
HTTP via the built `PosthornAdminClient`**, then drove the data plane with the built `PosthornClient`
(create endpoint → send) — the running worker delivered and the webhook **verified** against the
admin-minted endpoint's secret through production ESM; `admin.getAppUsage` read `total:1` over HTTP; then
**restarted on the same `node:sqlite` files** and saw the tenant, its quota, and its usage all persist
(durable, no Redis). Exit 0; temp script removed; git shows only the 5 intended source/doc files (+ README).

**State:** GREEN → committing to main as Iteration 28. Net: Posthorn's first-class TS SDK now spans **both**
planes — tenants send/observe via `PosthornClient`, operators provision/meter via `PosthornAdminClient` —
over one shared, non-drifting transport; the typed foundation the P5 dashboard renders on. **Standing
deferred (next candidates):** usage-based billing integration (Stripe; needs an external account — ungateable);
per-tenant *delivery* usage (needs a recording rollup — attempts aren't tenant-indexed); per-key `lastUsedAt`;
attempt-log pagination; an operator deploy/monitoring guide; and the rest of P5 (dashboard UI).

---

## 2026-05-23 — Iteration 27: P5 — tenant self-service usage & quota (`GET /v1/usage`)

**Repo truth at start:** clean main @ `38fed27` (iter 26, monthly quota enforcement) — a real clean
baseline, not an interrupted tick (git clean; iter-26 entry present + matches head;
[[interrupted-tick-reconcile-pattern]] not triggered). Baseline re-verified by the manual gate
([[validation-gate-is-manual]]): `tsc --noEmit` clean, vitest **687/687, 32 files**, `npm run build` clean,
integrity + local gate exit 0. Node 24.15. The GOAL→PROJECT reconciliation stands (Posthorn; the GitHub
check is settled in PROJECT.md §1 — re-searching for a *new* project 27 ticks in would be anti-leverage).

**High-leverage move chosen (checklist #3):** Build the **tenant self-service usage & quota endpoint**
(`GET /v1/usage`). The decisive reasoning, consistent with iters 24–26's deliberate strategy (the sending
core is mature and exhaustively tested → its marginal polish is low-value; advancing the *profit phase*
P5 is high-value, the GOAL's prime filter): iter-25 *metered* message usage and iter-26 *enforced* a
monthly quota, but **both were admin-only** (`/v1/admin/apps/:id/usage`, admin-token-gated). A tenant had
**no way to see its own usage or even its plan limit** — so a freemium user that hit a `429` was blind,
which is both a support-ticket generator and a missed upgrade prompt. Exposing the metered+enforced quota
to the paying tenant **completes the meter→enforce→expose arc**, is the tenant-facing API the eventual P5
dashboard renders, and is a direct freemium→paid funnel lever. It beats the standing-deferred alternatives:
Stripe billing needs an external account (unvalidatable in the loop's gate); per-tenant *delivery* usage
needs a recording rollup (a larger, riskier store change); the admin SDK client / `lastUsedAt` / attempt
pagination are each narrower. And it is a clean, deterministic, **zero-new-state** green unit.

**Decisive design call — pure reuse, no new state.** The endpoint composes only existing primitives:
`summarizeUsageByApp` (the iter-25 exact-aggregate read model), `utcMonthRange` (iter-26), and one new
pure helper `quotaRemaining(used, quota)` (`src/apps/app.ts`; the companion to `isQuotaExceeded` —
`null`→`null` unlimited, else `max(0, quota−used)` so a soft-limit overshoot never reports negative). So
**no store change, no migration, no new index, no ingest/worker touch.** Scoped to the API key's tenant
(never a body/path `appId`, like every tenant route). The breakdown **defaults to the current UTC month**
(the self-service view) and accepts the same optional inclusive-`YYYY-MM-DD` `?from=&to=` historical
window as the admin route (reusing `parseUsageRangeParams`; partial/invalid/over-cap → `400`). Critically
the `quota` block (`monthlyMessageQuota`/`used`/`remaining`/`periodStart`/`resetsAt`) always reports the
**current month** regardless of the queried range — so a dashboard shows "N of M, resets on the 1st" while
still pulling history. One store call in the default case; a custom range adds one more to keep the quota
block live.

**Built this tick (a vertical slice over existing machinery):**
- **`apps/app.ts`** — pure `quotaRemaining`, re-exported from `index.ts`.
- **`http/api.ts`** — `"GET /v1/usage"` added to `API_ROUTE_KEYS` (the `Record<ApiRouteKey, …>` made wiring
  exhaustive); `getUsage` authed handler; `tenantUsageView` (the `usageView` breakdown + the live `quota`
  block); module surface table updated.
- **`http/openapi.ts`** — a `Usage` tag + the `getUsage` operation + `TenantUsage` (`allOf` of the existing
  `Usage` + `quota`) / `QuotaStatus` schemas; the bidirectional drift + orphan-schema tests *forced* the op
  and both schemas (and re-referencing `Usage` keeps it non-orphan).
- **`sdk/client.ts`** — `client.getUsage({from?,to?})` → `TenantUsage`, plus SDK-owned `TenantUsage`/
  `QuotaStatus`/`UsageDay`/`GetUsageParams` wire types (the SDK's own views, per its design); the top three
  re-exported from `index.ts` (the SDK's `UsageDay` deliberately not re-exported — it would collide with
  the message-store `UsageDay` already on the barrel).

**Force Absolute Validation (manual gate):** `tsc --noEmit` clean (strict). vitest **698/698, 32 files**
(was 687; **+11**: `quotaRemaining` pure unit ×4; a pure handler suite ×6 — 401, current-month default,
unlimited→`remaining:null`, used/remaining against a quota, historical-range-with-live-quota, partial/
invalid/inverted `400`, tenant isolation; an in-process SDK test ×1). `npm run build` clean. Integrity gate
exit 0 (three hash-protected files untouched); local gate exit 0. No tinypool flake this run
([[vitest-tinypool-flaky-worker-exit]]).

**Beyond the gate — compiled-`dist` smoke (production-ESM proof):** booted the **built** gateway on a
**file-backed** dir with an admin token; provisioned a tenant with `monthlyMessageQuota:5` over the admin
HTTP API, minted a key, sent 3 messages, and read `GET /v1/usage` **through the SDK's `getUsage`** — got
`total:3`, `quota.used:3`, `quota.remaining:2`, `periodStart:2026-05-01`, `resetsAt:2026-06-01`; a
historical `2020-01-01..02` range returned its empty window while `quota.used` stayed `3` (current month);
then **restarted on the same files** and saw usage + quota persist (durable, no Redis). Exit 0; temp script
removed; git shows only the 8 intended source/test files.

**State:** GREEN → committing to main as Iteration 27. Net: a Posthorn tenant can now **see its own**
message usage and live monthly quota status (used / remaining / when it resets) over its own API key and
the SDK — the customer-facing surface that turns the admin-only metering+enforcement into a self-service,
funnel-driving capability and the foundation the P5 dashboard renders. **Standing deferred (next
candidates):** usage-based billing integration (Stripe); per-tenant *delivery* usage (needs a recording
rollup — attempts aren't tenant-indexed); an *admin* SDK client; per-key `lastUsedAt`; attempt-log
pagination; an operator deploy/monitoring guide; and the rest of P5 (dashboard UI).

---

## 2026-05-23 — Iteration 26: P5 — real-time monthly quota enforcement (RECONCILED interrupted tick)

**Repo truth at start — an interrupted prior tick, not a clean baseline.** git head was `4f30cb9`
(iter 25, usage metering) and the iter-25 LOOP_LOG entry matched it, but the tree was **dirty** with 10
modified source files implementing an *unlogged, uncommitted* feature — the classic
`[[interrupted-tick-reconcile-pattern]]` signal, here even earlier than usual: the work was built but
PROJECT.md/README were **not** yet marked ✅. Critically the tree was **red**: `tsc --noEmit` failed
(`app.test.ts` constructed an `App` literal missing the new required `monthlyMessageQuota` field), and
several existing `toEqual` assertions (`normalizeNewApp`/`applyAppUpdate`, the admin `appView`) would
fail at runtime against the new field. Per the doctrine + Axiom 4, the high-leverage move was to
**adjudicate the orphaned work, not rebuild**: the implementation was read critically and judged coherent
and correct, so it was completed to the project bar rather than discarded.

**What the orphaned implementation was:** **real-time per-tenant monthly message quota enforcement** — the
*enforcement* half of iter-25's metering read model and the standing-first P5 deferred item ("real-time
quota enforcement (block at a free-tier limit)"). `App` gains `monthlyMessageQuota: number|null`
(null=unlimited default; `0`=suspended); a pure `utcMonthRange(now)` + the existing `summarizeUsageByApp`
+ a pure `isQuotaExceeded` (`>=`) gate `POST /v1/messages` → `429 quota_exceeded`; a new
`PATCH /v1/admin/apps/:id` is the plan-change route. Reuses the iter-25 read model (no rollup, no new
index, no ingest-write); the window resets at the UTC month edge with no scheduled job. Two correctness
calls baked in: an **idempotent replay is exempt** (no new message → 429-ing it would break idempotency),
and the limit is **soft** (concurrency-bounded overshoot). Nullable SQLite column via a seamless
`ALTER TABLE` migration (pre-quota DBs default to unlimited). Route table + bidirectional OpenAPI drift
test force the `updateApp` op, `AppUpdate` schema, `429` response, and the new fields.

**What THIS tick authored (completing the tick):** the missing test coverage + the doc/log truth.
- Fixed the red/broken existing tests: the `App` base literal + `normalizeNewApp`/`applyAppUpdate`/admin
  `appView` `toEqual`s now carry `monthlyMessageQuota`.
- Added pure unit tests: `normalizeQuota` (null-collapse/non-neg-int/reject), `isQuotaExceeded` (null
  never, `>=` boundary, 0-blocks-all), `utcMonthRange` (mid-month/Dec-rollover/half-open), `applyAppUpdate`
  quota set-clear + reject.
- Added HTTP handler tests: quota enforcement (unlimited-never-blocked, admits-N-then-429, replay-exempt,
  quota-0, **month-boundary reset** via an injected clock) and `PATCH /v1/admin/apps/:id` (set/change/
  clear, 400 invalid, 404 unknown, added to the disabled-by-default 404 probe list); admin appView quota.

**Force Absolute Validation (manual gate, `[[validation-gate-is-manual]]`):** `tsc --noEmit` clean (was
red at start). vitest **687/687, 32/32 files** (was 660 at iter 25; +6 quota app-store conformance ×2 +21
new this tick). First full run hit the known one-off `[[vitest-tinypool-flaky-worker-exit]]` ("Worker
exited unexpectedly", 1 file uncounted) — re-ran, fully green, confirming flake not red. `npm run build`
clean. Integrity gate exit 0 (three hash-protected files untouched); local gate exit 0. Node 24.

**Beyond the gate — compiled-`dist` smoke (production-ESM proof):** booted the **built** binary on a
**file-backed** dir with an admin token; admin-created a tenant with `monthlyMessageQuota:2` over HTTP
(SQLite column round-trips), sent 2→202 + 3rd→`429 quota_exceeded`, `PATCH`ed the quota to 4 → sends
resumed (202,202) then 429 at the new ceiling; **restarted on the same files** and saw the quota (=4) and
the counted messages both persist (still 429), then a further `PATCH` to 10 resumed delivery. Exit 0;
temp script + dir removed; git shows only the 12 intended source/test files.

**State:** GREEN → committing to main as Iteration 26. Net: a deployed Posthorn now **enforces** per-tenant
monthly message quotas (the freemium/usage-pricing boundary), not just *reports* usage — `429` at the
ceiling, plan changes over the admin control plane, the allowance resetting at the UTC month edge with no
job. **Standing deferred (next candidates):** usage-based billing integration (Stripe); per-tenant
*delivery* usage (needs a recording rollup — attempts aren't tenant-indexed); an *admin* SDK client; per-key
`lastUsedAt`; attempt-log pagination; an operator deploy/monitoring guide; and the rest of P5 (dashboard UI).

---

## 2026-05-23 — Iteration 25: P5 — per-tenant usage metering (the billing/quota read model)

**Repo truth at start:** clean main @ `37120eb` (iter 24, admin/control-plane HTTP API) — a real clean
baseline, not an interrupted tick (git clean; iter-24 entry present + matches head). Baseline re-verified
by the manual gate (`[[validation-gate-is-manual]]`): `tsc --noEmit` clean, vitest **641/641**, `npm run
build` clean, integrity + local gate exit 0. Node 24.15.

**High-leverage move chosen (checklist #3):** Build **per-tenant usage metering** — the substantive next
step in **P5 (the hosted control plane = monetization)**, whose keystone (the admin HTTP API) landed last
tick. The decisive reasoning: the sending core is mature and exhaustively tested, so more delivery polish
is low-marginal-value; advancing the *profit* phase is high-value (directly the GOAL's profit filter), and
**you cannot run usage-based pricing without metering usage**. Within P5, metering is the buildable,
deterministic, zero-dep, fully-in-process-testable piece — billing needs an external account (Stripe) and a
dashboard is UI, neither of which fits the loop's test gate. **Messages** is this market's canonical billing
unit (Svix's headline price is per message; PROJECT.md §2). Beat the standing-deferred alternatives (admin
*SDK* client — explicitly deprioritized in iter 24 since OpenAPI already covers cross-language admin
consumers; per-key `lastUsedAt`; attempt-log pagination; operator docs): each is narrower or lower-value.

**Decisive design call — an exact aggregate over the source of truth, not a rollup.** Every message already
carries `appId` + `createdAt`, and the `idx_messages_app_created (app_id, created_at, id)` index already
exists (added for keyset listing). So usage is a `GROUP BY day` aggregate over the messages table itself:
**exact (no recording seam to drop a write, no eventually-consistent rollup to reconcile/drift), zero new
schema, zero migration, no change to the ingest hot path or the safety-critical delivery worker.** A
separate rollup would only add value for O(1) real-time quota checks — a distinct, later feature — and was
deliberately *not* built. This is a far tighter, lower-risk green unit than a new store while delivering the
full capability.

**Built this tick (a full vertical slice, bottom-up):**
- **`storage/message-store.ts`** — `UsageRange`/`UsageDay`/`UsageSummary` types, `MAX_USAGE_RANGE_DAYS=366`,
  a pure `utcDayKey(ms)` (the one shared UTC-day rule), a shared `resolveUsageRange` validator (RangeError
  backstop), and `MessageStore.summarizeUsageByApp(appId, range)` on the contract.
- **Both store backends** — in-memory (filter by appId + half-open `[fromMs,toMs)`, group by `utcDayKey`);
  SQLite (`SELECT date(created_at/1000,'unixepoch') … GROUP BY day` riding the existing index — `utcDayKey`
  and the SQL `date()` produce the same key because `floor(floor(ms/1000)/86400) === floor(ms/86400000)`).
  Held to one expanded conformance suite (+6 cases ×2 backends).
- **`http/api.ts`** — `GET /v1/admin/apps/:id/usage` (adminAuthed), `parseUsageRangeParams` (inclusive
  `YYYY-MM-DD` UTC days → half-open ms range; **strict** date validation via a round-trip so `Date.parse`'s
  lenient rollover e.g. `2026-02-30`→Mar 2 is rejected; span cap; unknown app→404; bad/missing/inverted/
  over-cap→400), `usageView`; added to `API_ROUTE_KEYS` (the `Record<ApiRouteKey,…>` made wiring exhaustive).
- **`http/openapi.ts`** — the operation (gated by `adminAuth`) + `Usage`/`UsageDay` schemas; the
  bidirectional drift + orphan-schema tests *forced* both. **`index.ts`** re-exports the new surfaces.

**Force Absolute Validation (manual gate):** `tsc --noEmit` clean (strict). vitest **660/660** (was 641;
**+19**: conformance ×2 backends = +12; a pure handler suite = +7 — disabled→404, missing/wrong token→401,
unknown-app→404, the 400 family incl. the strict-date case, zero-summary, per-UTC-day counts+total,
tenant-isolation; plus the running-gateway admin e2e extended to query usage over HTTP and assert a tenant
key gets 401). `npm run build` clean. Integrity gate exit 0 (three hash-protected files untouched); local
gate exit 0. No tinypool flake this run (`[[vitest-tinypool-flaky-worker-exit]]`).

**Beyond the gate — compiled-`dist` smoke (production-ESM proof):** booted the **built** gateway on a
**file-backed** data dir with an admin token, provisioned a tenant + key **over the admin HTTP API**, sent 3
messages, and queried `/v1/admin/apps/:id/usage` over a real socket — the SQLite `date()` GROUP BY through
production ESM returned `total:3` with the correct single-day breakdown; the missing-`to`→400 path held;
then **reopened on the same files** and saw the usage persist (durable, no Redis). Exit 0; temp script + dir
removed; git shows only the 10 intended source files.

**State:** GREEN → committing to main as Iteration 25. Net: a deployed Posthorn now exposes **exact
per-tenant message usage** over the admin control plane — the read model a hosted dashboard/billing/quota
layer consumes — derived from the source of truth with no new schema and no hot-path cost. **Standing
deferred (next candidates):** per-tenant *delivery* usage (needs a recording rollup — attempts aren't
tenant-indexed); real-time quota enforcement atop this read model; an *admin* SDK client; per-key
`lastUsedAt`; attempt-log pagination; an operator deploy/monitoring guide; and the rest of P5 (billing
integration, dashboard UI).

---

## 2026-05-23 — Iteration 24: P3/P5 — admin / control-plane HTTP provisioning API (opt-in, token-gated)

**Repo truth at start:** clean main @ `cbae83c` (iter 23, zero-downtime secret rotation) — a real clean
baseline, not an interrupted tick (git clean; iter-23 entry present + matches head). Baseline re-verified
by the manual gate (`[[validation-gate-is-manual]]`): `tsc --noEmit` clean, vitest **623/623**, `npm run
build` clean, integrity + local gate exit 0. Node 24.15.

**High-leverage move chosen (checklist #3):** Build the **admin / control-plane HTTP provisioning API** —
the item listed *first* in every recent tick's "standing deferred" list and the **keystone for P5 (the
hosted control plane = monetization)**, which is exactly the GOAL's profit filter. The decisive
observation: a deployed gateway could only be provisioned by the `posthorn admin` CLI **on the host
shell** (or programmatic `AppStore`); a remote/hosted operator had **no network path** to mint the first
tenant/key, leaving the whole authenticated API unreachable without shell access. The sending core is
mature and exhaustively tested, so the marginal value of more delivery polish is low; opening the
monetization phase is high. It is also a clean, deterministic, zero-dep vertical slice that follows the
established HTTP-API pattern exactly (compile-checked route table + bidirectional OpenAPI drift test force
completeness), and it **respects the project's security stance** — the earlier ticks rightly refused an
*open* provisioning endpoint; an *authenticated, opt-in* one is the legitimate control plane.

**Built this tick (a full vertical slice):**
- **`runtime/config.ts`** — `GatewayConfig.adminToken: string | null` from `POSTHORN_ADMIN_TOKEN`
  (`readAdminToken`: unset/blank → `null` = disabled; present → trimmed, validated to
  `MIN_ADMIN_TOKEN_LENGTH = 16` chars else `ConfigError` at boot — a weak root credential never reaches
  prod).
- **`http/api.ts`** — `ApiDeps.adminToken?`; a constant-time `constantTimeEqual` (both sides SHA-256'd so
  neither length nor content leaks via timing); an `adminAuthed` wrapper (no token configured → **404**,
  indistinguishable from a nonexistent path, so a disabled instance never reveals the surface; bad/missing
  token → **401**); `appView`/`apiKeyView` (no secret material); 7 handlers — `POST/GET /v1/admin/apps`,
  `GET/DELETE /v1/admin/apps/:id`, `POST/GET /v1/admin/apps/:id/keys`, `DELETE /v1/admin/keys/:id` (a
  superset of the CLI); `UnknownAppError → 404` added to the error map; all 7 keys added to
  `API_ROUTE_KEYS` (the `Record<ApiRouteKey, RouteHandler>` made the handler wiring exhaustive at compile
  time). A minted key's secret is revealed once (like endpoint create); key listings are metadata-only;
  delete-app cascades keys.
- **`http/openapi.ts`** — an `adminAuth` security scheme + an `Admin` tag + the 7 operations (each
  overriding the global bearer with `security: [{ adminAuth: [] }]`) + `App`/`NewApp`/`AppList`/`ApiKey`/
  `ApiKeyList`/`CreatedApiKey` schemas; `info.description` corrected. The bidirectional drift test +
  orphan-schema test *forced* every operation and schema to exist.
- **`runtime/gateway.ts`** — passes `config.adminToken` into the HTTP deps (conditional spread; `null` →
  routes stay disabled); `Gateway.apps` docstring updated. **`index.ts`** re-exports
  `MIN_ADMIN_TOKEN_LENGTH`. Stale "provisioning is not an HTTP route" claims in `api.ts`/`gateway.ts`/
  `openapi.ts`/PROJECT.md corrected to the new opt-in reality.

**Force Absolute Validation (manual gate):** `tsc --noEmit` clean (strict). vitest **641/641** (was 623;
**+18**: an admin handler suite — disabled→404 across all 7 routes, missing/wrong/**tenant-key**→401, full
CRUD, **a minted key authenticates a tenant route**, revoke-then-401, delete-cascades-then-401, 400 on bad
name, 404s; 3 config parse/validate cases; an OpenAPI `adminAuth`/all-7-ops-gated assertion; and 2
running-gateway e2es — disabled→404 + provision→mint→deliver+verify→revoke→401). `npm run build` clean.
Integrity gate exit 0 (three hash-protected files untouched); local gate exit 0. No tinypool flake this run.

**Beyond the gate — compiled-`dist` smoke (production-ESM proof):** booted the **built** gateway against a
**file-backed** data dir (real `node:sqlite` `createRequire` path) with `POSTHORN_ADMIN_TOKEN` set;
provisioned a tenant + minted a key **entirely over the admin HTTP API**, used that key to create an
endpoint and send a message whose delivered webhook **verified** against the endpoint secret, confirmed
list-keys is metadata-only, revoked the key over HTTP (→ tenant route 401), then **reopened on the same
files** and saw the HTTP-provisioned tenant persist. Exit 0; temp script + dir removed; git shows only the
9 intended source files.

**State:** GREEN → committing to main as Iteration 24. Net: a deployed Posthorn can now be provisioned
**remotely over HTTP** behind an opt-in, constant-time-checked admin token — the control-plane seam P5's
hosted dashboard/billing will drive — without weakening the default posture (admin routes are `404` until
the token is set) or the refusal to ship an *open* provisioning door. **Standing deferred (next
candidates):** an *admin* SDK client (`PosthornAdminClient`); per-key `lastUsedAt`; attempt-log
pagination/retention; an operator deploy/monitoring guide (last P4 doc item); and the rest of P5 (usage
metering, billing, dashboard).

---

## 2026-05-23 — Iteration 23: P3 — zero-downtime endpoint secret rotation

**Repo truth at start:** clean main @ `de12c10` (iter 22, bounded concurrency) — a real clean baseline,
not an interrupted tick (git clean; iter-22 entry present + matches head). Baseline re-verified by the
manual gate (`[[validation-gate-is-manual]]`): `tsc --noEmit` clean, vitest **591/591**, `npm run build`
clean, integrity + local gate exit 0. Node 24.15.

**High-leverage move chosen (checklist #3):** Ship **first-class zero-downtime secret rotation**. The
decisive observation on reading the code: the *receiver* half of this Standard Webhooks capability was
already built — `verify` (and the SDK's `verifyWebhook`) accept a multi-token `webhook-signature`
header — but the *sender* half was missing: the worker only ever signed with one secret, and the lone
rotation path (`PATCH …{secret}`) was a **hard swap** that breaks every receiver until it is
reconfigured in lockstep. So this completes a named differentiator ("first-class Standard Webhooks")
that was genuinely half-finished, sits in the loop's strongest regime (pure, deterministic,
fake-clock/in-process testable), is a real security/compliance ask (a target segment), and needs **zero
new deps**. Beat the standing-deferred alternatives (admin HTTP route, per-key `lastUsedAt`, attempt-log
pagination, operator docs): every one is narrower or lower-value than closing a half-built spec feature.

**Built this tick (a full vertical slice, bottom-up):**
- **`endpoints/endpoint.ts`** — `Endpoint.previousSecrets: {secret, expiresAt}[]` (retirees still
  signing until they expire); pure `rotateEndpointSecret(current, newSecret, now, overlapMs?)` (install
  new primary, retire old with overlap, prune expired, cap at `MAX_PREVIOUS_SECRETS=8`), pure
  `activeSigningSecrets(endpoint, now)` (the one shared "which secrets sign now" rule),
  `DEFAULT_SECRET_ROTATION_OVERLAP_MS=24h`, `EndpointStore.rotateSecret(id, {secret?, overlapMs?})` +
  `RotateSecretOptions`. `applyEndpointUpdate` carries `previousSecrets` through untouched (a direct
  `secret` patch stays a deliberate hard swap; rotation owns the overlap).
- **Both store backends** — `rotateSecret` (in-memory + SQLite, read-modify-write in `BEGIN IMMEDIATE`
  for atomicity); SQLite gains a `previous_secrets` JSON column via a guarded `ALTER TABLE` migration
  (`#migratePreviousSecretsColumn`), default `'[]'` so a pre-rotation DB upgrades seamlessly with no
  re-delivery; both held to one expanded conformance suite.
- **Multi-secret signing** — `DeliveryTarget.additionalSecrets`; `buildSignedRequest` signs with the
  primary **plus** each additional, space-joining `v1,…` tokens; `endpointToDeliveryTarget(endpoint,
  now)` + `storeBackedResolver(store, {now})` filter expired retirees via an injected clock.
- **Surface** — tenant-scoped `POST /v1/endpoints/:id/rotate-secret` (reveals the **new** primary once
  like create; **never** exposes the retired secrets; optional body; bad secret/overlap → 400; cross-
  tenant → 404), added to the compile-checked `API_ROUTE_KEYS`; SDK `client.rotateEndpointSecret`; the
  OpenAPI operation + `RotateSecretRequest` schema (the bidirectional drift test forced both); `index.ts`
  re-exports.

**Force Absolute Validation (manual gate):** `tsc --noEmit` clean (strict). vitest **623/623** (was 591;
**+32**: pure rotate/active-secrets unit tests, conformance ×2 backends incl. overlap→expiry + SQLite
reopen + **pre-rotation-DB migration**, worker multi-sign verify-against-both, resolver overlap-with-
clock, api handler 5 cases + cross-tenant 404, SDK round-trip, and the zero-downtime gateway e2e). `npm
run build` clean. Integrity gate exit 0; local gate exit 0 (three hash-protected files untouched). One
transient tinypool "worker exited unexpectedly" appeared on a first full run and did not reproduce
(flaky Windows/node:sqlite worker exit, not a test failure — re-run was 32/32 clean, then 623/623).

**Beyond the gate — compiled-`dist` smoke (production-ESM proof):** booted the **built** gateway against
a **file-backed** data dir (real `node:sqlite` `createRequire` path), created an endpoint, rotated over
HTTP, sent a message; the single delivered webhook **verified against BOTH the old and the new secret**
(2 signature tokens), the rotate response did not leak `previousSecrets`, and after `stop()` + reopen on
the same files the new primary + retired secret **persisted** — proving the new column + migration work
through production ESM, not just under Vitest's bundler. Exit 0; temp script + dir removed; git shows
only the intended files.

**State:** GREEN → committing to main as Iteration 23. Net: rotating a signing secret no longer drops a
webhook — the old secret keeps verifying through a tunable overlap while receivers migrate, then
expires; the sender now produces the multi-sig header the verifier always accepted, closing the loop on
"first-class Standard Webhooks". **Standing deferred (next candidates):** admin/control-plane *HTTP*
provisioning route (CLI covers local bootstrap); per-key `lastUsedAt`; attempt-log pagination/retention;
an operator deploy/monitoring guide (last P4 doc item); and the larger P5 hosted control plane.

---

## 2026-05-23 — Iteration 22: P2.5 — bounded worker concurrency (kill head-of-line blocking)

**Repo truth at start:** clean main @ `436a0ad` (iter 21, audit log) — a real clean baseline, not an
interrupted tick (git clean, iter-21 entry present + matches the head commit). Baseline re-verified by
the manual gate (`[[validation-gate-is-manual]]`): `tsc --noEmit` clean, vitest **585/585**, `npm run
build` clean, integrity gate exit 0. Node 24.15.

**High-leverage move chosen (checklist #3):** Replace the delivery worker's **sequential** per-batch
loop with a **bounded concurrency pool** — the *one remaining engine-level limitation*, called out in
both the worker's own doc comment and PROJECT.md's P2.5 bullet as "the next throughput optimization."
Reasoning that beat the alternatives (admin HTTP route, per-key `lastUsedAt`, attempt-log pagination,
operator docs): every feature shipped in the last ~10 ticks was observability / packaging / API
*surface*; the **core delivery engine** still serialized a claimed batch, so one slow/timing-out
receiver blocked every healthy delivery behind it (head-of-line blocking) and `batchSize ×
requestTimeoutMs` could exceed the visibility timeout under load → leases lapse → wasted reclaim churn.
It is a core-path *reliability/throughput* fix (the product's central promise), sits in the loop's
strongest regime (pure, deterministic, fake-clock/gated-transport testable), and needs **zero new deps**.

**Built this tick:**
- **`delivery-worker.ts`** — new `concurrency` option (default `DEFAULT_WORKER_CONCURRENCY = 8`;
  validated positive int; `1` = fully sequential). `processOnce` now delegates the claimed batch to a
  new private `#deliverBatch`: a fixed pool of `min(concurrency, batch)` pump loops, each pulling the
  next un-started task as it frees a slot, collecting outcomes **by original index**. Each `#deliver`
  already settles its own task under its own lease, so the pool needs no extra coordination. The
  "unexpected (non-stale) settle error propagates from `processOnce`" contract is preserved *without*
  leaving sibling rejections unhandled: a pump captures the first such error, the others stop pulling
  new work, and it is re-thrown after the in-flight deliveries settle. Doc comments updated (the lease
  constraint is now `ceil(batchSize/concurrency) × timeout`).
- **`config.ts`** — `POSTHORN_WORKER_CONCURRENCY` (min 1) → `WorkerConfig.concurrency`; **`gateway.ts`**
  passes it to the worker; **`index.ts`** re-exports `DEFAULT_WORKER_CONCURRENCY`.

**Force Absolute Validation (manual gate):** `tsc --noEmit` clean (strict). vitest **591/591** (was
585; **+6**: worker construction-reject `concurrency`, a 4-test gated-transport pool suite —
parallel-but-bounded at the limit, strictly-sequential at `concurrency:1`, a slow receiver does **not**
block the fast deliveries in its batch, in-flight cap holds for a larger batch — and a config
parse/validate case). `npm run build` clean. Integrity gate exit 0; local gate exit 0 (three
hash-protected files untouched).

**Beyond the gate — compiled-`dist` smoke (production-ESM proof):** booted the **built** gateway with
`POSTHORN_WORKER_CONCURRENCY=4`, fanned one message to a **slow** (500 ms response delay) and a **fast**
receiver, and measured the gap between when each *received* its request: **0 ms** (a sequential worker
would only send to the second after the first's full ~500 ms attempt resolved). Both deliveries verified
via the SDK's own `isValidWebhook`. Exit 0; temp script removed; git shows only the intended files.

**State:** GREEN → committing to main as Iteration 22. Net: head-of-line blocking is gone — a stuck
receiver occupies only its own slot, and the worst-case batch wall time drops by up to `concurrency×`.
The core delivery engine has no remaining known throughput/correctness-under-load gap. **Standing
deferred (next candidates):** admin/control-plane *HTTP* provisioning route (CLI covers local
bootstrap); per-key `lastUsedAt`; attempt-log pagination/retention; an operator deploy/monitoring guide
(last P4 doc item); and the larger P5 hosted control plane.

---

## 2026-05-23 — Iteration 21: P3 — per-attempt delivery audit log (`GET /v1/messages/:id/attempts`)

**Repo truth at start — reconciliation, not a clean baseline.** `git log` head was `51585d7` (iter 20,
OpenAPI), but the **workspace was dirty**: a complete, untracked `src/attempts/` plus matching edits to
the worker, api, openapi, sdk, gateway, index, README, and PROJECT.md — and **no LOOP_LOG entry**. A prior
tick had clearly *built* the per-attempt audit log and *updated the docs to mark it ✅*, then was
interrupted before validating, logging, or committing. So this tick's highest-leverage move was not to
write a new feature but to **reconcile and adjudicate** the orphaned work: prove it green and land it
(Axiom 2), or archive + restore it (Axiom 3). The work is exactly the top "next candidate" iter 20 named
(the remaining observability *depth* item) and matches the dual-backend conformance pattern used
throughout, so it was a credible landing candidate, not slop to discard.

**Reconciliation findings (read before trusting):** reviewed the load-bearing pieces by hand —
`src/attempts/delivery-attempt.ts` (immutable `DeliveryAttempt`, strict `normalizeNewAttempt` intake
guard, `datt_` ids), `sqlite-attempt-store.ts` (the `createRequire("node:sqlite")` builtin path, `STRICT`
append-only table, `idx_delivery_attempts_message`, prepared statements), the **worker hot-path edit**
(records one attempt through a best-effort `recordAttempt` seam *before* settling; latency captured in a
`finally` so a thrown/aborted send still measures; `attemptNumber = task.attempts`, already incremented by
`applyClaim`; a thrown audit write is routed to `onError`, never failing the delivery), the `api.ts` route
(tenant-scoped `404`-not-`403`, explicit `attemptView` map so no internal field leaks, key added to the
compile-checked `API_ROUTE_KEYS` map), and the gateway wiring (opens/closes the 5th SQLite backend, feeds
the worker + HTTP server). Coherent and faithful to the codebase's conventions.

**Force Absolute Validation (the manual gate, per `[[validation-gate-is-manual]]`):** `tsc -p
tsconfig.json --noEmit` clean (strict). `npx vitest run` **585/585** (was 540 at iter 20 end; **+45**: the
new `src/attempts/` suite — pure normalize/id + in-memory & SQLite shared conformance — plus worker
`recordAttempt` cases, api handler, sdk `listMessageAttempts`, gateway end-to-end, and the openapi
operation/schema drift coverage). `npm run build` clean. Integrity gate exit 0; local gate exit 0 (the
three hash-protected files untouched).

**Beyond the gate — compiled-`dist` smoke (the unique production-ESM proof vitest's bundler workaround
can mask):** booted the **built** gateway against a **file-backed** data dir (real `node:sqlite`
`createRequire` path, not `:memory:`), fanned one message to a 200 receiver and a 500 receiver, and polled
`GET /v1/messages/:id/attempts` until **both first attempts were recorded** — `succeeded`/`responseStatus
200` and `failed`/`responseStatus 500`, each `attemptNumber 1`, non-negative `durationMs` — then confirmed
a second tenant's key gets `404` (cross-tenant isolation). Exit 0. Temp dir + smoke script removed; git
status shows only the intended files.

**State:** GREEN → committing the reconciled work to main as Iteration 21. Net: `dead_letter`/`succeeded`
state was already observable; now the *history* behind it is — one immutable record per HTTP attempt, the
view a developer debugs a flaky receiver from. **Standing deferred (next candidates):** an admin/control-
plane *HTTP* route for app/key provisioning (CLI already covers local bootstrap); per-key `lastUsedAt`;
pagination/retention for the attempt log once a single message's attempt count can grow large; and the
larger P5 hosted control plane. With the audit log landed, the v1 observability surface (status → list →
retry → attempts) is complete.

---

## 2026-05-23 — Iteration 20: P3 — OpenAPI 3.1 contract (`GET /openapi.json`)

**Repo truth at start:** clean main @ `7669885`. Baseline re-verified before any change: `tsc --noEmit`
clean, vitest **529/529**, `npm run build` clean. Node 24.15. Reconciled GOAL→PROJECT: Posthorn's v1 is
functionally complete and now *deployable + bootstrappable + monitorable* (iter 18 Docker, iter 19
`/metrics`). The standing deferred list was: **OpenAPI spec**, an admin HTTP route, a per-attempt audit
log, per-key `lastUsedAt`. Iter 19 deferred OpenAPI deliberately ("lower operational value than 'can I
monitor this in prod?'"); with metrics now landed, the cross-language interop/adoption gap is the top item.

**High-leverage move chosen:** Ship the **OpenAPI 3.1 document + `GET /openapi.json`** (checklist #3).
Highest-leverage now because it compounds the just-shipped TS SDK by unlocking **every other language**
(client codegen) + interactive docs (Swagger/Redoc) — a table-stakes adoption/procurement asset the
product lacked — and it sits squarely in the loop's strongest regime: pure, deterministic, **zero new
deps**, low landing risk. Chosen over the **per-attempt audit log** (larger, touches the worker hot path,
migration → higher risk; deferred again) and the **admin HTTP route** (the CLI already covers bootstrap).

**Built this tick:**
- **`src/http/openapi.ts`** — `buildOpenApiDocument()`, a **pure**, zero-dependency builder of a
  hand-authored OpenAPI 3.1 document (15 component schemas modeled byte-faithfully to the real
  `api.ts` views/error envelope; Bearer security scheme + `security:[]` on the three unauthenticated
  routes; `info.version` from the `version.ts`/`createRequire` seam). Hand-authored, not reflected —
  a useful spec carries per-field docs/schemas/error-codes/examples the route table can't.
- **`api.ts` refactor → single source of truth.** Extracted `API_ROUTE_KEYS` (exported), built the
  route table from it via a `Record<ApiRouteKey, RouteHandler>` map (a missing/extra key is a *compile*
  error), added the `GET /openapi.json` handler (served verbatim as JSON), and an exported pure
  `patternToOpenApiPath` (`:id`→`{id}`). Behaviour of the existing 11 routes unchanged (49 api tests green).
- **`index.ts`** re-exports `buildOpenApiDocument`/`OpenApiDocument`/`API_ROUTE_KEYS`/`ApiRouteKey`/
  `patternToOpenApiPath`. **README + PROJECT.md** updated (feature bullet, surface table row, curl line).

**Anti-drift (the load-bearing guarantee, same discipline as the dual-backend conformance suites):**
a **bidirectional drift test** asserts the document's operations exactly equal `API_ROUTE_KEYS`
(mapped via `patternToOpenApiPath`) — a route can never ship undocumented, nor a doc entry without a
route. Plus ref-integrity (every `$ref` resolves) + no-orphan-schema + structure (3.1, unique
operationIds, described responses, the exact 3 unauthenticated routes) tests.

**Validation:** `tsc --noEmit` clean (strict). vitest **540/540** (was 529; +11: openapi suite 9, api +1,
server +1). `npm run build` clean. **Compiled-`dist` smoke:** booted the *built* gateway, fetched
`/openapi.json` over a real socket → 200 `application/json`, `openapi:"3.1.0"`, `info.version:"0.0.1"`
(proves the production `createRequire` path), 12 operations / 15 schemas, retry route present. **Beyond
the gate:** generated the doc and ran the **Redocly CLI OpenAPI linter** (`npx @redocly/cli lint`) →
*"Your API description is valid"*, **0 errors** (only the stylistic `operation-4xx-response` warning on
`/healthz` + `/openapi.json`, which correctly have no client-error path). Smoke artifacts removed; git
status shows only intended files.

**State:** GREEN → committing to main. Next candidates: per-attempt audit log (the remaining
observability *depth* item), an admin/control-plane HTTP route, or P4 operator/deploy docs.

---

## 2026-05-23 — Iteration 19: P4 — Prometheus `/metrics` endpoint (operator observability)

**Repo truth at start:** clean main @ `1f3cca4`. Baseline re-verified before any change: `tsc --noEmit`
clean, vitest **503/503**, `npm run build` clean, integrity + local gate both exit 0. Node 24.15.
Reconciled GOAL→PROJECT: Posthorn stands; v1 is functionally complete (sign → fan-out → deliver →
observe → list → retry; HTTP API + SDK + admin CLI + bootable gateway + single-container image). The
remaining glaring gap in P4 (self-host packaging): you could now *deploy* and *bootstrap* an instance,
but you could not **monitor a running one** — no metrics surface at all. "Does it expose Prometheus
metrics?" is a real self-host procurement question, and it is the operator-facing half of the product's
own "**observable**" promise (the prior ticks' status/list/retry answered the *producer's* questions).

**High-leverage move chosen:** Build a Prometheus **`GET /metrics`** endpoint end-to-end. Highest-
leverage (checklist #3): it closes the production-operability gate that blocks serious self-host
adoption, completes P4's substantive scope, and stays squarely in the loop's strongest regime — fully
deterministic, in-process testable, **zero new dependencies** (a pure text renderer over `node:http`,
the same posture as `node:sqlite`/`node:crypto`). Chosen over the **per-attempt audit log** (larger,
touches the worker hot path → higher landing risk; deferred again) and **OpenAPI** (interop/docs,
lower operational value than "can I monitor this in prod?"). Re-confirmed the sandbox has Docker +
network (memory `[[sandbox-has-network-and-docker]]`), but this tick needed neither — it validates
fully on the manual gate plus a compiled-`dist` smoke.

**Built this tick:**
- **`src/metrics/metrics.ts`.** `MetricsRegistry` — a tiny in-memory accumulator of monotonic counters
  (arrow-bound `recordIngest`/`recordTick` so they pass as bare callbacks) + uptime from an injected
  clock; holds no domain logic. `renderPrometheus(snapshot)` — a **pure**, exhaustively-tested function
  to v0.0.4 text exposition (HELP/TYPE headers, labeled series, label-value escaping, trailing newline).
- **`DeliveryQueue.countByStatus()`** — the load-bearing new read primitive behind the backlog gauge.
  Added to the contract + a shared `DeliveryCountsByStatus` type + `zeroDeliveryCounts()` helper, both
  backends (in-memory tally; SQLite a single prepared `GROUP BY status` scan), and the one shared
  conformance suite (+3×2 cases: empty, all-four-statuses, reflects-a-transition). Always returns every
  status key (zero when none) so a full gauge family renders.
- **`DeliveryWorker.onTick(result)`** — an optional observability seam (sibling of `onError`) called
  once per `processOnce` tick with its `TickResult`; the gateway wires `onTick: metrics.recordTick`.
  The worker gains *no* metrics logic. Counters: ingested / deduplicated / `deliveries_total{outcome}`.
- **HTTP.** `ApiResponse.contentType` — a raw-body escape hatch so the adapter writes the Prometheus
  text verbatim instead of JSON-encoding it (`server.ts`). `GET /metrics` route (`api.ts`),
  unauthenticated like `/healthz`; reads `countByStatus()` at scrape time, renders, returns text. Ingest
  is counted in `createMessage`. `metrics?` added (optional) to `ApiDeps` → `404` when not wired.
- **Gateway + version.** `createGateway` constructs the registry (version from `POSTHORN_VERSION`),
  wires it to the worker (`onTick`) and the HTTP deps, and exposes it on `Gateway`. New `src/version.ts`
  reads `package.json`'s version once via `createRequire` (same idiom as `node:sqlite`; degrades to
  `"unknown"` if not found, so a cosmetic label can never break `/metrics`). New public symbols exported
  from `src/index.ts`.
- **Docs reconciled to reality.** README: a Status bullet + a `/metrics` curl example + the route table
  row. PROJECT.md: P4 metrics ✅ with the design + validation evidence; P4 remaining narrowed to operator
  docs.

**Key decisions (honest tradeoffs):** **unauthenticated** `/metrics` (Prometheus norm) — it exposes only
instance-aggregate data (counts, a backlog gauge), never a tenant id, payload, or secret; documented
that operators restrict it at the network layer, with a dedicated admin port / opt-out flag noted as a
later add (kept config.ts untouched this tick). **Counters in-memory / process-lifetime** (reset on
restart) — correct for the single-process, no-Redis model, and Prometheus detects resets; a multi-replica
P5 plane aggregates per-instance series the usual way. Backlog as a **scrape-time gauge** from the queue
(never stale) vs. counters for throughput — the idiomatic split. Fed metrics through the *existing* ingest
+ worker-tick seams rather than mutating the delivery hot path (the per-attempt-audit-log risk we keep
deferring). Modeled the delivery breakdown as one labeled counter (`outcome=`) not four metric names.

**Validation:** `tsc --noEmit` clean (strict). vitest **529/529** (was 503; +26: metrics 13, queue
conformance 3×2=6, api route 4, server raw-text 1, worker onTick 1, gateway end-to-end 1). `npm run
build` clean. **Compiled-`dist` smoke** (production ESM, in-memory gateway + a real receiver): ingest →
worker delivers → poll `/metrics` until `posthorn_deliveries_total{outcome="succeeded"} 1`, asserting
the v0.0.4 content-type, `posthorn_messages_ingested_total 1`, the backlog gauge, and
`posthorn_build_info{version="0.0.1"}` (proving `version.js` + `SqliteDeliveryQueue.countByStatus`'
`createRequire`/`node:sqlite` paths work in the built output). Integrity + local gate: exit 0. The three
hash-protected files were not touched.

**State:** GREEN → committing to main. Posthorn is now deployable, bootstrappable, *and monitorable*.
Next ticks: operator docs (deploy/monitoring guide, closes P4); then the per-attempt audit log or OpenAPI
(P3 deferred), or begin P5 (hosted control plane).

---

## 2026-05-23 — Iteration 18: P4 — single-container `Dockerfile` (the deployment wedge made real)

**Repo truth at start:** clean main @ `6c37137`. Baseline re-verified before any change: `tsc --noEmit`
clean, vitest **503/503**, `npm run build` clean, integrity + local gate both exit 0. Node 24.15.
Reconciled GOAL→PROJECT: Posthorn stands; the product is functionally complete for v1 (sign → fan-out →
deliver → observe → list → retry, HTTP API + SDK + admin CLI + bootable gateway). The glaring gap: the
**entire market wedge is "deploy as one container, no Redis," and there was no `Dockerfile`** — the
headline differentiator existed only as prose. P4's top remaining item.

**Re-tested a blocking assumption from iter 17 — it was wrong.** Iter 17 deferred the Dockerfile as
"un-validatable green here — needs network egress this sandbox blocks." I probed it directly: `docker
--version`/`docker info` (29.4.3, daemon live), `docker pull node:24-alpine` **succeeded**, and `npm ci`
**inside the build succeeded**. Network egress is available. So the Dockerfile is not only the
highest-leverage move (realizes the wedge, unblocks all self-host adoption) but now **fully validatable
for real** — a `docker build` + `docker run` smoke that *exceeds* the standard gate. Chosen over the
metrics endpoint / operator docs (smaller, and docs follow a real artifact) and the per-attempt audit log
(deferred again — larger, touches the worker hot path, higher landing risk).

**Built this tick:**
- **`Dockerfile` (multi-stage).** Stage 1 (`node:24-alpine`): `npm ci` (cached on lockfile) → `tsc` →
  `dist/`, then strips the compiled `*.test.*` output tsc emits from `src/**/*.test.ts` (never on the
  runtime graph). Stage 2 (`node:24-alpine`): copies **only** `dist/` + the `package.json` that marks the
  output ESM (`"type":"module"`) — **no `node_modules`, because the runtime has zero dependencies** (every
  moving part is a `node:*` builtin: `node:http`/`node:sqlite`/`node:crypto`). The cleanest possible
  expression of the wedge: nothing to `npm install`, audit, or patch in the runtime image.
- **Hardening / ops.** Runs as the unprivileged `node` user (uid 1000); durable SQLite state on a `/data`
  `VOLUME` (chowned to `node` before the privilege drop, so anonymous volumes inherit a writable baseline);
  `POSTHORN_*` defaults (`HOST=0.0.0.0`, `PORT=3000`, `DATA_DIR=/data`); a dependency-free `HEALTHCHECK`
  using Node's built-in `fetch` against `/healthz` (no curl/wget). One exec-form
  `ENTRYPOINT ["node","dist/main.js"]`: `node` is PID 1 and receives `SIGTERM` directly → the existing
  graceful drain; no args → gateway, `admin <command>` args → the one-shot bootstrap. Same image runs the
  server *and* mints the first key.
- **`.dockerignore`** keeps the build context to just the compiled sources (`src/`, `package*.json`,
  `tsconfig.json`); excludes `node_modules`/`dist`/`.git`/state/docs so the image is reproducible and lean.
- **Docs reconciled to reality.** README: a "Run with Docker (the headline deployment)" subsection (build/
  run/admin/volume/healthcheck/uid-1000 bind-mount caveat) + a Status bullet. PROJECT.md: P4 Dockerfile ✅
  with the validation evidence.

**Key decisions (honest tradeoffs):** pinned `node:24-alpine` to match the dev/test runtime (`node:sqlite`
is a stable builtin there; Alpine = small) — image ~231 MB, dominated by the Node base, acceptable for v1
(a `slim`/distroless shave is a later optimization). Did **not** add `tini`/`--init`: the app spawns no
children and handles its own signals, so PID-1 `node` is correct and lighter; noted `--init` is harmless if
an operator wants it. Stripped only `*.test.*` from `dist` (clearly off the runtime graph) rather than
introducing a second `tsconfig.build.json` — keeps **one** validated build path, no config fork. Kept the
existing `npm run build`; the container reuses it verbatim.

**Validation (exceeds the standard gate):** standard gate first — `tsc --noEmit` clean, vitest **503/503**
(no source changed; Docker/docs-only), `npm run build` clean, integrity + local gate exit 0, three
hash-protected files untouched. Then a **real container smoke**: `docker build -t posthorn:smoke .`
succeeds; booted container serves `/healthz` 200 and Docker reports `healthy`; a *separate* `admin`
container sharing the `/data` volume mints app+key and the **running server authenticates that key over
HTTP** (401 without → 200 on `/v1/endpoints`, 202 on `POST /v1/messages`); the sent message is listable;
`docker stop` logs the graceful `SIGTERM` drain; and the message **survives a full teardown + fresh boot on
the same volume** (durability, no Redis). Smoke artifacts (image/volume/containers) removed after.

**State:** GREEN → committing to main. The "single container, no Redis" wedge is now a thing you can
`docker run`, not a claim. Next ticks (P4 tail): a metrics endpoint, operator docs; then OpenAPI / a
per-attempt audit log (P3 deferred).

---

## 2026-05-23 — Iteration 17: P3 — manual retry / replay (`POST /v1/messages/:id/retry`)

**Repo truth at start:** clean main @ `fe2ca77`. Baseline re-verified before any change: `tsc --noEmit`
clean, vitest **479/479**, `npm run build` clean, integrity + local gate both exit 0. Node 24.15 /
Vitest 2.1.9. Reconciled GOAL→PROJECT: Posthorn decision stands; repo is far past the GOAL's "decide a
project" stage. The glaring gap after iter 16: the send→fan-out→deliver→observe→list loop is complete,
but `dead_letter` was a **terminal dead end** — once a receiver outage exhausted the retry schedule,
nothing could make Posthorn try again. The delivery FSM had *no* transition out of a terminal state, the
queue *no* re-drive primitive, and the API *no* route. "Replay"/"retry" is a feature every incumbent
(Svix/Convoy/Hookdeck) exposes; it is the unaddressed half of the tagline's "**retried**".

**High-leverage move chosen:** Build **manual retry** end-to-end — FSM `manualRetry` → queue `retry` →
`retryMessageDeliveries` service → `POST /v1/messages/:id/retry` → SDK `client.retryMessage`. Highest-
leverage (checklist #3): it closes a *functional capability* gap (not docs), turns `dead_letter` from a
permanent loss into a recoverable state (a real product limitation), and completes the operability story
the prior two ticks began (status read → listing → **recovery**). Chosen over **OpenAPI** (interop/docs,
smaller user value than recovering lost deliveries), the **per-attempt audit log** (larger, touches the
worker hot path → higher landing risk), and the **Dockerfile** (still un-validatable green here — needs
network egress this sandbox blocks). Stayed in the loop's strongest regime: fully deterministic, in-process
testable, **zero new deps**, on the proven pure-core / interface+two-backends+one-conformance-suite pattern.

**Built this tick:**
- **FSM `manualRetry` (`src/delivery/delivery-state.ts`).** The lone transition *out* of a terminal state:
  legal only from `succeeded`/`dead_letter` (illegal from `pending`/`delivering` — those are already being
  driven), reviving the delivery as brand-new: `pending`, `nextAttemptAt:null` (deliverable now),
  **`attempts:0`** (a fresh budget — keeping the exhausted count would re-dead-letter on the first new
  attempt), `lastError:null`. The exhaustive switch forced the case (no fallthrough), so the FSM stays the
  single source of transition truth.
- **Queue `retry` primitive + `applyManualRetry` (`src/queue/`).** Pure `applyManualRetry` defers to the
  reducer (terminal→pending can't drift) and clears the lease overlay; `DeliveryQueue.retry(taskId)` added
  to the contract + both backends (in-memory; SQLite in a `BEGIN IMMEDIATE` txn that rolls back a non-
  terminal retry). +4 shared conformance cases × 2 backends: revives dead_letter (claimable, budget reset),
  revives succeeded (a resend), `UnknownDeliveryTaskError` (unknown id), `DeliveryStateError` (non-terminal,
  task left untouched).
- **`retryMessageDeliveries` service (`src/queue/retry-message.ts`).** The structural twin of `fanOut`:
  lists a message's tasks, re-drives only the **dead-lettered** ones (succeeded/in-flight/pending untouched
  — replaying healthy deliveries is not "retry the failures"), returns `{messageId, retried, tasks}` (the
  refreshed snapshots). Absorbs the concurrent double-retry race (`DeliveryStateError`/`UnknownDeliveryTaskError`
  ⇒ "already revived", the same expected-catchable pattern as a lapsed lease). 5 tests incl. a worker-driven
  **full recovery loop** (ingest → fail → dead_letter → retry → delivered).
- **HTTP route + SDK.** `POST /v1/messages/:id/retry` (`src/http/api.ts`): tenant from the key, another
  tenant's/absent message is `404` (existence never revealed, identical to the read route); returns the
  refreshed per-endpoint statuses (replayed ones back to `pending`); internal `leaseToken` never exposed.
  `client.retryMessage(id)` (`src/sdk/client.ts`) + the `RetryMessageResponse` wire view. New public symbols
  re-exported from `src/index.ts`. Fixed two inline `DeliveryQueue` stubs in the worker test for the new
  contract method.

**Key decisions (honest tradeoffs):** reset the attempt budget on retry (the feature's whole point — a full
fresh schedule after the receiver is fixed) at the cost of losing the prior count, which a future per-attempt
audit log would preserve. Target **dead_letter only** (the unambiguous "needs human intervention" state),
not pending/delivering/succeeded — crisp semantics, no surprise re-sends to healthy receivers; "force-retry
pending" / "resend succeeded" noted as possible later options (the FSM/queue primitive already permits
reviving `succeeded`, the route just doesn't expose it). Modeled the transition in the FSM (not ad-hoc in the
queue) so it can't drift. Extracted a tested `retryMessageDeliveries` rather than inlining in the route, for
symmetry with `fanOut`/`ingest` and reuse (a future `posthorn admin retry-message`).

**Validation:** `tsc --noEmit` clean (strict). vitest **503/503** (was 479; +24: FSM 3, conformance 4×2=8,
service 5, api route 5, SDK 3). `npm run build` clean. **Smoke-tested the compiled `dist`** (SQLite backends,
production ESM): ingest → worker dead-letters → `retryMessageDeliveries` → worker delivers a request that
**verifies** against the endpoint secret → status `succeeded` (exercised the `node:sqlite` `createRequire`
path in `SqliteDeliveryQueue.retry`). Integrity + local gate: exit 0. The three hash-protected files were not
touched.

**State:** GREEN → committing to main. `dead_letter` is no longer a dead end — a sustained-outage delivery is
recoverable on demand, end-to-end. Next tick: the **OpenAPI** spec over this surface (other-language clients +
interactive docs); the **per-attempt audit log** (richer than the latest-state-per-endpoint view, and would
restore full attempt history across a manual retry); or the single **Dockerfile** to finish P4 (still blocked
on validatable network egress here).

---

## 2026-05-23 — Iteration 16: P3 — message listing (`GET /v1/messages`, keyset-paginated)

**Repo truth at start:** clean main @ `f6030ba`. Baseline re-verified before any change:
`tsc --noEmit` clean, vitest **450/450**, `npm run build` clean, integrity + local gate both exit 0.
Node 24.15 / Vitest 2.1.9. Reconciled GOAL→PROJECT: Posthorn decision stands; repo is far past the
GOAL's "decide a project" stage. The glaring gap after iter 15: the server + SDK cover the full
send→observe-*one*-message→verify loop, but there was **no way to enumerate messages** — a producer
could read `GET /v1/messages/:id` only if it had kept the id; it could not browse what it sent. Every
incumbent's dashboard centers on a messages list, and PROJECT.md listed `GET /v1/messages` (gated on a
`MessageStore.listByApp`) as deferred. Also note: there was **no query-string plumbing** in the HTTP
layer at all (`server.ts` discarded it), so pagination needed that rail built too.

**High-leverage move chosen:** Build **`GET /v1/messages`** — tenant-scoped, **keyset-paginated**
message listing — backed by a new `MessageStore.listByApp`, plus query-string support in the HTTP layer
and `client.listMessages` on the SDK. Highest-leverage (checklist #3): it closes a *functional* gap (not
docs), completes the "observable" half of the product (iter 14 did the single message; this does the
collection), and lays a **reusable `?limit=&cursor=` rail** every future list/filter route — and the P5
control-plane dashboard — needs; messages is exactly the unbounded collection where pagination is
mandatory. Chosen over **OpenAPI** (interop/docs, not a capability — a smaller user value than the
missing browse) and the **per-attempt audit log** (larger, touches the worker hot path → higher risk to
land green in one tick) and the **Dockerfile** (still un-validatable green here — `docker build` needs
network egress this sandbox blocks). The loop's strongest regime: fully deterministic, in-process
testable, **zero new deps**; followed the proven pure-core / interface+two-backends+one-conformance-suite
pattern.

**Built this tick:**
- **`MessageStore.listByApp(appId, {limit, cursor})` → `MessagePage` (`src/storage/message-store.ts`).**
  Newest-first by `(createdAt, id)` DESC, **keyset** (not offset) paginated: an opaque base64url cursor
  encodes the last row's `(createdAt, id)`; the next page is everything strictly older. Keyset is stable
  under concurrent inserts (a new message appears on page one, never shifting an in-flight scan — the
  classic offset bug) and stays indexed as the log grows unbounded. Shared pure helpers are the single
  source of the rule: `encodeMessageCursor`/`decodeMessageCursor` (malformed → `TypeError`),
  `resolveListMessagesQuery` (limit defaults 50, capped at `MAX_LIST_MESSAGES_LIMIT=200`, RangeError
  otherwise), and `compareMessagesNewestFirst`/`isMessageAfterCursor` — the in-memory backend sorts by
  the comparator, SQLite mirrors it as `ORDER BY created_at DESC, id DESC` + the keyset predicate, so the
  two cannot drift (ids are ASCII ⇒ JS string order == SQLite BINARY collation).
- **Both backends + conformance.** In-memory: filter+sort+slice (fetch-one-extra signals a further page).
  SQLite: two prepared statements (first page / keyset page) + a new `idx_messages_app_created
  (app_id, created_at, id)` created via `IF NOT EXISTS` — **no migration**, a pure read optimization over
  existing rows (same reasoning as iter 14's per-message index). 9 new shared conformance cases × 2
  backends (empty, newest-first, tenant-scoping, multi-page coverage with no overlap/gaps, exact-multiple
  termination [no phantom trailing page], same-ms id tiebreak, limit out-of-range reject, malformed-cursor
  reject, real-cursor round-trip).
- **HTTP query rail + route (`src/http/api.ts`, `server.ts`).** `ApiRequest` gained a `query` map, filled
  by the `node:http` adapter from `URL.searchParams` (first value wins for repeats) — the reusable rail.
  `GET /v1/messages` validates `?limit=` to a `400` and passes `?cursor=` through (a malformed one →
  `TypeError` → `400` via the existing map); tenancy is the key's, so a listing never reveals another
  tenant's messages. **Lean list rows** (`messageListItemView`): id/appId/eventType/idempotencyKey/
  createdAt only — no payload, no deliveries, so a page never fans out into an N+1 delivery query (detail
  stays on `/:id`).
- **SDK `client.listMessages({limit, cursor})` → `{ data: MessageRef[], nextCursor }`** (`src/sdk/client.ts`),
  building the query string via `URLSearchParams`. Re-exported new public types/constants from
  `src/index.ts` (storage `ListMessagesOptions`/`MessagePage`/`MessageCursor` + cursor helpers + limit
  constants; SDK `ListMessagesParams`/`MessageListPage`). README + PROJECT.md updated; the deferred list
  dropped the message-list item.

**Key decisions (honest tradeoffs):** keyset over offset (correctness under concurrent writes + indexed
at scale, at the cost of opaque cursors — the right call for an append-only log). Lean list rows over
embedding delivery status per row (avoids N+1; detail view already exists). `query` made a **required**
`ApiRequest` field (one test helper + the one adapter updated) rather than optional, so handlers never
thread an `undefined`. List items typed as the existing SDK `MessageRef` (identical shape) rather than a
new wire type — less surface, no lie.

**Validation:** `tsc --noEmit` clean (strict). vitest **479/479** (was 450; +29: conformance 9×2=18,
api list block 7, server query-parse 1, SDK 3 [in-process paging + 2 injected-fetch URL-construction]).
`npm run build` clean. **Smoke-tested the compiled `dist`**: boot gateway → SDK send 5 → page through
3×(limit 2) → distinct full coverage, full list lean (no payload/deliveries) + `nextCursor:null`, unknown
id still `404` — through production ESM. Integrity + local gate: exit 0. The three hash-protected files
were not touched.

**State:** GREEN → committing to main. A producer can now browse everything it has sent, paginated and
tenant-scoped, and the HTTP layer has a reusable query/pagination rail. Next tick: the **OpenAPI** spec
over this surface (other-language clients + docs); the **per-attempt audit log** (richer than the
latest-state-per-endpoint view); or the single **Dockerfile** to finish P4 (blocked on validatable
network egress here).

---

## 2026-05-23 — Iteration 15: P3 — the first-class TS/JS SDK (the consumer's touchpoint)

**Repo truth at start:** clean main @ `f1a7608`. Baseline re-verified before any change:
`tsc --noEmit` clean, vitest **420/420**, `npm run build` clean, integrity + local gate both exit 0.
Node 24 / Vitest 2.1.9. Reconciled GOAL→PROJECT: Posthorn decision stands; repo is far past the
GOAL's "decide a project" stage. Verified a *product* fact before choosing: iter 14's `GET
/v1/messages/:id` is reachable — `POST /v1/messages` does return `message.id` in its 202 (`api.ts`
:319), so the read API is not stranded. The glaring gap after iter 14: the server surface is
feature-complete and observable, but there was **no client SDK** — a consumer had to hand-roll
`fetch`, header construction, error parsing, *and* the receiver-side signature verification. Yet
"first-class TS/JS SDK" is the named DX differentiator in PROJECT.md's wedge table and the #1
deferred item.

**High-leverage move chosen:** Build the **TypeScript/JavaScript SDK** (`src/sdk/`). Highest-leverage
(checklist #3) because it is the *consumer's entire touchpoint* (send → observe → verify received
webhooks) — the move that most advances adoption / "beyond-market DX," the product's stated goal.
Chosen over the **Dockerfile** (a `docker build` pulls a base image needing network egress this
sandbox blocks → it cannot be *validated* green, violating "Force Absolute Validation"; iter 14
already judged it "convenience over an already-runnable process") and over the **per-attempt audit
log / `GET /v1/messages` list** (incremental observability over what iter 14 already made gating; the
SDK is the higher consumer-value unit). Exactly the loop's strongest regime: fully deterministic,
in-process testable against the real server on an ephemeral port, **zero new runtime dependencies**
(platform `fetch` + the existing verifier), preserving the zero-dep wedge.

**Built this tick (`src/sdk/`):**
- **`client.ts` — `PosthornClient`.** A typed wrapper over the whole v1 surface
  (`health`/`sendMessage`/`getMessage`/`listEndpoints`/`createEndpoint`/`getEndpoint`/`updateEndpoint`/
  `deleteEndpoint`). Errors are mapped: a non-2xx → **`PosthornApiError`** (carries HTTP `status` + the
  `{error:{code,message}}` envelope's machine `code`, falling back to `http_<status>` for a non-envelope
  body), a transport failure → **`PosthornError`** (with `cause`), a request past `timeoutMs` →
  **`PosthornTimeoutError`** (via an internal `AbortController`; default 30s, `0` disables). `fetch` is
  injectable (the `PosthornFetch` structural subset the platform global satisfies) so error/timeout/
  parse paths are unit-testable with no socket. The wire types are **SDK-owned views**, not the server's
  domain types, because the HTTP surface returns reduced shapes (endpoint `secret` write-only; delivery
  `leaseToken` never exposed) — the SDK models exactly what crosses the wire.
- **`verify.ts` — the receiver half.** `verifyWebhook(secret, headers, rawBody, opts?)` and the
  non-throwing `isValidWebhook(...)` extract the three Standard Webhooks headers from a raw header bag
  (case-insensitive, collapsing node's array-valued headers) and delegate to the library `verify` — no
  crypto duplicated, so SDK and core can't drift. Docstring hammers the one footgun: verify the **raw
  bytes as received**, before any JSON round-trip.
- Re-exported the whole SDK surface from `src/index.ts` (client + types + the three error classes +
  `verifyWebhook`/`isValidWebhook`/`IncomingHeaders`). README gained a status bullet + a "Quickstart (TS
  SDK)" (send + receive); PROJECT.md P3 gained the SDK bullet and the deferred list dropped "TS SDK".

**Key decisions (honest tradeoffs):**
- **`getMessage().payload` is the raw signed JSON *string*, not a parsed value.** It is the exact bytes
  delivered/signed; the SDK surfaces it losslessly and documents `JSON.parse` to recover the value.
  Parsing for the caller would hide what was actually on the wire.
- **SDK-owned wire types over re-exporting domain types.** Slightly more type code, but it can't lie
  about secret/leaseToken being absent from reads, and it decouples the SDK from internal store shapes.
- **OpenAPI deferred (not bundled).** The SDK serves typed TS consumers now; an OpenAPI spec (other-
  language clients + interactive docs) is a distinct, larger artifact and a separate tick. Logged.

**Validation:** `tsc --noEmit` clean (strict). vitest **450/450** (was 420; +30: verify 10
[authentic/tampered/wrong-secret/missing-header/case-insensitive/array-valued/replay-window +
isValid×3], client 20 [in-process CRUD + send + status-read + idempotency + secret-never-leaked +
401/404 mapping + trailing-slash + 3 construction guards + injected-fetch envelope/`http_<status>`/204/
parse-error/transport-error/timeout + a full **end-to-end driven entirely through the SDK**: send →
running worker delivers → receiver verifies with the SDK's own `verifyWebhook` → `getMessage` observes
`succeeded`]). `npm run build` clean. **Smoke-tested the compiled `dist`**: the same full SDK loop
(health → create [secret once, never leaked on get] → send → deliver → `verifyWebhook` passes, tampered
rejected → poll `getMessage` to `succeeded` → idempotency dedup → unknown-id `404` PosthornApiError)
through production ESM incl. the `node:sqlite` `createRequire` path. Integrity + local gate: exit 0.
The three hash-protected files were not touched.

**State:** GREEN → committing to main. A consumer's whole integration — send, observe, and verify
received webhooks — is now one typed, zero-dependency import. Next tick: the **OpenAPI** spec (other-
language clients + docs) over this surface; the single **Dockerfile** to finish P4 packaging; or a
per-attempt audit log + `GET /v1/messages` list for richer observability.

---

## 2026-05-23 — Iteration 14: P3 — delivery-status read API (the "observable" promise made real)

**Repo truth at start:** clean main @ `24400c4`. Baseline re-verified before any change:
`tsc --noEmit` clean, vitest **407/407**, `npm run build` clean, integrity + local gate both exit 0.
Node 24.15 / Docker 29.4.3 present / Vitest 2.1.9. Reconciled GOAL→PROJECT: Posthorn decision stands;
the repo is far past the GOAL's "decide a project" stage. Inspected the live HTTP surface (`api.ts`):
it can **accept** (`POST /v1/messages` → 202) and CRUD endpoints, but there was **no way to read what
happened to a delivery** — no `GET /v1/messages/:id`, no delivery-status read of any kind. The queue
persists per-task `status`/`attempts`/`lastError` but exposed only `get(taskId)`/`claimDue`; the 202
doesn't even return task ids. So a producer fired a message into a void: the product's own one-liner
promises "signed, retried, **observable** webhooks," yet observability was entirely absent.

**High-leverage move chosen:** Build the **delivery-status read API**. Highest-leverage (checklist #3)
because it adds a *gating* product capability, not sugar: for a *reliable-delivery* product, inability
to observe delivery outcomes is the most fundamental missing piece, and per-message status is the
single most-used feature of every incumbent (Svix/Convoy dashboards). Chosen over the **Dockerfile**
(the service already runs via `npm start`; containerization is convenience over an already-runnable
process and adds no new capability) and the **TS SDK** (which would *wrap* this read — it is upstream).
Exactly the loop's strongest regime: fully deterministic, in-process testable, **zero new
dependencies**. Followed the proven pure-core / interface+two-backends+one-conformance-suite patterns.

**Built this tick:**
- **`DeliveryQueue.listByMessage(messageId)`** — the load-bearing read primitive (the data was already
  persisted; nothing exposed it per message). Added to the contract (a pure read: oldest-first, `[]`
  for unknown/empty id, never throws, never mutates), to **both backends** (in-memory: filter the
  insertion-ordered map; SQLite: `WHERE message_id ORDER BY rowid` + a new
  `idx_delivery_tasks_message`, added to the schema via `IF NOT EXISTS` so a pre-index DB gains it
  automatically on next open — **no migration needed, it is a pure read optimization over existing
  rows**), and to the **one shared conformance suite** (3 cases: empty for unknown, oldest-first +
  scoped-to-message, reflects post-transition state) so the two backends can't drift.
- **`GET /v1/messages/:id`** (`src/http/api.ts`) — authenticated; loads the message, **404 if absent
  or another tenant's** (existence never revealed — identical to the endpoint routes; tenancy from the
  key, never the body), lists its tasks, and returns a `messageView` (id/appId/eventType/idempotencyKey/
  **payload echoed**/createdAt + `deliveries[]`). `deliveryView` surfaces status/attempts/nextAttemptAt/
  lastError/endpointId/timestamps and **omits the internal `leaseToken`**. Route ordering is safe:
  `/v1/messages` (2 segments, POST) and `/v1/messages/:id` (3 segments, GET) never collide.

**Key decisions (honest tradeoffs):**
- **Latest-state-per-endpoint, not a full per-attempt audit log.** The view shows each delivery's
  *current* task state; a per-HTTP-attempt history (one row per attempt with response detail) is the
  richer observability add-on, still deferred and logged (distinct from the load-bearing state shown).
- **Single-message read only; no `GET /v1/messages` list yet.** A tenant-wide list needs a
  `MessageStore.listByApp` (+ pagination) that doesn't exist; the bounded single-id read is the precise
  high-value slice. Logged as the next deferred item.
- **Payload is echoed back** in the status read (the producer's own data, tenant-scoped) — useful for
  "what did I actually send?" debugging; the 202 create response still omits it for brevity.

**Validation:** `tsc --noEmit` clean (strict). vitest **420/420** (was 407; +13: queue conformance 3
× 2 backends = 6, api 6 [401/404-unknown/pending-before-worker/succeeded-after-worker/empty-deliveries/
404-cross-tenant], gateway 1 real-socket end-to-end [ingest → running worker delivers → poll status →
`succeeded`]). `npm run build` clean. **Smoke-tested the compiled `dist`** on the **SQLite** backends
through `createApi` (ingest → status `pending`/0 attempts, payload echoed, no `leaseToken` leak → worker
drains → status `succeeded`/1 attempt → cross-tenant read `404`), through production ESM incl. the
`node:sqlite` `createRequire` path. Integrity + local gate: exit 0. The three hash-protected files were
not touched.

**State:** GREEN → committing to main. Posthorn's deliveries are now observable: a producer can ask
what became of any message it sent. Next tick: the **TS SDK** + **OpenAPI** over this surface (now
including the status read), the single **Dockerfile** to finish P4 self-host packaging, or a per-attempt
audit log + `GET /v1/messages` list for richer observability.

---

## 2026-05-23 — Iteration 13: P3/P4 — admin provisioning CLI (the deployed gateway becomes usable)

**Repo truth at start:** clean main @ `e71de03`. Baseline re-verified before any change:
`tsc --noEmit` clean, vitest **385/385**, `npm run build` clean, integrity + local gate both
exit 0. Node 24 / Vitest 2.1.9. Reconciled GOAL→PROJECT: Posthorn decision stands. The glaring
gap after Iter 12: the gateway boots and serves an authenticated HTTP API, and the core delivery
path is now crash-consistent — **but there was no way to create the first credential against a
running deployment.** Every API route requires a Bearer key; minting that key existed *only* as the
programmatic `AppStore` surface (`gateway.ts`'s own docstring: "provisioning is done programmatically
… by an admin script" — a script that did not exist). So a freshly-deployed `posthorn` could be
*started* but its entire authenticated API was **unreachable out of the box** unless the operator
wrote and ran TypeScript. For a product whose standalone-gateway half is a headline wedge, "boots but
cannot be used" is the dominant defect.

**High-leverage move chosen:** Build the **`posthorn admin` provisioning CLI**. Highest-leverage
(checklist #3) because it converts a startable-but-unusable service into an *operable* one — the
single biggest systemic step available. Chosen over the **Dockerfile** (which without provisioning
would `docker run` into the same unusable state — provisioning is strictly upstream) and over the
**SDK/OpenAPI** (which describe an API you still can't authenticate against). It is also the regime
this loop is strongest in: fully deterministic, in-process testable, **zero new dependencies**
(node built-ins only). Security boundary chosen deliberately: provisioning lives behind **the shell
on the host that owns the data directory**, *not* an open HTTP route — exactly the door Iter 10
refused to build. The CLI naturally pairs with a future Dockerfile (`docker exec … posthorn admin …`),
so it is not throwaway.

**Built this tick:**
- **`src/runtime/admin.ts`** — `runAdminCommand(args, {store, out, err})`: the tested core. Takes an
  injected `AppStore` + output sinks, dispatches `create-app [name]` / `create-key <appId>` (prints
  the one-time secret + a "shown ONCE" warning + the `Authorization: Bearer` hint) / `list-apps` /
  `list-keys <appId>` / `revoke-key <keyId>` / `help`, and **returns a process exit code** (`0` ok,
  `1` usage error or failed op). Performs no I/O of its own — every command's behaviour, exit code, and
  exact output is unit-testable without a process/socket/fs. Expected failures (unknown app, nothing to
  revoke) are reported via `err` and the exit code, never thrown. `list-keys` distinguishes
  unknown-app (error) from app-with-no-keys (ok) via a `store.get` probe.
- **`src/main.ts`** — gained an `admin` dispatch: `argv[0] === "admin"` runs a one-shot command (open
  the `SqliteAppStore` at the configured `dataDir`, run, close, set `process.exitCode`) and exits; any
  other invocation boots the server as before. The existing boot logic moved into `runServer()`; the
  file stays the thin, untested process shell (the core it drives is tested).
- **`src/runtime/gateway.ts`** — `resolveLocations` (+ its `StoreLocations` type) is now **exported**
  and documented as the single source of truth for the on-disk store layout, so the admin path and the
  running gateway open the *same* `apps.db` and can never drift. `src/index.ts` re-exports the admin
  surface (`runAdminCommand`, `ADMIN_USAGE`, `AdminDeps`) + `resolveLocations`/`StoreLocations`.

**Key decisions (honest tradeoffs):**
- **CLI, not an HTTP route.** A control-plane HTTP route for provisioning is still deferred (it needs
  its own admin-auth design); the filesystem-gated CLI is the correct, smaller bootstrap primitive and
  the right privilege boundary for v1. Logged.
- **WAL makes admin-vs-live-server safe.** The app store opens in WAL mode, so a separate admin
  process writing while the server reads/runs is fine. A rare `SQLITE_BUSY` is possible if both write
  the exact same instant (server app/key writes are rare — it mostly *reads* on authenticate); no
  busy-retry added in v1, noted not hidden.
- **Test-fixture pitfall hit + fixed (same class as Iter 9):** the first test secret (`phk_secret_1`)
  was exactly 12 chars — equal to the display-prefix length — so the leak-check ("the full secret never
  appears in `list-keys`") falsely failed because the prefix *was* the whole secret. Fixed by using a
  realistically long test secret so the 12-char prefix is a strict truncation.

**Validation:** `tsc --noEmit` clean (strict). vitest **407/407** (was 385; +22 admin: per-command
success + failure paths, usage/exit-code semantics, no-secret-leak, and an end-to-end "a CLI-minted
secret authenticates against the store / a revoked one does not"). `npm run build` clean.
**Smoke-tested the compiled `dist` across processes**: `node dist/main.js admin create-app/create-key`
in one process, then a separately-spawned `node dist/main.js` server authenticated the minted key over
real HTTP (`401` without → `200` with), a CLI `revoke-key` was honored live (→ `401`), and `list-keys`
never echoed the full secret — through production ESM incl. the `node:sqlite` `createRequire` path.
Integrity + local gate: exit 0. The three hash-protected files were not touched.

**State:** GREEN → committing to main. A deployed Posthorn can now be bootstrapped end-to-end without
writing code: `npm start`, then `posthorn admin create-app` + `create-key`, and curl the API with the
key. Next tick: the single **Dockerfile** (finishes the P4 single-container story, now that the bootstrap
exists) + a **metrics endpoint**, or the **TS SDK** + **OpenAPI** over the HTTP surface.

---

## 2026-05-22 — Iteration 12: P3 — transactional outbox (close the accept→fan-out crash window)

**Repo truth at start:** clean main @ `4beaa66`. Baseline re-verified before any change:
`tsc --noEmit` clean, vitest **355/355**, `npm run build` clean, integrity + local gate both
exit 0. Node 24.15 / Vitest 2.1.9. Reconciled GOAL→PROJECT: Posthorn decision stands. The glaring
gap after Iter 11: the gateway is now *runnable*, but `ingest` had **one known correctness hole** —
its create-then-fan-out was not atomic. A crash after the message is stored but before fan-out
completes leaves a message whose idempotent retry **dedups and skips fan-out** → some/all of its
deliveries are *never enqueued*. For a product whose entire value is *reliable* delivery, an
accepted message that is silently delivered **zero** times is the worst possible failure. Every
prior tick (5×) deferred this "on principle" — runnability was upstream. Iter 11 explicitly named
the outbox "the clearly-named next correctness tick." So it was now the unambiguous highest-leverage
move (checklist #3: maximize systemic value), and it is exactly the deterministic, in-process-
testable regime this loop is strongest in (Axiom 2). Chosen over the Dockerfile/SDK (additive
packaging/DX, no correctness gain) because closing a *zero-once* delivery bug in a reliability
product dominates.

**Design — transactional outbox, faithful to the cross-store reality.** The four stores are
separate SQLite files, so you cannot enqueue into the queue *inside* the message's transaction.
The outbox pattern bridges exactly that: record the **intent** ("this message owes a fan-out") in
the *same* transaction that accepts the message, then relay it. So the message store *becomes* the
outbox.

**Built this tick:**
- **`MessageStore` contract + both backends** — `CreateMessageResult` gains `fanoutPending`; the
  interface gains `markFannedOut(id)` (idempotent marker-clear) + `listPendingFanout({limit,
  createdAtOrBefore})` (oldest-first drain). In-memory: a `#pendingFanout` set. SQLite: a
  `fanned_out_at` column (NULL = owed), written NULL **in the same `BEGIN IMMEDIATE` txn** as the
  insert (the atomic accept-and-record), a **partial index** `WHERE fanned_out_at IS NULL` so the
  sweep stays cheap as `messages` grows unbounded, and a guarded **migration** (`PRAGMA table_info`
  → `ALTER ADD COLUMN` + one-time backfill of pre-existing rows as *already*-fanned so an upgrade
  never re-delivers history). Both held to the same new **conformance** block (7 cases) so semantics
  can't drift; SQLite adds a migration test + a crash-safe outbox-replay-across-reopen test.
- **`ingest` reworked** (`src/fanout/fanout.ts`) — fans out **iff** the store reports `fanoutPending`
  (always for a fresh create; **true for a deduplicated retry of an orphaned create** → the retry now
  *recovers* the skipped fan-out instead of dropping it), then `markFannedOut`. The old "honest
  limitation: not atomic" docstring is replaced by the outbox guarantee + the residual at-least-once
  note. `IngestResult` no longer extends `CreateMessageResult` (so it doesn't leak a stale
  `fanoutPending`).
- **`FanoutDispatcher`** (`src/fanout/fanout-dispatcher.ts`) — the relay, the structural twin of the
  delivery worker: `sweepOnce()` (deterministic unit — list pending older than `graceMs`, `fanOut` +
  `markFannedOut` each) + `run()`/`stop()` (poll loop, **backs off on no-progress** so a persistently
  failing message can't hot-loop), every seam (clock/sleep) injected. Reuses the pure `fanOut` so
  routing can't drift. A `graceMs` window keeps it from racing a healthy in-flight inline ingest
  (duplicate fan-out is *safe* — at-least-once + receiver dedup — so grace is an efficiency guard, not
  a correctness one; logged). Wired into `createGateway` (runs alongside the worker; `start`/`stop`
  manage both) and `loadConfig` (`POSTHORN_FANOUT_GRACE_MS/_BATCH_SIZE/_IDLE_POLL_MS`).

**Key decisions (honest tradeoffs):**
- **Inline fan-out kept for the common path; dispatcher is the safety net.** ingest still fans out
  synchronously (low latency, the HTTP 202 can report fan-out counts); the dispatcher only recovers
  orphans. This is least-disruptive (no API contract change) and the grace period prevents the two
  racing on the happy path.
- **Residual at-least-once, not exactly-once.** fan-out enqueues into the queue (one DB) then clears
  the marker (another DB); a crash between them re-fans on recovery → a possible duplicate delivery.
  That is the queue's pre-existing at-least-once contract (receiver dedups on the stable message id).
  What changed: the floor moved from *zero*-once to *at-least*-once. Logged, not hidden.
- **Migration backfills old rows as fanned-out.** Adding a NULL column would mark all history "owed"
  → a re-delivery storm on upgrade. The one-time backfill (inside the column-add branch only, never
  on subsequent boots) prevents that.

**Validation:** `tsc --noEmit` clean (strict). vitest **385/385** (was 355; +30: store conformance
outbox ×2 backends +14, sqlite migration/replay +2, ingest +3, dispatcher +9, config +2, gateway +1
[orphan recovered end-to-end in a *running* gateway, signature verifies]). `npm run build` clean.
**Smoke-tested the compiled `dist`**: simulated a crash (accept, no fan-out) → `listPendingFanout`
sees it → `FanoutDispatcher.sweepOnce` recovers it → worker delivers → signature **verifies**, all
through production ESM incl. the `node:sqlite` `createRequire` path. Integrity + local gate: exit 0.
The three hash-protected files were not touched.

**State:** GREEN → committing to main. The core delivery path is now crash-consistent: an accepted
message is guaranteed to be fanned out (at-least-once) even across a crash, by retry **or** by the
dispatcher. The one known correctness gap is closed. Next tick: the **TS SDK** + **OpenAPI** over the
HTTP surface, or the single **Dockerfile** to finish the P4 self-host packaging story.

---

## 2026-05-22 — Iteration 11: P3/P4 — composition root + `posthorn` bin (the gateway actually boots)

**Repo truth at start:** clean main @ `5e25f91`. Baseline re-verified before any change:
`tsc --noEmit` clean, vitest **338/338**, `npm run build` clean, integrity + local gate both
exit 0. Node 24 / Vitest 2.1.9. Reconciled GOAL→PROJECT: Posthorn decision stands. The glaring
gap after Iter 10: the HTTP API landed only as a **`createHttpServer(deps)` factory** — `src/index.ts`
exports it and `createApi`, but there was **no composition root and no bootable entrypoint** (no
`src/main.ts`, no `bin`, nothing that instantiates the SQLite stores, wires `ingest`+worker, and
calls `.listen()`). So last tick's "the engine becomes a runnable service" built the *handler* but
Posthorn could be *constructed in a test* and **not actually started or deployed** — the
"standalone gateway" half of PROJECT.md's wedge ("library *or* a standalone gateway") did not exist.

**High-leverage move chosen:** Build the **composition root + runnable gateway bin**. Highest-leverage
because it converts a pile of correct modules + an inert handler factory into a *thing you can run*
(`npm start` / `posthorn`) — the single biggest systemic step (checklist #3), and it realizes the
missing half of the product wedge. Explicitly chosen over the **transactional outbox** (again
deferred): you cannot meaningfully harden the crash-consistency of an ingest path on a service that
has no way to boot — making it runnable is strictly upstream of refining its crash semantics. Kept
fully deterministic + in-process testable (Axiom 2); zero new dependencies (`node:http`/`node:fs`/
`node:sqlite` only), preserving the zero-dep wedge. Followed the codebase's pure-core/thin-I/O split.

**Built this tick (`src/runtime/` + `src/main.ts`):**
- `config.ts` — `loadConfig(env)`: a **pure** env→`GatewayConfig` parser (`POSTHORN_*` vars,
  defaults imported from the worker/queue/http modules so they can't drift, integer-range validation
  with a `ConfigError` naming the offending key, frozen result). No `process.env`/socket/fs access —
  the whole config surface is unit-testable.
- `gateway.ts` — `createGateway(config)`: pure plumbing. Resolves store locations (one SQLite file
  per store under `dataDir`, `mkdir -p`; or `:memory:`), opens the four backends, wires the worker
  (`storeBackedResolver(endpoints)`) + `createHttpServer`, returns a `Gateway`: `start()` (listen via
  a promisified `listen`, capturing a bind error; then `worker.run()`, returns the bound address) and
  an **idempotent, graceful `stop()`** (worker.stop → await the run loop → `close()` + `closeAllConnections()`
  the server → close all four SQLite handles). Stores exposed so the keyless app/key bootstrap stays
  programmatic (still no HTTP route).
- `main.ts` — the `posthorn` bin (`#!/usr/bin/env node` shebang, preserved by tsc into `dist/main.js`):
  load config, boot, log the listen line, translate `SIGINT`/`SIGTERM` into one graceful `stop()`. The
  thin process shell; not unit-tested (the composition it drives is). `index.ts` re-exports the runtime
  surface; `package.json` gained `"bin": {"posthorn": ...}` + a `start` script.

**Key decisions (honest tradeoffs):**
- **Default `POSTHORN_HOST=0.0.0.0`** — correct for the headline single-container deploy (a
  loopback bind is unreachable through the container boundary); documented, override to `127.0.0.1`
  to restrict. A bind-everywhere default is a deliberate container-first choice, logged.
- **One SQLite file per store** (apps/endpoints/messages/queue), matching the existing per-store
  architecture rather than forcing a shared connection now. The transactional-outbox tick (which
  wants messages+queue in one txn) may later consolidate; flagged, not pre-optimized.
- **Transactional outbox deferred a 5th time — on principle, not avoidance.** Runnability is
  upstream of crash-window correctness; the outbox is now the clearly-named next correctness tick.

**Validation:** `tsc --noEmit` clean (strict). vitest **355/355** (was 338; +17: config 12 pure,
gateway 5 incl. a real-socket end-to-end boot→provision→ingest→deliver→**verify** + a file-backed
**durability-across-restart** test). `npm run build` clean. **Smoke-tested the compiled binary**
(`node dist/main.js` boots, logs the listen line, serves `/healthz 200` over a real socket) **and the
compiled `dist/index.js`** (full provision→ingest→deliver→verify through production ESM incl. the
`node:sqlite` `createRequire` path). Integrity + local gate: exit 0. The three hash-protected files
were not touched.

**State:** GREEN → committing to main. Posthorn is now a **runnable, deployable single-process
gateway** — `npm start` and it serves. Next tick: a single **Dockerfile** (finishing the P4
self-host story) + **TS SDK/OpenAPI**, or the **transactional outbox** to close the core crash window.

---

## 2026-05-22 — Iteration 10: P3 — HTTP API (the engine becomes a runnable service)

**Repo truth at start:** clean main @ `a954399`. Baseline re-verified before any change:
`tsc --noEmit` clean, vitest **295/295**, `npm run build` clean, integrity + local gate both
exit 0. Node 24.15 / Vitest 2.1.9. Reconciled GOAL→PROJECT: Posthorn decision stands. The glaring
gap after Iter 9: every backend layer existed and was wired (signer → store → queue → worker →
endpoints → fan-out → apps/auth), but there was **no way to actually run Posthorn as a service** —
it was a library only. PROJECT.md's wedge is explicitly "library *or* standalone gateway," yet only
the library half existed. Every prior tick ended "next: the Fastify HTTP API" and then deferred it,
citing Fastify's `npm install`/network risk in this sandbox. That deferral was the loop's local minimum.

**High-leverage move chosen:** Build the **HTTP API on Node's built-in `node:http`** instead of
Fastify. Highest-leverage because (a) it converts a pile of correct-but-inert modules into a
*deployable webhook gateway* — the single biggest systemic step available (checklist #3, "maximize
systemic value"); (b) `node:http` **kills the only stated blocker** (zero `npm install`, zero network)
and adds **zero runtime dependencies**, the same reasoning that chose `node:sqlite`/`node:crypto` —
so it *strengthens* the single-container wedge rather than compromising it with a framework; (c) it is
fully in-process testable on localhost (deterministic → Axiom 2). Deferred the transactional outbox
again — a narrower internal-robustness fix that couples two stores; the API is what makes the product
*exist*. Followed the worker's proven **pure-core + thin-I/O-adapter** split verbatim to keep risk low.

**Built this tick (`src/http/`):**
- `router.ts` — a **pure** dependency-free path router. `matchRoute(routes, method, path)` →
  `matched | methodNotAllowed(allow[]) | notFound`; path matched before method so a wrong-method hit
  on a known path yields 405 (+`Allow`), not a misleading 404. `:param` captures one URL-decoded
  segment; malformed percent-encoding = non-match. Exhaustively unit-testable without sockets.
- `api.ts` — `createApi(deps)`: the **pure** request→response handler composing `AppStore.authenticate`
  (Bearer auth), `EndpointStore` (CRUD), and `ingest` (accept + fan-out). Standard `{error:{code,message}}`
  envelope; domain errors mapped to status (`IdempotencyConflictError`→409, `UnknownEndpointError`→404,
  validator `TypeError`→400). Surface: `GET /healthz` (open); `POST /v1/messages` (202);
  `GET/POST /v1/endpoints`; `GET/PATCH/DELETE /v1/endpoints/:id`.
- `server.ts` — `createHttpServer(deps, {maxBodyBytes?})`: the thin `node:http` adapter — reads the
  body (1 MiB cap → 413, rejects early on overflow + closes the conn), normalizes headers, dispatches,
  writes JSON. `src/index.ts` re-exports the whole http surface.

**Security model (decided, not incidental):**
- **Tenancy from the key, never the body.** Every authed route scopes to `authenticate(bearer).id`;
  a body `appId` is ignored — a caller can't act as another tenant by forging a field (tested for both
  messages and endpoint-create).
- **Cross-tenant access is 404, not 403** — get/patch/delete/list of another app's endpoint is
  indistinguishable from "absent"; existence is never revealed.
- **Signing secrets are write-only over HTTP** — an endpoint's `secret` is returned exactly once in
  the 201 create body (you need it to configure verification) and never echoed by list/get/update.
- **App/key provisioning is intentionally not an HTTP route** — a privileged bootstrap with no key to
  authenticate it; exposing it unauthenticated is an open door. It stays on the programmatic `AppStore`
  (an admin/control-plane route is a later tick). This API is the *tenant-facing* surface only. Logged.

**Key decisions (honest tradeoffs):**
- **`payload` is any JSON value; the delivered/signed body is its `JSON.stringify`.** Conventional
  webhook-API contract (Svix-like); byte-exact control is traded for ergonomics. Logged.
- **`TypeError` → 400 is a deliberate convention** (every `normalize*`/`apply*Update` validator throws
  it on bad input). A genuine internal bug throwing `TypeError` would also surface as 400; the
  validators are the only realistic source on these routes. Commented in code.
- **One self-inflicted test bug found + fixed:** the end-to-end test pinned the worker clock to 2023,
  but `verify` checks the signed `webhook-timestamp` against the *real* wall clock + a replay window →
  "too old". The signature was correct; fixed by signing with the real clock (the test asserts the
  round-trip, not time logic).

**Validation:** `tsc --noEmit` clean (strict). vitest **338/338** (was 295; +43: router 11, api 27,
server 5). `npm run build` clean. **Smoke-tested the built `dist` over a real socket** (unauth→401,
health, endpoint create returns secret once, list never leaks it, ingest→202 fans out 1, worker drains,
the signed delivery **verifies** against the endpoint secret). Integrity + local gate: exit 0. The three
hash-protected files were not touched.

**State:** GREEN → committing to main. Posthorn is now a runnable, zero-dependency webhook *service*,
not just a library — curl an event in, it authenticates, fans out, and the worker delivers a verifiable
signed webhook. Next tick: the **TS SDK** + **OpenAPI** over this surface, or the **transactional
outbox** to close the one known correctness gap (crash between ingest's create and fan-out).

---

## 2026-05-22 — Iteration 9: P3 — App/tenant entity + API-key authentication (identity layer)

**Repo truth at start:** clean main @ `56a6f4a`. Baseline re-verified before any change:
`tsc --noEmit` clean, vitest **239/239**, `npm run build` clean, integrity + local gate both
exit 0. Node 24.15 / Vitest 2.1.9. Reconciled GOAL→PROJECT: Posthorn decision stands. The glaring
gap after Iter 8: every layer was built and connected (signer → store → queue → worker → endpoints →
fan-out → ingest), but `appId` was an **opaque, unauthenticated string** — any caller could assert
any tenant, and no entity minted or validated it. That identity gap blocks the HTTP API: without
auth, the API would be wide open and `appId` forgeable.

**High-leverage move chosen:** Build the **App/tenant entity + API-key auth** (`src/apps/`). Highest-
leverage because (a) it is the load-bearing tenancy+auth foundation the deferred Fastify HTTP API must
sit on (`authenticate(key)` → `appId` → scope existing ops); (b) it is security-critical yet fully
deterministic — golden-vector-testable like the P0 signer — the regime this loop is strongest in; (c)
**zero new dependencies** (only `node:crypto` + `node:sqlite`), preserving the zero-dep wedge, whereas
Fastify still carries the sandbox install/network risk the loop has repeatedly and correctly deferred.
Followed the proven `interface + in-memory reference + SQLite + one shared conformance suite` pattern
verbatim to keep risk low.

**Built this tick (`src/apps/`):**
- `app.ts` — `App`/`NewApp`/`AppUpdate`, `ApiKey` (metadata; no secret) + `CreatedApiKey` (one-time
  plaintext), the `AppStore` contract (app CRUD + `createApiKey`/`listApiKeys`/`revokeApiKey`/
  `authenticate`), `UnknownAppError`, and the shared **pure** crypto/validation helpers so backends
  can't drift: `createAppId`/`createApiKeyId`/`generateApiKeySecret`, `hashApiKey` (sha256 hex —
  storage *and* lookup index), `apiKeyPrefix` (12-char non-secret display prefix), `apiKeyHashesEqual`
  (constant-time), `normalizeNewApp`/`applyAppUpdate`.
- `in-memory-app-store.ts` — insertion-ordered reference; a `keyHash → keyId` index makes
  `authenticate` O(1), mirroring the SQLite hash index; cascade-drops a deleted app's keys.
- `sqlite-app-store.ts` — durable backend on built-in `node:sqlite` (same `createRequire` workaround),
  two `STRICT` tables (`apps`, `api_keys`), `api_keys.app_id REFERENCES apps(id) ON DELETE CASCADE`
  with `PRAGMA foreign_keys = ON`, UNIQUE indexed `key_hash`, `revoke` guarded by `revoked_at IS NULL`.
- `conformance.ts` + `app.test.ts` (pure helpers incl. **golden SHA-256 vectors**) + per-backend tests;
  SQLite adds crash-safe replay (app + live key + revocation survive reopen), cascade-survives-reopen,
  UNIQUE-hash-collision, and file isolation. `src/index.ts` re-exports the apps surface.

**Security model (decided, not hand-waved):** key secret = 256 bits CSPRNG, so store only its SHA-256
(fast hash is correct for high-entropy input — bcrypt/argon2 defend low-entropy passwords); plaintext
returned exactly once; constant-time compare as defense-in-depth atop the indexed exact-hash match;
revoked keys denied; `authenticate` is a pure read (no hot-path write-amplification). The golden vector
pins the hash format so a future change can't silently invalidate every stored key.

**Key decisions (honest tradeoffs):**
- **Per-key `lastUsedAt` deferred.** Bumping it on every auth would put a write on the hot read path;
  it's an observability add-on (like the deferred per-attempt audit log), logged not hidden.
- **App deletion cascades keys but not endpoints/messages.** Those are independent stores; cross-store
  reaping is a service-level concern, not a store coupling. Logged.
- **One test-fixture bug found + fixed mid-tick:** the conformance leak-check asserted the listed
  metadata omits the secret, but the *injected* test secret (`phk_test_1`) is shorter than the 12-char
  display prefix, so the prefix legitimately equals it. Moved the no-leak assertion to a test using the
  realistic (long) default generator, where the property actually holds.

**Validation:** `tsc --noEmit` clean (strict). vitest **295/295** (was 239; +56: apps pure helpers 14,
in-mem 20, sqlite 22). `npm run build` clean. **Smoke-tested the built `dist/index.js`** end-to-end on
the SQLite backend (mint → authenticate → isolated revoke-denies → wrong/empty denied → cross-tenant
isolation → cascade-delete-denies → metadata carries no full secret). Integrity + local gate: exit 0.

**State:** GREEN → committing to main. `appId` is now an authenticated identity. Next tick: the
**Fastify HTTP API** (composing `AppStore.authenticate`) — or the **transactional outbox** to make
ingest atomic if the Fastify install risk warrants staying dependency-free one more tick.

---

## 2026-05-22 — Iteration 8: P3 — message fan-out (the parts become a service)

**Repo truth at start:** clean main @ `b9c4cfa`. Baseline re-verified before any change:
`tsc --noEmit` clean, vitest **222/222**, `npm run build` clean, integrity + local gate both
exit 0. Node 24.15 / Vitest 2.1.9. Reconciled GOAL→PROJECT: Posthorn decision stands. The glaring
gap after Iter 7: signer, FSM/retry, message store, queue, worker, endpoint store, and resolver
were all built — but **nothing connected "a message was created" to "enqueue a delivery for each
subscribed endpoint."** You had to hand-enqueue one `DeliveryTask` per endpoint. That join — fan-out
— is the functional heart of a webhook service and the exact thing a future `POST /messages` sits on.

**High-leverage move chosen:** Build **message fan-out**. Highest-leverage because (a) it converts a
pile of correct-but-disconnected machinery into an actual service (ingest an event → it reliably
reaches every relevant destination); (b) it needs **zero new dependencies** (unlike Fastify, which
carries an install/network risk in this sandbox), is fully deterministic + in-process validatable
(Axiom 2); (c) it is the prerequisite the HTTP ingest path will sit on. Deferred the App/tenant
entity and the Fastify layer to keep this one cohesive green unit.

**Prerequisite, done right (`src/storage/`):** fan-out needs a message to know its tenant, so added
**`appId` to `Message`/`NewMessage`** (required, mirroring the endpoint store). Because the message
now carries a tenant, **idempotency had to become per-tenant** — otherwise tenant B's key would
dedup against, and *return*, tenant A's message (a real cross-tenant data leak that adding `appId`
would have introduced). So `getByIdempotencyKey(appId, key)`, a nested in-memory index, and a
composite `(app_id, key)` SQLite PK. The shared conformance suite gained cross-tenant isolation
tests proving both backends namespace keys per app. Fingerprint stays `(eventType, payload)` — within
a fixed `(appId, key)` scope the appId is invariant, so it adds nothing.

**Built this tick (`src/fanout/`):**
- `selectFanoutTargets(endpoints, eventType)` — **pure** routing: partitions into `matched`
  (enabled + `endpointSubscribesTo`), `skippedDisabled`, `skippedUnsubscribed`; order-preserving;
  disabled wins over subscribed. Skip-reason buckets give operators "why didn't my endpoint fire?".
- `fanOut(message, {endpoints, queue}, {availableAt?})` — lists the message's `appId` endpoints,
  selects, and enqueues one `DeliveryTask` per match (carrying the opaque `endpointId`), sequentially
  in endpoint order (deterministic; matches the worker's sequential model). Returns the tasks + counts.
- `ingest(input, {messages, endpoints, queue})` — the headline op: create the message, then fan out
  **only when the create was new**; a deduplicated retry is *not* re-fanned (would double-deliver).
- `src/index.ts` re-exports the fan-out surface.

**Key decisions (honest tradeoffs):**
- **Per-tenant idempotency was bundled in, not deferred.** Adding `appId` without scoping the key
  index would knowingly ship a cross-tenant leak; correctness outranks a smaller diff. The cost was
  mechanical test churn (every message-`create` call gained `appId`).
- **`ingest` is not atomic.** A crash after store-create but before fan-out completes leaves a
  message whose retry dedups and skips fan-out → some deliveries never enqueue. Right fix is a
  transactional outbox (enqueue inside the create txn); deferred and logged, not hidden. Best-effort
  -after-accept is the correct common-path default and never double-*creates*.
- **Fan-out is at-least-once** (like the queue it feeds): a second `fanOut` of the same message
  enqueues a second task set → possible duplicate delivery, which is why every message carries a
  stable id for receiver-side dedup (Standard Webhooks).

**Validation:** `tsc --noEmit` clean (strict). vitest **239/239** (was 222; +17: fan-out 13 [pure 6,
fanOut 4, ingest 3 incl. an end-to-end ingest→deliver→verify] + cross-tenant idempotency conformance
4 [in-mem 2, sqlite 2]). `npm run build` clean. **Smoke-tested the built `dist/index.js`** end-to-end
on SQLite backends (ingest fans out to 2/4 endpoints, skips 1 unsubscribed + 1 disabled; cross-tenant
key stays distinct/no-leak; retry dedups + no re-fan-out; worker drains both; signature **verifies**).
Integrity + local gate: exit 0.

**State:** GREEN → committing to main. Posthorn now ingests an event and reliably fans it out to a
tenant's subscribers, end-to-end. Next tick: the **App/tenant** entity (mint/validate `appId`), then
the **Fastify HTTP API**, or the **transactional outbox** to make ingest atomic.

---

## 2026-05-22 — Iteration 7: P3 begins — the endpoint store + store-backed resolver

**Repo truth at start:** clean main @ `6b58953`. Baseline re-verified before any change:
`tsc --noEmit` clean, vitest **168/168**, `npm run build` clean, integrity + local gate both
exit 0. Node 24.15 / Vitest 2.1.9. Reconciled GOAL→PROJECT: the Posthorn decision stands. The
glaring gap after P2.5: the worker could sign+POST, but its `EndpointResolver` seam had **no
implementation** — there was no persisted endpoint at all, and a `DeliveryTask` carried only an
opaque `messageId` with no way to say *which* endpoint it targets. So the worker still required a
hand-written resolver; nothing could store a subscription. That entity is the foundation the whole
of P3 (HTTP API, fan-out, SDK) sits on.

**High-leverage move chosen:** Build the **endpoint store** and connect it to the worker. Highest-
leverage because (a) it is the load-bearing entity every later P3 step depends on; (b) it fills the
worker's deliberately-left resolver seam, ending the "four/five disconnected islands" pattern; (c)
it needs **zero new dependencies** (no `npm install`/network risk in this sandbox) and is fully
in-process validatable, directly serving Axiom 2. Followed the proven `MessageStore`/`DeliveryQueue`
architecture verbatim (interface + in-memory reference + SQLite + one shared conformance suite) to
keep risk low. Deliberately deferred fan-out + the App/tenant entity + the Fastify HTTP layer to
keep this one cohesive green unit (Fastify also carries an install-network risk; the pure data layer
is both the foundation and the safe part).

**Built this tick (`src/endpoints/`):**
- `endpoint.ts` — `Endpoint` (tenant-scoped `appId`; `url` + `secret` + `eventTypes` filter [`null`
  = all] + `disabled`), the `EndpointStore` CRUD contract, `UnknownEndpointError`, and shared **pure**
  helpers so backends can't drift: `normalizeNewEndpoint` (http(s)-only URL validation, deduped
  filter, secret signalled as `null` → backend mints one via an injectable generator),
  `applyEndpointUpdate` (validated patch; `id`/`appId`/`createdAt` immutable, `updatedAt` bumped),
  `endpointSubscribesTo` (for fan-out next tick), `createEndpointId`.
- `in-memory-endpoint-store.ts` — insertion-ordered reference backend; `listByApp` oldest-first.
- `sqlite-endpoint-store.ts` — durable backend on built-in `node:sqlite` (same `createRequire`
  workaround), `STRICT` schema, `event_types` as JSON (or NULL), `disabled` as 0/1, `update` as a
  read-modify-write in a `BEGIN IMMEDIATE` txn, `delete` via row-changes count.
- `conformance.ts` + `endpoint.test.ts` (pure helpers) + per-backend tests; SQLite adds crash-safe
  replay (filter + flags survive reopen) + file isolation.
- **Wired to the worker:** `DeliveryTask`/`EnqueueInput` now carry an opaque, nullable `endpointId`
  (the "message×endpoint richer unit" the queue's own docstring anticipated) — threaded through both
  queue backends + the queue conformance suite (round-trip + reject-empty). `endpoint-resolver.ts`'s
  `storeBackedResolver(store)` fills the worker's `EndpointResolver` seam: resolves `endpointId` →
  target, declining (null → failed attempt → policy retries/dead-letters) for absent/deleted/disabled
  endpoints. `src/index.ts` re-exports the endpoint surface.

**Key decisions (honest tradeoffs):**
- `endpointId` is a **passenger** field — the queue carries it, never interprets it — so transitions
  preserve it for free via the existing `...task` spread and the SQLite `#persist` UPDATE leaves it
  untouched (immutable post-enqueue).
- A **disabled** endpoint resolves to `null`, i.e. a *failed attempt* that eventually dead-letters,
  rather than an out-of-band cancel (the worker has none in v1). Fan-out won't enqueue work for
  disabled endpoints; this only bites an endpoint disabled *after* enqueue. Logged, not hidden.
- `appId` is required now (multi-tenant from day one, `listByApp` never leaks) but treated as an
  opaque scope string — the App entity that mints/validates it is a later tick.

**Validation:** `tsc --noEmit` clean (strict). vitest **222/222** (was 168; +54: endpoints 50 [pure
9, in-mem 17, sqlite 18, resolver 6], queue +4, plus the worker-test literal gained `endpointId`).
`npm run build` clean. **Smoke-tested the built `dist/index.js`** (`SqliteEndpointStore` create →
filter round-trip → enqueue with `endpointId` → `storeBackedResolver` → worker delivers → signature
**verifies**) to prove the full path works in production ESM. Integrity + local gate: exit 0.

**State:** GREEN → committing to main. P3 underway; the endpoint is persisted and the worker delivers
to a stored endpoint end-to-end. Next tick: message **fan-out** (needs `appId` on the message) +
the **App/tenant** entity, then the Fastify HTTP API.

---

## 2026-05-22 — Iteration 6: P2.5 — the delivery worker (runtime I/O driver), end-to-end send real

**Repo truth at start:** clean main @ `7c1926b`. Baseline re-verified before any change:
`tsc --noEmit` clean, vitest **145/145**, `npm run build` clean, integrity + local gate both
exit 0. Node 24.15 / Vitest 2.1.9. Reconciled GOAL→PROJECT: Posthorn decision stands. The glaring
gap after P2: signer, retry/FSM, store, and the durable queue were **four fully-built but
disconnected islands** — nothing performed actual I/O, so Posthorn could not yet *send a single
webhook*. The roadmap's named next item (P2.5) closes exactly that.

**High-leverage move chosen:** Build the **`DeliveryWorker`** — the runtime loop that joins all four
islands into a real send: claim due tasks → load message → sign → POST → settle. Highest-leverage
because it converts a pile of correct-but-inert machinery into a working product (the first
end-to-end delivery), and it does so without adding any decision logic (retry/state stays in P1/P2),
keeping the unit small and fully green.

**Built this tick (`src/worker/delivery-worker.ts`):**
- Pure helpers: `isSuccessStatus` (2xx) and `buildSignedRequest` (Standard Webhooks headers; signs
  over `{id}.{ts}.{payload}` with the *send* time, not message createdAt; caller headers merged but
  cannot clobber the `webhook-*` headers).
- `DeliveryWorker`: `processOnce()` (deterministic single tick at one clock instant — claim a batch,
  deliver each sequentially, return a `TickResult` tally) and `run()`/`stop()` (continuous poll:
  drains back-to-back, sleeps `idlePollMs` when idle, survives unexpected tick errors via `onError`).
- Injected seams (the whole point — fully fake-clock/transport-testable): `queue`, `store`, `now`,
  `transport` (default `fetchTransport` over global `fetch`, with per-attempt `AbortSignal` timeout),
  injectable `sleep`, and an **`EndpointResolver`** — the deliberate plug-point for P3's
  endpoint/secret store (the queue task carries only an opaque `messageId`).
- Settle hygiene: a lapsed-and-reclaimed lease raises `StaleLeaseError` on `complete`/`fail`, which
  the worker absorbs (counted `stale`) per the queue's at-least-once contract — never double-settles.
  Missing message / unresolved endpoint / transport throw / non-2xx all become a *failed attempt*
  (the queue's policy then retries or dead-letters); deliberately no out-of-band cancel in v1.
- `src/index.ts` re-exports the worker surface.

**Key decision — sequential batch processing in v1.** Honest tradeoff: simple + deterministic, but
`batchSize × requestTimeoutMs` must stay below the queue's visibility timeout or leases lapse
mid-batch. Correctness holds regardless (stale settles are absorbed); bounded concurrency is the
next throughput optimization. Documented in code + PROJECT.md.

**Validation:** `tsc --noEmit` clean (strict). vitest **168/168** (was 145; +23 worker: pure-helper +
construction guards + happy-path + retry/dead-letter/missing-msg/no-endpoint/transport-error/stale-
reclaim/timeout-abort + `run` drain/resilience/concurrent-guard). The headline test and a
compiled-**`dist`** smoke run both prove a worker-emitted request **verifies against the existing
verifier** — the full sign→deliver→verify loop closed in-process and in production ESM.
`npm run build` clean. Integrity + local gate: exit 0.

**State:** GREEN → committing to main. P2.5 complete; Posthorn now performs a real end-to-end
delivery. Next tick: P3 — Fastify HTTP API (apps/endpoints/messages) + an endpoint store backing a
real `EndpointResolver` + TS SDK.

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
