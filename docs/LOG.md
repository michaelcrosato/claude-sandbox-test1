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

## 2026-05-24T18:45 · iter-0083 · GREEN · openapi-surface-url-not-allowed-400

- **Baseline:** clean main @ `5369313` (iter-0082 system-event per-attempt timeout). Verified green
  first: `tsc --noEmit` 0, `vitest run` **1630/1630** (49 files, 6 PG-skipped, no flaky exit),
  `npm run build` 0, `assert-gate-integrity.ps1` 0.
- **Move:** Close the API-contract gap deferred three times (iter-80/81/82 Next): the SSRF guard
  added a real `400 url_not_allowed` error code on the four URL-accepting routes, but the published
  OpenAPI never documented it — clients/codegen couldn't branch on a code the API actually returns.
- **Changed:**
  - `src/http/openapi.ts`: new `urlGuardedErrorResponse(description)` helper — one shared definition
    for the four routes that run `assertUrlDeliverable`, so their 400 wording can't drift apart. It
    appends the `url_not_allowed` condition to the description (human-facing) **and** attaches a
    concrete `application/json` envelope `example` (machine/codegen-facing) showing the exact shape.
  - Applied it to the four 400s: `POST /v1/endpoints`, `PATCH /v1/endpoints/{id}`,
    `POST /v1/admin/apps`, `PATCH /v1/admin/apps/{id}`.
  - Added `url_not_allowed` to the shared `Error.code` `examples` enum (the discoverability list).
  - Tests: +3 (`openapi.test.ts`) — code is in the Error enum; every URL-guarded route's 400 carries
    both the description mention and the `url_not_allowed` example; and a **reverse** guard that no
    other route's 400 falsely claims `url_not_allowed`.
- **Decisions:** Doc/spec only — zero product-code or runtime change (lowest risk; the green code
  baseline stands). Shared helper over four hand-edited strings to enforce the repo's "one source of
  truth, can't drift" discipline. Example message mirrors the real `BlockedUrlError` text. Reverse
  guard prevents over-claiming the code on unguarded routes.
- **Validation:** `tsc --noEmit` 0; `vitest run` **1633/1633** (+3, 6 PG-skipped); `npm run build` 0;
  `assert-gate-integrity.ps1` 0 (zero substrate edits); compiled-`dist` ESM smoke **PASS** (the built
  `openapi.js` carries the code in `Error.code` and the desc+example on all four 400s).
- **Next:** Connect-vs-total split on the delivery timeout (Svix exposes both; today one deadline
  spans DNS+connect+response) — iter-82 Next #2; or a `code`-enumerating error-table in the README so
  the human docs match the OpenAPI `Error.code` list.

## 2026-05-24T18:25 · iter-0082 · GREEN · system-event-delivery-per-attempt-timeout

- **Baseline:** clean main @ `546c94d` (iter-0081 two-layer SSRF guard on system-webhook URLs).
  Verified green first: `tsc --noEmit` 0, `vitest run` **1626/1626** (6 PG-skipped), `npm run
  build` 0, `assert-gate-integrity.ps1` 0, `validate-log-compliance.py` `[PASS]`.
- **Move:** Close iter-0081 Next #2 — **system-event delivery had no per-attempt timeout.** The
  tenant delivery path wraps every send in the worker's `#send` (`AbortController` +
  `setTimeout(requestTimeoutMs)`), but the `endpoint.disabled` / `message.dead_lettered`
  notification path passed **no signal**, so `systemEventTransportFrom` substituted a
  *never-aborting* signal — a system-webhook receiver that accepts the TCP connection but never
  responds would pin a socket open indefinitely. Bring system events to delivery-path parity.
- **Changed:**
  - `src/system-events/index.ts`: `systemEventTransportFrom(transport, options?)` gains an optional
    `timeoutMs` (`SystemEventTransportOptions`). When `> 0` and the caller supplies no signal, the
    request is bounded by an `AbortController` + `setTimeout` cleared on settle (the worker's exact
    `#send` idiom). A caller-supplied signal still wins (forwarded unchanged); `timeoutMs ≤ 0`
    preserves the prior never-abort fire-and-forget behavior.
  - `src/runtime/gateway.ts`: the single system-event transport instance now passes
    `timeoutMs: config.worker.requestTimeoutMs` — both emit paths inherit the worker's per-attempt
    deadline through one wiring point.
  - Tests: +4 (`system-events.test.ts`) — timeout aborts a hung transport (fake timers), the timer
    is cleared so a finished request never aborts late, a caller signal overrides the timeout, and
    `timeoutMs:0` stays never-abort.
