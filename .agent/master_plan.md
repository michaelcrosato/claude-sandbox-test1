# Posthorn — Master Plan

- **Generated:** 2026-05-28 (read-only analysis + web research; no product code changed)
- **Repo:** `C:\dev\claude-sandbox-test1` · branch `maint/iter-0115` · `posthorn@1.0.0`
- **Posture:** This is a **planning artifact**, not an authorization to implement. The product
  backlog in `docs/GOAL.md` is **complete**; the autonomous lane is **hardening, agent-readiness,
  docs, and bounded maintenance** — NOT feature expansion. Feature gaps below are recorded as
  *human-gated*, not as agent tasks.
- **How to use:** the `# Execution /goal` block at the end is a self-contained `/goal` that works
  this backlog top-down, smallest-safe-increment first, re-reading this file each loop.

---

# Repo Baseline

### Purpose / value prop
Posthorn is open-core (MIT) **outbound webhook-delivery infrastructure**: a SaaS platform uses it
to send signed, retried, observable webhooks to *its* customers. The wedge is **operational
simplicity** — a single Node process backed by `node:sqlite` (no Redis, no required Postgres),
durable leased queue built in, also embeddable as a Node library. Optional Postgres backend for
active/active HA. Buyer: an indie/SMB engineering team that wants reliable webhooks without standing
up a broker.

### Current state (evidence-backed, 2026-05-28)
- **Feature-complete v1.0.** The 11-item commercial-readiness backlog in `docs/GOAL.md` is done
  through iter-0131 (git log: iters 0116→0131 map 1:1 to the backlog).
- **Gates green (run this session):** `npm run typecheck` clean · `npm test` **2063 passed / 6
  skipped (61 files, 20.77s)** · `npm run build` exit 0.
- **Security/deps:** `npm audit --omit=dev` → **0 vulnerabilities**. Zero runtime deps (`pg`
  optional). devDeps: typescript ^5.7, vitest ^2.1, @types/node, @types/pg.
- **Hygiene:** **0** `TODO`/`FIXME`/`HACK`/`XXX`/`@deprecated` in `src`.
- **Toolchain:** Node v24.15.0 / npm 11.14.1 local; CI Node 24.

### Repo map (top-level)
`src/` (product) · `clients/python/` (zero-dep Python SDK) · `deploy/helm/posthorn/` · `docs/`
(canonical substrate + ops) · `scripts/` (gate + agent + smokes + site/bench) · `tickets/` ·
`bench/` · `.github/workflows/ci.yml`. Generated/ignored: `dist/`, `site/`, `coverage/`, `*.db*`.

### Key files / commands
- Entry: `src/main.ts` (CLI + bootstrap), `src/index.ts` (library exports), `src/runtime/gateway.ts`
  (`createGateway`), `src/runtime/config.ts` (**authoritative** `POSTHORN_*` parsing).
- Datastore: `src/db/sqlite.ts` (shared PRAGMAs: WAL + synchronous=NORMAL + busy_timeout=5000).
- Commands: `npm run typecheck|test|build`, `npm run agent:check` (all three),
  `bash scripts/agent/{status,doctor,check}.sh`, `scripts/smoke-*.mjs` (manual dist smokes),
  `npm run bench`, `npm run build:site`. Canonical gate: `scripts/local-gate.ps1` (pwsh).

### Architecture (data flow)
```
producer ──POST /v1/messages──▶ [idempotency dedup] ──▶ Message store
                                                          │
                                                  Fanout (match endpoints by
                                                  eventType/channel filter)
                                                          │
                                              per-endpoint Delivery (leased queue task)
                                                          │
        ┌───────────────────────────── Delivery Worker ──┘
        │ claim lease → sign (HMAC-SHA256, Standard Webhooks) → SSRF-guarded POST
        │ (DNS-pin + connect-time guard + timeout; 3xx NOT followed) → record Attempt
        │ → fold endpoint health → success | retry (jittered backoff, ~8 tries/28h) | dead-letter
        ▼
   Prometheus /metrics + JSONL logs ; data-pruner retention sweep
```
Entities: `App`(tenant)→`ApiKey`; `App`→`Endpoint`(filter); `App`→`Message`→`Delivery`→`Attempt`;
`EventType` catalog (`schemaExample`); `Plan`(free/pro/scale entitlements); internal `system-events`.
Stores have a shared async contract + cross-backend `conformance.ts` (in-memory / SQLite / Postgres).

### The bespoke agent substrate (central constraint)
The repo runs its **own** autonomous loop. Canonical goal: `docs/GOAL.md`. **Hash-protected, never
edit** (`scripts/manifest.txt`): `docs/AXIOMS.md`, `docs/AGENT-LOOP.md`,
`scripts/{assert-gate-integrity,local-gate,run-autonomous-loop}.ps1`. **Never hand-edit**
`docs/LOG.md` (auto-managed). New portable scaffold (this session): `AGENTS.md`, `ROADMAP.md`,
`docs/ai/REPO_MAP.md`, `.aiignore`, `scripts/agent/*`, `tickets/`, thin root `GOAL.md`/`CLAUDE.md`.
On any conflict, **the substrate wins**.

### Risks / assumptions
- **ASSUMPTION:** "v1.0 feature-complete, harden-only" is the standing intent (per `docs/GOAL.md` +
  memory). All feature-shaped gaps are deferred to a human.
