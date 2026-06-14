# Posthorn — Engineering Review

_Reviewer: senior engineer, top-to-bottom review. Date: 2026-06-14. Branch reviewed:
`chore/template-reset-20260614`; product code reviewed at `develop` (HEAD `d243193`).
Method: read the actual source, cross-checked claims, inspected every unmerged branch
with `git log`/`git diff`. No builds were run (per review constraints)._

---

## Verdict

**Grade: B.**

This is the rare AI-built repo where the product is _real_ and the surrounding process
is _theatrical in places_. The Posthorn service itself — a single-binary, SQLite-backed,
Standard-Webhooks-compatible outbound webhook delivery engine — is genuinely well-built:
a real `node:http` server bound to a real socket, a crash-safe leased delivery queue with
an atomic `BEGIN IMMEDIATE` claim, correct AES-256-GCM secret-at-rest and HMAC-SHA256
signing with `timingSafeEqual` everywhere it matters, a real SSRF denylist applied at
create/update/delivery, parameterized SQL throughout, and a test suite (~9,500 lines, 167
tests) that is ~88% load-bearing behavioral testing against a live in-process gateway and
real `:memory:` SQLite — not mock theater. The Docker image and Helm chart are hardened
(non-root, read-only rootfs, dropped caps, loopback-bound ports, mandatory admin token).

What knocks it off an A is partly real and partly self-inflicted. Real: the encryption
master key lives _in the same SQLite file_ as the ciphertext it protects (encrypt-at-rest
is meaningless against file/disk compromise); there is a residual DNS-rebinding SSRF gap;
and the README sells an "Embed as a Library" API (`gateway.apps.create()`, `gateway.queue`,
etc.) that **does not exist** — the `Gateway` interface exposes only `start`/`stop`/`config`/
`serviceName`. Self-inflicted, and the most damning systemic finding: **18 unmerged remote
branches (a wall of `jules-*`/`perf-*`/`fix-*` bot branches) are 100% dead.** Every one was
cut against a previous, completely different modular architecture (`src/queue/`, `src/billing/`,
`src/dashboard/handler.ts`, `src/http/api.ts`, `src/system-events/`) that was thrown away in
a wholesale rewrite. They are all ~85 commits behind `develop` and touch files that no longer
exist; several "optimizations" would have been regressions even on the old code. That is a
lot of agent compute spent producing zero mergeable work, and nobody pruned it.

Bottom line: a strong B product strapped to a process that generated a graveyard. Delete the
branch graveyard, move the encryption key out of the DB, and stop documenting an embedding API
that isn't built, and this is an A-.

---

## What this actually is

Posthorn ("posthorn", repo `claude-sandbox-test1`) is an **outbound webhook delivery service**
— the "send signed, retried, observable webhooks to your customers" problem that Svix and
Convoy solve, but packaged as a single Node process with embedded SQLite and zero runtime
dependencies (`node:sqlite`, `node:crypto`, `node:http` only — confirmed: `dependencies` in
`package.json` is empty; all deps are dev-only).

It is **not** vaporware. The shipped feature set, verified in code:

- Tenant + API-key provisioning via an admin control plane (`src/admin.ts`, `src/auth.ts`).
- Endpoint CRUD with SSRF-guarded URLs, per-endpoint rate limiting, delivery method
  (POST/PUT), and payload format (envelope / payload_only / CloudEvents 1.0)
  (`src/endpoints.ts`).
- Message intake (single + batch up to 100), idempotency keys, deduplication windows, fanout
  to matching endpoints (`src/messages.ts`, 985 lines).
- A crash-safe delivery worker: leased claim, exponential backoff, attempt budget →
  dead-letter, endpoint auto-disable, lease reclaim (`src/worker.ts`, 989 lines).
- Standard Webhooks signing/verification with multi-secret rotation overlap (`src/webhooks.ts`).
- Observability: per-attempt audit log, endpoint stats, app-wide delivery listing, usage
  metering with monthly quota + 429, Prometheus `/metrics`, static HTML dashboards.
- A TypeScript SDK + CLI (`src/client.ts`, `src/cli.ts`) and a partial standard-library-only
  Python SDK (`clients/python/`).