- **Decisions:** Reused `config.worker.requestTimeoutMs` rather than adding a config knob — a system
  event is a webhook POST like any other, same deadline semantics, and **no new env var** means no
  config-docs drift (iter-77 guard). Timeout lives in the transport adapter, not each emit helper, so
  both paths are covered at one seam. No unref on the timer (matches the worker's `#send`; it is
  always cleared on settle).
- **Validation:** `tsc --noEmit` 0; `vitest run` **1630/1630** (+4, 6 PG-skipped); `npm run build`
  0; `assert-gate-integrity.ps1` 0 (zero substrate edits); `validate-log-compliance.py` `[PASS]`;
  compiled-`dist` ESM smoke **5/5** (hung receiver aborts at ~50ms; finished request not aborted
  after the deadline; `timeoutMs:0` never aborts — all via `dist/system-events/index.js`).
- **Next:** Surface `url_not_allowed` in the OpenAPI 400s for endpoint + admin-app create/update
  (iter-80 Next #2 / iter-81 Next #1, still open); or a connect-vs-total split on the delivery
  timeout (today one deadline covers DNS+connect+response — adequate, but Svix exposes both).

## 2026-05-24T18:05 · iter-0081 · GREEN · ssrf-guard-on-system-webhook-urls

- **Baseline:** clean main @ `3fe6366` (iter-0080 connection-time SSRF guard on delivery).
  Verified green first: `tsc --noEmit` 0, `vitest run` **1610/1610** (6 PG-skipped; a one-off
  tinypool "Worker exited unexpectedly" cleared on re-run), `npm run build` 0,
  `assert-gate-integrity.ps1` 0, `validate-log-compliance.py` `[PASS]`.
- **Move:** Close the parallel SSRF residual iter-80 named as Next #1. The app's **system
  webhook URL** (operator-set via `POST/PATCH /v1/admin/apps`, fired on `endpoint.disabled` /
  `message.dead_lettered`) had **neither** guard: registration accepted any http(s) URL incl.
  private, and delivery used a plain redirect-following `fetch` — while tenant endpoint URLs
  already have both the registration (iter-78) and connection-time (iter-80) layers. Apply
  Posthorn's existing two-layer defense to the system-webhook path for full parity.
- **Changed:**
  - `src/system-events/index.ts`: new `systemEventTransportFrom(transport)` adapts a delivery
    `Transport` into a `SystemEventTransport`, so system events ride the guarded transport
    (connection-time resolved-IP check + no redirect-following). System events are POST and
    fire-and-forget → a never-aborting signal is supplied when none is passed; a block rejects
    and is absorbed by the worker's `onError` seam (unchanged from the prior fetch, which also
    threw). Type-only `Transport` import (no runtime coupling/cycle).
  - `src/runtime/gateway.ts`: replaced the plain-`fetch` `systemEventTransport` with
    `systemEventTransportFrom(deliveryTransport)` — both delivery paths now share one guarded
    transport and the single `allowPrivateNetworks` opt-out.
  - `src/http/api.ts`: registration guard — `assertUrlDeliverable(systemWebhookUrl, ssrfPolicy)`
    in admin `createApp`/`updateApp` when the value is a non-null string (`BlockedUrlError` →
    `400 url_not_allowed`; null/non-string defers to the store's syntactic validation). Mirrors
    the endpoint guard at lines 1347/1388.
  - Tests: +5 system-events (adapter forward/signal-default/signal-forward/reject + a
    connection-time block propagating through the real guarded transport) and +11 api (6 admin
    create block vectors, update→internal block, public allow on create+update, null clear,
    opt-out allow, invalid-URL→generic 400). These are also the first coverage of setting
    `systemWebhookUrl` via the admin API surface.
- **Decisions:** Two-layer parity over connection-guard-only — avoids a "saves 201 but silently
  fails at delivery" asymmetry. Reused the existing guarded transport instance (**zero new
  deps**). Secure-by-default block; an operator who points a system webhook at internal alerting
  flips the same documented `POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS=true` (governs both paths).
  Guard kept at the API boundary, not inside pure `normalizeSystemWebhookUrl`, so the trusted
  CLI/library path stays unconstrained (same model as iter-78). Helper stays internal —
  `system-events` is not a public `index.ts` export.
