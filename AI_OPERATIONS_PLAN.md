# AI Operations Plan — claude-sandbox-test1

**What this document is.** The complete blueprint for setting up and running this repository as a **100% AI-coded project**: frontier AI agents write every line of code, run autonomously for hours or days at a time (AFK), and the human operator participates only at two points — **planning** (deciding what to build next, in plain English) and **final QA** (clicking through the running product and approving releases).

**What this document is not.** It is not the product architecture. The product details, tech stack, and user stories are fully specified in the project specification (typically `README.md`). This plan describes the *factory*; the specifications describe the *car*.

> All tooling claims below were verified against official Anthropic documentation and engineering publications on **2026-06-09**. Sources are listed in [§13](#13-sources-verified-2026-06-09). Pre-2026 patterns (e.g., hand-rolled cron + bash agent loops, prompt-stuffed mega-contexts, "autonomous mode" via unsupervised `--dangerously-skip-permissions` on a laptop) were evaluated and rejected in favor of the current first-party primitives.

---

## 0. Executive Summary (plain English — read this first)

- **You (the operator) interact with exactly three things:** a plain-English roadmap file, pull requests with clickable preview links, and a daily status report written for a business audience. You never run code, read code, or answer technical questions.
- **The AI workforce is Claude Code running in Anthropic's cloud** (claude.ai/code and scheduled Routines). One **orchestrator** session plans and coordinates; it spins up specialized **sub-agents** (builder, evaluator, security reviewer, explorer) as needed. State lives in files in the repo, not in anyone's memory, so any agent can pick up exactly where the last one stopped — even days later.
- **Nothing reaches the stable branch without passing machine gates** (type checks, tests, security tests, a fresh-eyes AI evaluator) **and nothing ships without your click-through QA.** Agents merge their own work into a `develop` integration branch when all machine gates are green; only you promote `develop` → `master` (or your primary stable branch).
- **Your day costs ~20 minutes:** mornings, skim the status report and reorder/add roadmap bullets; evenings (or whenever), click the staging link, try the features marked "ready for QA," and leave plain-English comments on anything that feels wrong. The agents treat your comments as work orders.

---

## 1. Operating Principles (the contract)

These five rules are binding on every agent session and every file added to this repo. They restate the project's requirements as enforceable design constraints.

| # | Principle | Enforced by |
|---|-----------|-------------|
| P1 | **Current-stack only.** Decisions follow today's first-party tooling (verified June 2026). Any agent citing a pre-2026 pattern must re-verify it against live docs before using it. | `CLAUDE.md` rule + research skill requiring web verification of stale sources |
| P2 | **Never block on a human.** Agents decide-and-document instead of asking. Genuine blockers are logged to `roadmap/QUESTIONS.md` and the agent moves to the next task. A run never ends because of an unanswered question. | Decide-don't-ask policy (§6.1), Stop-hook checks |
| P3 | **The operator is a business client.** Every operator-facing artifact (status, PR descriptions, QA scripts, questions) is written in plain English with zero jargon, with click-by-click instructions where action is needed. | PR/status templates (§8), evaluator checks |
| P4 | **One orchestrator, disposable specialists, file-based state.** Coordination is centralized; context windows are short-lived; truth lives in `roadmap/` files + git history. Token-heavy parallelism (agent teams) is opt-in, not default. | Loop design (§5), token rules (§9) |
| P5 | **Trust nothing without evidence.** A feature is "done" only when machine verification has run and an independent fresh-context evaluator has seen proof (test output, screenshots). Self-grading is banned. | Default-FAIL `features.json`, evidence-gate hook, evaluator agent (§6, §7) |
| P6 | **Servant leadership; downtime sharpens the axe.** The orchestrator takes care of those in its charge: trust but monitor, help when an agent struggles, and treat repeated failure as a conditions problem the manager owns. Idle periods are spent proactively — sentinel monitoring, research, pre-briefing, daily 1% improvement — never burned on make-work or wasted waiting. | Downtime protocol (§5.5), `/kaizen` + `/downtime` skills, /work manager mindset |

---

## 2. Platform Decisions (verified June 2026)

### 2.1 Surfaces

| Concern | Decision | Why (and why not the alternative) |
|---|---|---|
| Agent runtime | **Claude Code** — cloud sessions on claude.ai/code, plus **Routines** (scheduled runs) for recurring autonomous work | Managed sandboxes, GitHub integration, mobile monitoring, session persistence; zero infrastructure for the operator to run. A custom orchestrator on the raw API/Managed Agents was rejected: more moving parts for no benefit at this scale, and the operator can't maintain it. |
| Orchestration | **Single orchestrator + on-demand sub-agents** (`.claude/agents/`) | Matches Anthropic's planner/generator/evaluator harness guidance; token cost scales with work done, not team size. Parallel fan-out is **opt-in per epic, never the default** (speed is our lowest priority). When an epic is provably parallel, prefer **Dynamic Workflows** (Opus 4.8, research preview — the orchestrator scripts parallel sub-agents inside one session) over **agent teams** (experimental, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, token cost scales linearly with teammate count). **Nested sub-agent delegation** (experimental, ≤5 levels, shipped Jun 2026) likewise stays off: centralized single-level delegation remains the default for token control and brief integrity. |
| Code host & gate | **GitHub** (`michaelcrosato/claude-sandbox-test1`) with branch protection + **claude-code-action v1 (GA)** for `@claude` mentions and CI autofix | PRs are the unit of review; CI is the objective referee; `@claude` lets the operator turn a plain-English comment into a fix without opening anything else. |
| App hosting / QA surface | **Kubernetes (Helm chart in `charts/posthorn`) + Docker (Dockerfile / docker-compose.yml)** — single-container, single-pod SQLite reference deployment; build the image and run it locally or in a cluster | A non-technical human QAs by hitting the running container's HTTP endpoints/dashboard, never by running source. |
| Database | **SQLite (embedded `node:sqlite`)** — file-backed under `POSTHORN_DATA_DIR`, or `:memory:` for ephemeral; no external database service, no migrations CLI | Zero runtime dependencies by design. Tests use `:memory:` / temp data dirs, so each run is isolated from any persisted dev data (§7.1). |
| E2E verification | **vitest (unit/integration); no browser E2E** — in-process HTTP/gateway tests exercise the API end-to-end against an in-memory store; no Playwright/Cypress in this repo | The product is a headless webhook service, not a browser UI, so integration tests against the in-process gateway are the realistic "test like a client" surface; a browser E2E lane is TBD if a richer dashboard warrants it. |

### 2.2 Model assignment — capability tiers, never hardcoded names

Roles bind to **capability tiers**, not to specific model names. The live tier→model mapping is a checked-in, machine-readable policy file — **`.claude/model-policy.json`** (`{tier: {model, effort, last_verified, notes}}`) — which is the single source of truth: the hygiene routine syncs sub-agent frontmatter `model:` fields from it whenever it changes, and the `/research` skill may update a mapping only after verifying the official model catalog, stamping `last_verified`. This keeps the factory model-agnostic: when a new model ships (or access changes), one file changes — no prompt or agent definition ever hardcodes a stale model name.

| Tier | Used by | Current mapping (2026-06-09) | Notes |
|---|---|---|---|
| `reasoning` | Orchestrator, planner (`/groom`), evaluator, security-reviewer, db-engineer | Claude Code default Opus tier (Opus 4.8), `high`/`xhigh` effort | Long-horizon autonomous execution; review quality is the last line of defense — never economize here. **Fable 5** (released 2026-06-09, Mythos-class) is a valid mapping for the hardest planning/evaluation passes: included on subscription plans through Jun 22, 2026, then usage credits at $10/$50 per MTok (2× Opus) — the cost line in STATUS.md flags this transition (§8.2). |
| `builder` | Builder sub-agent (routine implementation) | Sonnet 4.6, `high` effort | Best speed/intelligence balance for well-specified single features, at exactly 60% of Opus per-token price ($3/$15 vs $5/$25 per MTok). |
| `fast` | Explorer / search / triage sub-agents | Haiku 4.5, `low`/`medium` effort | Cheap fan-out for "find where X lives" work; returns conclusions, not file dumps. |

Per current model guidance, more effort up front on planning typically *reduces* total tokens by cutting retry loops.

### 2.3 Core vs optional vs product (the boundary rule)

Three questions decide where any capability lives: **(1)** Does every adopting repo need it on day one, regardless of stack, visibility, or scale? → core engine. **(2)** Does it activate only when a repo-state condition becomes true (product code lands, repo goes public, branch protection enabled, first external tool, multiple CLIs, external adopters)? → it is **optional**: cataloged with its trigger in [`docs/optional-modules.md`](docs/optional-modules.md), zero cost until the `/downtime` sentinel detects the trigger firing and grooms it into the backlog. **(3)** Is it specific to one product domain? → it belongs in the product repo, never the engine. Standing rule for any future external/MCP tool: it requires a registry entry (purpose, trust level, env-named secrets, allowed commands, network needs, approval gate) before integration — the machine-readable registry artifacts themselves are an optional module that activates with the first such tool.

### 2.4 Deliberately not used

- **`--dangerously-skip-permissions` on local machines** — autonomy comes from cloud sandboxes + scoped allowlists + hooks, not from disabling safety.
- **Marathon contexts** — no attempts to keep one session alive for days. Sessions are bounded (one feature), state is handed off through files; this follows Anthropic's context-reset + structured-handoff guidance.
- **Markdown task lists as machine state** — Anthropic found models mangle markdown checklists over long runs; the machine backlog is JSON (`features.json`), which models reliably leave structurally intact.

---

## 3. Repository Layout (the control plane)

Phase 0 (§10) builds exactly this tree. One-line purpose per entry; detailed specs in §4–§7.

```
claude-sandbox-test1/
├── README.md                     # Product architecture & specifications
├── AI_OPERATIONS_PLAN.md         # This file (the "how")
├── CLAUDE.md                     # Agent constitution, ≤150 lines (§4.1)
├── OPERATOR_GUIDE.md             # One-page plain-English manual for the human (§8.5)
├── AGENTS.md                     # Pointer stub for non-Claude agents → CLAUDE.md
│
├── roadmap/                      # ALL durable state shared between human and agents
│   ├── ROADMAP.md                # Human-owned priorities, plain English bullets
│   ├── features.json             # Machine backlog: every feature, default passes:false (§4.2)
│   ├── features.schema.json      # JSON Schema for features.json — validated in CI (§4.2)
│   ├── PROGRESS.md               # Agent-maintained session log / handoff notes (§4.3)
│   ├── QUESTIONS.md              # Non-blocking escalations for the human (§6.1)
│   ├── DECISIONS.md              # Append-only log of decisions agents made autonomously
│   ├── STATUS.md                 # Auto-generated plain-English status report (§8.2)
│   ├── evidence/F-XXXX/          # Physical proof per feature: verify logs, screenshots (§4.2, §7.3)
│   ├── briefs/F-XXXX.md          # Builder briefs (TEMPLATE.md is the canonical shape) (§5.5)
│   └── metrics.jsonl             # One record per session: attempts, verdicts, findings (§5.1 RECORD)
│
├── .claude/
│   ├── settings.json             # Permissions, hooks, env, enabledPlugins (§6.2, §7.2)
│   ├── model-policy.json         # Tier→model mapping — the ONLY place model names live (§2.2)
│   ├── claude-security-guidance.md  # Project threat model for plugin reviews (§7.2)
│   ├── security-patterns.json    # Deterministic secret/prod-ref/PII patterns (§7.2)
│   ├── agents/                   # Sub-agent definitions (§5.3)
│   │   ├── builder.md            #   implements ONE feature (builder tier)
│   │   ├── evaluator.md          #   fresh-context, read-only grader → PASS/NEEDS_WORK
│   │   ├── security-reviewer.md  #   security-focused review (Auth, PII, dependencies)
│   │   ├── db-engineer.md        #   migrations, schema updates, query plans
│   │   └── explorer.md           #   cheap read-only codebase search (fast tier)
│   ├── skills/                   # Reusable procedures (§5.4)
│   │   ├── work/SKILL.md         #   /work — the main autonomous loop
│   │   ├── groom/SKILL.md        #   /groom — ROADMAP.md → features.json entries
│   │   ├── status/SKILL.md       #   /status — regenerate roadmap/STATUS.md
│   │   ├── qa-pack/SKILL.md      #   /qa-pack — click-by-click QA script for the human
│   │   ├── research/SKILL.md     #   /research — web-verify any AI/stack claim (P1)
│   │   ├── kaizen/SKILL.md       #   /kaizen — daily ≥1% system improvement (§5.5)
│   │   └── downtime/SKILL.md     #   /downtime — idle protocol: sentinel scan, pre-briefs (§5.5)
│   ├── rules/                    # Path-scoped rules, loaded only when touching matches
│   │   ├── database.md           #   paths: schema/**, migrations/**
│   │   ├── security.md           #   paths: src/api/**, src/auth/**
│   │   └── frontend.md           #   paths: src/components/**, src/views/**
│   └── hooks/                    # Hook scripts (§6.3)
│       ├── verify-gate.sh        #   blocks direct features.json edits → update-state.ts only (§6.3)
│       ├── guard-bash.sh         #   deny destructive/forbidden commands
│       ├── commit-on-stop.sh     #   no session ends with uncommitted work
│       └── session-brief.sh      #   SessionStart: top of PROGRESS + git log + dirty-state audit
│
├── scripts/
│   ├── init.sh                   # Bootstrap dev env (dependencies, toolchain setups)
│   ├── verify.sh                 # THE gate: typecheck+lint+unit+build (+e2e flag) (§7.1)
│   ├── test-hooks.sh             # Contract tests for every hook + the state writer (§6.3)
│   ├── verify-rules.ts           # Scanning utility to detect framework configuration & sync rules
│   ├── assertion-shield.ts       # Guardrail checking to block test assertion deletion
│   ├── update-state.ts           # The ONLY writer for features.json — schema-safe mutations (§4.2)
│   └── seed.ts                   # Seed data generator for isolated manual & automated tests
│
├── .github/
│   ├── pull_request_template.md  # The operator PR template (§8.3), evaluator-checked
│   ├── dependabot.yml            # Weekly dependency/action update PRs (§7.2)
│   └── workflows/
│       ├── ci.yml                # verify.sh + security jobs on every PR (§7.2)
│       ├── e2e.yml               # E2E test runs against preview deployments
│       └── claude.yml            # claude-code-action: @claude mentions + CI-failure autofix
│
└── src/ ...                      # Product source code (organized by components)
```

**Always-loaded context is tiny by design:** `CLAUDE.md` (≤150 lines) plus whichever single `rules/*.md` file matches the files being touched. Everything else — including this plan — is read on demand.

---

## 4. State & Handoff Files (the memory system)

Agents are stateless between sessions; these files + git history are the system's memory. This implements Anthropic's harness pattern (initializer → progress file → feature list → fresh-context recovery) exactly.

### 4.1 `CLAUDE.md` — the constitution (≤150 lines)

Contents (spec for Phase 0):
1. One-paragraph project description + pointer map (README = architecture, this plan = operations, roadmap/ = state).
2. Commands: `bash scripts/init.sh`, `bash scripts/verify.sh`, `bash scripts/verify.sh --e2e`.
3. The session protocol (§5.1) in ~10 lines: read state → pick ONE feature → implement → verify → evidence → evaluator → merge-on-green → update state → commit.
4. The decide-don't-ask policy + escalation rule (§6.1).
5. Git rules: branch naming, never touch default stable branches (`master` / `main`), PR template requirements.
6. Operator-communication rules (P3): templates location, reading level, forbidden jargon.
7. Hard prohibitions (mirrors of the hook denylist, so the model knows *why* a hook blocked it).

### 4.2 `roadmap/features.json` — the machine backlog

Default-FAIL contract: every feature is born failing and only flips on evidence. Schema:

```jsonc
{
  "$schema": "./features.schema.json",
  "features": [
    {
      "id": "F-0001",
      "epic": "core-auth",                      // maps to spec section
      "title": "Session token expiry handling",
      "spec_ref": "README.md#auth-layer",
      "description": "Ensure expired sessions redirect user to login and clean local storage token cache.",
      "acceptance": [
        "Unit test: expired session token triggers clean-up function",
        "Unit test: redirection is invoked on API 401 unauthorized response",
        "E2E: logging in and manually expiring the cookie redirects on page transition"
      ],
      "authorized_paths": ["src/auth/**", "src/api/**", "e2e/auth/**"],
      "forbidden_paths": [".github/workflows/**", ".claude/**"],  // hooks enforce both mechanically (§6.3)
      "priority": 1,                            // 1 = now, 2 = next, 3 = later
      "status": "pending",                      // pending | in_progress | blocked | done
      "passes": false,                          // ONLY the evidence-gated flow flips this
      "evidence": [],                           // file paths: test logs, screenshots
      "attempts": 0,                            // failure-protocol counter (§6.4)
      "blocked_reason": null
    }
  ]
}
```

Rules: agents never hand-edit this file (a PreToolUse hook blocks it). All mutations go through `scripts/update-state.ts` (`--add`, `--status`, `--attempt`, `--evidence`, `--passes`, `--validate`), which enforces the schema's invariants in code (unique ids, status enums, priority ranges, dependency references incl. cycle detection, done⇒passes) — `features.schema.json` documents the same contract for humans and external tooling. `--passes true` is refused unless (a) every listed evidence file physically exists on disk and is non-empty, and (b) the evidence includes a verify log ending in the gate's literal `VERIFY: PASS (exit 0)` marker with a `VERIFY-COMMIT` signature; the *hard* backstop against a forged log is CI re-running the real gate on every PR. JSON hand-edits are additionally a known corruption vector over long runs. CI re-validates schema invariants **and the physical evidence of every passing feature** on every PR, so a corrupted or forged backlog can't merge. The file is the single source of "what is left"; Phase 0 seeds it by decomposing the system specification into ~30–100 features with acceptance criteria.

### 4.3 `roadmap/PROGRESS.md` — the handoff log

Newest entry first: each session **prepends** its block at the top of the file (never appends to the bottom), so "read the top ~50 lines" always means "read the most recent work". Each block: date, feature id(s), what was done, what was verified (with evidence paths), what surprised the agent, and **exact next step**. The SessionStart hook injects the top ~50 lines. When the file exceeds ~500 lines, the orchestrator archives the oldest blocks (from the bottom) to `roadmap/archive/`.

### 4.4 Other state files

- **`ROADMAP.md`** — the only file the human edits. Plain bullets under "Now / Next / Later / Ideas". Agents never edit it except to mark items "✅ shipped (PR #n)".
- **`QUESTIONS.md`** — agent-written, human-answered, inline. Format per entry: *question, why it matters, what the agent assumed in the meantime, deadline-free.* Answers get folded into `DECISIONS.md`/specs by the next `/groom`.
- **`DECISIONS.md`** — append-only ADR-lite: every autonomous judgment call (one line: context → decision → reversible? → where).
- **`STATUS.md`** — regenerated by `/status`; never hand-edited (§8.2).

---

## 5. The Orchestrator Loop

### 5.1 One work cycle (the `/work` skill)

```
┌─────────────────────────── ORCHESTRATOR SESSION ───────────────────────────┐
│ 0. SessionStart hook prints: top of PROGRESS, git log -10, failing-feature │
│    count, open QUESTIONS count. Orchestrator reads ROADMAP for priorities. │
│ 1. SELECT  highest-priority feature with status=pending, attempts<2,       │
│            dependencies done. If none → run /groom, then /status, exit.    │
│ 2. BRIEF   run explorer sub-agents (fast) for any codebase context the     │
│            task needs, then write a self-contained, immutable brief        │
│            (spec_ref excerpt, acceptance criteria, file map, rules) —      │
│            the full spec up front. ALL delegation happens at this level:   │
│            builders never spawn sub-agents of their own.                   │
│ 3. BUILD   delegate to builder sub-agent (builder tier, own context):      │
│            implement + unit tests on branch feat/F-XXXX from the brief.    │
│ 4. VERIFY  builder runs scripts/verify.sh and assertion-shield.ts; for UI   │
│            features also E2E framework like a human user; saves logs and    │
│            screenshots to roadmap/evidence/F-XXXX/.                        │
│ 5. JUDGE   evaluator sub-agent (fresh context, read-only) reviews diff +   │
│            evidence vs acceptance → PASS | NEEDS_WORK(findings).           │
│            NEEDS_WORK → findings go back to step 3 (attempts++).           │
│            Security-sensitive paths additionally get security-reviewer.    │
│ 6. SHIP    orchestrator opens PR feat/F-XXXX → develop (template §8.3) —   │
│            PR creation is this session's job, never assumed from CI bots.  │
│            When CI is green: merge to develop, flip passes:true via        │
│            update-state.ts (checks evidence on disk), status=done.         │
│ 7. RECORD  prepend PROGRESS block, run Adaptive Memory rule extraction to │
│            update CLAUDE.md/rules, update DECISIONS/QUESTIONS, commit.     │
│            Stop hook blocks exit if anything is uncommitted.               │
│ 8. LOOP    if context <60% used and time remains → step 1; else exit       │
│            cleanly (Routines/operator start the next session).             │
└─────────────────────────────────────────────────────────────────────────────┘
```

Planning, generation, and evaluation are separated into different contexts deliberately — Anthropic's 2026 harness work showed self-evaluation bias (agents confidently praising mediocre work) and that fresh-context evaluators fix it.

### 5.2 Session & cadence model

| Trigger | What runs | Notes |
|---|---|---|
| Operator types "continue the roadmap" in claude.ai/code (or mobile) | `/work` loop until context budget reached | Stage 1 autonomy; available day one |
| **Routine: nightly** (schedule trigger; created via `/schedule` or claude.ai/code/routines) | `/work` loop | Stage 2; enable after one week of clean supervised runs. Routines run on Anthropic infra with the repo's environment + network policy. Daily per-account run caps apply (current allowance visible at claude.ai/settings/usage; one-off runs are exempt). If Routines (research preview) are unavailable or capped, the identical lane runs as a GitHub Actions `on: schedule` job invoking headless `claude -p "/work"`. |
| **Routine: on CI failure / on PR comment** (GitHub trigger) + `claude.yml` action | Triage & fix CI, respond to `@claude` review comments | Keeps PRs healing themselves while AFK |
| **Routine: weekly hygiene** | Dependency patch PRs, lint debt, PROGRESS archival, `/status` refresh, model-policy sync (§2.2) | Low-priority maintenance lane |
| **Routine: API trigger** (`/fire` endpoint) | Alert-driven triage — the caller POSTs run context (e.g., an alert body) with a per-routine bearer token and gets back a session URL | Wired in later phases for server/application monitoring alerts |

**Lane economics (effective Jun 15, 2026).** Agent SDK runs, headless `claude -p`, and GitHub Actions agent runs bill against a separate per-user monthly **agent credit pool** ($20 Pro / $100 Max 5x / $200 Max 20x, at full API rates; automation halts when exhausted unless overflow billing is enabled; no rollover). Interactive sessions and Routines continue drawing subscription usage (Routines additionally under their daily run caps). Consequence: high-volume autonomous lanes run as **Routines or interactive cloud sessions**; the Actions lane is reserved for CI autofix and `@claude` PR responses, sized to the credit pool — and the `on: schedule` fallback above bills against credits too.

**Routine hardening (verified against the official Routines doc, 2026-06-09).** Routines run with *no permission prompts* and act *as the operator's connected GitHub/connector identity*, and **all** connected MCP connectors are included by default. Every routine here is therefore configured with: (a) all unneeded connectors removed; (b) **"Allow unrestricted branch pushes" left OFF** — the default restricts pushes to `claude/`-prefixed branches; (c) the minimal network allowlist; (d) a prompt that opens with the branch invariant from §6.4, because **runs clone the repository's default branch**. A green run in the list only means the session exited without infrastructure error — task success is judged solely by the evidence gate, CI, and the evaluator, never by run status.

Long single sessions are *allowed* (cloud sessions persist after the browser closes; auto-compaction handles context) but the design never *depends* on them — any session can die and the next one resumes from files.

### 5.3 Sub-agent roster (`.claude/agents/`)

| Agent | Tier (§2.2) | Tools | Mandate |
|---|---|---|---|
| `builder` | `builder` | full edit/bash in sandbox | Implement exactly one briefed feature + its tests; no scope creep; stay inside the feature's `authorized_paths`; report evidence paths |
| `evaluator` | `reasoning` | **read-only** (no Write/Edit) | Grade diff + evidence against acceptance; output `PASS` or `NEEDS_WORK` + findings; never trust claims without opening evidence; **always diff the test files for deleted/weakened assertions** — the known failure-loop cheat — before any PASS |
| `security-reviewer` | `reasoning` | read-only | Authorization models, Data Access Layer checks, PII handling/encryption, secrets in diffs; mandatory for sensitive API and auth paths |
| `db-engineer` | `reasoning` | edit/bash | Migrations, database performance, index/EXPLAIN validation |
| `explorer` | `fast` | read-only | Fan-out codebase/docs searches; return conclusions only |

### 5.4 Skills (`.claude/skills/`)

`/work` (the loop above), `/groom` (decompose ROADMAP/README specs into `features.json` entries with acceptance criteria; fold in QUESTIONS answers), `/status` (regenerate STATUS.md), `/qa-pack` (produce the human QA script for everything newly `done` since last promotion), `/research` (P1 enforcement: web-search any AI/framework claim; anything sourced >3 months old must be re-verified against current docs — this mirrors the project's own research rule; also maintains `.claude/model-policy.json` `last_verified` stamps and evaluates official MCP servers as cleaner tool integrations in later phases), `/kaizen` (daily ≥1% system improvement, §5.5), `/downtime` (the idle protocol, §5.5).

### 5.5 Downtime & idle protocol (the self-sharpening axe)

**Triggers:** no eligible pending feature; all remaining work blocked on operator answers; waiting on long CI/E2E runs; a scheduled session finds the backlog empty.

**Doctrine (P6).** *"Give me six hours to chop down a tree, and I will spend the first four sharpening the axe."* Idle time is when the orchestrator earns its title: it improves the conditions under which future work happens. And because *leadership is taking care of those in your charge*, downtime review focuses on what made agents struggle — a builder that failed twice didn't fail; its brief, tools, or rules failed it.

**Priority-ordered downtime work** (run top-down; stop when the session's downtime budget is spent):

1. **Sentinel scan (catch problems before they happen):** CI run history for new flakiness or slowdowns; staging health; dependency/security alerts (`gh api` Dependabot endpoints); stale branches and unmerged green PRs; evidence/state drift (`update-state.ts --validate`); model-policy `last_verified` staleness. Anything found becomes a `fix/...` branch now (if small) or a backlog feature (if not).
2. **Risk research for upcoming moves:** for the next 2–3 roadmap items, run `/research` on their riskiest assumption (an API's current shape, a framework's current major, a pricing change). Findings go into the feature's description/acceptance so the eventual builder starts with verified facts, not stale memory. This maximizes the success probability of future moves before a single token is spent building them.
3. **Pre-brief the next features (sharpen the axe):** write the immutable builder briefs for the top 2–3 pending features — explorer fan-out, spec excerpts, file maps — and save to `roadmap/briefs/F-XXXX.md`. When work resumes (or parallel lanes open), builders launch instantly with zero discovery cost.
4. **`/kaizen`** if not yet done this calendar day (one shipped ≥1% improvement).
5. **Trust-but-monitor spot check:** re-open one recently merged feature; re-run its evidence; confirm staging still honors it. Regressions become fixes immediately.
6. **Hygiene:** PROGRESS archival past ~500 lines, `/status` refresh, QUESTIONS tidy-up.

**Bounds (this protocol obeys §9, it doesn't fight it):** downtime work is capped at roughly **30% of a session's context budget**; "keeping the team busy" means keeping the *system ready* — pre-briefed features, verified assumptions, healthy pipelines — not spinning up sub-agents to look busy. When the list is exhausted or the budget is hit, the session exits cleanly. An empty backlog with a sharpened axe is a success state, not a failure to find work.

---

## 6. Autonomy Rails (never ask, never wreck)

### 6.1 Decide-don't-ask policy

Written into `CLAUDE.md` verbatim (this is the single highest-leverage instruction for AFK operation):

> For minor choices (naming, file layout, library minor-versions, copy text, default values, which of two equivalent approaches), pick the most conventional option, log one line in `roadmap/DECISIONS.md`, and continue. Never stop to ask.
> Escalate to `roadmap/QUESTIONS.md` — *without stopping work* — only when a choice is (a) expensive to reverse, (b) visible to end users in a way the operator might veto (pricing display, branding, legal/compliance wording), or (c) explicitly reserved to the operator in ROADMAP.md. Record the assumption you proceeded with; prefer building behind a flag or on a branch so either answer remains cheap.
> If a feature is truly unimplementable as specified, set `status: "blocked"` with `blocked_reason`, log the question, and take the next feature.

### 6.2 Permissions (`.claude/settings.json`)

- **Allow:** `npm` scripts, `node`, `tsc` (TypeScript), `biome` (lint), `vitest` (test runner); no external database CLI (SQLite is embedded), `git` (add/commit/push/branch/fetch/pull), `gh pr` equivalents via the GitHub integration, file edits repo-wide.
- **Deny (hard):** `git push` to default stable branches (`master` / `main`), force-push, `rm -rf` outside workspace temp, reading `.env*`/secret stores, `curl|sh`-style pipe-to-shell, package publishing, or modifying production database configurations.
- **Permission posture (differs by surface — verified against the permission-modes doc, 2026-06-09):**
  - **Cloud sessions** (claude.ai/code — our primary surface) expose only **Auto accept edits** and **Plan mode**; auto and bypass modes are *not available* there. Cloud autonomy comes from the sandboxed environment + allowlists + hooks, with permission prompts surfacing in the claude.ai UI when needed. Routines run promptless by design (§5.2) — sandbox, connector trimming, and hooks are the control surface.
  - **Local CLI/desktop sessions** (occasional maintainer use): **auto mode** (research preview, all plans) is preferred over `bypassPermissions` — a separate classifier screens every tool call and blocks scope-escalation, untrusted targets, and injection-driven actions; explicit ask/deny rules still apply. Note Claude Code deliberately ignores `defaultMode: "auto"` in checked-in project settings so a repository cannot grant itself auto mode — it's a user-level choice. In headless `-p` runs, repeated classifier blocks abort the session (no one to prompt); `dontAsk` is the locked-down alternative for scripted CI.
  - In every case these modes only *reduce prompts*; they are **not** the security boundary. The mechanical layers below (allowlist/denylist, hooks, branch protection, sandbox network policy) are.
- **Cloud environment** (claude.ai/code settings): network policy = Trusted/Custom (package registries, github.com, development database endpoints, QA deployment provider API); env vars hold dev credentials only; setup script = `scripts/init.sh` (cached per environment). Production secrets exist only in target dashboard providers — agents never see them.
- **Data boundary (compliance):** agents operate exclusively on seeded, synthetic non-production data. Live customer leads or PII are never mounted into any agent environment — required by general data compliance postures (e.g. GDPR, HIPAA, PIPEDA), and doubly so now that frontier-tier models carry a mandatory 30-day provider retention on traffic, overriding prior zero-retention agreements. The `.env*` deny rules above are load-bearing for this boundary.

### 6.3 Hooks (mechanical enforcement, not vibes)

| Hook event | Script | Behavior |
|---|---|---|
| `SessionStart` | `session-brief.sh` | Inject state summary (top of PROGRESS, git log, backlog counts) **plus a dirty-state audit**: uncommitted changes, unpushed branches, or a missing PROGRESS entry from the previous session, and runs `npx ts-node scripts/verify-rules.ts` to audit and sync configurations before new work. |
| `PreToolUse` (Bash) | `guard-bash.sh` | Exit 2 (block + explain) on the deny patterns in §6.2 |
| `PreToolUse` (Edit/Write on `features.json`) | `verify-gate.sh` | Block **all** direct edits to `features.json` — mutations go through `scripts/update-state.ts` only, which enforces the default-FAIL contract on *physical artifacts* (evidence files exist on disk and are non-empty; verify log shows exit 0) rather than on what was read in-conversation — so it can't be satisfied by a simulated log or bypassed by a different context doing the merge |
| `PostToolUse` (Edit/Write) | format hook | Format/Lint-fix the touched file (keeps diffs clean, prevents lint-debt loops). **Deferred until Phase 1** — activates when the product stack defines a formatter; the template ships no formatter to hook. |
| `Stop` | `commit-on-stop.sh` | Block session end if uncommitted changes or unpushed branch exists; instruct the agent to commit/push and prepend the PROGRESS entry first |
| `Pre-Commit` (Git Hook) | `assertion-shield.ts` | Run `npx ts-node scripts/assertion-shield.ts` to block commits that delete or weaken test assertions compared to `origin/develop` |

Hook mechanics follow the current hooks reference: simple denials use exit code 2; richer control (allow/deny/ask + feedback to the model) uses the JSON `hookSpecificOutput.permissionDecision` output. `commit-on-stop.sh` registers on `Stop` only — per the hooks reference (verified 2026-06-10), `StopFailure` fires on API-error turn ends and **cannot block** (its output and exit code are ignored), so registering enforcement there is useless. A PreToolUse edit guard enforcing the active feature's `authorized_paths`/`forbidden_paths` from `features.json` (§4.2) is **planned, not yet shipped** (backlog F-0007; design must resolve which feature is "active" when several are in progress) — until then scope discipline relies on the evaluator's path check (§5.3). Phase 0 ships **contract tests with fixtures for every hook script** — the safety net is tested code, not vibes.

**Operator kill switches** (documented in OPERATOR_GUIDE.md): pause/stop the session from claude.ai/code or the mobile app; or comment `@claude stop work on this` on the PR. A repo-level `AGENT_STOP` file is also honored by `guard-bash.sh` (any session halts work and exits cleanly when it exists).

### 6.4 Failure & recovery protocol

- **Two-strike rule:** a feature failing evaluator/CI twice (`attempts >= 2`) is set `blocked`, logged to QUESTIONS.md with findings attached, and skipped. No infinite retry loops, no burning the night's budget on one bug.
- **Branch invariant (hard rule):** `develop` (or your staging/integration branch) is the repository's **default branch** on GitHub (§11) — cloud sessions and Routines clone the default branch, so this makes every tool land on the right base automatically. Every autonomous run additionally begins with `git fetch origin develop` and branches from `origin/develop`; every PR targets `develop`. Work discovered to be based on the wrong branch is redone from `develop`, not force-rebased.
- **Revert-first (code), roll-forward (database):** if `develop` CI breaks, the fixing session's first move is `git revert` of the offending merge (restore green), then re-attempt on a new branch. **Exception:** merges containing applied database migrations are never git-reverted — reverting deletes migration files while the staging schema stays mutated, desynchronizing ORM/client state from the database. Schema problems roll *forward* with a new corrective migration. Staging never stays red overnight either way.
- **Branch protection (GitHub settings):** default stable branch (`master`/`main`) — no direct pushes, PR + human approval required; integration branch (`develop`) — no direct pushes, PR + green CI required (agents may merge). All agent branches are `feat/F-XXXX` or `fix/...`; cloud sessions default to `claude/`-prefixed branches, which is acceptable for ad-hoc fixes.
- **Record-PR pattern (state under branch protection):** with `develop` push-protected nothing writes to it directly — feature state (`features.json` entry, `--status`/`--passes` flips, evidence) rides the feature PR itself (per the state-flip convention, DECISIONS 2026-06-09), and post-merge records (PROGRESS/STATUS/metrics/kaizen notes) land via short-lived `chore/` branch PRs merged on green CI. This is the designed shape under branch protection — the direct consequence of `develop` rejecting direct pushes — not a workaround.
- **Disaster floor:** worst case is always "revert to last green commit on the stable branch" — which the human can do with one click, documented in OPERATOR_GUIDE.md.

---

## 7. Verification Pyramid (self-testing)

### 7.1 `scripts/verify.sh` — the single local gate

One command, used identically by agents and CI: compiles/typechecks -> lints -> unit/integration tests -> build. `--e2e` adds: reset the run's *isolated* database (see Database isolation below) -> runs database seeding -> E2E test suite. Setup dependencies are owned by `init.sh`; if a given sandbox still can't run E2E browser environments, the agent pushes the branch and uses the CI pipeline run as its evidence instead of local execution. Exit code is the only truth; agents are forbidden (CLAUDE.md + evaluator) from declaring success on partial output.

**Database isolation:** E2E/test runs never execute destructive resets against shared development environments. PR pipelines use ephemeral per-PR test databases or containerized instances in CI; the shared dev databases serve interactive sessions only. This removes the race where parallel builders or workflows truncate each other's data mid-run.

### 7.2 CI (`.github/workflows/`)

- **ci.yml (every PR):** runs `verify.sh` and `npx ts-node scripts/assertion-shield.ts` along with security checks: authorization rules validation, secrets checking, database index checks, and validation of environment separation constraints.
- **e2e.yml:** Runs E2E tests against the PR's preview deployment using seeded data.
- **claude.yml (claude-code-action, pinned to an exact commit SHA, rolled forward by Dependabot):** responds to `@claude` comments and, on CI failures on agent PRs, triages and pushes fix commits to the PR branch (capped `--max-turns`, concurrency-limited). It pushes commits; opening PRs remains the orchestrator session's job — no workflow assumes the action creates PRs. Two disclosed incidents make the hardening rules above load-bearing (verified 2026-06-10): ① **GHSA-8q5r-mmjf-575q** (published 2026-05-20) — claude-code-action **< 1.0.74** allowed a malicious MCP server configuration in PRs to achieve remote code execution and secret exfiltration; ② Microsoft-documented prompt-injection research (2026-06-05) showed untrusted issue/PR text could drive the un-sandboxed Read tool to exfiltrate `/proc/self/environ` (API keys, OIDC credentials) — fixed in **Claude Code 2.1.128** (2026-05-05), which blocks sensitive `/proc` reads. Consequences for this repo: pin at or beyond the current v1 SHA (≫1.0.74), keep workflows on a current action release so the bundled CLI is ≥2.1.128, never check `.mcp.json` changes in from untrusted PRs without review, and follow the "Agents Rule of Two" — no workflow simultaneously processes untrusted input, holds secrets, and mutates state. Billing note: from **Jun 15, 2026**, GitHub Actions agent runs bill against the separate per-user agent credit pool included with the plan, not subscription session usage (§5.2). **Auth is subscription-first (verified 2026-06-10):** the workflow authenticates with `CLAUDE_CODE_OAUTH_TOKEN` (Pro/Max token from `claude setup-token`, drawing the included credit pool) — an `ANTHROPIC_API_KEY` is an optional alternative, never a requirement. This engine requires **no paid API key from any provider** in any lane: cloud sessions, Routines, and local sessions are subscription login; the Actions lane is the subscription token.
- **CI hardening (all workflows):** every action pinned to a release tag or commit SHA; least-privilege `permissions:` blocks and explicit `timeout-minutes` on every job; `concurrency` groups keyed by PR/branch; `@claude` triggers restricted to actors with write access (no bot or non-write-user allowances of any kind); PR/issue/vendor-feed text always framed as untrusted input in prompts; no debug or full-tool-output logging into public logs; a leak check fails CI if production configurations or secret-shaped strings appear in config or workflow files; agent pushes use the GitHub App token. Dependency gates: Dependabot alerts on; lockfile audits as a required check; every new runtime dependency requires a `DECISIONS.md` entry; lockfile-heavy PRs get the security-reviewer.
- **In-session security tooling:** the official **security-guidance plugin** is enabled at **project scope** via checked-in settings — `"enabledPlugins": {"security-guidance@claude-plugins-official": true}` in `.claude/settings.json` — because user-scoped installs do **not** carry into Claude Code web sessions (our primary surface). Its two checked-in config files: `.claude/claude-security-guidance.md` (this project's threat model: security controls, credentials policy, DAL/auth guidelines; ≤8 KB combined cap) and `.claude/security-patterns.json` (deterministic per-edit rules; schema per the plugin docs, verified 2026-06-10: `patterns[]` of `rule_name`/`reminder`(≤1 KB)/`regex`(Python flavor)|`substrings`, optional `paths`/`exclude_paths` globs, ≤50 rules; YAML is the plugin's native format — JSON is used here deliberately so the check works without PyYAML). Plugin prerequisites: Claude Code ≥2.1.144, Python ≥3.8 on PATH. Cost profile: the pattern layer is zero-token; the end-of-turn and commit reviews are model-backed and consume usage. All findings are **advisory** — they re-prompt the writing agent but block nothing — so anything that must be a hard gate is expressed as a deny-hook or CI check instead. It complements the security-reviewer agent and CI security jobs.

### 7.3 Definition of Done (per feature — enforced by evaluator)

1. Code + tests implementing every acceptance criterion; 2. `verify.sh` green (evidence: log file); 3. UI/E2E features exercised and verification outputs (screenshots/logs) saved; 4. evaluator `PASS` from fresh context; 5. security review if sensitive paths; 6. CI green on the PR; 7. PROGRESS/DECISIONS updated; 8. PR description follows the operator template. Only then `passes: true`.

### 7.4 Human final QA (the only human gate)

Promotion PR `develop → master` is opened at phase milestones (or weekly) **under the GitHub App/bot identity** (the orchestrator triggers it via the `@claude` workflow lane rather than authoring it as the operator's connected identity): GitHub forbids approving your own PR, so an operator-authored promotion PR would deadlock against the stable branch's required-approval rule. The PR contains the `/qa-pack` output: a numbered, click-by-click script in plain English ("1. Open staging.../dashboard. 2. Enter value X. 3. You should see results Y..."), with screenshots of expected results. The operator follows it on the staging URL, comments on anything off (`@claude step 3 showed error Z`), and merges when satisfied. Merge = release. For security-sensitive or promotion PRs, the operator may additionally paste the qa-pack/diff into a *different* frontier model for a heterogeneous second opinion to avoid same-family LLM review blind spots.

---

## 8. The Human Interface (non-technical operator)

### 8.1 Daily workflow (~20 min total)

**Morning (5–10 min):** read `roadmap/STATUS.md` (or the same content posted to the promotion PR). Edit `ROADMAP.md` on github.com directly — reorder bullets, add ideas in plain English, answer anything new in `QUESTIONS.md` inline. Open claude.ai/code → "Continue the roadmap" (until nightly Routines take over, then this step disappears).

**Evening / ad hoc (10 min):** open the staging link; try features listed under "Ready for your QA"; leave comments on the PR in plain English. `@claude <comment>` anywhere on GitHub turns feedback into a fix task.

### 8.2 `STATUS.md` format (regenerated by `/status`)

Shipped this week (bullets, business language) · Ready for your QA (links + one-liners) · In progress · Blocked/Questions (copied from QUESTIONS.md) · Health: ✅/⚠️ staging status, test count, last green build, and a one-line cost note (sourced from `/usage` session telemetry: spend trend, routine runs consumed vs. daily allowance, agent-credit-pool balance from Jun 15, 2026), flagging dated pricing transitions (e.g., Fable 5 moves from subscription-included to usage credits on Jun 23, 2026). No file paths, no stack traces, no other token talk.

### 8.3 PR description template (mandatory, checked by evaluator)

**What this does** (2 sentences, business language) · **How to see it** (click-by-click on the preview link) · **What could be risky** (one honest line) · **Machine checks** (auto-filled checklist). Technical detail lives below a "Technical notes (optional reading)" fold.

### 8.4 What the operator never does

Run commands · read or write code · edit any file except `ROADMAP.md`/`QUESTIONS.md` · resolve merge conflicts (agents rebase their own work) · debug ("it's broken when I click X" is a complete, sufficient bug report) · answer questions to unblock a run (P2 guarantees runs don't block).

### 8.5 `OPERATOR_GUIDE.md`

One page, 8th-grade reading level, written in Phase 0: the three surfaces, the daily routine, how to start/pause/stop agents (web + mobile), how to read a PR page (with annotated screenshot), the one-click rollback, and "if something looks scary, just type `@claude stop and explain in plain English what's going on`."

---

## 9. Token-Efficiency Rules

1. **Small always-on context:** CLAUDE.md ≤150 lines; path-scoped `rules/` load only when relevant; this plan and the README specifications are referenced by section, never pasted whole.
2. **State in files, not in conversation:** fresh bounded sessions reading PROGRESS/features.json beat marathon contexts and repeated re-discovery; auto-compaction is a safety net, not a strategy.
3. **Fan out cheap, synthesize expensive:** fast-tier explorers gather information; the reasoning-tier orchestrator only ever sees conclusions.
4. **Full spec up front:** every builder brief is self-contained (current Opus guidance: well-specified single first-turns maximize autonomy and minimize token churn vs. drip-fed clarifications).
5. **One feature per builder context; two-strike cap** on retries (§6.4).
6. **Teams off by default** (§2.1); enable per-epic only when work items are provably independent.
7. **Model tiering per §2.2;** effort tuned per role.
8. **No narration:** builders work silently between tool calls; reporting happens once, in PROGRESS + PR.
9. **Bounded injections:** any new hook or skill that injects model-visible content must declare a hard size bound and redaction behavior at introduction (the session brief's `head -50` / `-10` caps are the pattern); unbounded injections are rejected in review.
10. **Caching-aware context ordering:** stable always-loaded content (CLAUDE.md, rules) forms the cached prompt prefix — edit it sparingly and batch changes, since any byte change invalidates the cache for everything after it. Volatile state (PROGRESS.md, features.json, tool output) enters mid-conversation as tool results, never the prefix. With prompt caching, *re-reading* a large stable doc on demand is cheap — explorers exist to keep **conclusions** small in the orchestrator's context, not because reading files is expensive.

---

## 10. Build Phases & Milestones

Each phase ends with a promotion PR (`develop → master`) and a human QA gate. The product scope inside each phase comes from the core project roadmap; `/groom` turns them into `features.json` entries at phase start.

| Phase | Scope | Exit criteria (human QA gate) |
|---|---|---|
| **0 — Build the factory** | Everything in §3–§8 of this plan: CLAUDE.md, roadmap/ files seeded (~20–50 features from requirements via `/groom`), features.schema.json + update-state.ts, model-policy.json, agents, skills, rules, hooks with contract tests, settings, security-guidance plugin configuration, scripts, CI workflows, branch protection + `develop` as default branch, PR/STATUS templates, OPERATOR_GUIDE.md | Operator can read STATUS.md, ROADMAP.md, OPERATOR_GUIDE.md and confirm they make sense; a deliberately-trivial demo feature (e.g. health-check / ping page) flows the entire loop: brief → build → verify → evaluate → PR → CI → develop, with correct PROGRESS/evidence artifacts |
| **1 — Foundation** | Project environment, build pipelines, basic project structure, core configuration, test harness, development database wiring, preview setups | Staging shows basic entry page or status indicators; CI fully green |
| **2 — Core Features & Data Layer** | Primary backend components, API structures, data modeling and migration pipelines, caching layers | Operator QA: verify primary backend components can process mock inputs; schemas and tables verify cleanly |
| **3 — User Interfaces / Clients** | Primary frontends, components layout, navigation layers, styling systems integration | Operator QA: walk through key views on staging via qa-pack script |
| **4 — Integration & Workflows** | Data ingestion or scheduling workflows, event loops, notification and queue handling, PII encryption and compliance audits | Operator QA: submit sample inputs; verify downstream operations are fully processed |
| **5 — Hardening & Administration** | Access control roles, dashboards, monitoring/telemetry integrations, performance/scale test reports, security-reviewer final sign-off | Operator QA: admin-role walkthrough; scale-test report reads green; security-reviewer sign-off log |

Throughout: nightly `/work` Routine (enabled after Phase 1 runs cleanly supervised for ~a week), weekly hygiene Routine, CI-failure Routine from Phase 0.

---

## 11. One-Time Human Setup Checklist (~30 minutes, click-through only)

The only technical-adjacent actions the operator ever performs; each is a guided web flow:

1. GitHub: install the **Claude GitHub App** on the repository (claude.ai/code → settings → GitHub). ☐
2. GitHub: set `develop` as the repository's **default branch**, then confirm branch protection on the stable branch (PR + 1 approval) and `develop` (PR + green CI). Note: promotion PRs must be opened by the Claude GitHub App/bot (§7.4) — you cannot approve a PR you authored, and cloud sessions act as *your* identity. ☐
3. QA Surface: Import project from the GitHub repo into your deployment provider (e.g. Vercel, Netlify); accept defaults. ☐
4. Database/Infrastructure: create two projects (dev + prod) via dashboard; paste the **dev** URL/keys into the Claude Code **environment variables** screen; paste prod keys into the production deployment provider environment settings only. ☐
5. claude.ai/code: create the repo **environment** (network policy: Trusted + the domains from §6.2; setup script `scripts/init.sh`). ☐
6. Enable the nightly + hygiene **Routines** when Phase 1 gate passes (one toggle each): remove all connectors they don't need, leave "Allow unrestricted branch pushes" OFF, and check at claude.ai/settings/usage that your plan's daily routine-run allowance covers the cadence. ☐
7. Generate a subscription token for the `@claude` PR lane: in a terminal in the project folder run `claude setup-token`, copy the token it prints, and add it as a GitHub Actions secret named `CLAUDE_CODE_OAUTH_TOKEN` (repo → Settings → Secrets and variables → Actions). **No API key required** — this token runs on your Claude subscription's included agent credits. (An `ANTHROPIC_API_KEY` remains an optional alternative, never a requirement.) ☐
8. After **June 15, 2026**: check Settings → Billing on claude.ai that the separate per-user **agent credit pool** covers the CI-autofix lane (optionally enable overflow billing); after **June 23, 2026**, note Fable 5 usage bills as credits. ☐

---

## 12. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Agent marks work done that doesn't actually work | Default-FAIL contract + evidence gate + fresh-context evaluator + CI + human QA gate (five independent layers) |
| Run stalls AFK on a question | P2: decide-don't-ask, QUESTIONS.md, blocked-and-skip; runs end with work done, never with a modal |
| Runaway cost overnight | Bounded sessions, two-strike cap, Routine daily caps, model tiering, teams off; the agent credit pool hard-bounds Actions lanes (Jun 15+); weekly cost line in STATUS.md |
| Provider-side data retention on frontier tiers (30-day on Fable/Mythos-class traffic) vs. compliance obligations | Agents only ever see seeded synthetic data; live leads/PII never mounted into agent environments (§6.2 data boundary) |
| Broken staging compounds overnight | Revert-first rule restores green before any forward fix |
| Secrets leak into agent context or repo | Prod secrets never in agent environment; deny-rules on `.env*`; local Git ignore policies; CI secrets leak scanning |
| API rate limits and quotas exhausted | Automated back-off handles rate limits; daily caps on Routines; fallback execution configurations |
| LLM code hallucinations / package confusion | Strict linting/type gates; validation checks in `verify.sh`; using official plugins and whitelisted dependencies in `settings.json` |

---

## 13. Sources Verified (2026-06-09)

1. **Anthropic Claude Code Primitives**: Verification of cloud session capabilities, auto accept settings, and permission handling structures.
2. **Anthropic Routines System**: Verification of daily run capabilities, connector access permissions, environment isolation, and network policy options.
3. **Anthropic Agent Harness Guidance**: Planner/generator/evaluator pattern recommendations, state handoff mechanisms, and token optimization strategies.
4. **Claude Code Actions**: Configuration profiles for `@claude` automated PR triage, autofix mechanisms, and permissions requirements.
5. **Claude Official Plugins**: Specification of security-guidance plugin schemas, regex formats for `.claude/security-patterns.json`, and local execution parameters.
