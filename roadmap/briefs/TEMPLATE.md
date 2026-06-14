# Builder Brief — F-XXXX: <title>

> Immutable. Build exactly this; report back; nothing more. (Orchestrator: note here whether explorer fan-out ran and what it found, or why it was skipped.)

## Feature
<One paragraph: what this is and why it exists. Cite the spec section (spec_ref).>

## Spec
<The full, self-contained specification: exact files to create/modify, exact behaviors, exact names. The builder must never need to ask a question or read the roadmap. Include code-shape examples where ambiguity is possible.>

## Acceptance criteria (verbatim from roadmap/features.json)
1. <copied exactly — never paraphrased>

## Your scope & rules
- Touch ONLY: <explicit file list or globs — must be inside the feature's authorized_paths>.
- Authorized paths: <from features.json>. Forbidden: <from features.json>.
- Run `bash scripts/verify.sh` and save the full output to `roadmap/evidence/F-XXXX/verify.log`, plus <list any feature-specific evidence artifacts: test output, screenshots, CLI runs>.
- Exit code is the only truth: report success only on `VERIFY: PASS (exit 0)`.
- Never delete, weaken, or skip any assertion. Work silently; final report = files changed, evidence paths, verify exit code, anything surprising.
- Applicable `.claude/rules/`: <list matching rule files, or "none">.