- An OpenAPI 3.1 doc generated from a route table and pinned to the real router by a contract
  test (`src/openapi.ts`, `tests/openapi-contract.test.ts`).

It is built by an autonomous AI "operations engine" (the `.claude/`, `roadmap/`, `scripts/`
machinery). The review scope explicitly ignores that scaffolding as a _review target_; this
document treats only the product.

---

## Architecture

### Service (`src/`, 24 files, ~10,200 LOC)

Flat module layout — one file per domain concept, no nested packages. This is the _current_
architecture; an earlier 151-file modular layout (`src/apps/`, `src/attempts/`, `src/queue/`,
`src/billing/`, `src/dashboard/`, Postgres stores) was discarded in a rewrite around
`681a1de` (F-0002, "Add configuration and SQLite storage"). That rewrite matters enormously
for the branch situation below.

- **HTTP layer** — `src/gateway.ts` (1,294 LOC) is a real `node:http` server
  (`createServer` @149, `server.listen` @1274). Routing is a hand-rolled if/regex dispatcher
  (`handleRequest` @206-337), **not** a declarative table; each sub-handler re-derives path
  params via per-pattern regexes (`*FromPath` helpers @958-1017). Body size is capped and
  streamed (`readRequestBody` @1080-1138) → 413 + `connection: close`. JSON parse errors →
  400 `invalid_json`. Auth is checked on **every** `/v1/*` route before work
  (`authenticateTenantRequest` @925, `authenticateAdminRequest` @942); no unprotected `/v1`
  route was found. Admin routes 404 (not 401) when no token is configured (@340-343) — good
  surface hiding.
- **Storage** — `src/storage.ts` (410 LOC): a single SQLite DB, schema in one SQL string
  plus idempotent `ALTER TABLE`-guarded column migrations (@214-313). Sensible indexes for
  the claim hot path (`deliveries_status_due_idx`, `deliveries_status_lease_idx`). Foreign
  keys ON with cascades.
- **Delivery worker** — `src/worker.ts`: the heart of the system, and it is correct. The
  claim uses `BEGIN IMMEDIATE` + a conditional `UPDATE ... SET status='delivering'` guarded
  on `status='pending' AND next_attempt_at<=now` OR an expired lease, plus an `EXISTS`
  enabled-endpoint check (@205-257). This is the right single-writer pattern for SQLite. Rate
  limiting, backoff (`calculateRetryBackoffMs` @174 caps the exponent at 30 to avoid
  overflow), starvation avoidance, and security fail-closed (`signing_secret_unavailable`)
  are all real.
- **Crypto** — `src/secret-protection.ts` (AES-256-GCM, 12-byte nonce, auth-tag verified
  before plaintext is returned), `src/webhooks.ts` (HMAC-SHA256, `timingSafeEqual` with
  length guard), `src/auth.ts` (SHA-256-hashed admin token compared with `timingSafeEqual`;
  API keys stored only as hashes). Textbook-correct choices.

### Clients

- **TypeScript SDK + CLI** (`src/client.ts`, `src/cli.ts`): real `fetch`, Bearer auth, typed
  `PosthornApiError` with a closed error-code union. CLI does not shell out; it constructs the
  SDK and never echoes secrets (test-enforced). Route tables (`POSTHORN_CLIENT_ROUTES`, etc.)
  are pinned ⊆ `IMPLEMENTED_ROUTES` by tests, so client/CLI/OpenAPI cannot silently diverge.
- **Python SDK** (`clients/python/posthorn/`): real, std-lib-only, with a deliberate
  no-redirect opener (`_NoRedirectHandler`) to avoid bearer-token leakage on 3xx, and
  `hmac.compare_digest` (constant-time) in `webhooks.py`. **But it is a partial mirror** —
  missing `getEndpoint`/`updateEndpoint`/`deleteEndpoint`/`rotateEndpointSecret`/`testEndpoint`,
  all event-type methods, `listMessages`, `createPortalSession`, and the **entire admin
  client**. No automated TS↔Python parity gate exists. There is no root `pyproject.toml`, so
  `verify.sh`'s `pytest` step is skipped; all Python coverage rides on one vitest subprocess
  test (`tests/python-client.test.ts`) that spawns a real interpreter.

