# Operator Guide: How to run ForgeOps

Welcome to your AI-coded repository! You do not need to run commands or read code. The AI workforce handles the execution, and you act as the planner and the final release authority.

---

## 1. The Three Surfaces

You will interact with the system via these three main interfaces:

1. **GitHub Dashboard**: 
   - Edit the roadmap (`roadmap/ROADMAP.md`) and answer questions (`roadmap/QUESTIONS.md`) directly in the browser.
   - Review and merge pull requests (PRs) opened by the agents.
2. **Staging / QA URL**:
   - Every PR generates a click-through link (e.g. Vercel Preview, Netlify Preview). 
   - Staging (from `develop` branch) is a persistent staging site running with seeded mock data.
3. **Claude Code / cloud settings**:
   - Start sessions by typing "Continue the roadmap" or let scheduled nightly Routines run autonomously in the cloud.

---

## 2. Your Daily 20-Minute Routine

### Morning (5–10 minutes)
1. **Check Status**: Open `roadmap/STATUS.md` in your repository. Check which features were completed, which are in progress, and if any are blocked.
2. **Update Priorities**: If you want to change what is built next, edit `roadmap/ROADMAP.md` and reorder the bullet points.
3. **Answer Blockers**: Open `roadmap/QUESTIONS.md`. If the agents logged any questions, answer them inline in plain English.
4. **Trigger Session**: (If not using automated routines) open claude.ai/code and enter: `"Continue the roadmap"`.

### Evening / Release Time (10 minutes)
1. **Click preview link**: Go to the open Pull Request for the feature or the integration branch.
2. **Follow the QA script**: Find the QA pack generated in the PR comments. Follow the click-by-click instructions.
3. **Approve or Comment**:
   - If everything works: Approve the PR and merge it.
   - If something is broken: Write a plain-English comment in the PR (e.g., `@claude the submit button on page X doesn't do anything when clicked`). The agents will automatically wake up and fix it.

---

## 3. The Kill Switches (If things look wrong)

If you see an agent doing something unexpected, or if you want to stop work immediately:
- **Pause/Stop**: Click the "Stop" button in the claude.ai/code UI or mobile app.
- **Git comment**: Comment `@claude stop work on this` on the open Pull Request.
- **Emergency stop file**: Create a blank file named `AGENT_STOP` in the root of the repository. The agents will immediately stop executing any shell commands and shut down the session safely.

---

## 4. Disaster Recovery (The Reset Button)

If staging gets into a messy state and you want to restore the last known working version, you have two clicks-only options — you never need to run commands:

1. **Ask the agents (easiest):** comment on any open pull request, or open a new GitHub issue, with:
   `@claude restore the last working version and explain in plain English what went wrong.`
   The agents will revert the bad change, get staging green again, and reply with a plain-English summary.
2. **One-click revert (do it yourself):** open the pull request that introduced the problem (the newest one on the "Pull requests → Closed" list), and click GitHub's **Revert** button at the bottom. That opens a ready-made undo PR — merge it and staging rolls back.

Either way, the agents detect the rollback automatically and put the reverted work back into the backlog as "needs another attempt."

---

## 5. Local Windows CLI Recovery (Maintainers Only)

If you personally run Claude Code or another local agent CLI on Windows and see repeated `PostToolUse hook (failed)` messages, or the prompt fills with `[I[O[I[O` text and stops accepting input, close the stuck terminal tab. The usual cause is PowerShell resolving `bash` to WSL instead of Git Bash.

Launch the CLI from Git Bash, or run this in PowerShell before starting the CLI:

```powershell
$env:Path = 'C:\Program Files\Git\bin;' + $env:Path
claude
```

If the shell still accepts commands but keeps echoing focus-event text, run:

```powershell
[Console]::Write("$([char]27)[?1004l")
cls
```
