# OpenLinear MCP — Phase 2: Bulk Task Creation Endpoint

**Effort:** ~0.5 day  
**Blocks:** `bulk_create_plan` tool (Phase 4)  
**Depends on:** Phase 1 (PAT auth, so we can test with PATs)

---

## 2.1 Endpoint

**File:** `apps/api/src/routes/tasks.ts`

```
POST /api/tasks/bulk
Authorization: Bearer <JWT or PAT>
Content-Type: application/json
```

---

## 2.2 Zod Schema

**File:** `apps/api/src/schemas/tasks.ts` (extend)

```typescript
export const bulkCreateTasksSchema = z.object({
  projectId: z.string().uuid(),
  tasks: z.array(z.object({
    title: z.string().min(1).max(500),
    description: z.string().max(10000).optional(),
    priority: z.enum(['low', 'medium', 'high']).default('medium'),
    status: z.enum(['todo', 'in_progress', 'done', 'cancelled']).default('todo'),
    labelIds: z.array(z.string().uuid()).optional(),
    parentId: z.string().uuid().optional(),
    dueDate: z.string().datetime().optional(),
  })).min(1).max(100),
});
```

---

## 2.3 Implementation Logic

```typescript
// 1. Validate projectId exists and user has access (assertProjectAccess)
// 2. Resolve teamId from project (project must have at least one team via ProjectTeam)
// 3. prisma.$transaction():
//    a. Atomically increment team.nextIssueNumber by tasks.length
//    b. For each task (index i):
//       - Assign teamId from project
//       - Set identifier = `${team.key}-${startNumber + i}`
//       - Set number = startNumber + i
//       - Create task with all fields
//       - If labelIds provided: create TaskLabel junction records
//    c. Return all created tasks with relations
// 4. Emit SSE event: { type: 'tasks:bulk-created', projectId, count, taskIds }
// 5. Return response
```

---

## 2.4 Response Shape

```typescript
{
  created: Task[],           // successfully created tasks with full data
  failed: {                  // tasks that failed validation (e.g. invalid labelId)
    index: number,           // position in input array
    error: string            // human-readable reason
  }[]
}
```

---

## 2.5 Identifier Generation (Bulk-Optimized)

Existing single-task pattern (tasks.ts ~line 280-300):
- Read `team.nextIssueNumber`
- Increment by 1
- Format as `TEAM_KEY-NUMBER`

**Bulk optimization:**
- Increment `nextIssueNumber` by `tasks.length` in ONE atomic update
- Assign numbers sequentially from the old value
- Example: team has nextIssueNumber=42, bulk creating 5 tasks → assigns 42,43,44,45,46, sets nextIssueNumber=47

---

## 2.6 Edge Cases

- **Empty labelIds array:** Skip TaskLabel creation (valid)
- **Invalid labelId:** Fail that specific task, continue others → appears in `failed` array
- **parentId references another task in same batch:** NOT supported in v1 (would require two-pass). Return error for that task.
- **Project has no team:** 400 error (shouldn't happen with valid data, but guard)
- **Exceeds 100 cap:** 400 before any DB work

---

## 2.7 Tests

Integration tests covering:
- [ ] Happy path: 5 tasks created, all returned with correct identifiers (sequential)
- [ ] Exceeds cap: 101 tasks → 400 error, no tasks created
- [ ] Invalid projectId → 404
- [ ] No access to project → 403
- [ ] Mixed valid/invalid labelIds → partial success with failed array
- [ ] Auth: PAT with correct scopes → 200
- [ ] Auth: PAT with insufficient scopes → 403
- [ ] SSE event emitted with correct shape
- [ ] Identifiers are sequential and gapless within the batch

---

## Acceptance Criteria

- [ ] `POST /api/tasks/bulk` creates up to 100 tasks in one transaction
- [ ] All tasks get sequential identifiers (no gaps)
- [ ] Response includes both `created` and `failed` arrays
- [ ] SSE event `tasks:bulk-created` emitted
- [ ] 100-task cap enforced at validation layer
- [ ] Works with both JWT and PAT auth
- [ ] Integration tests pass
