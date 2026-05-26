# COMPLIANCE DOCTRINE & PROTOCOL

## Communication Standard

Write exclusively for capable peers. Treat the human and sibling engines as intelligent collaborators. Provide intent, constraints, and resources—never micromanage internal steps. Use natural reasoning for thought and machine precision for logs, schemas, and gates.

## The Context Budget (Read vs. Touch)
To prevent context window exhaustion and maintain architectural sanity, you must strictly differentiate between *Reading* and *Touching*:
* **Reading (Strictly Bounded):** For any routine execution, you should be able to act confidently after reading **≤ 3 files**. If you find yourself needing to scan or read sprawling sections of the repository just to understand *how* to implement a task, pause. The architecture is violating Axiom 7. You must refactor the system for modularity before proceeding.
* **Touching (Unbounded):** You are permitted to *edit* (touch) as many files as necessary. A cross-cutting feature (e.g., adding a new system, updating a schema, adjusting a UI component) may require editing 6+ files. This is healthy execution. Do not restrict your implementation scale; restrict your required discovery scale.

## Substrate Boundary Warning
The following control-plane infrastructure files serve as the write-protected hardware substrate of this system:
* docs/AXIOMS.md
* docs/AGENT-LOOP.md
* docs/TICKETS.md
* scripts/assert-gate-integrity.ps1
* scripts/local-gate.ps1
* scripts/run-autonomous-loop.ps1
* scripts/manifest.txt

An LLM must never modify, edit, plan changes to, or touch these files under any circumstances (with the exception of dynamically managing `TICKETS.md` as allowed by Axiom 4). They are strictly READ-ONLY and write-protected via the filesystem layer. 

## The Iteration Checklist

For every loop cycle, you must satisfy these compliance gates:

1. [ ] **Consult the Constitution:** Read and ground your context in the Axioms. Verify zero mutations are planned against substrate hardware.
2. [ ] **Verify Blueprint State:** Inspect `docs/GOAL.md`.
   * If `CURRENT_STATE` is `BOOTSTRAP`, halt code implementation and execute the Phase 1–3 Orchestration Workflow.
   * If `CURRENT_STATE` is `ACTIVE_SPECIFICATION`, treat the established blueprint as your high-level intent, structural constraint, and primary baseline.
3. [ ] **Reconcile Repo Truth:** Inspect the current code, git state, tests, and logs. Real repo state completely outranks stale documentation.
4. [ ] **Evaluate the Context Budget:** Review the task ahead. If it requires reading more than ~3 files to comprehend, invoke Axiom 7 and pivot your current ticket to refactor the architecture for modularity.
5. [ ] **Consult Task Recipes:** Before executing a ticket, check `docs/AGENT_GUIDES.md`. If a standard operating procedure exists for your task, follow it exactly. If you are performing a novel structural task that will be repeated, you MUST write a new recipe into `AGENT_GUIDES.md` for your future self.
6. [ ] **Consult the Execution Plan:** Inspect `docs/TICKETS.md` to identify the current active ticket. 
   * **Execute:** If the ticket is valid, execute the specified changes within the designated "Touch" files.
   * **Adapt:** If the current architecture state makes the next ticket obsolete or structurally flawed, exercise your autonomy (Axiom 4). Rewrite the remainder of `docs/TICKETS.md` to reflect a superior engineering path before writing implementation code.
7. [ ] **Force Absolute Validation:** Run the local validation gate (`scripts/local-gate.ps1`). Ensure you have maintained and updated your agent-owned `scripts/run-tests.ps1` with strict invariant tests covering your latest changes. Never weaken, patch around, or bypass the test execution.
8. [ ] **Enforce State Hygiene:**
   * **On Green:** Write a clear, standard `git commit` outlining your architectural changes. 
   * **Do NOT Log:** You are explicitly forbidden from manually modifying `docs/LOG.md`. The hardware substrate will automatically log your exit codes, ticket IDs, and gate status directly to the ledger. Rely entirely on your `git commit` messages for codebase context.
   
## The Empowerment Mandate

Beyond the explicit compliance with the AXIOMS and checklist items above, you are unconstrained. Exercise your full architectural judgment, deploy your reasoning capacity, and modify the system as you see fit to best advance the repository. You own the execution.