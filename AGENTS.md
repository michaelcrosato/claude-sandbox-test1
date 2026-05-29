# AGENTS.md

Canonical instructions for autonomous coding agents working in this repo. Humans: see
[README.md](README.md). Terse by design.

**What this is.** Posthorn — reliable outbound webhook-delivery infrastructure: a single
Node process, SQLite by default (no Redis), Standard Webhooks-compliant, MIT. TypeScript/ESM,
Node >= 22.13, tested with Vitest.

## Canonical sources & precedence

This repo predates the generic `AGENTS.md` convention and already has a bespoke autonomous
substrate under `docs/`. This file orients you and points into it — it does not replace it.
**On any conflict, the substrate wins:**

| Source | Role | Editable? |
| --- | --- | --- |
| [docs/GOAL.md](docs/GOAL.md) | Canonical goal, ordered backlog, per-item definition of done, `CURRENT_STATE` lifecycle gate. | yes (don't fork into root GOAL.md — that's a pointer) |
| [docs/AXIOMS.md](docs/AXIOMS.md) | Invariants you must not violate. | **NO — hash-protected** |
| [docs/AGENT-LOOP.md](docs/AGENT-LOOP.md) | The canonical work loop. | **NO — hash-protected** |
| [docs/LOG.md](docs/LOG.md) | Append-only iteration log (strict schema; written by the harness). | **NO — never hand-edit** |
| [scripts/manifest.txt](scripts/manifest.txt) | SHA-256 of the protected files; `assert-gate-integrity.ps1` verifies them. | **NO** |
| docs/PROJECT.md · docs/PARITY.md · docs/DEPLOY.md · docs/AGENT_GUIDES.md | Product decision · competitor matrix · ops runbook · supplementary guidance. | yes |

The 5 hash-protected files (the 2 docs above + `scripts/{assert-gate-integrity,local-gate,run-autonomous-loop}.ps1`)
are listed in `scripts/manifest.txt`. **Never modify them. Never hand-edit `docs/LOG.md`.**

## Read-first order

1. `bash scripts/agent/status.sh` — branch, HEAD, upstream delta, working tree.
2. [docs/GOAL.md](docs/GOAL.md) — the goal, backlog, and definition of done.
3. [docs/AXIOMS.md](docs/AXIOMS.md) + [docs/AGENT-LOOP.md](docs/AGENT-LOOP.md) — invariants + the loop.
4. [docs/ai/REPO_MAP.md](docs/ai/REPO_MAP.md) — where everything lives; what to skip.
5. [ROADMAP.md](ROADMAP.md) + [tickets/](tickets/) — phased plan; pick one unblocked ticket.
6. Tail of [docs/LOG.md](docs/LOG.md) — what the last few iterations did (read the tail, not the archive).

## The loop

Summarizes [docs/AGENT-LOOP.md](docs/AGENT-LOOP.md) (authoritative). Repeat unprompted:

`status` → read GOAL + ROADMAP + REPO_MAP + top ticket → pick one unblocked, small ticket →
mark it in-progress → make the change → **targeted checks then the full gate** → self-review the
diff (optionally via the `code-reviewer` subagent in `.claude/agents/`) → update docs + the
ticket → file follow-up tickets → summarize. Inside the harness the iteration is logged to
`docs/LOG.md` automatically; outside it, record rationale in the ticket + commit message — never
hand-edit the log.

## Commands

| Need | Command |
| --- | --- |
| Install deps | `bash scripts/agent/bootstrap.sh` (`npm ci`) |
| Repo status | `bash scripts/agent/status.sh` |
| Toolchain check | `bash scripts/agent/doctor.sh` |
| **Definition-of-done gate** | `bash scripts/agent/check.sh` · or `npm run agent:check` (any shell) · or canonical `pwsh scripts/local-gate.ps1` |
| Type-check | `npm run typecheck` |
| Test (all / one) | `npm test` · `bash scripts/agent/test.sh src/http/api.test.ts` |
| Test → machine-readable | `npm run test:json` → writes JSON results to `test-results.json` (gitignored; opt-in, leaves default `npm test` unchanged) |
| Build | `npm run build` |
| Lint / format | none — deliberate (see Conventions › Code style); `scripts/agent/{lint,format}.sh` report "skipped" and exit 0 |
| Docs site | `npm run build:site` |
| Benchmark | `npm run bench` |
| Compiled-dist smoke | all (non-PG): `bash scripts/agent/smoke.sh` · one: `npm run build && node scripts/smoke-<name>.mjs` (smokes hit `127.0.0.1`) |
| Log compliance | `python scripts/validate-log-compliance.py` |
| Postgres-backed tests | `POSTHORN_TEST_PG_URL=postgres://… npm test` (Docker `postgres:16`) |

## Conventions

- **TypeScript strict**: `exactOptionalPropertyTypes` (don't assign `undefined` to an optional —
  omit it), `noUncheckedIndexedAccess` (indexed access is `T | undefined`), `verbatimModuleSyntax`
  (use `import type`). ESM only.
