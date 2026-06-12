---
paths:
  - "src/components/**"
  - "src/views/**"
  - "src/pages/**"
---

# Frontend rules (loaded only when touching UI paths)

- Match the existing component patterns (state management, styling system, file naming) — explore first, don't import a second paradigm.
- Every user-visible state needs handling: loading, empty, error, success. Error states show plain-language messages, never raw error objects.
- UI features are E2E features: the acceptance evidence must include the E2E run (or screenshots from walking it like a user) — unit tests alone never close a UI feature.
- Accessibility floor: semantic elements, labels on inputs, keyboard reachability for anything clickable.
- Copy/text changes the operator might veto (pricing, legal, branding tone) → decide-and-document in DECISIONS.md and flag in the PR's "What could be risky" line.
