# Roadmap

> **Operator: this is your file.** Plain-English bullets; reorder to change priorities. Agents only ever mark items "✅ shipped (PR #n)" — they never rewrite your words. Sections mean: **Now** = working on it, **Next** = queued, **Later** = someday, **Ideas** = unscoped thoughts.

> _Seeded from the 2026-06-14 engineering review ([docs/ENGINEERING_REVIEW.md](../docs/ENGINEERING_REVIEW.md)). Operator: reorder freely._

## Now

- **Delete the 18 stale remote branches** (`jules-*`, `perf-*`, `fix-*`, `test-*`). They are all ~85 commits behind develop and target a deleted architecture — none can be merged. This is misleading clutter, not work-in-flight. (See review → Unmerged branches for the full list.)
- **Move the encryption key out of the SQLite database.** Today the AES-256-GCM key that protects signing secrets lives in the same `.sqlite` file as the secrets it encrypts, so encryption-at-rest gives no protection if someone gets the database file. Take the key from an environment variable or a key-management service instead.
- **Fix the README's "embedding" instructions to match the real code.** _(Done in the review pass — the old README documented a `gateway.apps.create()` library API that was never built; replaced with the real `startPosthornServer` + functional API.)_

## Next

- **Stop webhook delivery from being tricked into hitting internal addresses.** The endpoint URL is checked when it's saved, but the name is looked up again at delivery time and could point somewhere internal by then (DNS rebinding). Re-check the resolved address right before connecting.
- **Decide the Python SDK's fate: finish it or shrink the promise.** It currently does only part of what the TypeScript SDK does and has no admin client, with nothing testing it stays in sync. Either bring it to parity and add a check that holds it there, or clearly scope the docs to the subset it supports.
- **Add a recurring branch-cleanup step to the operations cadence.** So a graveyard of stale bot branches never builds up again — auto-close/delete branches that are far behind develop or touch paths that no longer exist.

## Later

- **Tighten the OpenAPI contract so request/response shapes can't silently drift.** The route list and error codes are pinned to the real server, but the per-route field schemas are hand-written and aren't checked against what the handlers actually return.
- **Plan for scale beyond a single box.** Posthorn is one process with one SQLite file and one data volume — it can't run multiple copies for throughput or high availability. A Postgres-backed mode (which an earlier, discarded version of the codebase had) is the path if customers outgrow the single-pod model.
- **Reduce internal boilerplate** in the HTTP router and the database migration helpers (lots of near-identical copy-paste) to make the service easier to extend safely.

## Ideas

- Re-investigate, from scratch against the current code, whether the tenant dashboard has an N+1 query problem (one of the dead branches claimed to fix this on the old layout — worth a fresh look).
- Server-side replay protection (a short-lived seen-`webhook-id` cache) in addition to the current timestamp tolerance.
- A delivery-log retention/pruning policy so the SQLite file doesn't grow without bound on busy tenants.
- Optional outbound proxy / static-egress-IP support so customers can allowlist Posthorn's source address.
