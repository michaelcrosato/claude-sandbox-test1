<!-- Operator PR template (AI_OPERATIONS_PLAN §8.3) — mandatory shape, checked by the evaluator. Plain English above the fold; no jargon, no file paths, no stack traces. -->

## What this does
<!-- 2 sentences, business language. What changed from the operator's point of view? -->

## How to see it
<!-- Click-by-click on the preview/staging link, or exact steps a non-technical person can follow. Every step is a physical action or an observation. -->

## What could be risky
<!-- One honest line. "Nothing" is acceptable only with a reason. -->

## Machine checks
- [ ] `bash scripts/verify.sh` green (evidence path: `roadmap/evidence/F-XXXX/verify.log`)
- [ ] Fresh-context evaluator: PASS
- [ ] Security review: APPROVE / skipped per sensitivity rule (logged in DECISIONS.md)
- [ ] State updated via `update-state.ts` only

<details><summary>Technical notes (optional reading)</summary>

<!-- Anything an engineer would want; the operator never needs to open this. -->

</details>
