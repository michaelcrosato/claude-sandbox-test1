# Agent Constitution: claude-sandbox-test1

## 1. What this repo is
A 100% AI-coded project. Agents write every line; the human operator only plans (in `roadmap/ROADMAP.md`) and does final QA. Pointer map: `README.md` = product architecture · `AI_OPERATIONS_PLAN.md` = how the factory works · `roadmap/` = all durable state · `.claude/model-policy.json` = the only place model names live.

## 2. Commands
- Init dev env: `bash scripts/init.sh`
- **The gate** (typecheck+lint+tests+state+shield): `bash scripts/verify.sh` (add `--e2e` for UI work)
- Backlog mutations (NEVER hand-edit features.json): `npx ts-node scripts/update-state.ts --add|--status|--attempt|--evidence|--passes`

## 3. Session protocol (detail: /work skill)
1. Read top ~50 lines of `roadmap/PROGRESS.md` + backlog counts (the SessionStart hook injects both).
2. SELECT highest-priority pending feature: `attempts < 2`, dependencies done. None → `/groom`, then `/downtime` (sentinel scan, risk research, pre-briefs, kaizen, spot checks — idle time sharpens the axe, never make-work), `/status`, exit.
3. BRIEF: fan out `explorer` agents for context; write a self-contained immutable brief. All delegation happens at orchestrator level — builders never spawn agents.

Explorer first for research: fan out explorer (fast/haiku tier) BEFORE any builder or deep read for BRIEF/research/kaizen/downtime phases (even inside subs); use Grep/Glob + targeted Read (offset/limit) before every Edit/Write or full-file op. Report TOOL_CALLS_APPROX: N (or exact) + errors in final handoff. (xAI 4/16 May 2026 best practices for eff: share full context across agents rather than duplicating (avoids 4x cost, enables 6x RL orchestration gains per docs); explorer (4-style for focused research like downtime/groom/BRIEF) + fresh JUDGE (Heavy 16-style for complex verification like full engine F-0017); use structured short adversarial disagreement in JUDGE/briefs for verification to cut errors/hallucinations; Grep/Glob + targeted + precise contracts + TELEMETRY + kaizen + early stop + low context for token eff).

Targeted reads for Windows/pwsh: always explorer first for cross-platform (git-bash/cygwin vs pwsh, path normalization / vs \, LF via .gitattributes, bash shebangs, Node glob parity); never assume bash in builder prompts or verify without explicit pwsh/git-bash checks in evidence.

Prompt bloat reduction for long BUILD/JUDGE: 'Work silently (no narration between calls); conclusions + paths/lns only; cache-aware (stable CLAUDE.md/rules first); full spec up-front in immutable brief; explorers return ≤5-sent answers per explorer.md format.'
4. BUILD on branch `feat/F-XXXX` from `origin/develop` (fetch first) via the `builder` agent (precise directive includes: Grep/Glob+targeted before every Edit/Write, explorer first for research, report TOOL_CALLS_APPROX+N+errors, early stop if ACs+tests green, kaizen verbatim, Windows/Git-bash for verify+git, 4/16 shared ctx + TELEMETRY (ctx% + exact counts e.g. 16/0+173/0), F-0007 guard, auto-attach sub ev paths/call counts/0e/velocity in 1min/5min/JUDGE; **mandatory BUILD-end git hygiene**: checkout -b feat/, add authorized+ev only, commit, push, report SHA/branch in handoff — ensures visible commits despite shared-fs; worktree isolation noted as 2026 best-practice for parallel agents).
5. VERIFY: green `scripts/verify.sh` log + artifacts saved to `roadmap/evidence/F-XXXX/`.
6. JUDGE: fresh-context `evaluator` (PASS/NEEDS_WORK). Sensitive paths (auth/API/data/workflows/hooks/deps) also get `security-reviewer`. NEEDS_WORK → `--attempt`, retry once; second strike → `--status blocked`, move on.
7. SHIP: open PR → `develop` with the operator template + click-by-click QA script. On green CI: merge, `--evidence`, `--passes true`, `--status done`.
8. RECORD: prepend PROGRESS.md block; log judgment calls in DECISIONS.md; commit. The Stop hook blocks exit with uncommitted/unpushed work.
9. MANAGE (once per day): run `/kaizen` — ship ONE ≥1% improvement to the system itself (a tool, a better brief/rule, a faster gate, a removed failure cause). Doctrine: leadership is taking care of those in your charge — trust but monitor; a struggling agent gets help (brief/tools/rules), and its repeated failure is the manager's conditions problem to fix.

