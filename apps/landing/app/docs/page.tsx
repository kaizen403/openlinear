"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { Menu, X } from "lucide-react"

const NAV = [
  {
    group: "Getting Started",
    items: [{ id: "getting-started", title: "Getting Started" }],
  },
  {
    group: "Features",
    items: [
      { id: "kanban-board", title: "Kanban Board" },
      { id: "task-management", title: "Task Management" },
      { id: "task-execution", title: "Task Execution" },
      { id: "batch-execution", title: "Batch Execution" },
      { id: "brainstorm", title: "Brainstorm" },
      { id: "god-mode", title: "God Mode" },
      { id: "inbox", title: "Inbox" },
      { id: "teams", title: "Teams" },
      { id: "projects", title: "Projects" },
    ],
  },
  {
    group: "Integrations",
    items: [
      { id: "github-integration", title: "GitHub Integration" },
      { id: "opencode-integration", title: "OpenCode Integration" },
    ],
  },
  {
    group: "Configuration",
    items: [{ id: "settings", title: "Settings" }],
  },
  {
    group: "Technical Reference",
    items: [
      { id: "architecture", title: "Architecture" },
      { id: "real-time-events", title: "Real-Time Events" },
      { id: "api-reference", title: "API Reference" },
    ],
  },
]

const ALL_IDS = NAV.flatMap((g) => g.items.map((i) => i.id))

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="bg-secondary rounded-lg p-4 text-[0.8125rem] font-mono overflow-x-auto my-4 leading-[1.7]">
      <code className="text-foreground/80">{children}</code>
    </pre>
  )
}

function DocTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto my-6">
      <table className="w-full text-[0.8125rem]">
        <thead>
          <tr>
            {headers.map((h) => (
              <th
                key={h}
                className="text-left font-medium text-foreground/70 py-2.5 px-3 border-b border-border/30 whitespace-nowrap"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-border/20">
              {row.map((cell, j) => (
                <td
                  key={j}
                  className={`py-2.5 px-3 ${j === 0 ? "font-mono text-primary/80" : "text-muted-foreground/60"} whitespace-nowrap`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SectionHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2
      id={id}
      className="font-display text-[1.625rem] md:text-[2rem] font-bold tracking-[-0.04em] text-foreground scroll-mt-24"
    >
      {children}
    </h2>
  )
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="font-display text-[1.125rem] md:text-[1.25rem] font-bold tracking-[-0.03em] text-foreground mt-10 mb-3">
      {children}
    </h3>
  )
}

function Paragraph({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-muted-foreground/65 leading-[1.7] text-[0.9375rem] tracking-[-0.01em] mt-4">
      {children}
    </p>
  )
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="flex flex-col gap-3 mt-4">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-3 text-[0.875rem] text-muted-foreground/55 tracking-[-0.01em]">
          <span className="h-[3px] w-[3px] rounded-full bg-foreground/10 shrink-0 mt-[9px]" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  )
}

function NumberedList({ items }: { items: string[] }) {
  return (
    <ol className="flex flex-col gap-3 mt-4">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-3 text-[0.875rem] text-muted-foreground/55 tracking-[-0.01em]">
          <span className="font-mono text-primary/50 shrink-0 text-[0.75rem] mt-[2px] w-4 text-right">{i + 1}.</span>
          <span>{item}</span>
        </li>
      ))}
    </ol>
  )
}

function InlineCode({ children }: { children: string }) {
  return (
    <code className="bg-secondary px-1.5 py-0.5 rounded text-[0.8125rem] font-mono text-foreground/70">
      {children}
    </code>
  )
}

function SectionDivider() {
  return <div className="section-divider my-16" />
}

function SectionGettingStarted() {
  return (
    <section>
      <SectionHeading id="getting-started">Getting Started</SectionHeading>
      <Paragraph>
        OpenLinear is a desktop kanban board connected to your GitHub repository. Tasks don&apos;t just get tracked
        &mdash; they get done by AI agents. This guide walks you through installation, configuration, and your first
        task execution.
      </Paragraph>

      <SubHeading>Prerequisites</SubHeading>
      <BulletList items={["Node.js 18+", "pnpm package manager", "Docker (for PostgreSQL and worker containers)"]} />

      <SubHeading>Installation</SubHeading>
      <CodeBlock>{`# Clone and install dependencies
git clone https://github.com/kaizen403/openlinear.git
cd openlinear
pnpm install

# Start PostgreSQL
docker compose up -d

# Set your database URL
export DATABASE_URL=postgresql://openlinear:openlinear@localhost:5432/openlinear

# Push the database schema
pnpm db:push`}</CodeBlock>

      <SubHeading>Running</SubHeading>
      <Paragraph>
        OpenLinear requires two processes running simultaneously: the API server and the desktop app.
      </Paragraph>
      <CodeBlock>{`# Terminal 1 — API server
pnpm --filter @openlinear/api dev

# Terminal 2 — Desktop app
pnpm --filter @openlinear/desktop dev`}</CodeBlock>

      <SubHeading>Connect a Repository</SubHeading>
      <Paragraph>
        You can connect repositories with or without GitHub authentication.
      </Paragraph>
      <BulletList
        items={[
          "Without GitHub: Paste the URL of any public repository. OpenLinear will clone it locally.",
          "With GitHub: Authenticate via OAuth to access your private repositories. OpenLinear manages tokens automatically.",
        ]}
      />

      <SubHeading>Authentication</SubHeading>
      <Paragraph>
        OpenLinear supports two authentication methods: username/password registration and GitHub OAuth login. Both
        methods issue JWT tokens for subsequent API requests.
      </Paragraph>

      <SubHeading>Create and Execute a Task</SubHeading>
      <NumberedList
        items={[
          "Create a new task on the kanban board with a title and description.",
          "Set a priority level (Urgent, High, Medium, or Low).",
          "Click Execute \u2014 the AI agent clones your repo, creates a branch, and starts coding.",
          "Watch real-time progress in the execution drawer as the agent works.",
          "When complete, get a pull request link. Review, approve, and merge.",
        ]}
      />

      <SubHeading>Environment Variables</SubHeading>
      <DocTable
        headers={["Variable", "Description"]}
        rows={[
          ["DATABASE_URL", "PostgreSQL connection string"],
          ["API_PORT", "API server port (default: 3001)"],
          ["OPENCODE_PORT", "OpenCode container port"],
          ["OPENCODE_HOST", "OpenCode container host"],
          ["REPOS_DIR", "Host path for cloned repos (default: /tmp/openlinear-repos)"],
          ["JWT_SECRET", "Secret for signing auth tokens"],
          ["GITHUB_CLIENT_ID", "GitHub OAuth app client ID"],
          ["GITHUB_CLIENT_SECRET", "GitHub OAuth app client secret"],
          ["GITHUB_REDIRECT_URI", "OAuth callback URL"],
          ["FRONTEND_URL", "Frontend URL for redirects"],
          ["GITHUB_TOKEN", "Personal access token (optional, for higher rate limits)"],
          ["CORS_ORIGIN", "Allowed CORS origin (default: http://localhost:3000)"],
        ]}
      />
    </section>
  )
}

