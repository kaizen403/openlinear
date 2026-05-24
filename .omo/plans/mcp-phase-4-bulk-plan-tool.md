# OpenLinear MCP — Phase 4: bulk_create_plan Tool + End-to-End

**Effort:** ~1 day  
**Depends on:** Phase 2 (bulk endpoint) + Phase 3 (MCP scaffold deployed)

---

## 4.1 The Magic Tool — `src/mcp/tools/plan.ts`

This is the primary tool. One MCP call → entire project structure in the dashboard.

### Input Schema

```typescript
z.object({
  workspaceId: z.string().uuid().optional().describe("Omit to use default workspace."),
  teamId: z.string().uuid().describe("Team to assign all tasks to."),
  project: z.object({
    name: z.string().min(1).max(100),
    description: z.string().max(1000).optional(),
    key: z.string().regex(/^[A-Z0-9]{2,12}$/).optional().describe("Auto-generated if omitted."),
  }),
  phases: z.array(z.object({
    name: z.string().min(1).max(100).describe("Phase name, e.g. 'Foundation'"),
    description: z.string().max(500).optional(),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    tasks: z.array(z.object({
      title: z.string().min(1).max(500),
      description: z.string().max(10000).optional(),
      priority: z.enum(["low", "medium", "high"]).default("medium"),
    })).min(1).max(50),
  })).min(1).max(10),
})
```

### Execution Flow

```typescript
async ({ workspaceId, teamId, project, phases }) => {
  // Step 1: Create project
  const createdProject = await client.createProject({
    ...project,
    workspaceId,       // undefined = API auto-defaults
    teamIds: [teamId],
    status: "planned",
  });

  // Step 2: For each phase, create label + bulk tasks
  const phaseResults = [];
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];

    // Create phase label
    const label = await client.createLabel({
      teamId,
      name: `phase:${i + 1} — ${phase.name}`,
      color: phase.color || DEFAULT_PHASE_COLORS[i % DEFAULT_PHASE_COLORS.length],
    });

    // Bulk create tasks for this phase
    const bulkResult = await client.bulkCreateTasks({
      projectId: createdProject.id,
      tasks: phase.tasks.map(t => ({
        ...t,
        status: "todo",
        labelIds: [label.id],
      })),
    });

    phaseResults.push({
      name: phase.name,
      labelId: label.id,
      labelName: label.name,
      taskCount: bulkResult.created.length,
      taskIds: bulkResult.created.map((t: any) => t.id),
    });
  }

  // Step 3: Return summary
  const result = {
    projectId: createdProject.id,
    projectKey: createdProject.key,
    projectName: createdProject.name,
    totalTasks: phaseResults.reduce((sum, p) => sum + p.taskCount, 0),
    phases: phaseResults,
  };

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}
```

### Tool Description (for AI discovery)

```
Create an entire project plan in one call. Creates a project, phase labels, and all tasks organized by phase. This is the primary tool for turning an AI-generated execution plan into OpenLinear issues.

Example use: "Plan the auth revamp with 3 phases: Foundation, Implementation, Polish"

The tool will:
1. Create a new project
2. Create a color-coded label for each phase (phase:1 — Foundation, phase:2 — Implementation, etc.)
3. Create all tasks under each phase with the phase label attached
4. Return the project ID, all phase label IDs, and all task IDs
```

---

## 4.2 Register in server.ts

```typescript
import { registerPlanTools } from "./tools/plan.js";

// In createMcpServer():
registerPlanTools(server, client);
```

Total tools after Phase 4: **7** (6 from Phase 3 + bulk_create_plan)

---

## 4.3 End-to-End Smoke Test

### From OpenCode:

User prompt:
> "use openlinear to plan the execution workflow for project 'Auth Revamp' with phases: Foundation (setup OAuth providers, add session table), Implementation (login flow, signup flow, password reset), Polish (rate limiting, audit logs, docs)"

AI should call `openlinear_bulk_create_plan` with:
```json
{
  "teamId": "uuid-of-eng-team",
  "project": {
    "name": "Auth Revamp",
    "description": "Complete authentication system overhaul"
  },
  "phases": [
    {
      "name": "Foundation",
      "tasks": [
        { "title": "Setup OAuth providers (Google, GitHub)", "priority": "high" },
        { "title": "Add session table to database schema", "priority": "high" }
      ]
    },
    {
      "name": "Implementation",
      "tasks": [
        { "title": "Implement login flow with OAuth", "priority": "high" },
        { "title": "Implement signup flow", "priority": "high" },
        { "title": "Implement password reset flow", "priority": "medium" }
      ]
    },
    {
      "name": "Polish",
      "tasks": [
        { "title": "Add rate limiting to auth endpoints", "priority": "medium" },
        { "title": "Add audit logs for auth events", "priority": "low" },
        { "title": "Write authentication documentation", "priority": "low" }
      ]
    }
  ]
}
```

**Expected result:** Project + 3 phase labels + 8 tasks appear in OpenLinear dashboard within ~3 seconds.

### From MCP Inspector:

1. Connect to `https://mcp.openlinear.tech/mcp`
2. Call `openlinear_list_workspaces` → get workspace
3. Call `openlinear_bulk_create_plan` with a test payload
4. Verify in OpenLinear UI: project exists, labels exist, tasks have labels

---

## 4.4 Error Handling

| Scenario | Behavior |
|---|---|
| Invalid teamId | MCP returns error text: "Team not found" |
| Project name too long | Zod validation fails → MCP returns validation error |
| Bulk tasks exceed 50/phase | Zod validation fails before API call |
| API 401 (bad PAT) | MCP returns "Authentication failed" |
| API 403 (no access) | MCP returns "Insufficient permissions" |
| Partial phase failure (e.g. label created but bulk fails) | Return partial result with error details — don't rollback successfully created items |

---

## 4.5 Deploy

```bash
cd apps/mcp
wrangler deploy
```

No config changes needed — just adding the new tool file and registering it.

---

## Acceptance Criteria

- [ ] `openlinear_bulk_create_plan` tool registered and discoverable
- [ ] Tool creates project + N labels + bulk tasks in correct order
- [ ] Phase labels follow naming convention `phase:N — Name`
- [ ] Auto-colors applied when color not specified
- [ ] Workspace defaults when workspaceId omitted
- [ ] Response includes projectId, projectKey, phases with labelIds and taskIds
- [ ] End-to-end works from OpenCode (user prompt → dashboard populated)
- [ ] End-to-end works from MCP Inspector
- [ ] Error cases return actionable error messages (not stack traces)
- [ ] Deployed to `mcp.openlinear.tech` and functional
