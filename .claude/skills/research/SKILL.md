---
name: research
description: Web-verify any AI/stack/tooling claim before relying on it (Operating Principle P1). The AI field changes week to week — anything not verified against live sources within ~3 months is stale by default. Also maintains .claude/model-policy.json.
---

# /research — verify before you trust

**Trigger discipline (P1):** before acting on any claim about AI models, pricing, Claude Code features, framework majors, security advisories, or third-party APIs, check its freshness. Sourced >3 months ago — or from model training memory — means **re-verify now**. This applies to *this engine's own documents*: AI_OPERATIONS_PLAN.md cites sources verified 2026-06-09; after ~2026-09 treat its tooling claims as stale too.

Procedure:
1. State the claim and the decision depending on it (one line each).
2. Web-search for the **official/primary source** (vendor docs, changelogs, release notes, security advisories). Cross-check ≥2 independent sources for anything load-bearing; prefer dated pages.
3. Record verdict in the artifact that depends on it: confirmed (cite URL + date) / changed (update the doc AND log one line in DECISIONS.md) / unverifiable (say so explicitly; choose the conservative option).

Model-policy duty: any change to a `.claude/model-policy.json` mapping happens **only** through this skill — verify the official model catalog + pricing page, update the mapping, stamp `last_verified`, list the change in DECISIONS.md. The weekly hygiene routine re-runs this check; mappings older than 30 days get re-verified.
