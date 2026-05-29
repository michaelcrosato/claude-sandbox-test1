# CLAUDE.md

Thin pointer — the canonical agent instructions are in **[AGENTS.md](AGENTS.md)**. Read it first.

**Orient:** `bash scripts/agent/status.sh` → [docs/GOAL.md](docs/GOAL.md) (goal + backlog +
definition of done) → [docs/ai/REPO_MAP.md](docs/ai/REPO_MAP.md) → [ROADMAP.md](ROADMAP.md) →
[tickets/](tickets/). **Gate** every change with `bash scripts/agent/check.sh` (or `npm run agent:check`).

**Hard rules:** never edit the hash-protected files listed in [scripts/manifest.txt](scripts/manifest.txt);
never hand-edit [docs/LOG.md](docs/LOG.md); never push or merge to `main` without an explicit human
ask. The full command reference and the autonomous-vs-ask matrix are in [AGENTS.md](AGENTS.md).
