# OpenLinear — Project Context & Ideas (Non-Technical)

This document describes **what OpenLinear is**, **who it is for**, **how it works from a user’s perspective**, and **how the product has evolved**. It is written in plain language for anyone who needs to understand the project without diving into code.

---

## 1. Vision & Purpose

**OpenLinear** is a **desktop app** that combines:

- A **task board** (like Linear or Jira) where you manage coding tasks.
- **AI agents** that **actually do the work** — they clone your repo, make changes, and open pull requests.

So instead of only *tracking* “Fix the login button” or “Add API pagination,” you can **run** those tasks and have an AI coding agent implement them in your repository. You see progress in real time and can cancel or adjust as needed.

**In one sentence:** OpenLinear is a Linear-style kanban board that executes tasks through AI coding agents.

---

## 2. Core Idea

- **Familiar workflow:** You create issues/tasks, put them on a board (Todo → In Progress → Done / Cancelled), add labels and priorities — similar to Linear.
- **Execution, not just planning:** When you hit “Execute,” an AI agent (e.g. OpenCode) works on that task in a real repo: it edits code, runs commands, and can create a branch and open a PR.
- **Desktop-first, local control:** The app runs on your machine. The API and execution run locally or against your own database. You connect your GitHub repo and (optionally) sign in with GitHub; the agent works in clones/worktrees on your machine or in a controlled environment.
- **Real-time feedback:** The board and execution views update live (e.g. when a task starts, finishes, or fails) so you’re not guessing what the agent is doing.

The “open” in OpenLinear signals openness to different agents and a local/transparent way of working — not a closed SaaS black box.

---

## 3. Who It’s For

- **Developers** or **small teams** who already think in “issues” and “tasks” and want to try or rely on AI to implement them.
- People who want **one place** to:
  - Capture what needs to be done (tasks + labels).
  - Trigger and watch AI execution.
  - See outcomes (e.g. PR link, done/cancelled) without leaving the board.
- Users who prefer a **desktop app** and **local/controlled execution** over a purely cloud-only tool.

---

## 4. Key Concepts (Plain Language)

| Concept | Meaning |
|--------|----------|
| **Task** | A single unit of work: title, description, optional priority (low/medium/high). It sits on the board in one of: Todo, In Progress, Done, Cancelled. |
| **Label** | A tag (e.g. “bug”, “fe”, “api”) with a name and color. You attach labels to tasks to categorize or prioritize them. |
| **Execute** | Start the AI agent on that task. The task moves to “In Progress”; the agent works in a clone of your repo and can open a PR when done. |
| **Cancel** | Stop the agent for that task. The task is moved to “Cancelled.” |
| **Batch** | A group of tasks you run together — either in **parallel** (several at once, up to a limit) or **queue** (one after another). The system can merge their branches into one PR. |
| **Project** | A connected GitHub repository. You sign in with GitHub, pick or add a repo; that repo is the “project” whose issues/tasks you’re managing and where the agent does the work. |
| **OpenCode** | The main AI coding agent integrated today. The app can check if OpenCode is installed and prompt you to install it if not. Other agents (e.g. Claude Code, Codex) are planned. |
| **Settings** | Where you configure things like: how many tasks can run at once (parallel limit), batch size, and behavior when tasks conflict or fail. |

---

## 5. How a User Works (End-to-End)

1. **Setup (one-time)**  
   - Install and open the OpenLinear desktop app.  
   - Optionally sign in with GitHub so you can connect repos.  
   - Connect a GitHub repository as the “project.”  
   - Ensure OpenCode (or the chosen agent) is available; the app can guide you to install it if needed.  
   - Configure database if required (e.g. PostgreSQL URL).

2. **Plan**  
   - Create tasks (e.g. “Fix login button”, “Add pagination to /users”).  
   - Add labels and priorities.  
   - Leave them in **Todo**.

3. **Execute (single task)**  
   - Click **Execute** on a task.  
   - It moves to **In Progress**; the agent works in the background.  
   - You see status/progress; when done, the task moves to **Done** and you may get a PR link.

4. **Execute (batch)**  
   - Select several tasks (e.g. with checkboxes).  
   - Choose **Parallel** (run up to N at once) or **Queue** (one by one).  
   - The app runs them; each task may use its own branch/worktree; results can be merged into a single PR.