function SectionKanbanBoard() {
  return (
    <section>
      <SectionHeading id="kanban-board">Kanban Board</SectionHeading>
      <Paragraph>
        The kanban board is the primary interface for managing tasks. It provides a visual, column-based layout for
        organizing work across your project.
      </Paragraph>

      <SubHeading>Columns</SubHeading>
      <Paragraph>The board has four fixed columns representing task lifecycle stages:</Paragraph>
      <BulletList items={["Todo \u2014 tasks ready to be worked on", "In Progress \u2014 tasks currently being executed", "Done \u2014 completed tasks with PRs", "Cancelled \u2014 tasks that were abandoned"]} />

      <SubHeading>Drag and Drop</SubHeading>
      <Paragraph>
        Tasks can be moved between columns via drag and drop, powered by <InlineCode>@hello-pangea/dnd</InlineCode>.
        Dropping a task into a column updates its status on the server immediately.
      </Paragraph>

      <SubHeading>Task Cards</SubHeading>
      <Paragraph>Each task card displays:</Paragraph>
      <BulletList
        items={[
          "Title and issue number (e.g. ENG-3)",
          "Priority indicator (Urgent, High, Medium, Low)",
          "Labels with color coding",
          "Due date if set",
          "Execution status indicator",
          "Pull request link when available",
        ]}
      />

      <SubHeading>Multi-Select and Batch Operations</SubHeading>
      <Paragraph>
        Select multiple tasks using checkboxes. A floating control bar appears at the bottom of the screen, offering
        batch operations: execute selected, change status, change priority, or delete.
      </Paragraph>

      <SubHeading>Real-Time Updates</SubHeading>
      <Paragraph>
        The board receives real-time updates via Server-Sent Events (SSE). When another user or process changes a task,
        the board updates automatically. Events include:
      </Paragraph>
      <BulletList
        items={[
          "task:created \u2014 new task appears on the board",
          "task:updated \u2014 card refreshes with new data",
          "task:deleted \u2014 card is removed",
          "execution:progress \u2014 execution indicator updates",
          "execution:complete \u2014 PR link becomes available",
        ]}
      />

      <SubHeading>Project Filtering</SubHeading>
      <Paragraph>
        Use the project selector to filter the board to tasks belonging to a specific project. The selector persists
        across sessions and defaults to the last selected project.
      </Paragraph>
    </section>
  )
}

function SectionTaskManagement() {
  return (
    <section>
      <SectionHeading id="task-management">Task Management</SectionHeading>
      <Paragraph>
        Tasks are the core unit of work in OpenLinear. Each task represents a change you want made to your codebase.
      </Paragraph>

      <SubHeading>Creating Tasks</SubHeading>
      <Paragraph>Create tasks via the board UI or the API. Available fields:</Paragraph>
      <DocTable
        headers={["Field", "Type", "Required", "Description"]}
        rows={[
          ["title", "string", "Yes", "Short summary of the task"],
          ["description", "string", "No", "Detailed description for the AI agent"],
          ["priority", "enum", "No", "Urgent, High, Medium, Low (default: Medium)"],
          ["dueDate", "datetime", "No", "Optional deadline"],
          ["labels", "string[]", "No", "Array of label IDs to attach"],
          ["teamId", "string", "No", "Team to scope the task under"],
          ["projectId", "string", "No", "Project to assign the task to"],
        ]}
      />

      <SubHeading>Updating and Deleting</SubHeading>
      <Paragraph>
        Tasks can be updated at any time. Deleting a task performs a soft delete &mdash; the task is marked as archived
        and hidden from the board but remains in the database.
      </Paragraph>

      <SubHeading>Task Detail View</SubHeading>
      <Paragraph>
        Clicking a task card opens a side panel with the full task detail view. This panel shows all task fields, the
        description editor, execution history, and PR links.
      </Paragraph>

      <SubHeading>Labels</SubHeading>
      <Paragraph>
        Labels provide flexible categorization for tasks. Each label has a name, color, and optional priority.
      </Paragraph>
      <BulletList
        items={[
          "Create labels: POST /api/labels",
          "List labels: GET /api/labels",
          "Update labels: PATCH /api/labels/:id",
          "Delete labels: DELETE /api/labels/:id",
        ]}
      />

      <SubHeading>Issue Numbers</SubHeading>
      <Paragraph>
        Tasks scoped to a team receive sequential issue numbers using the team&apos;s key prefix. For example, a task in
        the Engineering team (key: ENG) would be numbered ENG-1, ENG-2, ENG-3, and so on.
      </Paragraph>
    </section>
  )
}

function SectionTaskExecution() {
  return (
    <section>
      <SectionHeading id="task-execution">Task Execution</SectionHeading>
      <Paragraph>
        Task execution is the core feature of OpenLinear. When you execute a task, an AI agent implements the changes
        described in the task directly in your repository.
      </Paragraph>

      <SubHeading>Execution Flow</SubHeading>
      <Paragraph>Execution follows a 7-step pipeline:</Paragraph>
      <NumberedList
        items={[
          "Clone \u2014 clone or update the repository into an isolated worktree",
          "Branch \u2014 create a new branch named after the task",
          "Session \u2014 start an AI agent session (OpenCode container)",
          "Prompt \u2014 send the task description as the agent\u2019s prompt",
          "Stream \u2014 stream real-time progress and logs to the UI",
          "Commit \u2014 commit all changes made by the agent",
          "Push & PR \u2014 push the branch and create a pull request",
        ]}
      />

      <SubHeading>Progress Stages</SubHeading>
      <DocTable
        headers={["Stage", "Description"]}
        rows={[
          ["cloning", "Repository is being cloned or worktree created"],
          ["executing", "AI agent is actively writing code"],
          ["committing", "Changes are being committed"],
          ["creating_pr", "Pull request is being created on GitHub"],
          ["done", "Execution completed successfully"],
          ["error", "An error occurred during execution"],
          ["cancelled", "Execution was cancelled by the user"],
        ]}
      />

      <SubHeading>Execution Logs</SubHeading>
      <Paragraph>The execution drawer streams real-time logs with different types:</Paragraph>
      <BulletList
        items={[
          "info \u2014 general progress messages",
          "agent \u2014 messages from the AI agent",
          "tool \u2014 tool calls made by the agent (file edits, terminal commands)",
          "success \u2014 completion messages",
          "error \u2014 error messages and stack traces",
        ]}
      />

      <SubHeading>Progress Estimation</SubHeading>
      <Paragraph>
        Progress percentage is estimated using the formula: <InlineCode>progress = min(95, elapsed / timeout * 100)</InlineCode>.
        The progress bar never reaches 100% until the execution is confirmed complete.
      </Paragraph>

      <SubHeading>Timeout</SubHeading>
      <Paragraph>
        Each execution has a 30-minute timeout. If the agent hasn&apos;t completed within this window, the execution is
        cancelled and any partial changes are discarded.
      </Paragraph>

      <SubHeading>Cancellation</SubHeading>
      <Paragraph>
        Users can cancel a running execution at any time. Cancellation stops the agent, cleans up the worktree, and
        marks the task as cancelled. The task can be re-executed later.
      </Paragraph>

      <SubHeading>Pull Request Creation</SubHeading>
      <Paragraph>
        After successful execution, OpenLinear creates a real pull request on GitHub. If the user hasn&apos;t
        authenticated with GitHub, a compare URL is generated as a fallback so the user can create the PR manually.
      </Paragraph>

      <SubHeading>Execution Drawer</SubHeading>
      <Paragraph>
        The execution drawer is a slide-out panel that shows real-time execution progress, logs, and the final PR link.
        It opens automatically when an execution starts and can be reopened from the task card.
      </Paragraph>
    </section>
  )
}