### Charts + Docker

- `Dockerfile`: multi-stage, `node:24-bookworm-slim`, `npm ci --ignore-scripts`,
  `npm prune --omit=dev`, runs as `USER node`, `VOLUME /data`, real `HEALTHCHECK`. Good.
- `docker-compose.yml`: loopback-bound ports, `no-new-privileges`, **mandatory**
  `POSTHORN_ADMIN_TOKEN` (`:?` fail), bundled Prometheus. Good.
- `charts/posthorn/` (Helm): `runAsNonRoot`, `readOnlyRootFilesystem`, `allowPrivilegeEscalation:
  false`, `capabilities.drop: [ALL]`, PVC-backed persistence, admin token from a Secret. This
  is a single-pod SQLite reference — **not** horizontally scalable (one writer, one PVC), and
  the README/chart are honest about that.

---

## Code quality & correctness (file:line)

The product code is high quality. Findings, worst-first:

1. **README documents a library/embedding API that does not exist (vaporware).**
   `README.md` §"Embedding as a Library" shows `gateway.apps.create(...)`,
   `gateway.apps.createApiKey(...)`, and claims `gateway.apps`, `gateway.messages`,
   `gateway.endpoints`, `gateway.queue` stores are "usable independently." The actual
   `Gateway` interface (`src/gateway.ts:78-83`) is only `{ serviceName, config, start, stop }`.
   None of those store objects or methods exist anywhere in `src/`. This is the single
   clearest false claim in the repo. (Real embedding is possible via `startPosthornServer`
   and the exported functional API — `createAdminApp(storage, …)` etc. — but not the
   documented object surface.) **Fixed in the rewritten README.**

2. **Dead/no-op code: `parseScope`.** `src/portal-sessions.ts:159-161`:
   `return value === 'endpoint_management' ? 'endpoint_management' : 'endpoint_management';`
   — both ternary branches return the same literal, so the stored `scope` column is ignored
   entirely. Harmless today (one scope exists) but a latent privilege bug the moment a second
   scope is added.

3. **`migrate*Columns` boilerplate** in `src/storage.ts:214-313` — six near-identical
   functions, each re-reading `PRAGMA table_info`. Correct, but a clear DRY target; a single
   `ensureColumns(table, columns)` helper would remove ~70 lines.

4. **Hand-rolled route dispatch** (`src/gateway.ts:206-337` + `*FromPath` regexes @958-1017
   + the `write*Error` family @1140-1222) is boilerplate-heavy and the obvious refactor target
   if the route count keeps growing. Not a bug; a maintainability cost.

5. **OpenAPI schema drift risk.** `tests/openapi-contract.test.ts` enforces _operation-set_
   and _error-code-set_ equality against the live server (a genuine contract test), but the
   per-route request/response **schemas** in `src/openapi.ts` are hand-written and are not
   proven to match handler payload shapes. A handler could change its response body without
   failing the contract test.

No `TODO`/`FIXME`/`stub`/`not implemented` markers exist in `src/`. No swallowed errors of
concern (every `catch {}` is intentional cleanup or a typed 4xx). SQL is parameterized
everywhere; the only dynamic SQL is hardcoded column-name lists in `updateAdminApp`/
`updateEndpoint`, never user values.

---

## Tests — real or theater?

**Real.** This is among the better AI-generated suites I have reviewed: 26 files, ~9,473 LOC,
167 `it()` blocks, ~1,241 `expect()` (~7.4 assertions/test). **Zero** `.skip`/`.only`/`.todo`,
zero commented-out assertions, no tautologies, no asserting-on-mocks-only.

- **18 of 26 files stand up a real in-process gateway** (`createGateway`/`startPosthornServer`)
  and hit it over **real `fetch` on a real socket**. The DB is **real `node:sqlite` `:memory:`**
  everywhere; tests reach into `storage.db.prepare(...)` to assert persisted ciphertext columns
  (e.g. `tests/endpoints-http.test.ts:97-115`).
