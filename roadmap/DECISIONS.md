# Decisions Log (append-only, ADR-lite)

> One entry per autonomous judgment call: context → decision → reversible? → where it lives.

- QA surface: charter names Docker/Fly.io (single-container, no Redis) → adopted Docker/Fly.io as the deployment and QA surface; persistent staging from `develop` on Fly.io; preview per PR (department)
- Database: charter specifies SQLite via node:sqlite (built-in, no external service) as the default, with optional PostgreSQL backend for scale-out → adopted SQLite as the primary database; no external DB CLI needed (department)
- E2E approach: charter specifies vitest + compiled-dist smoke tests covering ~2060 tests across all routes and wire contracts → adopted vitest compiled-dist smokes as the E2E verification method (department)
- GitHub repo: michaelcrosato/claude-sandbox-test1 (as specified by department runbook) (department)
- Package manager / toolchain: npm, node ≥22.13, tsc, biome, vitest — all confirmed by existing package.json and charter docs (department)
- F-0001 verification lane: local PowerShell can run Node 24 and product checks, but Git Bash lacks a native `node` binary and the Windows `node.exe` path/env bridge breaks existing hook fixtures → use Ubuntu CI as the authoritative full `verify.sh` evidence for this branch; reversible by installing native Node in the Bash environment.
