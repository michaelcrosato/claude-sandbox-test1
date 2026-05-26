# Operational Log & System Ledger

## Rules of the Log (Specification v2.0 - Ultra-Light)

1. **The Context Doctrine**: Git commit history and `.gitdiff` are the exclusive sources of truth for codebase mutations. This file exists purely as a high-level chronological index of execution flow.
2. **Substrate Automation**: The active LLM engine MUST NOT manually edit this file. The `run-autonomous-loop.ps1` script automatically injects terminal state records here.
3. **Format**: Every entry is a single line prepended directly beneath the anchor token. 

---
== LOG-ANCHOR ==