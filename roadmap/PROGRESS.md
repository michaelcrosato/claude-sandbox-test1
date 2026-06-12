# Progress Log

> Newest entry first. Each session **prepends** a block: date, feature id, what was done, what was verified (evidence paths), surprises, exact next step. The SessionStart hook injects the top ~50 lines into every new session.

---

## 2026-06-12 — F-0001 in progress (product scaffold)

**What:** Groomed the empty roadmap into 18 machine backlog items, selected F-0001, and added the first Posthorn TypeScript product scaffold with a minimal gateway factory, Vitest test, build script, and README status wording.

**Verified:** Local product checks passed: `npm run typecheck`, `npm test`, `npm run build`, `npm run lint`, and `npx ts-node scripts/update-state.ts --validate`.

**Surprises:** `bash scripts/verify.sh` reaches the existing hook contract tests but fails locally because Git Bash can see Windows `npm`/`npx` without a native Bash `node`; CI on Ubuntu is the authoritative full-gate lane for this branch.

**Next step:** Push `feat/F-0001`, open the PR to `develop`, and use the CI verify log as F-0001 evidence before marking it done.

---

## 2026-06-11 — Engine installed (department bootstrap)

**What:** AI operations engine (ai-operations-template drop-in) installed into claude-sandbox-test1 (Posthorn — webhook relay). Engine files copied, placeholders filled, roadmap seeded, PROGRESS/DECISIONS/ROADMAP initialized.

**Verified:** `bash scripts/init.sh` and `bash scripts/verify.sh` both passed — VERIFY: PASS confirmed. Branch `develop` pushed to GitHub with engine commit. Default branch set to `develop`; branch protection applied to `develop` and `main`.

**Next step:** Run `/groom` against the charter (README.md + GOAL.md + roadmap/ROADMAP.md) to decompose the Now/Next/Later bullets into `features.json` entries with acceptance criteria.