function SectionBatchExecution() {
  return (
    <section>
      <SectionHeading id="batch-execution">Batch Execution</SectionHeading>
      <Paragraph>
        Batch execution lets you run multiple tasks at once and merge all changes into a single pull request.
      </Paragraph>

      <SubHeading>Creating a Batch</SubHeading>
      <Paragraph>
        Create a batch by selecting multiple tasks and choosing &ldquo;Execute Selected&rdquo; from the batch control
        bar. Alternatively, use the API:
      </Paragraph>
      <CodeBlock>{`POST /api/batches
{
  "taskIds": ["task-1", "task-2", "task-3"],
  "mode": "parallel"
}`}</CodeBlock>

      <SubHeading>Parallel Mode</SubHeading>
      <Paragraph>
        In parallel mode, multiple tasks execute concurrently. The concurrency limit is configurable (default: 3, max:
        5). When one task completes and a slot opens, the next queued task starts automatically.
      </Paragraph>

      <SubHeading>Queue Mode</SubHeading>
      <Paragraph>
        In queue mode, tasks execute sequentially, one after another. An optional auto-approve setting determines whether
        the next task starts automatically or waits for user confirmation.
      </Paragraph>

      <SubHeading>Git Worktrees</SubHeading>
      <Paragraph>
        Each task in a batch executes in its own git worktree, providing complete file-system isolation. This allows
        parallel tasks to modify the same files without conflicts during execution.
      </Paragraph>

      <SubHeading>Merge Phase</SubHeading>
      <Paragraph>
        After all tasks complete, the merge phase begins. A batch branch is created and each task&apos;s changes are
        merged sequentially. Conflict handling depends on settings:
      </Paragraph>
      <BulletList
        items={[
          "skip \u2014 skip the conflicting task and continue with the rest",
          "fail \u2014 fail the entire batch if any merge conflict occurs",
        ]}
      />

      <SubHeading>Task Lifecycle</SubHeading>
      <DocTable
        headers={["Status", "Description"]}
        rows={[
          ["queued", "Waiting to be executed"],
          ["running", "Currently being executed by an agent"],
          ["completed", "Execution completed successfully"],
          ["failed", "Execution encountered an error"],
          ["skipped", "Skipped due to a merge conflict"],
          ["cancelled", "Cancelled by the user"],
        ]}
      />

      <SubHeading>Batch Lifecycle</SubHeading>
      <DocTable
        headers={["Status", "Description"]}
        rows={[
          ["pending", "Batch created, waiting to start"],
          ["running", "Tasks are being executed"],
          ["merging", "All tasks done, merging changes"],
          ["completed", "Merge successful, PR created"],
          ["failed", "One or more tasks failed or merge failed"],
          ["cancelled", "Batch was cancelled"],
        ]}
      />

      <SubHeading>API Endpoints</SubHeading>
      <DocTable
        headers={["Method", "Path", "Description"]}
        rows={[
          ["POST", "/api/batches", "Create a new batch"],
          ["GET", "/api/batches", "List all batches"],
          ["GET", "/api/batches/:id", "Get batch details"],
          ["POST", "/api/batches/:id/cancel", "Cancel a running batch"],
          ["POST", "/api/batches/:id/approve", "Approve next task in queue mode"],
        ]}
      />

      <SubHeading>SSE Events</SubHeading>
      <BulletList
        items={[
          "batch:created \u2014 new batch started",
          "batch:updated \u2014 batch status changed",
          "batch:task:started \u2014 a task within the batch began execution",
          "batch:task:completed \u2014 a task within the batch finished",
          "batch:task:failed \u2014 a task within the batch failed",
          "batch:merging \u2014 merge phase started",
          "batch:completed \u2014 batch completed with PR",
          "batch:failed \u2014 batch failed",
        ]}
      />
    </section>
  )
}

function SectionBrainstorm() {
  return (
    <section>
      <SectionHeading id="brainstorm">Brainstorm</SectionHeading>
      <Paragraph>
        Brainstorm mode lets you describe a high-level goal in natural language and generates a set of actionable tasks
        that can be added directly to your board.
      </Paragraph>

      <SubHeading>Flow</SubHeading>
      <NumberedList
        items={[
          "Open the brainstorm panel from the sidebar or via God Mode",
          "Type a goal or feature description",
          "Click Generate \u2014 the AI analyzes your goal and produces tasks",
          "Review the generated task cards with priorities and descriptions",
          "Insert selected tasks into your board",
        ]}
      />

      <SubHeading>Input Options</SubHeading>
      <Paragraph>The brainstorm input supports several toggles:</Paragraph>
      <BulletList
        items={[
          "Web search \u2014 enable web search for the AI to research APIs and libraries",
          "Research mode \u2014 deeper analysis with more context gathering",
          "Writing mode \u2014 generate documentation or content tasks",
        ]}
      />

      <SubHeading>Generated Tasks</SubHeading>
      <Paragraph>
        Tasks are streamed as they&apos;re generated, each displayed as a priority-coded card. Tasks include a title,
        description, and suggested priority level. You can edit any task before inserting it into the board.
      </Paragraph>

      <SubHeading>Trigger Methods</SubHeading>
      <BulletList
        items={[
          "Sidebar \u2014 click the Brainstorm button in the left sidebar",
          "God Mode \u2014 type a brainstorm prompt in the command bar",
        ]}
      />
    </section>
  )
}