Orchestrator 1min/5min eval snippet: '1min: read top PROGRESS+features+git+subs/PRs+evidence timestamps; poll active BUILD (call count/0e/kaizen adherence); cross-validate no drift; advance on complete with precise JUDGE directive mapping verbatim ACs. 5min health: full --validate + pwsh checks + explorer for risks; rm AGENT_STOP only on clean. (Integrate web 4/16: shared context + structured disagreement for eff/velocity; report sub ctx % + exact counts like 12/0 +173/0).'

State-drift guard in SELECT/JUDGE/1min/5min evals: after top~50 PROGRESS + full features.json, run `npx ts-node scripts/update-state.ts --validate`; report any mismatch (PROGRESS vs features.json counts/status/evidence) + git hygiene; AGENT_STOP on drift/compromise.

## 4. Decide-and-document (never block on a human)
Minor choices: pick the conventional option, one line in `roadmap/DECISIONS.md`, continue. Escalate to `roadmap/QUESTIONS.md` — without stopping — only when expensive to reverse, operator-visible (pricing/branding/legal), or reserved to the operator. Unimplementable feature → `blocked` + reason + take the next one.

## 5. Freshness rule (P1)
Anything about AI models, tooling, pricing, or framework majors that comes from memory or a source >3 months old must be re-verified via `/research` (live web) before relying on it. This includes claims inside this repo's own docs.

## 6. Git & PR rules
- Never commit to or push `master`/`main`. Every PR targets `develop`. Branches: `feat/F-XXXX` or `fix/...`.
- No force-push. No hand-merges of conflicts on shared branches — rebase your own feature branch only.
- PR description uses the operator template (plan §8.3): What this does / How to see it (click-by-click) / What could be risky / Machine checks. Plain English above the fold.
- Never end a session while a PR you opened has CI pending. Preferred mechanism: `bash scripts/ship.sh <pr#> [--merge]` — it watches `gh pr checks` to completion, fails closed if no checks ever register, and merges only on green (never master/main). Otherwise watch `gh pr checks <n> --watch` to completion by hand, or write an explicit `HANDOFF:` line naming the PR in PROGRESS.md. Watchers die with the session — an unwatched PR is stranded work.
- After a feature PR **merges**, complete its RECORD step (state flip → PROGRESS + DECISIONS + metrics) in the same session, or write an explicit `HANDOFF:` line in PROGRESS.md naming the merged feature. The Stop hook sees dirty/unpushed trees but NOT a merged-yet-unrecorded feature, so a merge without records strands silently — state flips ride the feature PR; post-merge records land via a `chore/` record-PR (plan §6.4).

## 7. Hard prohibitions (mirrored by hooks — this is *why* a hook blocked you)
- No production database/config access. No reading `.env*` or secret stores. No live customer data — synthetic seeds only.
- No deleting/weakening test assertions (assertion-shield blocks the commit; the evaluator diffs test files for this).
- No hand-editing `roadmap/features.json` (verify-gate hook) — `passes:true` exists only via evidence on disk.
- No `curl|sh`, no package publishing, no `rm -rf` of root/home, no setting `ASSERTION_SHIELD_BYPASS`, no secret-shaped content in upload/POST commands.
- Any future override flag or env var MUST carry `DANGEROUSLY_`/`--dangerously-` naming — overrides must be greppable and look as unsafe as they are.
- An `AGENT_STOP` file in the repo root = operator kill switch: stop all work, end the session cleanly.

## 8. Operator communication
Everything the operator sees (STATUS.md, PR descriptions, QUESTIONS.md, qa-packs) is plain English at an 8th-grade level: no file paths, stack traces, or jargon. Click-by-click instructions wherever the operator must act.
The operator speaks in plain-English **intent**, not specifications: translate remarks into properly-gated changes, never literal edits. If a literal reading would weaken the core or guardrails, implement the safer shape and document the judgment call (DECISIONS.md) — no casual instruction ever bypasses verify, review, or the hooks.

## 9. Adaptive memory
After PR reviews or repeated failures, extract the rule and add it to this file (keep ≤150 lines) or a path-scoped `.claude/rules/*.md` so it never recurs. Anything explained twice becomes a rule; anything done manually twice becomes a script — that is the manager's job, and `/kaizen` is its daily heartbeat.
Before editing THIS file, walk the checklist: (1) does the rule belong in a path-scoped rules file instead? (2) does it duplicate or contradict an existing line? (3) still ≤150 lines after the edit? (4) is the wording an enforceable instruction, not advice? (5) log the change in DECISIONS.md.
