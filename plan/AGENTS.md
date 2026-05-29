# plan/AGENTS — execution rules for this plan (self-contained)

Rules, verification commands, conventions, and gotchas for executing `plan/`. These **incorporate**
the repo's inviolable invariants ([`docs/AXIOMS.md`](../docs/AXIOMS.md),
[`docs/AGENT-LOOP.md`](../docs/AGENT-LOOP.md) — hash-protected) and the canonical agent guide
([`/AGENTS.md`](../AGENTS.md)). Where this file restates them it must match; the hash-protected files
win on any conflict because `scripts/assert-gate-integrity.ps1` enforces them.

## Verification commands (the gate must be green before any commit)

| Need | Command |
| --- | --- |
| **Definition-of-Done gate** | `npm run agent:check` (typecheck + `vitest run` + build) |
| Individually | `npm run typecheck` · `npm test` · `npm run build` |
| Agent helpers (git-bash) | `bash scripts/agent/{status,doctor,check,test,smoke}.sh` |
| Machine-readable tests | `npm run test:json` → `test-results.json` (opt-in; default `npm test` unchanged) |
| Postgres-backed tests | `POSTHORN_TEST_PG_URL=postgres://… npm test` (Docker `postgres:16`) |
| Compiled-dist smokes | `npm run build` then `node scripts/smoke-*.mjs` (bind `127.0.0.1`) |
| Log compliance | `python scripts/validate-log-compliance.py` |
| Canonical gate (pwsh) | `pwsh scripts/local-gate.ps1` |

## Conventions

- **TypeScript strict** — `exactOptionalPropertyTypes` (omit, don't assign `undefined`),
  `noUncheckedIndexedAccess`, `verbatimModuleSyntax` (`import type`). ESM only.
- **No linter/formatter by deliberate choice** — strict `tsc` + review is the style gate.
- **Tests** colocated `src/**/*.test.ts`; store backends share `conformance.ts` — extend it on any
  store change. **Routes** must keep the OpenAPI drift/orphan tests green.
- **New `POSTHORN_*` var** ⇒ document in **both** `.env.example` and `docs/DEPLOY.md`
  (`src/runtime/config.test.ts` enforces) and keep the hand-built smoke configs constructing.
- **New end-to-end path** ⇒ add a `scripts/smoke-*.mjs`. `dist/`+`site/` are generated/gitignored.
- **Commits** — conventional, **explicit** staging (never `git add -A`), **no co-author trailer**.
  This plan's work is **out-of-loop**: **no `(iter-NNNN)` suffix**, **no `docs/LOG.md` edit**.

## Gotchas

- **Known flake:** a lone vitest `Worker exited unexpectedly` (tinypool) with **0 failed assertions**
  is the documented teardown flake — **re-run once** to confirm; never blanket-`retry`, never force
  `singleFork`/`threads`.
- **Windows-primary dev:** the `scripts/agent/*.sh` need git-bash; `npm run agent:check` works in any
  shell; full CI (matrix/image/helm) can't be reproduced locally — **say so, don't claim green**.
- **Smokes** print a harmless Windows teardown assertion locally and must hit `127.0.0.1` (IPv4 bind).

## Hard rules (inviolable)

- **Never edit** the hash-protected files in [`scripts/manifest.txt`](../scripts/manifest.txt).
- **Never hand-edit** [`docs/LOG.md`](../docs/LOG.md).
- **Never push or merge to `main`** without an explicit human ask.
- Stay in the **maintenance** lane. Features, schema/interface/dependency-removal/storage/deployment/
  architecture changes, the credential-gated EXCLUSIONS, and the 5 discovery questions are
  **human-gated** — stop and ask.