function SectionGodMode() {
  return (
    <section>
      <SectionHeading id="god-mode">God Mode</SectionHeading>
      <Paragraph>
        God Mode is a command palette-style input bar for quick actions. It provides instant access to task creation,
        brainstorming, and search.
      </Paragraph>

      <SubHeading>Keyboard Shortcuts</SubHeading>
      <BulletList
        items={[
          "Option + Space (macOS) \u2014 toggle God Mode",
          "Ctrl + K (Windows/Linux) \u2014 toggle God Mode",
        ]}
      />

      <SubHeading>Behavior</SubHeading>
      <Paragraph>
        God Mode presents a pill-shaped input bar in the center of the screen. As you type, it interprets your input
        and routes it to the appropriate action &mdash; creating a task, triggering a brainstorm, or searching existing
        tasks.
      </Paragraph>

      <SubHeading>UI Elements</SubHeading>
      <BulletList
        items={[
          "Input field \u2014 centered text input with placeholder",
          "Brainstorm label \u2014 tag indicating brainstorm mode is active",
          "Globe button \u2014 toggle web search for brainstorm",
          "Mic button \u2014 voice input (experimental)",
          "Submit button \u2014 execute the current action",
        ]}
      />
    </section>
  )
}

function SectionInbox() {
  return (
    <section>
      <SectionHeading id="inbox">Inbox</SectionHeading>
      <Paragraph>
        The inbox collects completed and cancelled tasks that haven&apos;t been archived yet. It serves as a review
        queue for finished work.
      </Paragraph>

      <SubHeading>What Appears in the Inbox</SubHeading>
      <Paragraph>
        Tasks with status &ldquo;Done&rdquo; or &ldquo;Cancelled&rdquo; that have not been archived appear in the
        inbox. Each item shows the task title, status, completion time, and PR link if available.
      </Paragraph>

      <SubHeading>Unread Badge</SubHeading>
      <Paragraph>
        The sidebar shows an unread count badge next to the Inbox link. This count represents tasks that have been
        completed or cancelled since the user last viewed them.
      </Paragraph>

      <SubHeading>API Endpoints</SubHeading>
      <DocTable
        headers={["Method", "Path", "Description"]}
        rows={[
          ["GET", "/api/inbox", "List inbox items"],
          ["GET", "/api/inbox/count", "Get unread count"],
          ["PATCH", "/api/inbox/read/:id", "Mark a single item as read"],
          ["PATCH", "/api/inbox/read-all", "Mark all items as read"],
        ]}
      />
    </section>
  )
}

function SectionTeams() {
  return (
    <section>
      <SectionHeading id="teams">Teams</SectionHeading>
      <Paragraph>
        Teams organize users and scope tasks within your workspace. Each team has its own issue numbering sequence.
      </Paragraph>

      <SubHeading>Creating a Team</SubHeading>
      <DocTable
        headers={["Field", "Type", "Required", "Description"]}
        rows={[
          ["name", "string", "Yes", "Team display name"],
          ["key", "string", "Yes", "Short prefix for issue numbers (e.g. ENG)"],
          ["description", "string", "No", "Team description"],
          ["color", "string", "No", "Team color for UI"],
          ["icon", "string", "No", "Team icon identifier"],
          ["private", "boolean", "No", "Whether the team is private (default: false)"],
        ]}
      />

      <SubHeading>Issue Numbering</SubHeading>
      <Paragraph>
        Each team maintains its own sequential issue counter. Tasks created under the Engineering team (key: ENG) are
        numbered ENG-1, ENG-2, ENG-3, and so on. Numbers never reset and are unique within the team scope.
      </Paragraph>

      <SubHeading>Member Roles</SubHeading>
      <DocTable
        headers={["Role", "Permissions"]}
        rows={[
          ["owner", "Full control, can delete team, manage members"],
          ["admin", "Can manage members, modify team settings"],
          ["member", "Can create and execute tasks within the team"],
        ]}
      />

      <SubHeading>Invite Codes</SubHeading>
      <Paragraph>
        Teams use 10-character alphanumeric invite codes for adding members. Generate a code via the team settings,
        share it with teammates, and they can join by entering the code.
      </Paragraph>

      <SubHeading>Joining a Team</SubHeading>
      <CodeBlock>{`POST /api/teams/join
{
  "inviteCode": "aBcDeFgHiJ"
}`}</CodeBlock>

      <SubHeading>Deletion</SubHeading>
      <Paragraph>
        Deleting a team cascades to all associated data: tasks, labels, and memberships are removed. This action is
        irreversible.
      </Paragraph>

      <SubHeading>API Endpoints</SubHeading>
      <DocTable
        headers={["Method", "Path", "Description"]}
        rows={[
          ["POST", "/api/teams", "Create a new team"],
          ["GET", "/api/teams", "List teams for the current user"],
          ["GET", "/api/teams/:id", "Get team details"],
          ["PATCH", "/api/teams/:id", "Update a team"],
          ["DELETE", "/api/teams/:id", "Delete a team"],
          ["POST", "/api/teams/:id/invite", "Generate invite code"],
          ["POST", "/api/teams/join", "Join a team via invite code"],
          ["GET", "/api/teams/:id/members", "List team members"],
          ["PATCH", "/api/teams/:id/members/:userId", "Update member role"],
          ["DELETE", "/api/teams/:id/members/:userId", "Remove a member"],
        ]}
      />
    </section>
  )
}

function SectionProjects() {
  return (
    <section>
      <SectionHeading id="projects">Projects</SectionHeading>
      <Paragraph>
        Projects group related tasks and link them to a repository. They provide context for task execution and
        organize work across teams.
      </Paragraph>

      <SubHeading>Creating a Project</SubHeading>
      <DocTable
        headers={["Field", "Type", "Required", "Description"]}
        rows={[
          ["name", "string", "Yes", "Project name"],
          ["description", "string", "No", "Project description"],
          ["status", "enum", "No", "active, paused, completed, cancelled"],
          ["color", "string", "No", "Project color for UI"],
          ["icon", "string", "No", "Project icon identifier"],
          ["startDate", "datetime", "No", "Project start date"],
          ["endDate", "datetime", "No", "Project end date"],
          ["leadId", "string", "No", "User ID of the project lead"],
          ["teamIds", "string[]", "No", "Teams associated with this project"],
          ["repoUrl", "string", "No", "GitHub repository URL"],
          ["localPath", "string", "No", "Local path to the repository"],
        ]}
      />

      <SubHeading>Team Associations</SubHeading>
      <Paragraph>
        A project can be associated with multiple teams. Tasks created within the project inherit team scoping and issue
        numbering from their assigned team.
      </Paragraph>

      <SubHeading>Repository Linking</SubHeading>
      <Paragraph>
        Projects can be linked to a repository via <InlineCode>repoUrl</InlineCode> (GitHub URL) or{" "}
        <InlineCode>localPath</InlineCode> (local directory). When a task is executed, the linked repository is used as
        the target for code changes.
      </Paragraph>

      <SubHeading>Project Selector</SubHeading>
      <Paragraph>
        After first login, users are prompted to select or create a project. The project selector filters the kanban
        board to show only tasks belonging to the selected project.
      </Paragraph>

      <SubHeading>Task Assignment</SubHeading>
      <Paragraph>
        Tasks are assigned to projects via the <InlineCode>projectId</InlineCode> field. The board filters by the
        currently selected project, and tasks without a project are shown in an &ldquo;Unassigned&rdquo; view.
      </Paragraph>

      <SubHeading>API Endpoints</SubHeading>
      <DocTable
        headers={["Method", "Path", "Description"]}
        rows={[
          ["POST", "/api/projects", "Create a new project"],
          ["GET", "/api/projects", "List all projects"],
          ["GET", "/api/projects/:id", "Get project details"],
          ["PATCH", "/api/projects/:id", "Update a project"],
          ["DELETE", "/api/projects/:id", "Delete a project"],
        ]}
      />
    </section>
  )
}

