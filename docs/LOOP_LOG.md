# LOOP_LOG

High-compression, unvarnished record of every iteration (Axiom 5). Newest first.

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