- **Validation:** `tsc --noEmit` 0; `vitest run` **1626/1626** (+16; 6 PG-skipped, no flaky exit
  on the full run); `npm run build` 0; `assert-gate-integrity.ps1` 0 (zero substrate edits);
  `validate-log-compliance.py` `[PASS]`; compiled-`dist` ESM smoke **2/2** (system event to a
  metadata-resolving host blocked with `BlockedUrlError`; loopback delivered under the opt-out).
- **Next:** Surface `url_not_allowed` in the OpenAPI 400s for endpoint + admin-app create/update
  (iter-80 Next #2, still open); or add a per-attempt request timeout to system-event delivery
  (it currently has none — the never-abort signal preserves prior behavior).

## 2026-05-24T17:45 · iter-0080 · GREEN · connection-time-ssrf-guard-on-delivery

- **Baseline:** clean main @ `a501770` (iter-0079 hex/NAT64 SSRF fix). Verified green first:
  `tsc --noEmit` exit 0, vitest **1585/1585** (6 PG-skipped), `npm run build` exit 0,
  `assert-gate-integrity.ps1` exit 0.
- **Move:** Close the explicitly-documented SSRF residual — a *hostname* that resolves (or rebinds)
  to a private/internal IP, invisible to the registration-time literal-host guard, which cannot do
  DNS. Add a connection-time resolved-IP check on the actual delivery path.
- **Changed:**
  - `src/net/guarded-lookup.ts` (new): `createGuardedLookup(policy, resolver?)` builds a Node
    `lookup` for `http/https request({lookup})`. Resolves all addresses, blocks the connection if
    **any** is private/internal (fail-closed vs round-robin/0-TTL rebinding), else hands Node the
    resolved set so it connects without re-resolving — no TOCTOU window. Pass-through under the
    `allowPrivateNetworks` opt-out; genuine resolution errors surface unchanged.
  - `src/net/guarded-transport.ts` (new): `createGuardedTransport(policy)` — a `Transport` over
    built-in `node:http/https` (**zero new deps**, preserving the no-deps wedge; `undici` is not
    importable here). Same `HttpDeliveryResponse` contract as `fetchTransport`; additionally refuses
    private resolved IPs and does **not** follow redirects (closes a 3xx→internal SSRF hop that
    `fetch` auto-following allowed).
  - `src/runtime/gateway.ts`: worker + test-send (`POST /v1/endpoints/:id/test`) now use the guarded
    transport, built from `config.allowPrivateNetworks`.
  - `src/net/ssrf-guard.ts`: module doc updated to the two-layer model; `src/index.ts`: export the
    two factories. +25 tests (lookup decisions via fake resolver; transport over a real loopback
    receiver incl. hostname block + pinned-delivery).
- **Decisions:** node:http+lookup over adding `undici` (dep cost) or resolve-then-fetch (TOCTOU /
  HTTPS-SNI-breaking). Connection guard shares the single `allowPrivateNetworks` opt-out — when set,
  both layers pass-through (tests run that way, unaffected). Literal-IP hosts skip DNS, so the
  connection guard covers only hostnames (literals stay the registration guard's job).
- **Validation:** `tsc --noEmit` 0; `vitest run` **1610/1610** (+25, 6 PG-skipped); `npm run build`
  0; `assert-gate-integrity.ps1` 0 (zero substrate edits); compiled-`dist` ESM smoke 4/4 (metadata +
  RFC1918 rebind blocked; opt-out + literal-IP deliver).
- **Next:** Extend the guard to the system-event transport (app-configured system-webhook URLs are
  also remotely-influenced); surface `url_not_allowed`/blocked-resolution in the OpenAPI 400s.

## 2026-05-24T17:21 · iter-0079 · GREEN · close-ipv6-embedded-ipv4-ssrf-bypass

- **Baseline:** clean main @ `0bc883a` (iter-0078 SSRF guard). Code baseline verified green first:
  `tsc --noEmit` clean, vitest **1570/1570** (6 PG-skipped, no flaky exit), `npm run build` clean,
  `assert-gate-integrity.ps1` + `validate-log-compliance.py` PASS.
- **Move:** Close a live, exploitable bypass *inside* the SSRF guard iter-78 just shipped. The IPv6
  classifier only unwrapped IPv4-mapped addresses in dotted form (`::ffff:127.0.0.1`); the
  equivalent all-hex spelling slipped through. Confirmed against compiled `dist`:
  `http://[::ffff:a9fe:a9fe]/` (== cloud metadata `169.254.169.254`) and `::ffff:7f00:1`
  (== `127.0.0.1`) were reported **deliverable** — the exact target the guard exists to block.
- **Changed:**
  - `src/net/ssrf-guard.ts`: new pure `expandIpv6` expands any literal to its 8 hextets (resolves
    `::`, folds a trailing dotted-quad to hex). `isBlockedIpv6` rewritten to classify on the
    expanded bits, routing every embedded-IPv4 form — IPv4-mapped (`::ffff:0:0/96`), deprecated
    IPv4-compatible (`::/96`), NAT64 (`64:ff9b::/96`) — through `isBlockedIpv4` in *any* spelling;
    link-local/ULA/multicast become exact masked-prefix checks; an unparseable literal fails closed.
    Module-doc Limitations updated (hex caveat removed; DNS-rebinding gap retained).
  - `src/net/ssrf-guard.test.ts`: +15 golden vectors — hex mapped loopback/private/metadata,
    fully-expanded form, compatible + NAT64, uppercase; public hex-mapped + NAT64 still permitted;
    fail-closed cases; two URL-level regressions (`http://[::ffff:a9fe:a9fe]/…`).
- **Decisions:** Expand-then-classify over more string regexes — judging actual bits is spelling-
  independent and kills the whole bypass class, not just the one reported form. NAT64 included (real
  translation prefix; fail-closed for a private low-32). Public embedded v4 (`::ffff:8.8.8.8`) stays
  deliverable — extract-and-classify, never block all of `::/96`. Signature unchanged; only
  re-exported via `index.ts`, so no delivery-path caller churn.
- **Validation:** `tsc --noEmit` exit 0; `vitest run` **1585/1585** (+15; 6 PG-skipped, no flaky
  exit); `npm run build` exit 0; compiled-`dist` ESM probe: the 3 hex/NAT64 SSRF targets now
  blocked, public mapped + named still deliverable; `assert-gate-integrity.ps1` exit 0 (zero
  substrate edits); `validate-log-compliance.py` `[PASS]`.
- **Notes:** Registration-time, literal-host scope is unchanged — this hardens the existing guard,
  it does not widen where it runs.
- **Next:** Connection-time resolved-IP check (DNS-rebinding defense) via an undici `lookup`/connect
  hook — the remaining documented SSRF residual; or surface `url_not_allowed` in the OpenAPI 400
  responses of endpoint create/update.

## 2026-05-24T17:12 · iter-0078 · GREEN · ssrf-guard-on-endpoint-urls

- **Baseline:** clean main @ `5eaab3b` (iter-0077 config-docs drift guard). Code baseline verified
  green first: `tsc --noEmit` clean, vitest **1469/1469** (6 PG-skipped, no flaky worker exit),
  `npm run build` clean, `assert-gate-integrity.ps1` + `validate-log-compliance.py` PASS.
- **Move:** Close a real, unaddressed security hole. Posthorn is a webhook *sender*, but the only
  endpoint-URL validation was "syntactically http(s)". A tenant could register
  `http://169.254.169.254/…` (cloud metadata), `http://localhost:6379/`, `http://10.0.0.5/`, or
  `http://redis/` and coerce the gateway into requests against the operator's private network —
  textbook SSRF, which every incumbent (Svix/Hookdeck/Convoy) blocks and which is a showstopper for
  the hosted/multi-tenant P5 control plane that is the monetization path.
- **Changed:**
  - New pure, zero-dep `src/net/ssrf-guard.ts`: classifies a URL host (literal IPv4/IPv6 incl.
    IPv4-mapped, or a hostname) against loopback / RFC-1918 / link-local (incl. the metadata
    address) / CGNAT / unique-local / multicast ranges + internal names (`localhost`,
    `*.local`/`*.internal`, bare single-label). `assertUrlDeliverable`/`isUrlDeliverable`/
    `BlockedUrlError` (+77 unit tests).
  - Enforced at the **untrusted registration boundary only** — endpoint create/update on the JSON
    API (`BlockedUrlError`→`400 url_not_allowed` via `toErrorResponse`) and the always-on portal
    (inline error). Delivery/test run on already-validated stored URLs (a coherent "validate at
    registration" model: no silent on-upgrade delivery breakage, no resolver/worker churn).
  - Config `POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS` (new `readBool`; default **false** =
    secure-by-default block) on `GatewayConfig.allowPrivateNetworks`, threaded into ApiDeps +
    PortalDeps by the gateway; exported from `index.ts`; documented in `.env.example` +
    `docs/DEPLOY.md` (forced by iter-77's config-docs drift guard).
  - Tests: 3 e2e config helpers + 2 ad-hoc smokes opt out (loopback receiver = trusted in-test);
    api + portal suites cover block/allow/non-url-patch/invalid-url.
- **Decisions:** Secure-by-default block — the dangerous deployment is multi-tenant; a self-hoster
  flips one documented env var. Guard at registration, not delivery — avoids dead-lettering
  intentional internal endpoints on upgrade and leaves the trusted CLI/library path unconstrained.
  Distinct `url_not_allowed` code so clients separate an SSRF block from generic validation.
  Literal-host only — DNS-rebinding is a documented residual gap and a Next.
- **Validation:** `tsc --noEmit` exit 0; `vitest run` **1570/1570** (+101; 6 PG-skipped, no flaky
  exit); `npm run build` exit 0; `assert-gate-integrity.ps1` exit 0 (zero substrate edits);
  `validate-log-compliance.py` `[PASS]`. Compiled-`dist` ESM smoke: guard blocks the 5 canonical
  SSRF targets, permits public + opt-out, config rejects a bad bool. `smoke-test-endpoint` and
  `smoke-portal-delivery` pass (loopback endpoint create 201/200 under the opt-out).
- **Notes:** Also fixed pre-existing `localhost`→`127.0.0.1` bit-rot in the two smokes I touched
  (the gateway binds IPv4; `localhost` resolved to a 404 path on this Windows box) — unrelated to
  SSRF. A Windows-only libuv teardown assertion still prints on those two after all checks pass.
- **Next:** Connection-time resolved-IP check (DNS-rebinding defense) via a custom undici
  `lookup`/connect hook; or surface `url_not_allowed` in the OpenAPI 400 responses of the endpoint
  create/update operations.

## 2026-05-24T16:52 · iter-0077 · GREEN · config-docs-drift-guard

- **Baseline:** clean main @ `2c6c952` (iter-0076 ledger migration). Code baseline verified green
  before change: `tsc --noEmit` clean, vitest **1435/1435**, `npm run build` clean.
- **Move:** Close the config↔docs drift on the self-host surface — three operator env knobs had
  landed in `loadConfig` but never reached the docs, making them invisible to self-hosters — and add
  a guard so it can never recur.
- **Changed:**
  - `.env.example`: added the three undocumented vars — `POSTHORN_MAX_BODY_BYTES`,
    `POSTHORN_RETENTION_DAYS`, `POSTHORN_DEFAULT_RATE_LIMIT` (with new retention + rate-limit
    sections); admin-token comment now states the **enforced** 16-char floor (was a false "32").
  - `docs/DEPLOY.md`: added `POSTHORN_DEFAULT_RATE_LIMIT` + `POSTHORN_RETENTION_DAYS` rows to the
    configuration reference; corrected the three "≥ 32 chars" admin-token claims to the enforced ≥ 16.
  - `src/runtime/config.test.ts`: new **config-documentation drift guard** — a `Proxy` probes
    `loadConfig` to capture the exact `POSTHORN_*` keys it reads (no hand-maintained list, no source
    parsing), then asserts each is documented in *both* `.env.example` and `docs/DEPLOY.md`, plus a
    reverse check that `.env.example` lists no var the loader doesn't recognize. +34 tests.
- **Decisions:** Proxy-capture over an exported constant — the guard verifies real loader behavior
  and needs **zero** production-code change (lowest risk). Forward guard against both docs; reverse
  guard only against `.env.example` (structured `VAR=` lines; DEPLOY prose names vars in many
  contexts → too noisy to invert). Corrected docs to the code's `MIN_ADMIN_TOKEN_LENGTH=16` (code is
  source of truth), not the reverse. Same "one source of truth, can't drift" discipline as the
  OpenAPI route table.
- **Validation:** `tsc --noEmit` exit 0; `vitest` **1469/1469** (was 1435; +34), 6 PG-skipped, no
  flaky worker exit; `npm run build` exit 0; `assert-gate-integrity.ps1` exit 0 (zero substrate
  edits); `validate-log-compliance.py` → `[PASS]`.
- **Notes:** Docs + test only; no product code touched, so the green code baseline above stands.
- **Next:** Portal endpoint-detail page should surface the *effective* rate limit (explicit vs.
  `POSTHORN_DEFAULT_RATE_LIMIT` fallback) — thread the gateway default into `PortalDeps`; or extend
  the drift guard to cover README config mentions.

## 2026-05-24T16:39 · iter-0076 · GREEN · migrate-ledger-to-canonical-log

- **Baseline:** clean main @ `1159d45` (operator substrate refresh). Code baseline verified green
  before any change: `tsc --noEmit` clean, vitest **1435/1435** (46 files, 6 Postgres-skipped, no
  flaky worker exit), `npm run build` clean.
- **Move:** Adopt the new substrate-mandated logging system — make `docs/LOG.md` the single
  operational ledger and retire the now-forbidden `docs/LOOP_LOG.md`.
- **Changed:**
  - `git mv docs/LOOP_LOG.md docs/log/2026-05.md` — 75 prior iterations (4916 lines / 354 KB)
    archived intact into the substrate's documented monthly-rotation path; git tracks it as a rename
    so blame/history are preserved.
  - Prepended a provenance banner to the archive noting the migration, the originating commit, and
    that the file is now read-only legacy history.
  - Recorded this iteration as the first entry of the new ledger below the `== LOG-ANCHOR ==`,
    conforming to the strict header schema (`iter-0076`, 4-digit id, `·`-delimited).
- **Decisions:** Archived rather than reconstructed — re-formatting 75 entries into the new schema
  would risk corrupting history and violate the "no free-hand rewrite of older entries" rule; the
  validator only scans `docs/LOG.md`, so the legacy-schema archive is compliant. Used the
  `docs/log/YYYY-MM.md` rotation path the substrate itself documents. Left `docs/GOAL.md` untouched
  (no `CURRENT_STATE` marker present → loop proceeds as active development; PROJECT.md is `DECIDED`).
  Left the lone historical `LOOP_LOG` mention in `PROJECT.md:595` intact (accurate past narrative).
- **Validation:** `python scripts/validate-log-compliance.py` → exit 0 `[PASS]`;
  `pwsh scripts/assert-gate-integrity.ps1` → exit 0 (substrate hashes intact, zero substrate edits);
  `pwsh scripts/local-gate.ps1` → clean workspace pass. Code baseline unchanged (docs-only).
- **Notes:** No product code touched; the green code baseline above stands. `docs/LOOP_LOG.md` no
  longer exists in the workspace, satisfying the new rule while Axiom 3 is honored via the archive.
- **Next:** Resume feature work under the iter-75 backlog — portal endpoint-detail page surfacing
  the effective rate limit (explicit vs. `POSTHORN_DEFAULT_RATE_LIMIT` fallback), or documenting the
  new env knob in the OpenAPI schema / README operator section.