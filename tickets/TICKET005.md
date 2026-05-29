# TICKET005 — Decide & document the no-linter/-formatter stance

- **Status:** todo
- **Priority:** Low

## Goal
Make the absence of a linter/formatter a *documented, deliberate* choice rather than an apparent
gap, so agents stop "skipping" it as if something were missing.

## Context
There is no ESLint/Prettier/Biome config in the repo. Code style is held by `tsc` (strict:
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`) plus reviewer
discipline. `scripts/agent/lint.sh` and `format.sh` already detect this and print "skipped" (exit
0) — correct behavior, but a reader can't tell *deliberate* from *not-yet-added*. The decision
needs to be written down once. The default recommendation is to **stay tool-free**: the codebase is
small, consistent, and strict-typed; adding a formatter now would churn the entire tree for no
correctness gain.

## Scope
- **In:** a short "Code style" note (in `AGENTS.md` and/or `docs/ai/REPO_MAP.md`) stating the
  stance and why; confirm `lint.sh`/`format.sh` keep exiting 0 with a clear "skipped — none
  configured (deliberate)" line.
- **Out:** actually adding ESLint/Prettier/Biome (a separate, larger decision — would touch every
  file and CI). If ever revisited, do it as its own ticket with a one-shot format commit isolated
  from logic changes.

## Likely files
`AGENTS.md`, `docs/ai/REPO_MAP.md`, `scripts/agent/lint.sh`, `scripts/agent/format.sh`.

## Steps
1. Confirm no linter/formatter config exists (`*.eslintrc*`, `.prettierrc*`, `biome.json`,
   `package.json` keys).
2. Write the stance: strict `tsc` is the style gate; no formatter by choice; revisit only with a
   concrete need.
3. Ensure the agent scripts' "skipped" message reads as deliberate, not missing.

## Acceptance criteria
- [ ] The no-linter/-formatter decision is documented in one canonical place and linked.
- [ ] `lint.sh`/`format.sh` exit 0 and clearly state the absence is intentional.
- [ ] No new dependency added (decision is "stay tool-free" unless a future ticket overturns it).

## Commands
`ls -a | grep -Ei 'eslint|prettier|biome'` · `bash scripts/agent/lint.sh` · `bash scripts/agent/format.sh`

## Risks
Low. Worst case the stance is reversed later; this ticket just records the current, intentional
state so it isn't mistaken for an oversight.

## Notes
Found while building the agent scripts (TICKET001): the scripts handle the absence correctly, but
the *why* was undocumented. This ticket closes that gap without committing to tooling.
