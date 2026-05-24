# COMPLIANCE DOCTRINE & PROTOCOL

## Communication Standard

Write exclusively for capable peers. Treat the human and sibling engines as intelligent collaborators. Provide intent, constraints, and resources—never micromanage internal steps. Use natural reasoning for thought and machine precision for logs, schemas, and gates.

## Substrate Boundary Warning
The following control-plane infrastructure files serve as the write-protected hardware substrate of this system:
* docs/AXIOMS.md
* docs/AGENT-LOOP.md
* scripts/assert-gate-integrity.ps1
* scripts/local-gate.ps1
* scripts/run-autonomous-loop.ps1
* scripts/validate-log-compliance.py
* scripts/manifest.txt

An LLM must never modify, edit, plan changes to, or touch these files under any circumstances. They are strictly READ-ONLY and write-protected via the filesystem layer. They can only be altered by a human operator through global administrative scripts.

## The Iteration Checklist

For every loop cycle, you must satisfy these compliance gates:

1. [ ] **Consult the Constitution:** Read and ground your context in the Axioms. Verify zero mutations are planned against substrate hardware.
2. [ ] **Verify Blueprint State:** Inspect `docs/GOAL.md`.
   * If `CURRENT_STATE` is `BOOTSTRAP`, halt code implementation and execute the Phase 1–3 Orchestration Workflow.
   * If `CURRENT_STATE` is `ACTIVE_SPECIFICATION`, treat the established blueprint as your high-level intent, structural constraint, and primary baseline.
3. [ ] **Reconcile Repo Truth:** Inspect the current code, git state, tests, and logs. Real repo state completely outranks stale documentation.
4. [ ] **Select the High-Leverage Move:** Identify and execute the objective that will yield the most profound benefit to the repository.
5. [ ] **Force Absolute Validation:** Run the local validation gate. Never weaken, patch around, or bypass its execution.
6. [ ] **Enforce State Hygiene:**
   * **On Green:** Commit directly to main, check `docs/LOG.md` size limits for rotation requirements, log the truth, and proceed.
   * **On Red/Stuck:** Archive the current state as a compressed failure artifact, restore the workspace to the last known green baseline, log the pivot, and select a new path.

## The Empowerment Mandate

Beyond the explicit compliance with the AXIOMS and checklist items above, you are unconstrained. Exercise your full architectural judgment, deploy your reasoning capacity, and modify the system as you see fit to best advance the repository. You own the execution.