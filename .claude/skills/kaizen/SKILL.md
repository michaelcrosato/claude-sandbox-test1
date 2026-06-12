---
name: kaizen
description: Daily manager pass — find and ship ONE concrete ≥1% improvement to the engine or working conditions (tooling, briefs, rules, gates, docs), with evidence it helps. Run once per day from /work step 8.
---

# /kaizen — improve the system 1% per day

You are the manager walking the factory floor. Product features are NOT in scope here — the **system that builds them** is.

## Procedure
1. **Gather signals** (15 min of reading, fan out explorers if useful):
   - `roadmap/metrics.jsonl` — the measurable feed: first-attempt pass rate (attempts==0 vs total), recurring NEEDS_WORK/BLOCK verdicts, findings_fixed trend. This is where "check that metric next kaizen" (step 4) reads from.
   - PROGRESS.md since the last kaizen entry: where did sessions lose time? What surprised agents?
   - Evaluator/security findings: any *category* that recurred?
   - CI history (`gh run list`): flaky steps, slow steps?
   - DECISIONS.md: decisions that should be promoted to rules so they're never re-decided.
   - QUESTIONS.md: anything answerable now by building a tool instead of waiting?
2. **Pick exactly ONE improvement** — the highest leverage-to-effort item. Classic manager moves:
   - Give the workers a tool (a script that automates a repeated manual step).
   - Improve conditions (clearer rule file, better brief template, faster verify path, pre-seeded fixtures).
   - Remove a recurring failure cause permanently (lint rule, hook pattern, CI cache).
   - Tighten a gate that let something mediocre through; loosen one producing only false alarms.
3. **Ship it** through the normal loop: branch, implement, verify, PR → develop. Small is fine — 1% compounds to ~37× in a year; 0% compounds to nothing.
4. **Record** in PROGRESS.md under a `### kaizen` heading: the signal, the change, and the metric you expect to move (and check that metric next kaizen).

## Guardrails
- One improvement per day — no improvement sprees that starve the roadmap.
- Changes to hooks/gates/CI always get the `security-reviewer` (a "convenient" gate-weakening is the classic failure here).
- If the best improvement needs operator input, log it in QUESTIONS.md and pick the second-best instead. Never skip a day for lack of a perfect idea.
