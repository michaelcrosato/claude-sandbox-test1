# plan/RISK_REGISTER — Posthorn (2026-05-29)

Risks to autonomous maintenance + the human-gated launch, with mitigations and rollback. Extends the
register in [`.agent/master_plan.md`](../.agent/master_plan.md) with the 2026 research refresh.

| # | Risk | Likelihood | Impact | Mitigation | Rollback |
| --- | --- | --- | --- | --- | --- |
| R1 | Editing a hash-protected substrate file | Low | High | Never touch the files in `scripts/manifest.txt`; `assert-gate-integrity.ps1` verifies the SHA-256s | `git checkout -- <file>` before commit |
| R2 | Hand-editing `docs/LOG.md` | Low | High | It is harness-managed; never hand-edit | revert the edit |
| R3 | Out-of-loop work tagged with `(iter-NNNN)` or a LOG entry | Med | Med | This lane uses conventional commits, **no** iter suffix, **no** LOG edit | amend message / revert |
| R4 | CI matrix/smoke jobs can't be validated locally on Windows | High | Med | State the validation gap; never claim a CI-only job green unverified — rely on a pushed branch / human | n/a (don't merge unverified) |
| R5 | Adding a `POSTHORN_*` var without dual-doc | Med | Med | `config.test.ts` enforces `.env.example` **and** `docs/DEPLOY.md`; update both + the hand-built smoke configs | revert var + docs |
| R6 | Scope creep into product features | Med | High | Honor the harden-only lane + `docs/GOAL.md` product boundary; non-goals live in [BACKLOG.md](BACKLOG.md) | revert; move idea to BACKLOG |
| R7 | Flaky test masking a real failure | Low | High | Re-run protocol (confirmed this session); never blanket-`retry`; never force `singleFork`/`threads` | investigate root cause |
| R8 | **npm publish from a compromised/again-stale pipeline** (2026 threat) | Med | High | Use **trusted publishing (OIDC) + automatic provenance** from CI, granular short-lived tokens, FIDO 2FA; near-zero deps is the strongest mitigation. **Provenance proves *which* pipeline built it, not that the pipeline was clean** (a May-2026 worm shipped valid SLSA-L3 provenance) — review the diff + lockfile before tagging | unpublish/deprecate the bad version; rotate creds |
| R9 | Tightening `engines` perceived as a breaking change | Low | Low | It corrects a false claim (default datastore needs Node ≥22.13 for `node:sqlite`); documented in CHANGELOG | revert one line |
| R10 | `plan/` drifts from the canonical `docs/GOAL.md` / hash-protected AXIOMS over time | Med | Med | `plan/` is the execution entry point but **incorporates** those constraints by reference and restates them; it is a dated snapshot refreshed each program; the hash-protected files win on any conflict (enforced by `assert-gate-integrity.ps1`) | refresh `plan/` from the current substrate |
| R11 | `node:sqlite` API churn while pre-stable (1.2 RC as of Node v25.7) | Low | Med | Pinned Node floor `>=22.13`; RC status documented; Postgres is the stable-API alternative for HA | pin Node; switch to PG backend |

## Standing rollback posture

- Working tree is clean and `main` is green; any maintenance change is a small, reviewed,
  conventional commit that reverts cleanly (`git revert <sha>`).
- Never push/merge to `main` without an explicit human ask, so remote rollback is rarely needed.
- The DoD gate (`npm run agent:check`) must pass **before** any commit — a red gate means stop, not
  paper over.