function SectionGitHubIntegration() {
  return (
    <section>
      <SectionHeading id="github-integration">GitHub Integration</SectionHeading>
      <Paragraph>
        OpenLinear integrates with GitHub for authentication, repository management, and pull request creation.
      </Paragraph>

      <SubHeading>Authentication</SubHeading>
      <Paragraph>Two authentication methods are supported:</Paragraph>
      <BulletList
        items={[
          "Email/password \u2014 traditional registration and login with JWT tokens",
          "GitHub OAuth \u2014 login with your GitHub account, granting access to private repositories",
        ]}
      />

      <SubHeading>Environment Variables</SubHeading>
      <Paragraph>Configure GitHub OAuth with these environment variables:</Paragraph>
      <DocTable
        headers={["Variable", "Description"]}
        rows={[
          ["GITHUB_CLIENT_ID", "OAuth app client ID from GitHub"],
          ["GITHUB_CLIENT_SECRET", "OAuth app client secret"],
          ["GITHUB_REDIRECT_URI", "Callback URL (e.g. http://localhost:3000/auth/callback)"],
        ]}
      />

      <SubHeading>Auth Endpoints</SubHeading>
      <DocTable
        headers={["Method", "Path", "Description"]}
        rows={[
          ["POST", "/api/auth/register", "Register with email/password"],
          ["POST", "/api/auth/login", "Login with email/password"],
          ["GET", "/api/auth/github", "Initiate GitHub OAuth flow"],
          ["GET", "/api/auth/github/callback", "Handle OAuth callback"],
          ["GET", "/api/auth/me", "Get current user"],
        ]}
      />

      <SubHeading>Repository Management</SubHeading>
      <Paragraph>Repository access depends on authentication method:</Paragraph>
      <BulletList
        items={[
          "With GitHub auth \u2014 access both private and public repositories. Repos are listed from the GitHub API.",
          "Without GitHub auth \u2014 only public repositories accessible. Paste the URL to clone.",
        ]}
      />

      <SubHeading>Rate Limits</SubHeading>
      <Paragraph>
        GitHub API rate limits apply. Authenticated requests get 5,000 requests/hour. Unauthenticated requests are
        limited to 60/hour. Set <InlineCode>GITHUB_TOKEN</InlineCode> for higher limits in automated scenarios.
      </Paragraph>

      <SubHeading>Pull Request Creation</SubHeading>
      <Paragraph>
        After task execution, OpenLinear uses the GitHub API to create a pull request. The PR includes the task title
        as the PR title, the task description as the body, and a link back to the task in OpenLinear.
      </Paragraph>

      <SubHeading>PR Refresh</SubHeading>
      <Paragraph>
        Task cards show the current PR status (open, merged, closed). PR status is refreshed periodically and can be
        manually refreshed from the task detail view.
      </Paragraph>
    </section>
  )
}

function SectionOpenCodeIntegration() {
  return (
    <section>
      <SectionHeading id="opencode-integration">OpenCode Integration</SectionHeading>
      <Paragraph>
        OpenLinear uses OpenCode as its AI coding agent. Each user gets an isolated Docker container running their own
        OpenCode instance.
      </Paragraph>

      <SubHeading>Container-per-User Architecture</SubHeading>
      <NumberedList
        items={[
          "User triggers a task execution",
          "API checks if the user already has a running container",
          "If not, a new container is created from the opencode-worker image",
          "The repository is mounted into the container",
          "The agent session starts with the task prompt",
        ]}
      />

      <SubHeading>Container Lifecycle</SubHeading>
      <DocTable
        headers={["State", "Description"]}
        rows={[
          ["starting", "Container is being created and initialized"],
          ["running", "Container is active and processing"],
          ["stopping", "Container is shutting down gracefully"],
          ["stopped", "Container has been removed"],
          ["error", "Container encountered a fatal error"],
        ]}
      />

      <SubHeading>Idle Cleanup</SubHeading>
      <Paragraph>
        Containers that have been idle for more than 10 minutes are automatically stopped and removed to conserve
        resources. The cleanup runs on a periodic interval.
      </Paragraph>

      <SubHeading>Recovery</SubHeading>
      <Paragraph>
        On API restart, all running containers are detected and their state is reconciled. Orphaned containers are
        cleaned up, and in-progress executions are marked as failed.
      </Paragraph>

      <SubHeading>SDK Usage</SubHeading>
      <Paragraph>
        The API communicates with OpenCode containers via the OpenCode SDK. The SDK handles session creation, message
        sending, and event streaming.
      </Paragraph>
      <CodeBlock>{`import { OpenCode } from "@opencode/sdk"

const client = new OpenCode({
  baseUrl: "http://localhost:4892"
})

const session = await client.session.create()
await client.session.chat(session.id, {
  message: "Implement the login form component"
})`}</CodeBlock>

      <SubHeading>Session Management</SubHeading>
      <Paragraph>
        Each task execution creates a new OpenCode session. Sessions are isolated and stateless between tasks. The
        session ID is stored with the execution record for log retrieval.
      </Paragraph>

      <SubHeading>Event Streaming</SubHeading>
      <DocTable
        headers={["Event", "Description"]}
        rows={[
          ["message.created", "Agent sent a message"],
          ["message.updated", "Agent updated an existing message"],
          ["message.completed", "Agent finished processing"],
          ["tool.start", "Agent started a tool call (file edit, terminal, etc.)"],
          ["tool.result", "Tool call completed with result"],
          ["session.error", "Session encountered an error"],
        ]}
      />

      <SubHeading>Delta Buffer</SubHeading>
      <Paragraph>
        The delta buffer accumulates streaming text chunks and flushes them to the UI at a fixed interval. This
        prevents excessive re-renders while maintaining a responsive feel.
      </Paragraph>

      <SubHeading>Provider Authentication</SubHeading>
      <Paragraph>OpenCode supports two methods of AI provider authentication:</Paragraph>
      <BulletList
        items={[
          "API key \u2014 set the provider\u2019s API key as an environment variable in the container",
          "OAuth \u2014 use the provider\u2019s OAuth flow for token-based authentication",
        ]}
      />

      <SubHeading>API Endpoints</SubHeading>
      <DocTable
        headers={["Method", "Path", "Description"]}
        rows={[
          ["POST", "/api/opencode/start", "Start a container for the current user"],
          ["POST", "/api/opencode/stop", "Stop the user\u2019s container"],
          ["GET", "/api/opencode/status", "Get container status"],
          ["POST", "/api/opencode/session", "Create a new agent session"],
          ["POST", "/api/opencode/chat", "Send a message to the agent"],
          ["GET", "/api/opencode/events", "Stream agent events (SSE)"],
        ]}
      />
    </section>
  )
}