- **ASSUMPTION:** loop commits carry `(iter-NNNN)` + a `docs/LOG.md` entry; *this* out-of-loop work
  must NOT add an iter suffix and must NOT touch `docs/LOG.md`.
- **RISK:** Windows-primary dev; `scripts/agent/*.sh` need git-bash. `npm run agent:check` is the
  cross-shell fallback.

---

# Web Research Notes

All accessed 2026-05-28. Non-primary blog specifics flagged indicative. Full briefs in the three
research sub-reports that produced this section.

| Source | Date | Relevance | Takeaway | Plan impact |
| --- | --- | --- | --- | --- |
| svix/svix-webhooks README; svix.com/pricing | 2026-05-28 | Comparable | MIT server but **Postgres+Redis**; symmetric **+ ed25519 asymmetric**; 9+ SDKs; $490/mo | Asymmetric signing + SDK breadth = known gaps → **human-gated**, not agent work |
| frain-dev/convoy; getconvoy.io | 2026-05-28 | Comparable | **Elastic License v2** (not MIT); Go; PG+Redis; rate-limit/circuit-breaking, static IPs | Posthorn's true-MIT + single-binary is a real differentiator |
| hookdeck/outpost; hookdeck.com/pricing | 2026-05-28 | Comparable | Apache-2.0; Redis+PG+MQ; multi-destination (Kafka/SQS/S3…), full-text search, MCP server | Multi-destination/search are out-of-boundary (deliberate non-goals) |
| hook0/hook0 | 2026-05-28 | Comparable | **SSPL** (managed-restricted); Rust; PG15+ | License posture reinforces Posthorn's openness edge |
| agents.md (Agentic AI Foundation) | 2026-05-28 | Agent-readiness | AGENTS.md = open convention, **no formal schema**; rec. sections: overview, build/test, style, **security**; 60k+ repos; Codex reads it natively | Validate AGENTS.md has build/test/style/**security** sections; CLAUDE.md-as-pointer is correct |
| code.claude.com/docs best-practices | 2026-05-28 | Agent-readiness | "Give the agent a check it can run"; Stop hooks; cap turns; subagent self-review of the diff; explore→plan→code→commit | Gate IS the stop condition; add a code-reviewer subagent + worktree doc |
| Faros "Harness Engineering" | 2026-05-28 | Agent-readiness | Deterministic gates + **machine-readable** output; flaky tests erode the whole signal; show evidence not assertions | Add JSON/JUnit test output; de-flake the known tinypool flake |
| Node `sqlite` API docs (v22/v24/current) | 2026-05-28 | Stack/correctness | `node:sqlite` introduced **v22.5**; flag-free since 22.13/23.4; **Stability 1.1 (Node22) → 1.2 RC (Node24)**; pre-stable | **`engines.node>=20` is wrong** (code needs 22.5+); matrix the supported LTS lines; document RC status |
| Standard Webhooks spec | 2026-05-28 | Stack | `whsec_`/`whpk_`; HMAC-SHA256 over `id.ts.payload`; 300s window is **convention, not normative** | Posthorn's HMAC + 300s default is spec-correct; tolerance already configurable |
| OWASP SSRF Cheat Sheet / PortSwigger | 2026-05-28 | Security | **Connect-time** re-validation is the only reliable check; re-validate every redirect hop; allow-list > deny-list | Posthorn pins at connect-time AND **doesn't follow 3xx** → redirect-SSRF N/A (strength) |
| Prometheus naming/instrumentation; CNCF labels | 2026-05-28 | Observability | App-prefixed names; **bounded label cardinality** — keep IDs/URLs out of labels | Audit `/metrics` labels are bounded enums (per-endpoint stats live in the API, not labels) |
| npm supply-chain guides (Chainguard, THN) | 2026-05-28 | Security | Lockfile + `npm ci` + pin + OIDC trusted-publishing/provenance; cooldown on deps | Near-zero deps is the strongest mitigation; publish-with-provenance is a human/EXCLUSION step |
| TS ESM publishing (2ality, Liran Tal) | 2026-05-28 | Stack | `exports.types` must precede `import`; `.d.ts` must compile under varied consumer options | `package.json` ordering already correct; add a `.d.ts`-compiles smoke |

---

# Findings

Severity: **S1** correctness/contract · **S2** reliability/security hardening · **S3**
agent-readiness/docs · **S4** cosmetic. Confidence: H/M/L.

### Product
- **F-P1 (S3, H):** Feature gaps vs incumbents are **real but deliberate non-goals** — asymmetric
  (`whpk_`/ed25519) signing (confirmed absent: 0 matches for `whpk|ed25519|asymmetric|publicKey`),
  multi-destination sinks, payload transformations, FIFO ordering, mTLS/static-egress-IP, broader
  SDK languages. `docs/GOAL.md` product boundary excludes most; the rest are human-gated. *Evidence:*
  `docs/GOAL.md` "Product boundary"; research comparables. *Action:* record as human decisions; do
  not implement.
- **F-P2 (S3, H):** Five open **discovery questions** in `docs/GOAL.md` (public name, commercial
  path, metering unit, first deploy target, launch bar) gate any go-to-market work. *Action:*
  surface to human; not an agent task.

### Architecture / code quality
- **F-A1 (S4, H):** Architecture is stable, well-factored (per-subsystem dirs, three conformant
  store backends), zero `TODO`/`FIXME`. **Do not refactor without a concrete reason.** *Evidence:*
  `git grep` clean; `docs/ai/REPO_MAP.md`.
- **F-A2 (S2, H):** SQLite concurrency posture is **correct and deliberate** — `src/db/sqlite.ts`
  sets `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, with a documented
  multi-process rationale. *This refutes the generic "set PRAGMAs" recommendation — already done.*

### Tests
- **F-T1 (S2, M):** ~18 compiled-`dist` smokes (`scripts/smoke-*.mjs`) exercise production-ESM e2e
  paths but are **manual** — a `dist`-only regression (export/bin wiring) passes CI today. *Evidence:*
  `ci.yml` has no smoke step; `TICKET003`. → OPP-03.
- **F-T2 (S3, M):** Test output is human-formatted only; no machine-readable (JSON/JUnit) artifact
  for an agent or CI to parse. *Evidence:* `package.json` `test` = `vitest run`. → OPP-06.
- **F-T3 (S2, L):** Known intermittent vitest tinypool "Worker exited unexpectedly" on full runs
  (per memory) — currently treated as re-run-to-confirm. Flake erodes the agent gate signal. → OPP-12.

### Security / privacy
- **F-S1 (S2, H):** SSRF defense is **sound and matches OWASP guidance** — DNS-pin + connect-time
  guard, and **3xx redirects are deliberately not followed** (`delivery/failure-reason.ts:154`,
  `system-events/index.ts:86`), closing the redirect-rebinding class entirely. *Strength.*
- **F-S2 (S3, L):** Replay tolerance is configurable per-call (`signing/webhook-signature.ts:53`,
  default 300s) but **not exposed as a gateway env var** for Posthorn's own inbound verification
  (Stripe billing webhook / system events). Minor; spec-correct default. → OPP-13.

### Infra / CI
- **F-I1 (S1, H) — CONTRACT BUG:** `package.json` `engines.node` = **`>=20`**, but the default
  datastore uses `node:sqlite`, **introduced in Node 22.5** (flag-free 22.13+). The code itself says
  "runs anywhere **Node 22.5+** runs" (`src/storage/sqlite-store.ts:5`). On Node 20–22.4 the default
  (SQLite) gateway **crashes** at store construction (`require("node:sqlite")`). → OPP-01.
- **F-I2 (S2, H):** CI tests **only Node 24** (`ci.yml`), though the package claims `>=20` and
  `node:sqlite`'s stability index differs by LTS line (1.1 on 22, RC 1.2 on 24). No matrix → a
  version-specific break on a supported line is invisible. → OPP-02.
- **F-I3 (S3, H):** CI is otherwise strong — docker image + OCI-label verify, helm lint/template +
  anti-scale guards, `npm pack` readiness, dep audit. *Strength.*

### Docs
- **F-D1 (S3, M):** Several surfaces must stay in lockstep (README ↔ OpenAPI ↔ DEPLOY ↔ SDK ↔
  CHANGELOG); README had stale facts this session (admin-token min, version, test count — fixed).
  No automated cross-surface check beyond OpenAPI drift + env-var dual-doc. → OPP-04.
- **F-D2 (S3, M):** `node:sqlite` RC status + true Node floor aren't stated in README/DEPLOY; an
  operator could pick an unsupported Node. → OPP-07. **The no-linter/-formatter choice is
  undocumented** (reads as a gap, not a decision) → OPP-05.

### Performance
- **F-PF1 (S4, H):** A throughput bench harness exists (`bench/`, `BENCHMARKS.md`) and is asserted
  non-flaky in the gate. No action; don't expand without a concrete target.

### Accessibility
- **F-AC1 (S3, L):** Dashboards/portal are server-rendered HTML (`src/dashboard`, `src/portal`).
  No automated a11y check, but this is an operator/consumer utility UI, low surface. *UNCERTAINTY:*
  not audited this pass. Optional P3 at most; out of the harden-only lane unless a UI change lands.

### Agent readiness
- **F-AR1 (S3, H):** Strong base — `AGENTS.md`, deterministic gate, tickets, repo map, `.aiignore`.
  Gaps vs 2026 best practice: no machine-readable gate output (OPP-06), no documented worktree
  workflow (OPP-09), no project review subagent (OPP-11), linter stance undocumented (OPP-05).
  *UNCERTAINTY:* confirm `AGENTS.md` already carries explicit build/test/style/**security**
  sections (research says these are the recommended set).

---

# Opportunity Backlog

Score 1–5 each. **Priority = Impact·3 + Fit·2 + Feasibility·2 + Confidence − Risk − Effort.**

| ID | Title | Category | Imp | Fit | Feas | Conf | Risk | Eff | **Pri** | Tier | Rationale |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OPP-01 | Correct `engines.node` to the real `node:sqlite` floor | Correctness | 5 | 5 | 5 | 4 | 2 | 1 | **36** | P0 | Package claims a Node version it crashes on |
| OPP-02 | CI Node LTS matrix (supported lines only) | CI | 4 | 5 | 5 | 5 | 2 | 2 | **33** | P1 | Catches version-specific `node:sqlite` breakage |
| OPP-05 | Document the no-linter/-formatter stance (TICKET005) | Agent/Docs | 2 | 5 | 5 | 5 | 1 | 1 | **29** | P1 | Turns an apparent gap into a decision |
| OPP-04 | Doc-sync sweep + CHANGELOG check (TICKET004 spirit) | Docs | 3 | 5 | 4 | 4 | 1 | 2 | **28** | P1 | Keeps contract surfaces honest |
| OPP-06 | Machine-readable gate output (vitest JSON/JUnit) | Agent | 3 | 5 | 4 | 4 | 1 | 2 | **28** | P1 | Agent/CI can parse pass/fail + failures |
| OPP-03 | Run compiled-dist smokes in CI (TICKET003) | CI/Tests | 3 | 5 | 4 | 4 | 2 | 2 | **27** | P1 | Closes the per-item DoD loop |
| OPP-07 | Document `node:sqlite` RC status + Node floor | Docs | 2 | 4 | 5 | 4 | 1 | 1 | **26** | P1 | Operators pick a supported Node |
| OPP-08 | `.d.ts` "compiles under default tsconfig" smoke | Contract | 3 | 4 | 4 | 4 | 1 | 2 | **26** | P2 | Protects the published types contract |
| OPP-09 | Worktree workflow doc + gitignore `.claude/worktrees/` | Agent | 2 | 4 | 5 | 4 | 1 | 1 | **26** | P2 | Safe parallel agent work |
| OPP-10 | Prometheus label-cardinality audit | Observability | 2 | 4 | 4 | 3 | 1 | 2 | **22** | P2 | Prevent unbounded-label cardinality blowups |
| OPP-11 | Project code-reviewer subagent + self-review step | Agent | 3 | 3 | 4 | 3 | 2 | 2 | **22** | P2 | Adversarial diff review before landing |
| OPP-13 | Config var for inbound replay-window tolerance | Config | 2 | 3 | 4 | 3 | 1 | 2 | **20** | P3 | Operator-tunable verification window |
| OPP-12 | De-flake guard for the tinypool flake | Tests | 2 | 4 | 3 | 3 | 2 | 2 | **19** | P3 | Protect the gate signal |
| — | **Do Not Do Now** (below) | — | — | — | — | — | — | — | — | DNDN | Feature scope / credential-gated / re-architecture |

**Do Not Do Now:** asymmetric (`whpk_`/ed25519) signing · multi-destination sinks · payload
transformations · FIFO ordered delivery · mTLS / static egress IPs · more SDK languages · "fix" the
SQLite single-writer ceiling (that ceiling *is* the wedge; Postgres HA path already exists) ·
EXCLUSIONS (real `npm publish`, Docker registry push, live Stripe keys, domain purchase, hosted
demo, trademark) · resolving the 5 discovery questions (human strategy).

---

# Roadmap

- **Phase 0 — Safety / baseline / agent-readiness.** Confirm gates green (done this session).
  OPP-01 (engines fix, P0). OPP-05 (linter-stance doc). OPP-06 (machine-readable gate output).
  OPP-09 (worktree doc). Goal: the gate is trustworthy and agent-legible before anything else.
- **Phase 1 — Small wins.** OPP-02 (Node matrix), OPP-03 (smokes in CI), OPP-04 (doc-sync +
  CHANGELOG), OPP-07 (node:sqlite posture doc), OPP-08 (.d.ts smoke). Each is a tight, gate-clean,
  PR-sized change.
- **Phase 2 — Hardening (bounded).** OPP-10 (metrics cardinality audit), OPP-11 (review subagent),
  OPP-13 (replay-window config var — only if it cleanly fits the env-var dual-doc discipline).
- **Phase 3 — Architecture / scale.** **Intentionally empty for the agent.** The single-writer
  SQLite default is the product wedge; HA is the existing optional-Postgres path. Any re-architecture
  is a human decision. Action: *document* the scale story; do not change it.
- **Phase 4 — Optional bets (human-gated).** Asymmetric signing, SDK breadth, multi-destination,
  transformations. Each needs explicit human authorization (feature scope beyond `docs/GOAL.md`).

---

# Tasks

> Common to every task: obey `docs/GOAL.md` per-item Definition of Done — `tsc --noEmit` clean,
> `vitest run` green, `npm run build` succeeds; extend `conformance.ts` if a store changes; pass
> OpenAPI drift/orphan tests if a route changes; document a new `POSTHORN_*` var in BOTH
> `.env.example` AND `docs/DEPLOY.md`; add a dist smoke for a new e2e path. Never edit the
> hash-protected files or `docs/LOG.md`. Commit conventional, explicit staging, no co-author trailer,
> **no `(iter-NNNN)` suffix** (out-of-loop), no push/merge without an explicit human ask.

### OPP-01 — Correct `engines.node` to the real `node:sqlite` floor  · P0 · Correctness · Eff 1 · Risk 2 · Conf 4
- **Objective:** make `package.json#engines.node` reflect the version the default datastore actually
  requires, so `npm`/CI/consumers don't permit a Node that crashes.
- **Why:** `node:sqlite` lands in Node 22.5 (flag-free 22.13+); `>=20` is a false compatibility
  claim. The code already states "Node 22.5+" (`src/storage/sqlite-store.ts:5`).
- **Evidence:** F-I1. `engines.node:">=20"` (package.json:22) vs `src/storage/sqlite-store.ts:5`.
- **Scope / files:** `package.json` (`engines`); align any "Node 20" claims in `README.md`,
  `docs/DEPLOY.md`, `Dockerfile` base image. **Out:** changing the runtime code.
- **Steps:** (1) Decide the floor — recommend **`>=22.13.0`** (flag-free `node:sqlite`); note 22.5
  works only with `--experimental-sqlite`, so 22.13 is the clean minimum. (2) Update `engines`.
  (3) `grep -rni "node 20\|>= *20\|node20" README.md docs/ Dockerfile` and align. (4) Confirm the
  Dockerfile base (e.g. `node:24-*`) already satisfies it.
- **Edge cases:** a consumer pinned to Node 20 in *Postgres-only* mode technically avoids
  `node:sqlite` — but the default path and CLI bootstrap touch it, so 22.13 is the honest floor.
- **Acceptance:** `engines.node` ≥ 22.13; no doc claims Node 20; gate green; `npm pack --dry-run`
  still clean.
- **Verify:** `node -p "require('./package.json').engines"` · `npm run agent:check`.
- **Rollback:** revert the one-line `engines` change.
- **Agent notes:** in-scope as a **bounded bug fix** (false metadata), not a feature/arch change.
  Pairs with OPP-02 and OPP-07. **UNCERTAINTY:** confirm 22.13 vs 22.5-with-flag; pick flag-free.
- **Depends on:** none. **Blocks:** OPP-02 (matrix should use the corrected floor).

### OPP-02 — CI Node LTS matrix  · P1 · CI · Eff 2 · Risk 2 · Conf 5
- **Objective:** run the `ci` job across the supported LTS lines (e.g. 22.13 and 24) instead of 24
  only.
- **Why:** `node:sqlite` stability index differs by line; a per-version break is otherwise invisible.
- **Evidence:** F-I2 (`ci.yml` single Node 24).
- **Scope / files:** `.github/workflows/ci.yml` (`ci` job → `strategy.matrix.node`). **Out:** the
  docker/helm/package/audit jobs (keep single-version).
- **Steps:** add `strategy: matrix: node: ["22.13", "24"]`; set `node-version: ${{ matrix.node }}`;
  keep `npm ci` + typecheck + test + build.
- **Edge cases:** if 22.13 surfaces a real `node:sqlite` behavior diff, that's the finding — fix or
  raise the floor (loop back to OPP-01), don't silence it.
- **Acceptance:** CI green on all matrix entries on `main`; matrix uses the OPP-01 floor as the low
  end.
- **Verify:** push to a branch / `act` if available; otherwise inspect the rendered workflow.
- **Rollback:** revert the workflow hunk.
- **Agent notes:** **validation caveat** — full CI can't run locally on Windows; if you cannot
  validate the matrix, say so and stop short of claiming it green. **Depends on:** OPP-01.

### OPP-03 — Run compiled-dist smokes in CI (TICKET003)  · P1 · CI/Tests · Eff 2 · Risk 2 · Conf 4
- **Objective:** add a CI job that `npm run build` then runs every non-Postgres `scripts/smoke-*.mjs`,
  failing on any non-zero exit.
- **Why:** `dist`-only regressions (export/bin wiring) pass CI today; the DoD already requires a dist
  smoke per e2e path. **Evidence:** F-T1; `tickets/TICKET003.md`.
- **Scope / files:** `.github/workflows/ci.yml` (new `smoke` job); optionally
  `scripts/agent/smoke.sh` + an `agent:smoke` npm script. **Out:** `smoke-postgres.mjs` (needs a PG
  service — separate gated job or skip); no changes to smoke assertions.
- **Steps:** checkout → setup-node (matrix low end) → `npm ci` → `npm run build` → loop the smokes
  except `smoke-postgres.mjs`, `node "$f" || exit 1`. Optionally a `postgres:16` service job for the
  PG smoke.
- **Edge cases:** port races — smokes bind `127.0.0.1` ephemeral (`listen(0)`); run serially.
- **Acceptance:** job builds + runs every non-PG smoke and is green on `main`; a deliberately broken
  smoke fails the job (verify locally).
- **Verify:** locally `npm run build && for f in scripts/smoke-*.mjs; do [ "$f" = scripts/smoke-postgres.mjs ] && continue; node "$f" || exit 1; done`.
- **Rollback:** remove the job.
- **Agent notes:** smokes print a harmless Windows teardown assertion locally; CI is Linux (moot).

### OPP-04 — Doc-sync sweep + CHANGELOG check  · P1 · Docs · Eff 2 · Risk 1 · Conf 4
- **Objective:** verify the human/contract doc surfaces agree and `CHANGELOG.md` reflects shipped
  work; fix drift.
- **Why:** README drifted this session (admin-token min, version, test count). **Evidence:** F-D1.
- **Scope / files:** `README.md`, `docs/DEPLOY.md`, `CHANGELOG.md`, `GET /openapi.json` ↔
  `src/http/openapi.ts`, SDK surfaces. **Out:** changing behavior/contracts.
- **Steps:** (1) cross-check the README config table vs `src/runtime/config.ts` + `.env.example`.
  (2) Confirm every `POSTHORN_*` var is in both `.env.example` and `docs/DEPLOY.md` (config.test
  enforces — run it). (3) Confirm `CHANGELOG.md` covers iters since its last entry. (4) Spot-check
  SDK method↔OpenAPI mapping tests pass.
- **Acceptance:** no factual mismatch; gate green (`config.test.ts`, OpenAPI drift tests pass).
- **Verify:** `npm test` (drift/env-var tests) · manual table diff.
- **Rollback:** revert doc edits.
- **Agent notes:** docs-only; smallest possible diffs.

### OPP-05 — Document the no-linter/-formatter stance (TICKET005)  · P1 · Agent/Docs · Eff 1 · Risk 1 · Conf 5
- **Objective:** record that no ESLint/Prettier is a deliberate choice (strict `tsc` is the style
  gate), and make `lint.sh`/`format.sh` say "skipped — none configured (deliberate)".
- **Why:** the absence currently reads as a gap. **Evidence:** F-D2; `tickets/TICKET005.md`.
- **Scope / files:** `AGENTS.md` and/or `docs/ai/REPO_MAP.md` (a "Code style" note);
  `scripts/agent/{lint,format}.sh` message text. **Out:** adding any linter/formatter dependency.
- **Steps:** confirm no `eslint|prettier|biome` config; write the stance + why; adjust the script
  message to read as intentional.
- **Acceptance:** stance documented in one canonical place + linked; `lint.sh`/`format.sh` exit 0
  with a deliberate message; no new dep.
- **Verify:** `bash scripts/agent/lint.sh; bash scripts/agent/format.sh; echo $?`.
- **Rollback:** revert docs + message.

### OPP-06 — Machine-readable gate output  · P1 · Agent · Eff 2 · Risk 1 · Conf 4
- **Objective:** let an agent/CI parse test results — add a JSON/JUnit reporter path without
  changing default human output.
- **Why:** agents should consume structured pass/fail + failure list, not scrape text. **Evidence:**
  F-T2.
- **Scope / files:** `package.json` (e.g. `test:json` → `vitest run --reporter=json --outputFile=...`
  or `--reporter=junit`); optionally surface in `scripts/agent/test.sh` (`--json` flag) and as a CI
  artifact. **Out:** changing the default `test` script behavior.
- **Steps:** add an opt-in reporter script; document it in `AGENTS.md` commands; (optional) upload
  the artifact in CI.
- **Edge cases:** keep `npm test` unchanged so existing flows/gate are stable.
- **Acceptance:** a documented command emits machine-readable results; default gate unchanged; gate
  green.
- **Verify:** run the new script, confirm a parseable file is produced.
- **Rollback:** remove the added script.
- **Agent notes:** vitest 2.x supports `json`/`junit` reporters natively — no new dep.

### OPP-07 — Document `node:sqlite` RC status + Node floor  · P1 · Docs · Eff 1 · Risk 1 · Conf 4
- **Objective:** state the supported Node range and that `node:sqlite` is RC (Node 24) /
  active-development (Node 22) in `README.md` + `docs/DEPLOY.md`.
- **Why:** operators must pick a supported Node; sets expectations on the experimental datastore.
  **Evidence:** F-D2, F-I1.
- **Scope / files:** `README.md` (Development/Configuration), `docs/DEPLOY.md`. **Out:** code.
- **Steps:** add a short "Supported Node" note (≥ the OPP-01 floor; `node:sqlite` pre-stable;
  Postgres path for those who want a stable-API datastore).
- **Acceptance:** both docs state the floor + RC caveat; consistent with `engines`.
- **Verify:** manual; gate green (docs-only).
- **Depends on:** OPP-01 (same floor number).

### OPP-08 — `.d.ts` compiles-under-default-tsconfig smoke  · P2 · Contract · Eff 2 · Risk 1 · Conf 4
- **Objective:** prove the published `dist/index.d.ts` type-checks under a *default* consumer tsconfig
  (not just Posthorn's strict one).
- **Why:** strict-only validation can hide types that break ordinary consumers. **Evidence:** F-D1; TS
  ESM research.
- **Scope / files:** a small test/smoke that compiles a throwaway `import` of the built types under
  a minimal tsconfig; wire into smokes or a test. **Out:** loosening the project tsconfig.
- **Steps:** after `npm run build`, generate a temp consumer file importing public types; run `tsc`
  with default options against it; assert exit 0.
- **Edge cases:** must run post-build; ensure `exports.types` precedes `import` (currently correct).
- **Acceptance:** smoke fails if the published `.d.ts` doesn't compile cleanly for a default consumer.
- **Verify:** run the smoke locally after build.
- **Rollback:** remove the smoke.

### OPP-09 — Worktree workflow doc + gitignore `.claude/worktrees/`  · P2 · Agent · Eff 1 · Risk 1 · Conf 4
- **Objective:** document a safe git-worktree workflow for parallel/risky agent ticks; ignore the
  worktree dir.
- **Why:** 2026 best practice for isolating parallel agent work. **Evidence:** F-AR1; agent research.
- **Scope / files:** `AGENTS.md` (a short "Parallel work / worktrees" note); `.gitignore` +
  `.aiignore` (`.claude/worktrees/`). **Out:** mandating worktrees.
- **Acceptance:** AGENTS.md documents when/how; ignore entries present; gate green.
- **Verify:** `git check-ignore .claude/worktrees/x`.

### OPP-10 — Prometheus label-cardinality audit  · P2 · Observability · Eff 2 · Risk 1 · Conf 3
- **Objective:** confirm `/metrics` labels are bounded enums (no endpoint IDs/URLs/request IDs);
  add a guard test/doc if missing.
- **Why:** unbounded labels blow up cardinality. **Evidence:** F-S1-adjacent; Prometheus research.
  **UNCERTAINTY:** `src/metrics/` not read this pass.
- **Scope / files:** read `src/metrics/*`; if any label is unbounded, propose a bounded normalization
  (else add a test asserting the label set is closed). **Out:** changing metric *names* (contract).
- **Acceptance:** documented finding; if a real unbounded label exists, a fix + test; else a guard
  test pinning the label keys.
- **Verify:** `npm test`; inspect `/metrics` output from a booted gateway.
- **Agent notes:** per-endpoint failure-reason stats live in the **API** (`GET
  /v1/endpoints/:id/stats`), which is the right place — confirm they're not also high-cardinality
  metric labels.

### OPP-11 — Project code-reviewer subagent + self-review step  · P2 · Agent · Eff 2 · Risk 2 · Conf 3
- **Objective:** add a repo-local reviewer subagent that critiques each ticket's diff (correctness /
  requirement gaps only) before landing.
- **Why:** adversarial fresh-context review catches regressions. **Evidence:** F-AR1; agent research.
- **Scope / files:** `.claude/agents/code-reviewer.md` (Claude-specific); a one-line "self-review the
  diff before commit" step in the `AGENTS.md` loop. **Out:** tool-specific lock-in beyond an optional
  helper. **UNCERTAINTY:** keep it optional so non-Claude agents aren't blocked.
- **Acceptance:** reviewer config exists; loop references a self-review step; gitignored worktree
  unaffected.
- **Verify:** N/A (config); ensure it doesn't alter the gate.

### OPP-13 — Config var for inbound replay-window tolerance  · P3 · Config · Eff 2 · Risk 1 · Conf 3
- **Objective:** expose the verification tolerance (default 300s) as a `POSTHORN_*` var for
  Posthorn's own inbound verification (Stripe webhook / system events).
- **Why:** operator-tunable clock-skew window. **Evidence:** F-S2 (`signing/webhook-signature.ts:53`).
- **Scope / files:** `src/runtime/config.ts`, the inbound verify call sites, `.env.example`,
  `docs/DEPLOY.md`. **Out:** changing the default (stay 300s) or the SDK `verifyWebhook` signature.
- **Edge cases:** **adding a `POSTHORN_*` var triggers the dual-doc requirement** (`.env.example` +
  `DEPLOY.md`, enforced by `config.test.ts`) and the hand-built smoke configs must still construct.
- **Acceptance:** new var parsed + documented in both places; default unchanged; gate green.
- **Verify:** `npm test` (config.test); a smoke boot.
- **Agent notes:** lowest-value of the set; only do it if it lands cleanly. Confirm Posthorn actually
  *verifies* inbound (Stripe/system-events) before adding — if not, **drop this task**.

### OPP-12 — De-flake guard for the tinypool flake  · P3 · Tests · Eff 2 · Risk 2 · Conf 3
- **Objective:** reduce/contain the intermittent vitest "Worker exited unexpectedly".
- **Why:** flake erodes the agent gate signal. **Evidence:** F-T3; memory note.
- **Scope / files:** `vitest.config.*` (pool/isolation/retry options) — **investigate first**, change
  minimally. **Out:** masking real failures with blanket retries.
- **Edge cases:** a retry must not hide a genuine regression — scope any retry narrowly and document.
- **Acceptance:** documented root-cause hypothesis; if a safe config mitigates it, applied with a
  note; gate still green and meaningful.
- **Verify:** several consecutive `npm test` runs.
- **Agent notes:** if no safe fix, **document the known-flake + re-run protocol** in AGENTS.md and
  stop — do not over-engineer.

---

# Risk Register

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Editing a hash-protected substrate file | Low | High | Never touch `scripts/manifest.txt` files; `assert-gate-integrity.ps1` verifies hashes |
| Hand-editing `docs/LOG.md` | Low | High | It's auto-managed; never edit |
| Adding `(iter-NNNN)` / a LOG entry to out-of-loop work | Med | Med | This work is outside the loop — conventional commits, no iter suffix, no LOG edit |
| CI matrix (OPP-02) can't be validated locally on Windows | High | Med | State the validation gap; don't claim green unverified; rely on a pushed branch/human |
| Tightening `engines` perceived as breaking | Low | Low | It corrects a false claim (code never ran on Node 20 default); document in commit |
| Adding a `POSTHORN_*` var without dual-doc | Med | Med | `config.test.ts` enforces `.env.example` + `DEPLOY.md`; update both + smoke configs |
| Scope creep into feature work | Med | High | Honor "Do Not Do Now"; feature gaps are human-gated |
| Flaky test masking a real failure (OPP-12) | Low | High | Investigate root cause; never blanket-retry to green |

# What Not To Do

- **Do not implement product features** — asymmetric signing, multi-destination sinks,
  transformations, FIFO ordering, mTLS/static IPs, more SDK languages. All human-gated.
- **Do not "fix" the SQLite single-writer ceiling** — it is the wedge; Postgres is the HA path.
- **Do not refactor** stable, test-covered architecture without a concrete, evidenced reason.
- **Do not change** schemas, public interfaces, storage formats, deployment behavior, or core
  architecture outside an authorized task.
- **Do not attempt EXCLUSIONS** — real `npm publish`, Docker registry push, live Stripe keys, domain
  purchase, hosted demo, trademark. Build/dry-run/mock only.
- **Do not push or merge to `main`**, force-push, or run destructive git ops without an explicit
  human ask.
- **Do not edit** the hash-protected files or `docs/LOG.md`.
- **Do not answer** the 5 discovery questions in code — they are human strategy decisions.

# Agent-Readiness Improvements (summary)

- **Now strong:** deterministic gate (`agent:check`), `AGENTS.md` + repo map + tickets, `.aiignore`,
  zero TODO/FIXME, clean audit, OpenAPI drift + env-var dual-doc + npm-pack guards.
- **Add (this plan):** machine-readable gate output (OPP-06), CI Node matrix + dist smokes
  (OPP-02/03), worktree workflow (OPP-09), optional review subagent (OPP-11), documented
  no-linter stance (OPP-05), `.d.ts` consumer smoke (OPP-08).
- **Verify:** confirm `AGENTS.md` carries explicit build/test/**security**/style sections (the
  agents.md-recommended set); add any missing one as part of OPP-05/OPP-09.

