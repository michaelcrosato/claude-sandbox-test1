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

## 2026-05-24T16:39 · iter-0076 · GREEN · migrate-ledger-to-canonical-log

- **Baseline:** clean main @ `1159d45` (operator substrate refresh). Code baseline verified green
  before any change: `tsc --noEmit` clean, vitest **1435/1435** (46 files, 6 Postgres-skipped, no
  flaky worker exit), `npm run build` clean.
- **Move:** Adopt the new substrate-mandated logging system — make `docs/LOG.md` the single
  operational ledger and retire the now-forbidden `docs/LOOP_LOG.md`.
- **Changed:**
  - `git mv docs/LOOP_LOG.md docs/log/2026-05.md` — 75 prior iterations (4916 lines / 354 KB)
    archived intact into the substrate's documented monthly-rotation path; git tracks it as a rename
    so blame/history are preserved.
  - Prepended a provenance banner to the archive noting the migration, the originating commit, and
    that the file is now read-only legacy history.
  - Recorded this iteration as the first entry of the new ledger below the `== LOG-ANCHOR ==`,
    conforming to the strict header schema (`iter-0076`, 4-digit id, `·`-delimited).
- **Decisions:** Archived rather than reconstructed — re-formatting 75 entries into the new schema
  would risk corrupting history and violate the "no free-hand rewrite of older entries" rule; the
  validator only scans `docs/LOG.md`, so the legacy-schema archive is compliant. Used the
  `docs/log/YYYY-MM.md` rotation path the substrate itself documents. Left `docs/GOAL.md` untouched
  (no `CURRENT_STATE` marker present → loop proceeds as active development; PROJECT.md is `DECIDED`).
  Left the lone historical `LOOP_LOG` mention in `PROJECT.md:595` intact (accurate past narrative).
- **Validation:** `python scripts/validate-log-compliance.py` → exit 0 `[PASS]`;
  `pwsh scripts/assert-gate-integrity.ps1` → exit 0 (substrate hashes intact, zero substrate edits);
  `pwsh scripts/local-gate.ps1` → clean workspace pass. Code baseline unchanged (docs-only).
- **Notes:** No product code touched; the green code baseline above stands. `docs/LOOP_LOG.md` no
  longer exists in the workspace, satisfying the new rule while Axiom 3 is honored via the archive.
- **Next:** Resume feature work under the iter-75 backlog — portal endpoint-detail page surfacing
  the effective rate limit (explicit vs. `POSTHORN_DEFAULT_RATE_LIMIT` fallback), or documenting the
  new env knob in the OpenAPI schema / README operator section.