- **`tests/worker.test.ts`** (1,155 LOC, 28 tests) is the crown jewel: it boots a **real
  receiver HTTP server** and exercises backoff, dead-lettering, throttle windows, starvation
  avoidance across 20 endpoints, lease reclaim, timeout→retry, redirect refusal, response-body
  cancellation, auto-disable (5 negative cases), and security fail-closed — with real negative
  tamper checks on signatures.
- **`tests/webhooks.test.ts`** uses hardcoded known-answer HMAC vectors and byte-level
  Buffer/Uint8Array sensitivity — real cryptographic testing.
- **`tests/python-client.test.ts`** spawns a real Python interpreter against the live gateway
  and **throws if Python is absent** (does not silently skip) — a true cross-language contract.

The honest caveat: **~10–12% of the suite is artifact/doc string-matching, not behavior.**
Four files import nothing from `src/` and only `readFileSync` + `.toContain`:

| File | LOC | tests | `.toContain` |
| --- | --- | --- | --- |
| `helm-chart.test.ts` | 129 | 5 | 59/60 |
| `deployment-artifacts.test.ts` | 90 | 4 | 54/54 |
| `parity-doc.test.ts` | 163 | 6 | 22/42 |
| `monitoring-artifacts.test.ts` | 86 | 3 | 16/20 |
| **total** | **468 (~4.9%)** | **18 (~11%)** | — |

