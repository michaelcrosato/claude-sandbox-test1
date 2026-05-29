# TICKET002 — Fix README admin-token minimum (32 → 16)

- **Status:** done
- **Priority:** High

## Goal
Correct a documentation bug: the README overstates the minimum `POSTHORN_ADMIN_TOKEN` length.

## Context
`README.md` (Configuration table) said the admin token is "Minimum 32 chars." The authoritative
validator is `MIN_ADMIN_TOKEN_LENGTH = 16` in `src/runtime/config.ts` (enforced at boot:
`readAdminToken` throws when `trimmed.length < 16`). `.env.example` already correctly says "at
least 16 characters." An operator following the README would generate an unnecessarily long token
or wrongly believe a valid 16–31 char token is rejected.

## Scope
- **In:** the README Configuration row for `POSTHORN_ADMIN_TOKEN`.
- **Out:** changing the validator (16 is intentional — a floor, not a recommendation).

## Likely files
`README.md` (authoritative constant: `src/runtime/config.ts:367`).

## Steps
1. Confirm `MIN_ADMIN_TOKEN_LENGTH` (= 16) and the boot check.
2. Edit the README row to "Minimum 16 chars" (note a long random value is recommended).

## Acceptance criteria
- [x] README matches `src/runtime/config.ts` and `.env.example` (16, not 32).
- [x] Gate stays green (doc-only change).

## Commands
`grep -n MIN_ADMIN_TOKEN_LENGTH src/runtime/config.ts`

## Risks
None (documentation only).

## Notes
Found during the TICKET001 recon. The error-code table and SSRF/HSTS docs were cross-checked and
are accurate.