---

# Execution /goal

> Paste the block below as a new `/goal` to execute this plan. It is self-contained.

```
You are the maintenance engineer for Posthorn — an open-core (MIT), Standard-Webhooks
webhook-delivery gateway (TypeScript/ESM, Node; single-process node:sqlite by default, optional
Postgres). The product is v1.0 FEATURE-COMPLETE. Your lane is HARDENING, AGENT-READINESS, DOCS, and
BOUNDED MAINTENANCE — NOT new features.

Source of truth: re-read `.agent/master_plan.md` at the start of every loop (if present), plus
`docs/GOAL.md` (canonical product goal + per-item Definition of Done + EXCLUSIONS), `AGENTS.md`
(rules + loop), `docs/ai/REPO_MAP.md`, and `tickets/`. On any conflict, the bespoke substrate wins.

Work the master-plan backlog top-down by priority, ONE task per loop, smallest safe increment first:
P0 OPP-01 (correct engines.node to the real node:sqlite floor, ~>=22.13) →
P1 OPP-02 (CI Node LTS matrix) → OPP-05 (document no-linter stance, TICKET005) →
   OPP-04 (doc-sync sweep + CHANGELOG) → OPP-06 (machine-readable test output) →
   OPP-03 (compiled-dist smokes in CI, TICKET003) → OPP-07 (document node:sqlite RC + Node floor) →
P2 OPP-08 (.d.ts default-tsconfig smoke) → OPP-09 (worktree doc + gitignore) →
   OPP-10 (Prometheus label-cardinality audit) → OPP-11 (review subagent) →
P3 OPP-13 (replay-window config var — only if it fits cleanly; drop if inbound verify isn't used) →
   OPP-12 (de-flake guard — investigate; document if no safe fix).

Per loop:
1. Re-read `.agent/master_plan.md` + the task's full entry (objective, scope/files, steps, edge
   cases, acceptance, verify, rollback, agent notes, dependencies).
2. Establish a baseline: `npm run agent:check` (typecheck + test + build) before touching anything.
3. Make the smallest change that satisfies the task. Honor the DoD: extend `conformance.ts` if a
   store changes; pass OpenAPI drift/orphan tests if a route changes; document any new `POSTHORN_*`
   var in BOTH `.env.example` AND `docs/DEPLOY.md`; add a dist smoke for any new e2e path.
4. Validate: run targeted tests for the touched area, then the full gate (`npm run agent:check`).
   For CI-only changes you cannot run locally (matrix/smoke jobs), SAY SO and do not claim green —
   leave them for a pushed branch / human.
5. Update tests, docs, README, and `AGENTS.md` as needed to stay in sync.
6. Justify any new dependency explicitly (this project prides itself on near-zero runtime deps —
   default to NO new deps; vitest reporters etc. are built-in).
7. Self-review the diff in a fresh pass (or via the OPP-11 reviewer subagent once it exists): check
   for correctness and requirement gaps only, not style.
8. Mark a task complete ONLY after its acceptance criteria are verifiably met. Update the ticket and
   ROADMAP. File follow-ups for anything discovered.
9. Commit locally: conventional message, stage files explicitly (never `git add -A`), NO co-author
   trailer, NO `(iter-NNNN)` suffix (this is out-of-loop), NO `docs/LOG.md` edit. Do NOT push or
   merge to `main` without an explicit human ask. Verify with `git log -1`.

STOP and ask the human when you hit: a secret or credential need; a destructive or data-migration
action; an EXCLUSION (npm publish, registry push, live Stripe, domain, hosted demo, trademark); a
request to edit a hash-protected file or `docs/LOG.md`; unclear requirements or one of the 5
`docs/GOAL.md` discovery questions; a risky rewrite or any feature-scope work; or a case where you
cannot actually validate the change. Take the safest assumption, document it, and continue only when
the path is clearly safe and in-scope.

End each loop with a terse summary: task, change, commands+results, ticket/roadmap updates, blockers,
and the single best next task.
```
