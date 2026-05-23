# LOOP_LOG

High-compression, unvarnished record of every iteration (Axiom 5). Newest first.

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
