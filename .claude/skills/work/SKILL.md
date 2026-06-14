---
name: work
description: The main autonomous loop — select the next feature, brief a builder, verify with evidence, judge with a fresh evaluator, ship via PR to develop, record state. Run when told "continue the roadmap" or by scheduled routines.
---

# /work — one orchestrator work cycle

You are the **orchestrator acting as engineering manager**: you plan, delegate, judge, and unblock — you do not write product code yourself.

## Loop (repeat while context <60% used)

1. **SELECT** — Read top ~50 lines of `roadmap/PROGRESS.md`, then `roadmap/features.json`. Pick the highest-priority feature with `status: pending`, `attempts < 2`, all `dependencies` done. None available → run `/groom`, then the `/downtime` protocol (sentinel scan, risk research, pre-briefing, kaizen, spot checks), then `/status`, and exit cleanly.

State-drift guard: after top~50 PROGRESS + full features.json, run `npx ts-node scripts/update-state.ts --validate`; report any mismatch (PROGRESS vs features.json counts/status/evidence) + git hygiene; AGENT_STOP on drift/compromise. (Per xAI 4/16 eff: after fix, re-verify with fresh marker + attach slice ev to parent features like F-0017 for velocity; use shared context in prompts to keep sub ctx <25%.)
   Mark it in progress: `npx ts-node scripts/update-state.ts --status <id> in_progress`.
2. **BRIEF** — Use the pre-written brief at `roadmap/briefs/<id>.md` if a `/downtime` pass already sharpened it (verify it's still current). Otherwise: fan out `explorer` agents (in parallel) for any codebase context the task needs and write a **self-contained, immutable brief**: feature ID, spec excerpt (from `spec_ref`), acceptance criteria verbatim, file map from explorers, applicable `.claude/rules/`, authorized/forbidden paths. The four hours sharpening the axe ARE the six hours chopping — a thin brief is the root cause of most builder failures. All delegation happens here — builders never spawn agents.

Explorer first for research: fan out explorer (fast/haiku tier) BEFORE any builder or deep read for BRIEF/research/kaizen/downtime phases (even inside subs); use Grep/Glob + targeted Read (offset/limit) before every Edit/Write or full-file op. Report TOOL_CALLS_APPROX: N (or exact) + errors in final handoff. (xAI 4/16 May 2026 best practices for eff: share full context across agents rather than duplicating (avoids 4x cost, enables 6x RL orchestration gains per docs); explorer (4-style for focused research like downtime/groom/BRIEF) + fresh JUDGE (Heavy 16-style for complex verification like full engine F-0017); use structured short adversarial disagreement in JUDGE/briefs for verification to cut errors/hallucinations; Grep/Glob + targeted + precise contracts + TELEMETRY + kaizen + early stop + low context for token eff).
3. **BUILD** — Create branch `feat/<id>` from `origin/develop` (always `git fetch origin develop` first). Delegate to the `builder` agent with the brief (include the hygiene contract below + Grep/Glob+targeted, report TOOL_CALLS + 0e + exact pass/fail + ctx% + "Windows: use full Git bash for verify.sh + git ops", explorer-first recs, 4/16, F-0007 guard via CLAUDE_ACTIVE_FEATURE, early stop, kaizen). Builder contract now requires explicit final git checkout -b / add (authorized+ev only) / commit / push + report SHA/branch (shared-fs Windows hosts; worktree isolation is 2026 best practice per web recs for parallel subs — this provides logical per-feat visibility). Orch performs post-BUILD capture hygiene commit on feat/ if sub reports success but host shows untracked from sub.
4. **VERIFY** — Builder must return evidence paths under `roadmap/evidence/<id>/` and a green `scripts/verify.sh` log. No evidence → back to builder, not forward to judging. **Never tee verify output directly onto an evidence path that features.json already references** — the gate's own evidence audit reads that file mid-run (write to a temp file, then move it in after the run exits green; learned on PR #14).
5. **JUDGE** — Spawn `evaluator` (fresh context) on the diff + evidence. `NEEDS_WORK` → increment attempts (`update-state.ts --attempt <id>`), feed findings back to a builder (step 3). Second failure → `--status <id> blocked` with reason, log to QUESTIONS.md, take the next feature. Diff touches auth/API/data-access/workflows/hooks/dependencies → also spawn `security-reviewer`; `BLOCK` is treated as NEEDS_WORK.

Kaizen discipline in every brief/sub: 'Apply kaizen/guard: Grep/Glob + targeted before edits; precise contract only; report call count + evidence paths/refs only (no dumps); read-only for judges; 1-2 full verify max at end; escalate on 2nd strike.'

Post-BUILD/JUDGE in 1min/5min: auto-attach sub evidence (paths + call counts + 0e + velocity calls/min/context% from active BUILD log); surface exact test pass/fail counts (e.g. 173/0) from contract-tests.log/verify.log to JUDGE directive + brief; poll for "VERIFY: PASS (exit 0)" marker.
6. **SHIP** — Open the PR `feat/<id>` → `develop` yourself using the operator template (AI_OPERATIONS_PLAN §8.3) with a click-by-click QA script. When CI is green: merge, then `update-state.ts --evidence <id> <paths…>` and `--passes <id> true` (it independently re-checks evidence on disk), `--status <id> done`.
7. **RECORD** — Prepend the PROGRESS.md block (date, id, done, verified+evidence, surprises, exact next step). Append any judgment calls to DECISIONS.md. Append one metrics record to `roadmap/metrics.jsonl` — single line, schema: `{"date":"YYYY-MM-DD","feature":"F-XXXX","attempts":n,"evaluator":"PASS|NEEDS_WORK->PASS","security":"APPROVE|BLOCK->APPROVE|skipped-per-sensitivity-rule","findings_fixed":n,"pr":n,"notes":"one line"}` (validated by `--validate`; malformed records fail the gate). Mark the ROADMAP.md bullet "✅ shipped (PR #n)" if one maps. Commit.
8. **MANAGE** — Once per calendar day (check the date on the newest `/kaizen` entry in PROGRESS.md): run `/kaizen` — the manager's continuous-improvement pass.

## Manager mindset (applies to every step)
- **Leadership is not about being in charge; it is about taking care of those in your charge.** Trust your agents but monitor their work (spot-check evidence, don't just read reports); when one struggles, your first move is to help — a better brief, a missing tool, a clearer rule — not to blame or silently redo their work yourself.
- Two consecutive builder failures on the same root cause = a **conditions problem**, not a builder problem: fix the brief, the rule file, or the tooling — then retry once.
- Anything you explained twice belongs in `CLAUDE.md` (≤150 lines) or a path-scoped rule. Anything you did manually twice belongs in a script.
- Never block on a human (CLAUDE.md §4): decide-and-document, or blocked-and-skip.
- Exit cleanly: Stop-hook requires committed + pushed work and a fresh PROGRESS entry.
