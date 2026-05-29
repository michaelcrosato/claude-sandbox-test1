# TICKET001 — Agent scaffolding (AFK entry points)

- **Status:** done
- **Priority:** High

## Goal
Give autonomous agents portable, tool-agnostic entry points without forking the repo's existing
bespoke substrate.

## Context
The repo was already AFK-ready for its *own* loop (`docs/GOAL.md`, hash-protected
`docs/AXIOMS.md` + `docs/AGENT-LOOP.md`, the pwsh gate, `docs/LOG.md`) but had no generic
`AGENTS.md`, repo map, ignore file, or shell agent scripts. The constraint was "adapt, don't
duplicate": point into the substrate; never modify the hash-protected files or hand-edit the log.

## Scope
- **In:** `AGENTS.md`; root `GOAL.md`/`CLAUDE.md` thin pointers; `docs/ai/REPO_MAP.md`; `ROADMAP.md`;
  `.aiignore`; `scripts/agent/{_common,bootstrap,doctor,check,test,lint,typecheck,format,status}.sh`;
  `agent:check` npm script.
- **Out:** any change to product code, schemas, deps, or the hash-protected substrate.

## Likely files
`AGENTS.md`, `GOAL.md`, `CLAUDE.md`, `ROADMAP.md`, `.aiignore`, `docs/ai/REPO_MAP.md`,
`scripts/agent/*.sh`, `package.json`.

## Steps
1. Recon: `git status`, package scripts, `scripts/manifest.txt`, tree, `.env.example`.
2. Write the agent scripts (reuse npm scripts; skip-report absent lint/format; non-destructive).
3. Write `AGENTS.md` + pointers + `REPO_MAP.md` + `ROADMAP.md`; add `.aiignore`.
4. Validate the scripts run; confirm the gate is green.

## Acceptance criteria
- [x] `bash scripts/agent/status.sh`, `doctor.sh`, `check.sh` run and behave correctly.
- [x] `check.sh` and `npm run agent:check` run typecheck + test + build, non-zero on failure.
- [x] `lint.sh`/`format.sh` report "skipped" (no linter/formatter configured) and exit 0.
- [x] No hash-protected file changed; `docs/LOG.md` untouched.
- [x] Gate green: typecheck clean, 2063 tests pass, build succeeds.

## Commands
`bash scripts/agent/check.sh` · `npm run agent:check`

## Risks
Shell portability (Windows needs git-bash). Mitigated: `npm run agent:check` works in any shell;
colors auto-strip for non-TTY.

## Notes
`docs/GOAL.md` stays canonical; root `GOAL.md` is a pointer, not a fork.
