# AGENT_GUIDES.md — Task Recipes & SOPs

This document contains explicit, step-by-step standard operating procedures (SOPs) for routine engineering tasks within this specific architecture. 

When you encounter a repetitive or structural task (e.g., adding a new database model, creating a new UI component, extending an API route), **do not reinvent the wheel or debate architectural style.** Consult the recipes here.

## Recipe Format
Every guide added to this document must follow this exact format:
* **Context:** When to use this recipe.
* **Files Touched:** The exact, predictable list of files required (respecting the Context Budget).
* **Step-by-Step:** 1-2 sentence instructions per step.
* **Verification:** How to prove the implementation was successful before committing.

---
## [Dynamically Generated Recipes Below]
*(To be populated during the ACTIVE_SPECIFICATION phase based on the project's unique architecture.)*

### Recipe 1: [Example: Adding a New System/Component]
**Context:** **Files Touched:** **Step-by-Step:** **Verification:** ```

### 2. Update `template/project-template/docs/GOAL.md`
We must instruct the agent to actually write these recipes when it designs the system. Update **Phase 2** of the Orchestration Workflow to include `AGENT_GUIDES.md`.

**Update Phase 2 in `GOAL.md` to look like this:**
```markdown
### Phase 2: System Blueprint, Tickets & Task Recipes
Construct a markdown-based system specification sheet containing:
* **System Architecture File Tree:** A complete layout of the directories, modules, configuration files, and core components.
* **Database Schema & State Models:** Tabular or JSON-based state schemas displaying tables, fields, relationships, and data types.
* **The Sequenced Build Plan:** Populate `docs/TICKETS.md` with a sequentially numbered list of execution tickets (T-00, T-01, etc.) that map exactly to the blueprint.
* **Standard Operating Procedures:** Populate `docs/AGENT_GUIDES.md` with exact, step-by-step task recipes for the most common structural additions expected in this architecture (e.g., "Adding a new API endpoint", "Creating a new UI view").