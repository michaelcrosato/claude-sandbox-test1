---
name: Feature request
about: Propose a capability or improvement to the engine or demo
title: "[feat] "
labels: enhancement
---

## Problem / motivation

What is missing or painful today? Who is it for (operator, adopter, contributor)?

## Proposed change

What you'd like to see. If it touches the engine's guardrails (gates, hooks, state machine), say so explicitly.

## Fit with the operating model

This is an AI-operated template with a strict file-based loop (see `AI_OPERATIONS_PLAN.md`). Briefly note how the proposal fits:

- Does every adopting repo need it on day one → core engine; only when a repo-state trigger fires → optional module; product-specific → the product. (See `docs/optional-modules.md`.)
- Any new runtime dependency, and why it earns its keep.

## Acceptance criteria

How we'll know it's done (the objective bar the build must pass).