5. **Control**  
   - **Cancel** stops a running task and moves it to Cancelled.  
   - **Settings** let you cap parallelism, batch size, and how to handle conflicts or failures.

6. **Review**  
   - Done tasks show outcome/PR link where applicable.  
   - You review and merge in GitHub as usual.

---

## 6. Product Boundaries (What We Do and Don’t Do)

These reflect the product and plan decisions (MVP and later phases).

**In scope (current or planned):**

- Single board per project (Todo, In Progress, Done, Cancelled).  
- Tasks with title, description, priority, labels.  
- Execute one task or a batch (parallel/queue).  
- Real-time updates on the board.  
- GitHub sign-in and repo connection.  
- Desktop app (Mac, Linux) with local API/sidecar.  
- OpenCode as the primary agent; design allows adding more agents later.  
- Configurable parallel limit and batch behavior.

**Out of scope or explicitly not in scope (from plans):**

- No multi-user collaboration / team features in MVP.  
- No custom column names; columns are fixed.  
- No drag-and-drop reorder within columns (for MVP).  
- No task dependencies, file attachments, or rich task history/versioning.  
- No Windows in the first desktop phase.  
- No built-in terminal emulator (e.g. full xterm) — simplified log/status view only.  
- No automatic migration to SQLite; cloud PostgreSQL (user-provided) remains.  
- No auth/login in the earliest MVP; later, GitHub OAuth and local accounts.  
- Light theme and mobile-responsive are not required for MVP; desktop dark theme first.

---

## 7. Evolution of the Product (From Plans)

- **MVP:**  
  Linear-like kanban (4 columns), task/label CRUD, execute/cancel with OpenCode, real-time updates (SSE), configurable parallel limit, dark theme. Single workspace, no auth.

- **Tauri desktop:**  
  From “web app + API” to a **desktop app**: Tauri shell, API bundled as a sidecar, OpenCode detection and install prompt, GitHub OAuth via deep links, Mac + Linux builds (.dmg, .app, AppImage, .deb).

- **Parallel / batch execution:**  
  Multi-select tasks, run in parallel (up to N) or queue; git worktrees so each task has its own branch; merge into a single PR; per-task cancel; settings for batch size, conflict behavior, stop-on-failure.

- **GitHub auth wire-up:**  
  OAuth fully wired: env vars, sign-in at bottom of sidebar, user avatar and sign-out when authenticated, auth-related tests. No change to core OAuth flow or backend logic.

Together, this gives you the “full idea”: a desktop, board-centric tool that runs AI agents on your GitHub repo with batches, auth, and clear boundaries.

---

## 8. Terminology Cheat Sheet

- **OpenLinear** — The product: desktop kanban + AI task execution.  
- **Task** — One work item on the board (title, description, priority, labels, status).  
- **Label** — Tag with name and color on tasks.  
- **Execute** — Start the AI agent on a task (or batch).  
- **Cancel** — Stop the agent and mark task Cancelled.  
- **Batch** — Multiple tasks run together (parallel or queue); one PR possible.  
- **Project** — The connected GitHub repository.  
- **OpenCode** — Default AI coding agent; others planned.  
- **Sidecar** — The bundled API process that runs next to the desktop app.  
- **SSE** — Mechanism for real-time updates to the UI (no need to refresh).

---

## 9. Future Direction (From README & Plans)

- **More agents:** Claude Code, Codex, Aider, etc., alongside OpenCode.  
- **GitHub OAuth:** Sign in, connect repos, use token for clone/PR (partially done; full wire-up in progress).  
- **Batch polish:** Clearer batch progress, per-task logs, conflict handling.  
- **Distribution:** GitHub Releases (e.g. AppImage, .deb), AUR, and npm-based CLI that fetches the desktop binary.

---

## 10. Summary

OpenLinear is a **desktop kanban board for coding tasks that AI agents execute**. You create tasks, optionally group them in batches, run them (single or parallel/queue), and see results and PRs without leaving the board. The product is desktop-first, repo-centric (GitHub), and designed to support multiple AI agents while staying simple and predictable. This document captures the ideas, workflow, and boundaries in non-technical terms for context, onboarding, and product discussions.