function SectionSettings() {
  return (
    <section>
      <SectionHeading id="settings">Settings</SectionHeading>
      <Paragraph>
        Settings control batch execution behavior and are scoped to the current user.
      </Paragraph>

      <SubHeading>Available Settings</SubHeading>
      <DocTable
        headers={["Setting", "Type", "Default", "Description"]}
        rows={[
          ["parallelLimit", "number (1-5)", "3", "Maximum concurrent tasks in parallel batch mode"],
          ["maxBatchSize", "number (1-10)", "3", "Maximum number of tasks in a single batch"],
          ["queueAutoApprove", "boolean", "false", "Auto-approve next task in queue mode"],
          ["stopOnFailure", "boolean", "false", "Stop the batch if any task fails"],
          ["conflictBehavior", "enum", "skip", "How to handle merge conflicts (skip or fail)"],
        ]}
      />

      <SubHeading>API</SubHeading>
      <CodeBlock>{`# Get current settings
GET /api/settings

# Update settings
PATCH /api/settings
{
  "parallelLimit": 5,
  "queueAutoApprove": true
}`}</CodeBlock>

      <SubHeading>Real-Time Updates</SubHeading>
      <Paragraph>
        When settings are updated, a <InlineCode>settings:updated</InlineCode> SSE event is broadcast. All connected
        clients receive the new settings and update their UI accordingly.
      </Paragraph>
    </section>
  )
}

function SectionArchitecture() {
  return (
    <section>
      <SectionHeading id="architecture">Architecture</SectionHeading>
      <Paragraph>
        OpenLinear is a monorepo containing the desktop app, API server, and shared packages.
      </Paragraph>

      <SubHeading>Monorepo Structure</SubHeading>
      <CodeBlock>{`openlinear/
  apps/
    desktop-ui/        # Next.js frontend (Tauri webview)
    api/               # Express API server
    landing/           # Marketing site
  packages/
    db/                # Prisma schema + client
  docker/
    opencode-worker/   # Per-user container image
  docs/
    features/          # Feature documentation
    diagrams/          # Architecture SVGs`}</CodeBlock>

      <SubHeading>Desktop App</SubHeading>
      <Paragraph>
        The desktop app is built with Tauri (Rust shell) and Next.js (React frontend). Tauri provides native window
        management, file system access, and system tray integration. The Next.js frontend communicates with the local
        API server over HTTP.
      </Paragraph>

      <SubHeading>Database Models</SubHeading>
      <DocTable
        headers={["Model", "Description"]}
        rows={[
          ["User", "User accounts with email and optional GitHub ID"],
          ["Task", "Work items with title, description, status, priority"],
          ["Label", "Tags for categorizing tasks"],
          ["Execution", "Records of AI agent task executions"],
          ["Batch", "Groups of tasks executed together"],
          ["BatchTask", "Join table linking batches to tasks"],
          ["Team", "User groups with issue numbering"],
          ["TeamMember", "User-team association with roles"],
          ["Project", "Collections of tasks linked to repos"],
          ["Setting", "User-scoped configuration"],
        ]}
      />

      <SubHeading>Enums</SubHeading>
      <BulletList
        items={[
          "TaskStatus: backlog, todo, in_progress, done, cancelled",
          "TaskPriority: urgent, high, medium, low",
          "ExecutionStatus: cloning, executing, committing, creating_pr, done, error, cancelled",
          "BatchStatus: pending, running, merging, completed, failed, cancelled",
          "BatchMode: parallel, queue",
        ]}
      />

      <SubHeading>API Routes</SubHeading>
      <Paragraph>
        The Express API is organized by domain. Each route module handles a specific resource: tasks, labels, batches,
        teams, projects, settings, auth, and events.
      </Paragraph>

      <SubHeading>Authentication Middleware</SubHeading>
      <Paragraph>
        All API routes (except auth endpoints) require a valid JWT token in the Authorization header. The middleware
        extracts the user ID from the token and attaches it to the request object.
      </Paragraph>

      <SubHeading>Real-Time Communication</SubHeading>
      <Paragraph>
        Real-time updates use Server-Sent Events (SSE). The API maintains a map of connected clients and broadcasts
        events when data changes. Clients reconnect automatically on connection loss.
      </Paragraph>

      <SubHeading>Git Strategy</SubHeading>
      <BulletList
        items={[
          "Single execution \u2014 creates a branch from the default branch, makes changes, pushes",
          "Batch execution \u2014 each task gets its own worktree, changes are merged into a batch branch, single PR",
        ]}
      />

      <SubHeading>Container-per-User</SubHeading>
      <Paragraph>
        Each user gets a dedicated Docker container for AI agent execution. Containers are created on-demand and cleaned
        up after idle timeout. This ensures complete isolation of credentials and file system access.
      </Paragraph>

      <SubHeading>Docker Services</SubHeading>
      <BulletList
        items={[
          "postgres \u2014 PostgreSQL 15 database",
          "opencode-worker \u2014 per-user AI agent container (created dynamically)",
        ]}
      />

      <SubHeading>CI/CD and Distribution</SubHeading>
      <Paragraph>
        Release builds are triggered on tag push (<InlineCode>v*</InlineCode>). The CI pipeline builds the desktop app
        for all platforms and publishes artifacts: AppImage and .deb for Linux, DMG for macOS, and npm packages.
      </Paragraph>
    </section>
  )
}

