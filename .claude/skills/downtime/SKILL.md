---
name: downtime
description: The idle protocol — what the orchestrator does when no feature is buildable (empty backlog, blocked on operator, waiting on CI). Proactive sentinel scan, risk research, pre-briefing, kaizen, spot checks. Never make-work.
---

# /downtime — sharpen the axe

*"Give me six hours to chop down a tree, and I will spend the first four sharpening the axe."* You are the manager with no feature to assign. That is not idle time — it is the highest-leverage time you get. Budget: ≤30% of the session's context; run the list top-down and exit cleanly when either runs out.

1. **Sentinel scan — catch problems before they happen.**
   - `gh run list --limit 20`: new flakiness, slowdowns, red runs nobody triaged.
   - Staging up? Last deploy matches develop HEAD?
   - `gh api repos/{owner}/{repo}/dependabot/alerts` (if enabled): new vulnerabilities.
   - Stale branches, green-but-unmerged PRs, `npx ts-node scripts/update-state.ts --validate` drift.
   - `.claude/model-policy.json` entries with `last_verified` older than 30 days → `/research`.
   - **Optional-module triggers** (`docs/optional-modules.md`): check each trigger condition against the repo's actual state (src/ exists? public? protection on? external tool added?). A newly-true trigger → groom the module via `--add` (or QUESTIONS.md if it's an operator call). Never adopt silently; never load the catalog into routine context.
   - **Long-term 35-60min+ or complex systemic research/sentinel (per xAI 4-agent best practices for focused/quick research + our complex assess velocity/bottlenecks/weak outputs/groom/kaizen opp):** fan out 4 parallel explorer subs (Grep/Glob + targeted read_file FIRST on every path before runs/ls; share full context; precise contracts with kaizen/TOOL_CALLS_APPROX + 0e + velocity + early stop; report per sub + synthesize for report). Use 16 Heavy style only for deep JUDGE. Small finding → fix now on a `fix/...` branch through the normal loop. Big finding → backlog feature via `--add`.

**5min quick research/optimize explorers (per xAI 4 for quick/focused):** use the light Grep-only sentinel contract as deployed for 60s lighters and now for 5min: limited globs + specific sentinel patterns ONLY (the patterns list: "20/19p|173 passed, 0 failed|VERIFY: PASS \(exit 0\)|RBAC 2 principals|src/forge|Grep/Glob|4/16|0e|DECISIONS:34|AGENT_STOP|Velocity: 0|no AGENT_STOP|BUILD COMPLETE"), then 3-5 small targeted reads, cap 12 calls or >300s, early stop + partial + BUILD COMPLETE, no full sentinel, focus on eff/prompts/4-par/ctx/0e + web P1, 4/16 Windows. (Extended from previous 60s lighter fix after this 5min failure.)

2. **Risk research for the next moves.** For the top 2–3 pending/upcoming features, identify the riskiest external assumption each rests on (API shape, framework major, pricing, a "we think X works" claim) and `/research` it now. Write verified findings into the feature's description via `update-state.ts` so the future builder starts from facts. This is what "maximize the success probability of future moves" means in practice.

3. **Pre-brief the next features.** Fan out explorers; write the full immutable briefs (spec excerpt, acceptance, file map, rules) for the top 2–3 pending features into `roadmap/briefs/F-XXXX.md`. When work resumes — or the operator answers a blocker — builders start instantly, in parallel if the features are independent.

4. **`/kaizen`** — if no kaizen entry exists for today, do it now (one shipped ≥1% improvement).

5. **Trust-but-monitor spot check.** Pick one recently `done` feature; re-run its verify evidence; click-test its QA pack steps against staging if reachable. Leadership is taking care of those in your charge: if an agent's past work regressed, that's a conditions problem — fix the gate that should have caught it, then the regression.

6. **Hygiene.** Archive PROGRESS.md past ~500 lines, refresh `/status`, tidy answered QUESTIONS.

**Hard rules:** never invent busywork to look productive; never spin up sub-agents without a concrete deliverable; an empty backlog with a sharpened axe is a success state — record what was sharpened in PROGRESS.md and exit cleanly.