- **Code style — no linter/formatter, by deliberate choice.** Strict `tsc` (the settings above) plus
  reviewer discipline are the style gate; the tree is small and consistent, so adding ESLint/
  Prettier/Biome would churn every file for no correctness gain. `scripts/agent/{lint,format}.sh`
  report "skipped — none configured (deliberate)" and exit 0. Revisit only with a concrete need, as
  its own ticket with a one-shot format commit isolated from logic changes.
- **Tests** are colocated `src/**/*.test.ts`. The three store backends (in-memory / SQLite /
  Postgres) share `src/<area>/conformance.ts` — **extend the conformance suite when a store
  changes.** Postgres tests skip unless `POSTHORN_TEST_PG_URL` is set.
- **HTTP routes**: changing one must keep the bidirectional OpenAPI drift + orphan-schema tests
  green (`src/http/openapi.test.ts`).
- **New `POSTHORN_*` env var**: document it in **both** `.env.example` **and** `docs/DEPLOY.md`
  (`src/runtime/config.test.ts` enforces this).
- **New end-to-end path**: add a compiled-`dist` smoke under `scripts/smoke-*.mjs`.
- `dist/` and `site/` are generated and gitignored — commits are source-only.
- **Commits**: conventional style; stage files **explicitly** (not `git add -A`); no co-author
  trailer. The autonomous loop suffixes the subject with `(iter-NNNN)` (4-digit) — that suffix
  is loop-specific. **Never push or merge to `main` without an explicit human request.**

## Autonomous vs. ask

**Proceed autonomously:** bounded maintenance (lint/format normalization, dead-code & comment
cleanup, small localized bug fixes with an obvious validation path) and any item on the
`docs/GOAL.md` backlog. When unsure, take the safest assumption, record it in the ticket /
commit (and the loop's `Decisions`/`Next`), and continue.

**Stop and ask a human:**
- The credential-gated **Exclusions** in `docs/GOAL.md` — real `npm publish`, pushing images to
  a registry, a live Stripe account/keys, buying a domain, a hosted/cloud demo, trademark.
- Schema / public-interface / dependency / storage-format / deployment / core-architecture
  changes that no backlog item authorizes.
- Anything destructive or hard to reverse; **pushing or merging to `main`**.
- Editing a hash-protected file (`scripts/manifest.txt`) or hand-editing `docs/LOG.md`.

## Parallel work / worktrees

Optional — the single-tree loop is the default. For a **risky or throwaway change** (a big
refactor, a spike you may discard) or to run **independent ticks in parallel** without their
trees clobbering each other, use a git worktree so each line of work is an isolated checkout
sharing one `.git`:

```
git worktree add .claude/worktrees/<slug> -b <branch>          # isolated tree on a new branch
cd .claude/worktrees/<slug> && bash scripts/agent/bootstrap.sh # npm ci (node_modules isn't shared)
# …change + gate (bash scripts/agent/check.sh) as usual…
git worktree remove .claude/worktrees/<slug>                   # after the work has landed
```

`.claude/worktrees/` is gitignored and `.aiignore`d, so those checkouts are never committed or
scanned. All the hard rules still apply inside a worktree — never push or merge to `main`
without an explicit human ask.

## Token efficiency

- Respect [.aiignore](.aiignore): never scan `node_modules/`, `dist/`, `site/`, `coverage/`,
  `*.db*`, `__pycache__/`, or `docs/log/` archives.
- Orient via `docs/ai/REPO_MAP.md`; read the **tail** of `docs/LOG.md`, not the whole file.
- Prefer `grep`/`glob` over reading whole trees. The store backends are near-identical — read one
  + its `conformance.ts` and infer the rest.
- Heavy ops (full Vitest ≈ 2060 tests/~21s, Postgres tests, smokes): run **targeted first**, the
  full gate before committing.

## Definition of done

Per `docs/GOAL.md`, every change: `npm run typecheck` clean · `npm test` green · `npm run build`
succeeds (`bash scripts/agent/check.sh` runs all three). Plus, when applicable: conformance suite
extended (store change), OpenAPI drift/orphan tests pass (route change), new env var documented in
both `.env.example` + `docs/DEPLOY.md`, a dist smoke for any new end-to-end path. Keep `main`
green; never touch the manifest files; never hand-edit `docs/LOG.md`.

**Known flake — vitest worker teardown.** On a full `npm test` (vitest's default `forks` pool with
per-file isolation) a worker process is occasionally torn down mid-cleanup, surfacing as a one-off
`Error: Worker exited unexpectedly` / Tinypool error. It is **non-deterministic and not a real
failure** — the cause is worker-recycle timing in a suite that boots many real gateways (HTTP
sockets + `node:sqlite`), not a product or test bug. **Re-run protocol:** if a single full run fails
*only* with a worker-exit/Tinypool error and **no test assertion actually failed**, re-run it — a
genuine regression reproduces, the flake does not. Do **not** paper over it with a blanket `retry`
(it would mask real regressions) or by forcing `singleFork` / `pool: "threads"` (the first serializes
the whole suite; the second risks native-addon issues with `node:sqlite`) — the rare re-run is
cheaper than either, which is why `vitest.config.ts` is left on the safe defaults.