function SectionRealTimeEvents() {
  return (
    <section>
      <SectionHeading id="real-time-events">Real-Time Events</SectionHeading>
      <Paragraph>
        OpenLinear uses Server-Sent Events (SSE) for real-time communication between the API and connected clients.
      </Paragraph>

      <SubHeading>Connection</SubHeading>
      <CodeBlock>{`GET /api/events?clientId=optional-client-id

# Response: text/event-stream
data: {"type":"connected","clientId":"abc123"}`}</CodeBlock>
      <Paragraph>
        If no <InlineCode>clientId</InlineCode> is provided, the server generates one. The client should store this ID
        and pass it on reconnection to resume from where it left off.
      </Paragraph>

      <SubHeading>Task Events</SubHeading>
      <DocTable
        headers={["Event", "Payload", "Description"]}
        rows={[
          ["task:created", "Task object", "New task was created"],
          ["task:updated", "Task object", "Task was modified"],
          ["task:deleted", "{ id: string }", "Task was deleted"],
          ["task:status-changed", "{ id, status }", "Task status changed"],
        ]}
      />

      <SubHeading>Label Events</SubHeading>
      <DocTable
        headers={["Event", "Payload", "Description"]}
        rows={[
          ["label:created", "Label object", "New label was created"],
          ["label:updated", "Label object", "Label was modified"],
          ["label:deleted", "{ id: string }", "Label was deleted"],
        ]}
      />

      <SubHeading>Execution Events</SubHeading>
      <DocTable
        headers={["Event", "Payload", "Description"]}
        rows={[
          ["execution:started", "Execution object", "Execution began"],
          ["execution:progress", "{ id, progress, stage }", "Progress update"],
          ["execution:log", "{ id, type, message }", "New log entry"],
          ["execution:complete", "{ id, prUrl }", "Execution finished with PR"],
          ["execution:error", "{ id, error }", "Execution failed"],
          ["execution:cancelled", "{ id }", "Execution was cancelled"],
        ]}
      />

      <SubHeading>Batch Events</SubHeading>
      <DocTable
        headers={["Event", "Payload", "Description"]}
        rows={[
          ["batch:created", "Batch object", "New batch was created"],
          ["batch:updated", "Batch object", "Batch state changed"],
          ["batch:task:started", "{ batchId, taskId }", "Task in batch started"],
          ["batch:task:completed", "{ batchId, taskId }", "Task in batch completed"],
          ["batch:task:failed", "{ batchId, taskId, error }", "Task in batch failed"],
          ["batch:completed", "{ id, prUrl }", "Batch finished with PR"],
          ["batch:failed", "{ id, error }", "Batch failed"],
        ]}
      />

      <SubHeading>Settings Events</SubHeading>
      <DocTable
        headers={["Event", "Payload", "Description"]}
        rows={[["settings:updated", "Settings object", "User settings were modified"]]}
      />

      <SubHeading>OpenCode Events</SubHeading>
      <DocTable
        headers={["Event", "Payload", "Description"]}
        rows={[
          ["opencode:container:started", "{ userId, containerId }", "Container started"],
          ["opencode:container:stopped", "{ userId }", "Container stopped"],
          ["opencode:session:created", "{ sessionId }", "New agent session"],
          ["opencode:message", "{ sessionId, content }", "Agent message received"],
        ]}
      />

      <SubHeading>Team and Project Events</SubHeading>
      <DocTable
        headers={["Event", "Payload", "Description"]}
        rows={[
          ["team:created", "Team object", "Team was created"],
          ["team:updated", "Team object", "Team was modified"],
          ["team:deleted", "{ id: string }", "Team was deleted"],
          ["project:created", "Project object", "Project was created"],
          ["project:updated", "Project object", "Project was modified"],
          ["project:deleted", "{ id: string }", "Project was deleted"],
        ]}
      />
    </section>
  )
}

function SectionApiReference() {
  return (
    <section>
      <SectionHeading id="api-reference">API Reference</SectionHeading>
      <Paragraph>
        Complete REST API reference for OpenLinear. All endpoints require JWT authentication unless noted otherwise. Send
        the token in the <InlineCode>Authorization: Bearer &lt;token&gt;</InlineCode> header.
      </Paragraph>

      <SubHeading>Health</SubHeading>
      <DocTable
        headers={["Method", "Path", "Auth", "Description"]}
        rows={[["GET", "/api/health", "No", "Health check, returns server status"]]}
      />

      <SubHeading>Authentication</SubHeading>
      <DocTable
        headers={["Method", "Path", "Auth", "Description"]}
        rows={[
          ["POST", "/api/auth/register", "No", "Register a new account"],
          ["POST", "/api/auth/login", "No", "Login and receive JWT"],
          ["GET", "/api/auth/github", "No", "Start GitHub OAuth flow"],
          ["GET", "/api/auth/github/callback", "No", "Handle OAuth callback"],
          ["GET", "/api/auth/me", "Yes", "Get authenticated user profile"],
        ]}
      />

      <SubHeading>Repositories</SubHeading>
      <DocTable
        headers={["Method", "Path", "Auth", "Description"]}
        rows={[
          ["GET", "/api/repos", "Yes", "List available repositories"],
          ["POST", "/api/repos", "Yes", "Add a repository by URL"],
          ["GET", "/api/repos/:id", "Yes", "Get repository details"],
          ["DELETE", "/api/repos/:id", "Yes", "Remove a repository"],
        ]}
      />

      <SubHeading>Tasks</SubHeading>
      <DocTable
        headers={["Method", "Path", "Auth", "Description"]}
        rows={[
          ["GET", "/api/tasks", "Yes", "List tasks (filterable by status, project, team)"],
          ["POST", "/api/tasks", "Yes", "Create a new task"],
          ["GET", "/api/tasks/:id", "Yes", "Get task details"],
          ["PATCH", "/api/tasks/:id", "Yes", "Update a task"],
          ["DELETE", "/api/tasks/:id", "Yes", "Soft-delete a task"],
          ["POST", "/api/tasks/:id/execute", "Yes", "Execute a task"],
          ["POST", "/api/tasks/:id/cancel", "Yes", "Cancel task execution"],
        ]}
      />

      <SubHeading>Labels</SubHeading>
      <DocTable
        headers={["Method", "Path", "Auth", "Description"]}
        rows={[
          ["GET", "/api/labels", "Yes", "List all labels"],
          ["POST", "/api/labels", "Yes", "Create a label"],
          ["PATCH", "/api/labels/:id", "Yes", "Update a label"],
          ["DELETE", "/api/labels/:id", "Yes", "Delete a label"],
        ]}
      />

      <SubHeading>Settings</SubHeading>
      <DocTable
        headers={["Method", "Path", "Auth", "Description"]}
        rows={[
          ["GET", "/api/settings", "Yes", "Get user settings"],
          ["PATCH", "/api/settings", "Yes", "Update user settings"],
        ]}
      />

      <SubHeading>Batches</SubHeading>
      <DocTable
        headers={["Method", "Path", "Auth", "Description"]}
        rows={[
          ["POST", "/api/batches", "Yes", "Create a batch with taskIds and mode"],
          ["GET", "/api/batches", "Yes", "List all batches"],
          ["GET", "/api/batches/:id", "Yes", "Get batch details and task statuses"],
          ["POST", "/api/batches/:id/cancel", "Yes", "Cancel a running batch"],
          ["POST", "/api/batches/:id/approve", "Yes", "Approve next task in queue mode"],
        ]}
      />

      <SubHeading>Teams</SubHeading>
      <DocTable
        headers={["Method", "Path", "Auth", "Description"]}
        rows={[
          ["POST", "/api/teams", "Yes", "Create a team"],
          ["GET", "/api/teams", "Yes", "List user\u2019s teams"],
          ["GET", "/api/teams/:id", "Yes", "Get team details"],
          ["PATCH", "/api/teams/:id", "Yes", "Update a team"],
          ["DELETE", "/api/teams/:id", "Yes", "Delete a team (cascade)"],
          ["POST", "/api/teams/:id/invite", "Yes", "Generate invite code"],
          ["POST", "/api/teams/join", "Yes", "Join via invite code"],
          ["GET", "/api/teams/:id/members", "Yes", "List members"],
          ["PATCH", "/api/teams/:id/members/:userId", "Yes", "Update member role"],
          ["DELETE", "/api/teams/:id/members/:userId", "Yes", "Remove member"],
        ]}
      />

      <SubHeading>Projects</SubHeading>
      <DocTable
        headers={["Method", "Path", "Auth", "Description"]}
        rows={[
          ["POST", "/api/projects", "Yes", "Create a project"],
          ["GET", "/api/projects", "Yes", "List all projects"],
          ["GET", "/api/projects/:id", "Yes", "Get project details"],
          ["PATCH", "/api/projects/:id", "Yes", "Update a project"],
          ["DELETE", "/api/projects/:id", "Yes", "Delete a project"],
        ]}
      />

      <SubHeading>Inbox</SubHeading>
      <DocTable
        headers={["Method", "Path", "Auth", "Description"]}
        rows={[
          ["GET", "/api/inbox", "Yes", "List inbox items"],
          ["GET", "/api/inbox/count", "Yes", "Get unread count"],
          ["PATCH", "/api/inbox/read/:id", "Yes", "Mark item as read"],
          ["PATCH", "/api/inbox/read-all", "Yes", "Mark all items as read"],
        ]}
      />

      <SubHeading>Events</SubHeading>
      <DocTable
        headers={["Method", "Path", "Auth", "Description"]}
        rows={[["GET", "/api/events", "Yes", "SSE stream (pass clientId as query param)"]]}
      />

      <SubHeading>OpenCode</SubHeading>
      <DocTable
        headers={["Method", "Path", "Auth", "Description"]}
        rows={[
          ["POST", "/api/opencode/start", "Yes", "Start user container"],
          ["POST", "/api/opencode/stop", "Yes", "Stop user container"],
          ["GET", "/api/opencode/status", "Yes", "Get container status"],
          ["POST", "/api/opencode/session", "Yes", "Create agent session"],
          ["POST", "/api/opencode/chat", "Yes", "Send message to agent"],
          ["GET", "/api/opencode/events", "Yes", "Stream agent events (SSE)"],
        ]}
      />
    </section>
  )
}