These verify that YAML/Dockerfile/markdown contain (or don't leak) specific strings. They are
competently written drift-guards (they assert negatives — no `phk_`/`whsec_` leakage, no
overclaiming `redis`/`postgres`; `monitoring-artifacts` JSON-parses the Grafana dashboard and
asserts the referenced metric set _exactly_ equals the implemented set) but they are not
behavioral tests. `parity-doc.test.ts` in particular tests a _marketing comparison document_,
not code.

**Load-bearing estimate: ~88%.** Verdict: a genuinely strong, behavior-driven suite with a
small, defensible slice of doc-assertion filler.

---

## Security & data handling

Overall: **real protections, one architectural weakness.** Crypto choices are correct
throughout; `timingSafeEqual`/`compare_digest` are used at every secret comparison; CSPRNG
(`randomBytes`) for every key/token/nonce; SQL is fully parameterized; SSRF is guarded.

- **(HIGH) Encryption master key co-located with ciphertext.** `src/secret-protection.ts:75-84`
  (`getOrCreateLocalKey`) generates a random 32-byte AES key and stores it via `INSERT OR
  IGNORE INTO local_secret_keys` — _in the same SQLite file_ as the endpoint/app signing-secret
  ciphertext it protects. There is **no** env/KMS hook to supply the key externally (confirmed:
  no encryption-key env var in `src/config.ts`). So "encryption at rest" defends only against a
  partial logical read (e.g. a SQLi dump that misses one table), **not** against anyone who has
  the DB file or disk. Upside: no hardcoded/default/shared dev key ships — every install
  generates its own. This is the top fix.
- **(MEDIUM) SSRF residual: DNS rebinding / TOCTOU.** `parseEndpointUrl`/`isInternalHostname`
  (`src/endpoints.ts:371-451`) block localhost/`.local`/`.internal`/single-label hosts and a
  thorough private IPv4/IPv6 range set, at both create and update, and the worker uses
  `redirect: 'manual'` (`src/worker.ts:470`) so 3xx-to-internal isn't followed. But validation
  is on the _hostname string at config time_; the worker re-resolves DNS at delivery time with
  no pinning. A name that resolved public at create time can later resolve to `169.254.169.254`.
  The denylist is also string/parse-based, so exotic IP encodings that `new URL` accepts could
  slip past unless `node:net` normalizes them.
- **(LOW) `/metrics` is unauthenticated by design.** Aggregate, low-cardinality counters only
  (no tenant IDs/URLs/secrets — verified by `monitoring-artifacts.test.ts`). Acceptable, but
  the `0.0.0.0` default bind (`src/config.ts:23`) means an operator who exposes the port
  without a network policy leaks instance-aggregate volume. Compose/Helm bind loopback/ClusterIP,
  so defaults-in-practice are safe.
- **(LOW) `parseScope` ignores stored scope** (see Code quality #2) — latent, not yet exploitable.
- **Auth has no backdoor / default-allow.** Missing admin token → `authenticateAdminToken`
  returns `false` (`src/auth.ts:63`) and admin routes 404. Admin token has a 16-char floor
  (`src/config.ts:38`). No `DANGEROUSLY_` bypass exists for auth. Tenant scoping is consistently
  enforced by `appId` filtering, so cross-tenant reads are not possible.
- **Replay protection** present (±300s timestamp tolerance, `src/webhooks.ts`); there is no
  server-side nonce cache, matching the Standard Webhooks spec (receivers dedupe on
  `webhook-id`).

---

## Unmerged branches

**This is the headline systemic finding.** There are **18 unmerged remote branches** (the
two non-product remote branches — `chore/model-policy-june-2026` and the merged
develop-tracked ones — are already in `develop`). Every reviewed branch was committed on
**2026-06-11**, is **~85 commits behind `develop`**, and — critically — was cut against the
**pre-rewrite modular architecture** (`src/queue/`, `src/billing/`, `src/dashboard/handler.ts`,
`src/http/api.ts`, `src/system-events/`). **Every file these branches touch is GONE from
`develop`** (verified with `git cat-file -e develop:<path>` — all return "GONE"). They cannot
be merged, rebased, or cherry-picked without a full rewrite against the new layout, and most of
the _ideas_ are already moot or were never sound.

Two whole sub-themes are dead on arrival regardless of layout:
- **The "fix Secure cookie attribute" branches** fix a vulnerability in session-cookie code
  that **no longer exists** — current Posthorn sets **no cookies at all** (the only
  `cookie`/`set-cookie` strings in `src/` are in the endpoint header _denylist_). Dashboards
  are static shells using Bearer tokens.
- **The "parallelize queue retries with `Promise.all`" branches** would convert a deliberately
  serialized loop into concurrent writes — against an embedded single-writer SQLite DB that is
  the opposite of what you want. Even on the old code these were dubious.

| Branch | What it does | Quality | Recommendation |
| --- | --- | --- | --- |
| `jules-14114376179219540410-9e6a39ce` | "architectural health check + telemetry"; adds `bench/fuzz/`, `plan/specs/`, rewrites old `src/http/api.ts` + `src/worker/delivery-worker.ts` (469 LOC churn) | Dead — targets removed `src/http`, `src/worker/`; mixes plan docs with code | **Abandon** |
| `jules-16093478213463828521` | Tiny edits across `src/http`, `src/queue`, `src/sdk`, `src/storage`; commit msg "Acknowledging PR closure" | Dead — already self-acknowledged closed; files gone | **Abandon (delete)** |
| `fix-secure-cookies-12621239021464708045` | Add `Secure` to session cookies in `src/dashboard/`, `src/portal/` | Dead — no cookies exist anymore; files gone | **Abandon** |
| `fix/cookie-secure-attribute-9649095602443010258` | Same fix, leaner (no test files) | Dead — duplicate of the above; files gone | **Abandon** |
| `jules-12633352851970186916-85cc8dc4` | `Promise.all` on `src/queue/retry-app.ts`+`retry-message.ts` | Dead + wrong idea (concurrent SQLite writes); files gone | **Abandon** |
| `perf-retry-message-17142870735697212356` | `Promise.all` batch on `retry-message.ts` | Dead + wrong idea; files gone | **Abandon** |
| `performance-improve-queue-retry-concurrency-13574057378926878238` | Concurrent retry-app/retry-message | Dead + wrong idea; files gone | **Abandon** |
| `jules-3616429161098162028-5b310ee4` | Concurrent retry + cancel-message | Dead + wrong idea; files gone | **Abandon** |
| `jules-5876443510078069307-ff8a6bca` | Concurrent bulk retries + `pr_description.md` | Dead + wrong idea; files gone | **Abandon** |
| `jules-15744721551443159625-6373e1e8` | retry-app concurrency; "Acknowledge obsolete PR closure" | Dead — self-acknowledged obsolete | **Abandon (delete)** |
| `jules-perf-optimize-retries-10420574192359177556` | Concurrent retries (2 dup commits) | Dead + wrong idea; files gone | **Abandon** |
| `jules-optimize-cancel-message-9113223768473199127` | Reorder `cancel-message.ts` | Dead; file gone | **Abandon** |
| `fix/n-plus-one-query-tenant-dashboard-7585570271790670955` | Fix N+1 in `src/dashboard/tenant-handler.ts` (10 LOC) | Dead — file gone. **Idea worth re-checking** against current `src/dashboard.ts`/`messages.ts` for a real N+1 | **Abandon branch; re-evaluate the idea fresh** |
| `jules-optimize-tenant-handler-17752217191181656008` | Only adds `dummy-submit.py` (2 lines); "Preserve branch as archive" | Junk — no real change | **Abandon (delete)** |
| `test-billing-provider-1867712393725636274` | Tests for `src/billing/index.ts` + `pr_description.md` | Dead — billing module removed in rewrite | **Abandon** |
| `jules-5287189669532334063-b24b1fe2` | Tests for `createBillingProvider` + `pr_description.txt` | Dead — duplicate; billing gone | **Abandon** |
| `jules-add-systemEventTransportFrom-tests-17576351816775455343` | Tests for `systemEventTransportFrom` | Dead — `src/system-events/` removed | **Abandon** |
| `fix-testing-gap-9769365040422560746` | Adds top-level `plan.md` + `run_test.ts` | Junk — stray scratch files, no src change | **Abandon (delete)** |

**Net: 0 of 18 branches are mergeable or salvageable as-is.** At most _one idea_ (the tenant
dashboard N+1) is worth re-investigating from scratch against the current code; everything else
should be deleted. This represents a large amount of agent compute that produced zero shippable
output and was never garbage-collected — a process failure, not a code failure.

---

## Tech debt & risks (ranked)

1. **Branch graveyard (process risk, HIGH).** 18 stale, un-mergeable bot branches. They bloat
   the remote, mislead anyone scanning for "in-flight work," and signal that the agent fleet
   spawned external bots (`jules`) against a moving target with no cleanup loop. Delete all 18;
   add a branch-pruning step to the ops cadence.
2. **Encryption key in the database (security, HIGH).** See Security. Move it to env/KMS.
3. **README oversells (trust, HIGH).** The non-existent library/embedding API. Fixed here, but
   indicative — claims should be code-verified before they ship to a README (the repo has the
   tooling to do this; `parity-doc.test.ts` proves it).
4. **SSRF DNS-rebinding gap (security, MEDIUM).** Pin/re-validate the resolved IP at delivery.
5. **Python SDK partial + ungated (correctness, MEDIUM).** Missing ~half the surface and the
   entire admin client, with no parity test. It will silently rot relative to the TS client.
6. **OpenAPI schema-vs-handler drift (MEDIUM).** Operation/error sets are pinned; body schemas
   are not.
7. **Single-writer scaling ceiling (architecture, MEDIUM-LONG).** SQLite + one PVC = no
   horizontal scale-out. Honestly documented, but it is the product's eventual wall; the
   discarded modular layout had a Postgres path that was thrown away.
8. **`0.0.0.0` default bind (LOW).** Safe in the provided Compose/Helm, risky for a naive bare
   `docker run`/`node` operator.
9. **Boilerplate (LOW).** Route dispatch + migration helpers are copy-paste-heavy.
10. **`parseScope` no-op (LOW, latent).**

---

## Top 5 to fix first

1. **Delete all 18 stale remote branches** and add a recurring branch-pruning step (close+delete
   any branch >N commits behind `develop` or targeting removed paths). Highest ratio of cleanup
   to effort; removes the most misleading artifact in the repo.
2. **Move the AES master key out of SQLite** — env-supplied key or KMS (with a `DANGEROUSLY_`-named
   in-DB fallback only for dev). Makes encrypt-at-rest actually meaningful.
3. **Rewrite the README "Embedding as a Library" section** to the real exported API
   (`startPosthornServer` + functional `createAdminApp`/`acceptMessage`/… on `storage`), or build
   the documented store objects. No fictional APIs in the README. _(Done in this pass.)_
4. **Close the SSRF DNS-rebinding gap** — resolve the host at delivery time and re-check the IP
   against the private-range denylist before connecting.
5. **Either finish the Python SDK to TS parity + add a parity gate, or scope it down in the docs.**
   No half-claimed SDK without a test that holds it to the claim.
