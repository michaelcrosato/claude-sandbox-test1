# Operational Log & System Ledger

## Page 1: Rules of the Log (Specification v1.0)

### 1. Conformance Tier Matrix
- **MUST / REQUIRED**: Mandatory. Failing this item makes the file non-compliant.
- **SHOULD / RECOMMENDED**: Strong recommendation. Valid exceptions can exist, but implications must be understood and noted.
- **MAY / OPTIONAL**: Permissive. Truly optional fields or sections.
- **MUST NOT / SHALL NOT**: Absolute prohibition. Doing this breaks compliance or forensic safety.

### 2. File and Ordering Constraints
- This file (`docs/LOG.md`) **MUST** be the single source of truth for repository history.
- Root-level log files or duplicate files (like `LOOP_LOG.md`) **MUST NOT** exist in the workspace.
- Entries **MUST** be written in **newest-first (reverse-chronological)** order. 
- New entries **MUST** be programmatically prepended immediately below the `== LOG-ANCHOR ==` line.
- Agents and humans **MUST NOT** free-hand rewrite or hand-edit older historical entries.

### 3. Entry Content & Structure Rules
- An entry **MUST** be generated only when product code changes, gate status transitions, or a material architecture decision is made.
- Relational or no-op loop triggers that result in no codebase modification **MUST NOT** log an entry.
- Every entry **MUST** use this strict multiline markdown schema:
  `## YYYY-MM-DDThh:mm · iter-NNNN · STATUS · lowercase-kebab-slug`
  * `- **Baseline:**` (Git SHA and starting state)
  * `- **Move:**` (One sentence defining the loop iteration objective)
  * `- **Changed:**` (Bulleted changes list)
  * `- **Decisions:**` (tradeoffs made, or "none")
  * `- **Validation:**` (Command executed and its precise exit/response text)
  * `- **Notes:**` (**OPTIONAL / MAY** — Sandbox area for agent/human thoughts, commentary, or context)
  * `- **Next:**` (1-3 subsequent engineering paths)

### 4. Status Vocabulary
The `STATUS` token in the header line **MUST** be exactly one of: 
`GREEN` (Passed) | `AMBER` (Caveats) | `RED` (Failed) | `BLOCKED` (Waiting) | `INCIDENT` (System Error) | `ROLLBACK` (Reset).

### 5. Size Hard Boundaries
- Individual text lines **MUST NOT** exceed 2,000 characters (guards against single-line data dumps).
- Lines **SHOULD** wrap at or under 120 characters for clean terminal and diff presentation where practical.
- Entries **SHOULD** target 150–350 words, and **MUST NOT** exceed 500 words unless labeled an `INCIDENT` or `ROLLBACK`.
- This file **MUST** be rotated into monthly archives (`docs/log/YYYY-MM.md`) once it crosses 1,000 lines or 250 KB.

---
== LOG-ANCHOR ==

## 2026-05-24T23:45 · iter-0101 · GREEN · rotate-canonical-log-into-monthly-archive

- **Baseline:** clean main @ `2ebfab1` (iter-0100 tenant failure-reason column). `docs/LOG.md`
  stood at 994 lines / 83 KB — under the 250 KB ceiling but one product entry short of the
  1,000-line rotation boundary the last three ticks flagged (iter-0098/0099/0100 Notes).
- **Move:** Pre-emptively rotate the active ledger before the next code entry crosses the cap, so
  every commit lands a compliant, lean `docs/LOG.md` (Axiom 2 / checklist step 6 state hygiene).
- **Changed:**
  - Moved the 25 canonical-schema entries (`iter-0076`–`iter-0100`) verbatim out of `docs/LOG.md`
    into `docs/log/2026-05.md`, the existing monthly archive, placed **above** the legacy `LOOP_LOG`
    section so the file stays globally newest-first across both schema generations.
  - Rewrote the archive's provenance banner to describe both generations it now holds (canonical
    0076–0100 on top, legacy 1–75 below) and to record that the canonical block rotated here
    at iter-0101.
  - `docs/LOG.md` now carries only the Page-1 rules header, the `== LOG-ANCHOR ==`, and this entry.
- **Decisions:** Archived rather than truncated — Axiom 3: every prior entry is preserved intact,
  just relocated (no entry was rewritten; only the archive's own banner prose changed). Reused the
  `docs/log/YYYY-MM.md` monthly path the substrate documents and iter-0076 established, since all of
  2026-05's history belongs in one month archive. Started the active log "fresh" (header + anchor +
  newest entry) mirroring iter-0076, as the rules mandate no minimum retained-entry count and the
  full history is one `cat` away.
- **Validation:** `python scripts/validate-log-compliance.py` → `[PASS]` (anchor present, sole
  entry heading well-formed, no duplicate id, no >2000-char line); `pwsh
  scripts/assert-gate-integrity.ps1` → 0 (zero substrate edits). Docs-only: the iter-0100 green
  code baseline (tsc 0 · vitest 1819/1819 · build 0) is unchanged and still stands.
- **Notes:** The validator does not itself enforce the line cap; this rotation honors doctrine rule
  #5 and checklist step 6 proactively so the active ledger never lands oversized.
- **Next:** SQLite `busy_timeout` hardening so multi-process access (the `posthorn admin` CLI on
  `apps.db`, rolling-deploy file overlap, online backup tooling) waits briefly instead of failing
  with "database is locked"; or mirror the failure-reason column onto the admin dashboard.