export default function DocsPage() {
  const [activeSection, setActiveSection] = useState("getting-started")
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const isClickScrolling = useRef(false)

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (isClickScrolling.current) return
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id)
            break
          }
        }
      },
      { rootMargin: "-96px 0px -60% 0px", threshold: 0 }
    )

    ALL_IDS.forEach((id) => {
      const el = document.getElementById(id)
      if (el) observer.observe(el)
    })

    return () => observer.disconnect()
  }, [])

  const scrollTo = useCallback((id: string) => {
    setActiveSection(id)
    setMobileNavOpen(false)
    isClickScrolling.current = true
    const el = document.getElementById(id)
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" })
      setTimeout(() => {
        isClickScrolling.current = false
      }, 1000)
    }
  }, [])

  const sidebarContent = (
    <nav className="flex flex-col gap-7">
      {NAV.map((group) => (
        <div key={group.group}>
          <p className="text-[0.6875rem] font-medium text-muted-foreground/40 tracking-[0.04em] uppercase mb-3">
            {group.group}
          </p>
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => (
              <li key={item.id}>
                <button
                  onClick={() => scrollTo(item.id)}
                  className={`block w-full text-left py-1.5 pl-3 text-[0.8125rem] transition-colors duration-200 ${activeSection === item.id
                    ? "text-foreground font-medium border-l-2 border-primary"
                    : "text-muted-foreground/60 hover:text-foreground/80 border-l-2 border-transparent"
                    }`}
                >
                  {item.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  )

  return (
    <main>
      <Header />

      <div className="relative bg-background pt-24 min-h-screen">
        <div className="mx-auto max-w-none px-[100px]">
          <div className="pt-10 pb-6 lg:pt-16 lg:pb-10">
            <span className="text-[0.75rem] font-semibold text-primary/60 mb-5 tracking-[-0.01em] block">
              Documentation
            </span>
            <h1 className="font-display text-[2rem] md:text-[2.75rem] lg:text-[3.25rem] font-bold tracking-[-0.045em] text-foreground text-balance leading-[1.04] mt-5">
              Everything you need to know.
            </h1>
            <p className="text-muted-foreground/65 leading-[1.7] text-[0.9375rem] tracking-[-0.01em] max-w-xl mt-6">
              Comprehensive documentation for OpenLinear &mdash; from installation to API reference.
            </p>
          </div>

          <div className="section-divider" />

          <button
            onClick={() => setMobileNavOpen(!mobileNavOpen)}
            className="lg:hidden flex items-center gap-2 mt-6 mb-4 text-[0.8125rem] text-muted-foreground/60 hover:text-foreground/80 transition-colors duration-200"
            aria-label={mobileNavOpen ? "Close navigation" : "Open navigation"}
          >
            {mobileNavOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
            <span>{mobileNavOpen ? "Close" : "Navigation"}</span>
          </button>

          {mobileNavOpen && (
            <div className="lg:hidden mock-card rounded-xl p-5 mb-6">
              {sidebarContent}
            </div>
          )}

          <div className="flex gap-10 lg:gap-16 pb-24">
            <aside className="hidden lg:block w-64 shrink-0">
              <div className="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto py-8 pr-4 -mr-4 scrollbar-thin">
                {sidebarContent}
              </div>
            </aside>

            <div className="flex-1 min-w-0 py-8">
              <div className="max-w-3xl flex flex-col">
                <SectionGettingStarted />
                <SectionDivider />
                <SectionKanbanBoard />
                <SectionDivider />
                <SectionTaskManagement />
                <SectionDivider />
                <SectionTaskExecution />
                <SectionDivider />
                <SectionBatchExecution />
                <SectionDivider />
                <SectionBrainstorm />
                <SectionDivider />
                <SectionGodMode />
                <SectionDivider />
                <SectionInbox />
                <SectionDivider />
                <SectionTeams />
                <SectionDivider />
                <SectionProjects />
                <SectionDivider />
                <SectionGitHubIntegration />
                <SectionDivider />
                <SectionOpenCodeIntegration />
                <SectionDivider />
                <SectionSettings />
                <SectionDivider />
                <SectionArchitecture />
                <SectionDivider />
                <SectionRealTimeEvents />
                <SectionDivider />
                <SectionApiReference />
              </div>
            </div>
          </div>
        </div>
      </div>

      <Footer />
    </main>
  )
}
