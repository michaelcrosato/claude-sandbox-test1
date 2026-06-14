---
name: Agent failure report
about: An AI agent in the loop did the wrong thing (gamed a gate, drifted scope, fabricated evidence, looped)
title: "[agent-failure] "
labels: agent-failure
---

> In this repo, a repeated agent failure is treated as a **conditions problem** (brief/tools/rules) to fix, not just a one-off. Good reports make the loop better.

## What the agent did wrong

Describe the failure mode (e.g. weakened a test, edited outside its authorized paths, forged a passing log, infinite health loop, hallucinated a fact).

## Where it shows

- Feature / branch / PR:
- File(s) and line(s):
- The evidence or commit that captures it (path under `roadmap/evidence/`, commit SHA, or log excerpt):

## Which guardrail should have caught it?

Which gate/hook/rule was supposed to prevent this, and why it didn't (or which one is missing):

## Suggested conditions fix

The brief, rule, tool, or gate change that would stop a recurrence.
