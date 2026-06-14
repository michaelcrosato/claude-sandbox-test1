---
paths:
  - "schema/**"
  - "migrations/**"
  - "**/migrations/**"
---

# Database rules (loaded only when touching schema/migrations)

> No `schema/` or `migrations/` directory exists yet — this rule is forward-looking
> and documents the `db-engineer` contract for when a data layer lands. Until then
> it never fires (by design).

- Migrations are append-only; never edit an applied migration — roll forward with a corrective one.
- Expand/contract for anything destructive: add new column/table first release, backfill, switch reads, drop in a later release. Never DROP/TRUNCATE/narrow-type in the same release that stops using it.
- Every migration: reversibility note, updated client/ORM types, a test exercising the change, EXPLAIN capture for new query paths on growth tables (evidence dir).
- Dev/staging instances only; prod connection strings are a reportable incident, not a convenience.
- Delegate nontrivial schema work to the `db-engineer` agent rather than doing it inline.
