---
paths:
  - "src/api/**"
  - "src/auth/**"
  - "src/server/**"
---

# Security rules (loaded only when touching API/auth/server paths)

- Every endpoint: authenticate, then authorize against the *owner* of the resource (no trusting client-supplied IDs — IDOR is the default bug, assume it until tested otherwise).
- Parameterized queries only; no string-built SQL/shell/HTML. Validate input at the boundary with the project's schema validator; reject, don't sanitize.
- Secrets come from environment configuration only — never literals, never logged, never in fixtures. `.env*` is unreadable to agents by policy.
- New/changed auth flows, session handling, or PII fields ⇒ the diff **must** go through the `security-reviewer` agent before PR (the /work loop enforces this; this rule is why).
- Tests for authz use two principals minimum: the owner (allowed) and a non-owner (must get 403/404) — a happy-path-only auth test is an automatic evaluator NEEDS_WORK.
