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