# Optional Modules — NOT part of the core engine

> **Everything in this file is optional.** None of it ships active, none of it is loaded into agent context, and none of it belongs to the drop-in core that every adopting repo wants. Each module activates only when its **trigger condition** becomes true for *your* repo — until then it costs nothing. All entries were verified against current sources on 2026-06-10 (details + source URLs: [`feedback-2-verification.md`](feedback-2-verification.md)).
>
> **How this file is used:** the orchestrator's `/downtime` sentinel scan checks these triggers against the repo's actual state. When a trigger fires, the matching module is groomed into `roadmap/features.json` (or raised in `QUESTIONS.md` if it's an operator call) — it is never adopted silently.

## Trigger: product code lands (`src/` exists — verify.sh PRODUCT_MODE flips)

| Module | What it adds | Notes |
|---|---|---|
| Placeholder check | ~5-line grep failing `verify.sh` on remaining `<PLACEHOLDER>` tokens | Gated on PRODUCT_MODE — always-on would fail the template itself (#53) |
| Mutation testing | StrykerJS kill-rate gate against lazy generated tests | Opt-in/weekly lane, never the default verify hot path; StrykerJS 9.6.1 current, TS6-compatible (#21) |
| AST repo map | `scripts/repo-map.ts` (Node TS Compiler API, zero-dep — not tree-sitter binaries) injected into builder briefs during downtime pre-briefing | Worthless until there's a codebase to map (#31) |
| E2E / staging lane | Real preview deploys + `/qa-pack` against them; failure artifacts/screenshots | Needs the deployment surface from plan §2.1 (#71) |
| Env-var documentation | Plain-markdown list of required env-var **names** (never values) | NOT a literal `.env.example` — the engine's own deny rules would make that file unreadable to agents (#73, reshaped) |
| semgrep / CodeQL | Deep static analysis fleet | Explicitly deferred until real product source exists (J-23, fork-3) |
| Layout decision | src/packages structure | Decided by the product, never imposed by the template (#74, fork-6) |

## Trigger: the repo goes public

| Module | What it adds | Notes |
|---|---|---|
| SECURITY.md | Private-vulnerability reporting route + honest "reference template" scoping + dated In/Out-of-Scope block (absorbs the threat-model artifact idea) | GitHub private vuln reporting **only works on public repos** (#4, #47) |
| Issue templates | `bug_report` (asks for evidence paths), `feature_request`, `agent_failure` | No consumers while private; `operator_question.yml` stays rejected — QUESTIONS.md is the channel (#2) |
| CONTRIBUTING.md | Objective acceptance bars (pydantic-ai pattern) + slot-claim flow (goose pattern) | No contributors exist yet (#5) |
| CODE_OF_CONDUCT.md | Standard covenant | Low priority (#8) |
| Community-library split | Engine repo stays lean; community rules/skills live in a separate repo | (#69) |
| Responsible-AI note | Adopter-responsibility section | (#58) |

## Trigger: branch protection active (operator task Q-0001 done)

| Module | What it adds | Notes |
|---|---|---|
| CODEOWNERS | Guardrail-path map (CLAUDE.md, `.claude/**`, `scripts/**`, workflows, schema) routed to the operator | **Inert without required-review protection** — shipping earlier buys nothing (#6, fork-5) |
| Scheduled automation | Nightly `/work` Routine; model-policy freshness auto-PR cron | Hard rule J-4: no scheduled write-capable automation before protection; cron also bills the agent-credit pool — the zero-token staleness check in `--validate` (F-0009) covers the gap meanwhile (#48) |
| AI diff-review CI gate | claude-code-security-review-style independent diff analysis on sensitive paths | Diff-analysis ONLY, claude.yml-grade trust gates; upstream action only weakly maintained (last commit 2026-02) — re-verify before adopting (#13, fork-7) |

## Trigger: first external / MCP tool integration

| Module | What it adds | Notes |
|---|---|---|
| Tool registry artifacts | `.claude/tool-policy.json` + `docs/tool-registry.md` (purpose, trust level, env-named secrets, allowed commands, network, approval gate per tool) | The registry *principle* is already policy (plan §2.1 note); the machine-readable artifacts wait for a consumer (#44, K-2) |
| Schema-validated tool I/O | Zod validation at every external-tool boundary, auto-reprompt on failure | Engine scripts already validate in code; the dependency earns its keep at the first external boundary (#75) |
| Verb-first naming + capability boundaries | `get-file-info` not `file-info`; Roots-style filesystem scoping | (#76) |

## Trigger: you actually run other CLIs (Codex/goose/Cline) against this repo

| Module | What it adds | Notes |
|---|---|---|
| Deeper AGENTS.md integration | Promote shared rules into AGENTS.md with CLAUDE.md as the Claude-specific overlay (via the official `@AGENTS.md` import) | The thin pointer stub ships in core wave 1 (F-0011); anything deeper waits for real cross-tool use. Verified: Claude Code reads CLAUDE.md, not AGENTS.md (#61) |
| Vendor-neutral `.agents/` projections | One source generating `.claude/`/`.codex/`/`.cursor/` | Stays rejected until cross-tool sessions are routine (#62) |

## Trigger: external adopters exist (template actually distributed)

| Module | What it adds | Notes |
|---|---|---|
| Upgrade tooling | `engine-manifest.json` (engine-owned vs operator-owned paths) + `upgrade.sh` that never clobbers operator files and prints skips; installer/customizer | 1+ week; pointless with zero adopters (#60 heavy half). The cheap slice — CHANGELOG aggregating DECISIONS since last tag + release checklist — can start at any release |
| Examples library | 2–3 `claude.yml` variants, filled sample brief + evidence dir | Drift liability with no consumers (#55) |
| Troubleshooting docs | Common failures FAQ | Same (#54) |
| Docs site | Only if markdown-in-repo stops scaling; copy langfuse's LLM-readable `.md` endpoints idea | (J-12) |

## Trigger: stack- or situation-specific

| Module | Trigger | Notes |
|---|---|---|
| Python toolchain (uv, pyproject, ruff/mypy) | A Python product stack lands | (#72) |
| Devcontainer parity | Heavy local/maintainer development (the documented Windows hook-testing pain) | Copy Anthropic's reference `.devcontainer` (Dockerfile + init-firewall.sh — verified current) nearly verbatim; the operator never opens this (#43) |
| Native sandboxing | Untrusted-code review work or local unattended runs | Use **Claude Code's first-party OS-level sandbox** (bubblewrap/seatbelt, sandbox-runtime) — never bespoke Docker (fork-4) |
| Full eval suite (gating/nightly) | The loop is proven on real product work AND eval budget is accepted | The lean slice (deterministic fixtures in contract tests + advisory promptfoo set for evaluator/security-reviewer) comes first; gating thresholds, nightly benchmarks, fixture-corpus repos only after (#29) |
| zizmor workflow audit | Next substantive CI-workflow change | Configure `unpinned-uses` to respect the documented tag-pin decision (its default since v1.20 hash-pins everything) (B-11 rider) |
| Provider gateway / spend limits | Multiple providers or real spend caps needed | Until then `model-policy.json` stays the declarative indirection (J-20) |

## The decision rule (mirrors plan §2.1)

1. Does **every** adopting repo need it on day one, regardless of stack, visibility, or scale? → **core engine**.
2. Does it activate only when a repo-state condition becomes true? → **this file**, groomed in when the trigger fires.
3. Is it specific to one product domain? → **the product repo**, never the engine.
