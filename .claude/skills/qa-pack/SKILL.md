---
name: qa-pack
description: Produce the click-by-click human QA script for everything newly done since the last promotion. Posted on the promotion PR (develop → stable). The only artifact the operator uses to accept a release.
---

# /qa-pack — the human QA script

For every feature `done` since the last promotion PR, write a numbered click-through script a non-technical person follows on the staging URL. 8th-grade reading level.

Per feature:

```
### <Feature title in business language>
What changed: <one sentence>
1. Open <exact URL>.
2. Click "<exact visible button/label text>".
3. Type "<exact sample value>" into the "<field label>" box.
4. ✅ You should see: <exact expected result, screenshot attached if UI>.
5. ❌ If instead you see <likely failure>, comment on this PR: "@claude step 4 of <title> showed <what you saw>".
```

Rules:
- Every step is a physical action or an observation — never "verify the API returns 200".
- Use the seeded demo data (`scripts/seed.ts` fixtures) so values in the script actually exist; list any login credentials for the demo account (never real credentials).
- Attach expected-result screenshots from `roadmap/evidence/<id>/` where they exist.
- End the pack with: total time estimate, the one-click rollback reminder (OPERATOR_GUIDE §4), and "merging this PR = releasing to users."
- Walk each script against staging yourself before posting; a QA step that doesn't match reality is a NEEDS_WORK on the pack, not on the operator.
