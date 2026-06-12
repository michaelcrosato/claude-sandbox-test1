---
name: status
description: Regenerate roadmap/STATUS.md as a plain-English report for the business operator. Run at the end of every work session and by scheduled routines.
---

# /status — regenerate the operator's status report

Rebuild `roadmap/STATUS.md` from current state. Audience: a non-technical business owner. **Banned:** file paths (except clickable URLs), stack traces, jargon (commit, diff, lint, refactor…), model/token talk beyond the cost line.

Sections, in order:
1. **Shipped this week** — merged features in business language ("Customers can now reset passwords by email"), newest first.
2. **Ready for your QA** — features `done` but not yet promoted: staging/preview link + one sentence each. Empty → say "Nothing yet."
3. **In progress** — `in_progress` features, one line each, with an honest plain-English status.
4. **Blocked / needs you** — open QUESTIONS.md items, one line + pointer.
5. **Health** — ✅/⚠️ staging working?, "all automated checks passing" or what's red (in plain terms), test count trend, and one cost line (session spend trend; flag any dated pricing transitions).

Data sources: `features.json` (truth for status), `roadmap/metrics.jsonl` (pass rates, review outcomes, cost notes — feed the Health line from data, not prose), `git log origin/develop` since last report, open PRs (`gh pr list`), CI runs (`gh run list`), QUESTIONS.md. Facts only — if staging is broken, say so plainly; never soften health to look good.
