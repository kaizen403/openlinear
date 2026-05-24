# Brainstorm Feature — Full Implementation

## TL;DR

> **Quick Summary**: Build a real AI-powered brainstorm feature that replaces the existing mock brainstorm UI. Users enter a prompt, AI asks 3-5 clarifying questions, then generates 3-10 task suggestions that stream in one-by-one. Users select tasks and add them to a project via a project picker.
> 
> **Deliverables**:
> - Backend brainstorm API route with two endpoints (generate questions + generate tasks)
> - LLM integration service using the user's configured provider keys
> - Reworked `GlobalQuickCapture` sidebar panel with interview/questions phase
> - Project picker UI for "Add to Project" flow
> - Real task creation wired to `POST /api/tasks`
> 
> **Estimated Effort**: Large
> **Parallel Execution**: YES - 2 waves
> **Critical Path**: Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6

---

## Context

### Original Request
User wants to build a brainstorm feature in OpenLinear where: (1) user enters a prompt, (2) AI asks clarifying questions, (3) user answers, (4) AI generates 3-10 task suggestions, (5) user selects which ones to keep, (6) user picks a project and adds them as real tasks.

### Interview Summary
**Key Discussions**:
- **LLM Provider**: Reuse user-configured provider keys from Settings (OpenCode containers store them)
- **Interview Phase**: AI generates 3-5 context-dependent questions based on the prompt
- **Streaming**: Tasks stream one-by-one via NDJSON over HTTP ReadableStream
- **UI Approach**: Rework existing `global-quick-capture.tsx` sidebar panel (currently 100% mock)
- **Project Selection**: Project picker shown before adding selected tasks
- **Tests**: No automated tests — Agent-Executed QA scenarios only

**Research Findings**:
- Existing brainstorm UI uses hardcoded `MOCK_TASKS` array with `setTimeout` fake streaming
- "Insert" button only toggles local `inserted: boolean` — never calls the API
- `GodModeOverlay` correctly dispatches `brainstorm-query` events — no changes needed
- `GlobalQuickCapture` is mounted OUTSIDE `<SSEProvider>` in `layout.tsx` — so SSE broadcast won't work for streaming; use fetch `ReadableStream` instead
- Task creation via `POST /api/tasks` is fully functional with title, description, priority, projectId, teamId, labelIds
- Provider keys are stored in OpenCode containers; `getClientForUser()` returns an SDK client with `provider.list()` to check connected providers
- The OpenCode SDK is designed for heavyweight coding agent sessions (`session.prompt()`), NOT lightweight brainstorm — direct LLM API calls are the right approach

### Metis Review
**Identified Gaps** (addressed):
- **LLM Integration Strategy**: Direct API calls (e.g., `openai` SDK) rather than routing through OpenCode `session.prompt()` which is designed for multi-step coding agents — resolved: direct API calls
- **Streaming Approach**: `GlobalQuickCapture` is outside `<SSEProvider>` — resolved: use fetch `ReadableStream` with NDJSON, not SSE broadcast
- **Data Shape Mapping**: AI-generated `reasoning` field maps to task `description` when inserting — resolved: `reasoning` → `description`
- **Error Handling**: What if user has no provider configured? — resolved: check provider status before brainstorm, show setup prompt if none configured
- **Provider Key Extraction**: Need to get the actual API key from the container to make direct LLM calls — resolved: use OpenCode SDK's `session.prompt()` as a fallback approach OR store provider choice + model in backend config. Actually, the simplest approach: the brainstorm backend route will use `getClientForUser()` to get the OpenCode SDK client, then use `session.chat()` or a lightweight prompt through the container. If that's too heavy, install `openai`/`@anthropic-ai/sdk` and have the user's key passed through from the container's provider auth. **Decision**: Use `openai` SDK with a new env var `BRAINSTORM_API_KEY` + `BRAINSTORM_MODEL` for the initial implementation. This is the simplest reliable path. The user can configure this in their `.env` file. If no env var is set, fall back to checking the user's OpenCode container for a connected provider and extracting the key via the SDK.

---

## Work Objectives

### Core Objective
Replace the mock brainstorm UI with a fully functional AI-powered brainstorm feature that generates clarifying questions, streams task suggestions, and creates real tasks in the user's chosen project.

### Concrete Deliverables
- `apps/api/src/routes/brainstorm.ts` — New backend route with `/api/brainstorm/questions` and `/api/brainstorm/generate` endpoints
- `apps/api/src/services/brainstorm.ts` — LLM integration service (prompt engineering, streaming, provider resolution)
- Modified `apps/desktop-ui/components/global-quick-capture.tsx` — Reworked with interview phase, real API calls, project picker, real task insertion
- `apps/desktop-ui/lib/api/brainstorm.ts` — Frontend API client functions for brainstorm endpoints
- Modified `apps/api/src/app.ts` — Register new brainstorm route
- Modified `apps/desktop-ui/lib/api/index.ts` — Export brainstorm API functions

### Definition of Done
- [x] User can enter a prompt and receive AI-generated clarifying questions
- [x] User can answer questions and receive 3-10 streamed task suggestions
- [x] User can select tasks and add them to a chosen project as real tasks
- [x] Tasks appear on the kanban board after insertion (via existing SSE `task:created` events)
- [x] Graceful error handling when no LLM provider is configured

### Must Have
- Interview/questions phase between prompt and task generation
- Streaming task generation (one-by-one appearance)
- Project picker before task insertion
- Real task creation via `POST /api/tasks`
- Error state when no AI provider is available
- Loading states during API calls

### Must NOT Have (Guardrails)
- **NO new Prisma models or DB tables** — brainstorm sessions are ephemeral
- **NO changes to `god-mode-overlay.tsx`** — it already works correctly
- **NO React Query/SWR/Zustand** — follow existing `useState` + `fetch` pattern
- **NO SSE broadcast for streaming** — `GlobalQuickCapture` is outside `SSEProvider`; use fetch `ReadableStream`
- **NO modification of existing task schema** — use existing fields (title, description, priority, projectId)
- **NO over-engineered prompt templates** — keep prompts simple and maintainable
- **NO hardcoded provider choice** — support both OpenAI and Anthropic via environment config
- **NO changes to the task creation API** — use the existing `POST /api/tasks` endpoint as-is

---

## Verification Strategy (MANDATORY)

> **UNIVERSAL RULE: ZERO HUMAN INTERVENTION**
>
> ALL tasks in this plan MUST be verifiable WITHOUT any human action.

### Test Decision
- **Infrastructure exists**: YES (Vitest + Supertest)
- **Automated tests**: None (user chose no tests)
- **Framework**: N/A

### Agent-Executed QA Scenarios (MANDATORY — ALL tasks)

> Every task includes Agent-Executed QA Scenarios as the PRIMARY verification method.
> The executing agent will directly run the deliverable and verify it.

**Verification Tool by Deliverable Type:**

| Type | Tool | How Agent Verifies |
|------|------|-------------------|
| **Backend API** | Bash (curl) | Send requests, parse responses, assert fields |
| **Frontend/UI** | Playwright (playwright skill) | Navigate, interact, assert DOM, screenshot |
| **LLM Integration** | Bash (curl with streaming) | Send brainstorm request, verify NDJSON stream |

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately):
├── Task 1: Backend brainstorm service (LLM integration)
└── Task 2: Frontend API client + types

Wave 2 (After Wave 1):
├── Task 3: Backend brainstorm route (endpoints)
└── Task 4: Frontend interview/questions phase UI

Wave 3 (After Wave 2):
├── Task 5: Frontend task streaming + project picker + insertion
└── Task 6: Route registration + wiring + error handling

Critical Path: Task 1 → Task 3 → Task 4 → Task 5 → Task 6
Parallel Speedup: ~30% faster than sequential
```

### Dependency Matrix

| Task | Depends On | Blocks | Can Parallelize With |
|------|------------|--------|---------------------|
| 1 | None | 3 | 2 |
| 2 | None | 4, 5 | 1 |
| 3 | 1 | 4, 5 | 2 |
| 4 | 2, 3 | 5 | None |
| 5 | 4 | 6 | None |
| 6 | 5 | None | None (final) |

### Agent Dispatch Summary

| Wave | Tasks | Recommended Agents |
|------|-------|-------------------|
| 1 | 1, 2 | task(category="unspecified-high") for backend, task(category="quick") for types |
| 2 | 3, 4 | task(category="unspecified-high") for route, task(category="visual-engineering") for UI |
| 3 | 5, 6 | task(category="visual-engineering") for UI, task(category="quick") for wiring |

---

## TODOs

- [x] 1. Create brainstorm LLM service (`apps/api/src/services/brainstorm.ts`)

  **What to do**:
  - Create `apps/api/src/services/brainstorm.ts` with two main functions:
    1. `generateQuestions(prompt: string, options?: { provider?: string }): Promise<string[]>` — Takes the user's brainstorm prompt, calls the LLM with a system prompt that instructs it to generate 3-5 clarifying questions. Returns an array of question strings.
    2. `generateTasks(prompt: string, answers: { question: string; answer: string }[], options?: { provider?: string }): AsyncGenerator<BrainstormTask>` — Takes the prompt + answered questions, calls the LLM with a system prompt instructing it to generate 3-10 actionable task suggestions. Uses streaming to yield tasks one at a time as they're generated.
  - Define the `BrainstormTask` interface: `{ title: string; description: string; priority: 'low' | 'medium' | 'high' }`
  - Install `openai` npm package in `apps/api` — it supports both OpenAI and Anthropic-compatible APIs
  - Use environment variables for configuration:
    - `BRAINSTORM_API_KEY` — The API key (required)
    - `BRAINSTORM_MODEL` — Model to use (default: `gpt-4o-mini` for OpenAI, or `claude-sonnet-4-20250514` for Anthropic)
    - `BRAINSTORM_PROVIDER` — `openai` or `anthropic` (default: `openai`)
    - `BRAINSTORM_BASE_URL` — Optional base URL override (for Anthropic: `https://api.anthropic.com/v1`)
  - If `BRAINSTORM_PROVIDER` is `anthropic`, use the `@anthropic-ai/sdk` package instead (install it too)
  - System prompt for questions generation should instruct the LLM to:
    - Analyze the user's brainstorm prompt
    - Generate 3-5 specific, relevant clarifying questions
    - Questions should help understand scope, technical approach, priority, constraints
    - Return as a JSON array of strings
  - System prompt for task generation should instruct the LLM to:
    - Use the original prompt + Q&A context to generate 3-10 actionable tasks
    - Each task has title (concise, actionable), description (1-2 sentences explaining why/what), priority (low/medium/high)
    - Return as a JSON array, streaming each object as it's generated
    - Tasks should be specific, actionable development tasks (not vague goals)
  - For streaming task generation, use the LLM's streaming API and parse the JSON objects from the streamed content. Use a simple approach: instruct the LLM to output one JSON object per line (NDJSON format), parse each complete line as a task object.
  - Export a `checkBrainstormAvailability()` function that returns `{ available: boolean; provider: string; error?: string }` by checking if `BRAINSTORM_API_KEY` env var is set.

  **Must NOT do**:
  - Do NOT use OpenCode SDK's `session.prompt()` — it's for heavyweight coding agents
  - Do NOT hardcode API keys
  - Do NOT import from `@openlinear/db` — this service doesn't need the database
  - Do NOT add complex retry logic or rate limiting — keep it simple
  - Do NOT add Prisma models or database persistence for brainstorm sessions

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Backend service with LLM SDK integration, streaming, and prompt engineering — requires careful implementation
  - **Skills**: [`nodejs-backend-patterns`]
    - `nodejs-backend-patterns`: LLM service creation, async generators, streaming patterns in Node.js

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 2)
  - **Blocks**: Task 3
  - **Blocked By**: None

  **References** (CRITICAL):

  **Pattern References**:
  - `apps/api/src/services/opencode.ts:1-80` — Service module pattern (exports, broadcast integration). Follow this file's structure: imports at top, interfaces, exported functions. This is the canonical service pattern.
  - `apps/api/src/services/execution/lifecycle.ts:1-50` — How services interact with external SDKs (OpenCode SDK client usage). Shows the pattern for async service functions that interact with external APIs.
  - `apps/api/src/services/container-manager.ts:1-20` — How `createOpencodeClient` and `@opencode-ai/sdk` are imported and used. Shows the SDK client creation pattern.

  **API/Type References**:
  - `apps/api/src/routes/opencode.ts:17-73` — Shows how `getClientForUser()` works, how provider list is retrieved, and the `connectedSet` pattern for checking which providers have API keys configured. This is relevant for understanding the existing provider auth flow.
  - `apps/api/src/routes/opencode.ts:133-151` — Shows `client.auth.set()` pattern — how API keys are stored in containers. Understand this to know where keys live.

  **External References**:
  - OpenAI Node.js SDK: `https://github.com/openai/openai-node` — for `openai` package usage (chat completions, streaming)
  - Anthropic Node.js SDK: `https://github.com/anthropics/anthropic-sdk-typescript` — for `@anthropic-ai/sdk` package (messages API, streaming)

  **Acceptance Criteria**:

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: Service module exports correctly
    Tool: Bash
    Preconditions: apps/api compiled successfully
    Steps:
      1. Run: node -e "const b = require('./apps/api/src/services/brainstorm'); console.log(Object.keys(b))"
         (or equivalent ts-node/tsx check)
      2. Assert: Output includes "generateQuestions", "generateTasks", "checkBrainstormAvailability"
    Expected Result: All three functions are exported
    Evidence: Terminal output captured

  Scenario: checkBrainstormAvailability returns unavailable when no env var
    Tool: Bash
    Preconditions: BRAINSTORM_API_KEY not set
    Steps:
      1. Run the function without BRAINSTORM_API_KEY set
      2. Assert: Returns { available: false, error: "..." }
    Expected Result: Graceful unavailable response
    Evidence: Terminal output captured

  Scenario: BrainstormTask interface matches expected shape
    Tool: Bash
    Preconditions: File exists at apps/api/src/services/brainstorm.ts
    Steps:
      1. grep for "interface BrainstormTask" in the file
      2. Assert: Contains title: string, description: string, priority: 'low' | 'medium' | 'high'
    Expected Result: Interface matches spec
    Evidence: grep output captured
  ```

  **Commit**: YES
  - Message: `feat(api): add brainstorm LLM service with question and task generation`
  - Files: `apps/api/src/services/brainstorm.ts`, `apps/api/package.json`
  - Pre-commit: TypeScript compilation check

---

- [x] 2. Create frontend brainstorm API client and types (`apps/desktop-ui/lib/api/brainstorm.ts`)

  **What to do**:
  - Create `apps/desktop-ui/lib/api/brainstorm.ts` with the following:
    1. Define types:
       ```typescript
       export interface BrainstormQuestion {
         question: string;
       }
       export interface BrainstormTask {
         title: string;
         description: string;
         priority: 'low' | 'medium' | 'high';
       }
       export interface BrainstormAvailability {
         available: boolean;
         provider?: string;
         error?: string;
       }
       ```
    2. `checkBrainstormAvailability(): Promise<BrainstormAvailability>` — `GET /api/brainstorm/availability` with auth header
    3. `generateBrainstormQuestions(prompt: string): Promise<string[]>` — `POST /api/brainstorm/questions` with `{ prompt }` body, returns array of question strings
    4. `streamBrainstormTasks(prompt: string, answers: { question: string; answer: string }[], onTask: (task: BrainstormTask) => void, onDone: () => void, onError: (error: string) => void): Promise<void>` — `POST /api/brainstorm/generate` with `{ prompt, answers }` body. Uses `response.body.getReader()` to read the NDJSON stream. For each complete line, parses JSON and calls `onTask(task)`. On stream end, calls `onDone()`. On error, calls `onError(message)`.
  - Export all functions from `apps/desktop-ui/lib/api/index.ts`
  - Follow the exact pattern from `apps/desktop-ui/lib/api/tasks.ts` for fetch calls (use `API_URL`, `getAuthHeader()`)

  **Must NOT do**:
  - Do NOT use React Query, SWR, or axios — use raw `fetch` like all other API clients
  - Do NOT add WebSocket or EventSource — use fetch ReadableStream
  - Do NOT create new type files — put types in the same brainstorm.ts file

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Straightforward API client functions following existing patterns — ~50 lines of code
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 1)
  - **Blocks**: Task 4, Task 5
  - **Blocked By**: None

  **References** (CRITICAL):

  **Pattern References**:
  - `apps/desktop-ui/lib/api/tasks.ts:1-52` — Canonical API client pattern: import `API_URL` + `getAuthHeader`, async functions, fetch + error handling, return `.json()`. Follow this exact structure.
  - `apps/desktop-ui/lib/api/client.ts:1-7` — `API_URL` constant and `getAuthHeader()` helper. Import these for all fetch calls.
  - `apps/desktop-ui/lib/api/opencode.ts:1-46` — Another API client example with types defined in the same file (ProviderInfo, SetupStatus interfaces). Follow this pattern for defining brainstorm types inline.

  **API/Type References**:
  - `apps/desktop-ui/lib/api/index.ts` — Barrel export file. Add `export * from './brainstorm'` here.
  - `apps/desktop-ui/lib/api/types.ts` — Existing frontend types. Reference for style conventions (interface naming, field naming).

  **Acceptance Criteria**:

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: API client file exists with correct exports
    Tool: Bash
    Preconditions: File created at apps/desktop-ui/lib/api/brainstorm.ts
    Steps:
      1. Check file exists: ls apps/desktop-ui/lib/api/brainstorm.ts
      2. grep for "export async function checkBrainstormAvailability"
      3. grep for "export async function generateBrainstormQuestions"
      4. grep for "export async function streamBrainstormTasks"
      5. grep for "export interface BrainstormTask"
      6. Check barrel export: grep "brainstorm" apps/desktop-ui/lib/api/index.ts
    Expected Result: All functions and types exist, barrel export includes brainstorm
    Evidence: grep output captured

  Scenario: Streaming function uses ReadableStream pattern
    Tool: Bash
    Preconditions: File exists
    Steps:
      1. grep for "getReader" in apps/desktop-ui/lib/api/brainstorm.ts
      2. grep for "TextDecoder" or "decoder" in the file
      3. Assert: Both patterns found (ReadableStream consumption)
    Expected Result: Streaming uses fetch ReadableStream, not EventSource/WebSocket
    Evidence: grep output captured
  ```

  **Commit**: YES
  - Message: `feat(ui): add brainstorm API client with streaming support`
  - Files: `apps/desktop-ui/lib/api/brainstorm.ts`, `apps/desktop-ui/lib/api/index.ts`
  - Pre-commit: TypeScript type check

---

- [x] 3. Create backend brainstorm route (`apps/api/src/routes/brainstorm.ts`) and register it

  **What to do**:
  - Create `apps/api/src/routes/brainstorm.ts` with Express router and three endpoints:

    1. **`GET /api/brainstorm/availability`** (requires auth):
       - Calls `checkBrainstormAvailability()` from the brainstorm service
       - Returns `{ available: boolean, provider?: string, error?: string }`

    2. **`POST /api/brainstorm/questions`** (requires auth):
       - Validate body with Zod: `{ prompt: z.string().min(1).max(5000) }`
       - Calls `generateQuestions(prompt)` from brainstorm service
       - Returns `{ questions: string[] }`
       - If brainstorm is not available, returns 503 with `{ error: "No AI provider configured" }`

    3. **`POST /api/brainstorm/generate`** (requires auth):
       - Validate body with Zod: `{ prompt: z.string().min(1).max(5000), answers: z.array(z.object({ question: z.string(), answer: z.string() })) }`
       - Sets response headers for NDJSON streaming: `Content-Type: application/x-ndjson`, `Transfer-Encoding: chunked`, `Cache-Control: no-cache`
       - Calls `generateTasks(prompt, answers)` — the async generator
       - For each yielded task, writes `JSON.stringify(task) + '\n'` to the response
       - On completion, ends the response
       - On error, writes `JSON.stringify({ error: message }) + '\n'` and ends

  - Register the route in `apps/api/src/app.ts`:
    - Import: `import brainstormRouter from './routes/brainstorm'`
    - Mount: `app.use('/api/brainstorm', brainstormRouter)`
    - Place it after the existing route registrations, before the SSE events endpoint

  **Must NOT do**:
  - Do NOT use SSE broadcast (`broadcast()`) — this is a request-response stream, not a server push
  - Do NOT add rate limiting or complex middleware
  - Do NOT persist brainstorm data to the database
  - Do NOT use `optionalAuth` — brainstorm requires authentication (use `requireAuth`)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Express route with streaming response, Zod validation, and service integration
  - **Skills**: [`nodejs-backend-patterns`]
    - `nodejs-backend-patterns`: Express route patterns, streaming responses, middleware integration

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (sequential after Wave 1)
  - **Blocks**: Task 4, Task 5
  - **Blocked By**: Task 1

  **References** (CRITICAL):

  **Pattern References**:
  - `apps/api/src/routes/tasks.ts:1-30` — Canonical route pattern: Zod schema definition at top, `Router()` creation, route handlers with `(req: Request, res: Response)` or `(req: AuthRequest, res: Response)`. Follow this exactly.
  - `apps/api/src/routes/tasks.ts:167-250` — Task creation handler showing Zod `safeParse`, error response format `{ error: ..., details: ... }`, success response format. Copy this validation pattern.
  - `apps/api/src/routes/settings.ts:1-58` — Simpler route example showing the minimal pattern (GET + PATCH). Good reference for the availability GET endpoint.
  - `apps/api/src/routes/opencode.ts:17-73` — Auth-protected route with `requireAuth` middleware. Shows the pattern for `(req: AuthRequest, res: Response)` handlers.

  **API/Type References**:
  - `apps/api/src/middleware/auth.ts` — `requireAuth` middleware and `AuthRequest` type. Import these for auth-protected endpoints.
  - `apps/api/src/app.ts` — Route registration file. Add `app.use('/api/brainstorm', brainstormRouter)` following the existing pattern on the lines after other route registrations.

  **Acceptance Criteria**:

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: Availability endpoint returns status
    Tool: Bash (curl)
    Preconditions: API server running on localhost:3001, user has valid JWT token
    Steps:
      1. curl -s -w "\n%{http_code}" http://localhost:3001/api/brainstorm/availability \
           -H "Authorization: Bearer $TOKEN"
      2. Assert: HTTP status is 200
      3. Assert: response has "available" boolean field
    Expected Result: Returns availability status JSON
    Evidence: Response body captured

  Scenario: Questions endpoint validates input
    Tool: Bash (curl)
    Preconditions: API server running
    Steps:
      1. curl -s -w "\n%{http_code}" -X POST http://localhost:3001/api/brainstorm/questions \
           -H "Content-Type: application/json" \
           -H "Authorization: Bearer $TOKEN" \
           -d '{"prompt":""}'
      2. Assert: HTTP status is 400
      3. Assert: response contains validation error
    Expected Result: Empty prompt rejected with 400
    Evidence: Response body captured

  Scenario: Questions endpoint returns questions for valid prompt
    Tool: Bash (curl)
    Preconditions: API server running, BRAINSTORM_API_KEY configured
    Steps:
      1. curl -s -w "\n%{http_code}" -X POST http://localhost:3001/api/brainstorm/questions \
           -H "Content-Type: application/json" \
           -H "Authorization: Bearer $TOKEN" \
           -d '{"prompt":"Build a user authentication system"}'
      2. Assert: HTTP status is 200
      3. Assert: response has "questions" array with 3-5 items
      4. Assert: each item is a non-empty string
    Expected Result: Returns 3-5 relevant questions
    Evidence: Response body captured

  Scenario: Generate endpoint streams NDJSON tasks
    Tool: Bash (curl)
    Preconditions: API server running, BRAINSTORM_API_KEY configured
    Steps:
      1. curl -s -N -X POST http://localhost:3001/api/brainstorm/generate \
           -H "Content-Type: application/json" \
           -H "Authorization: Bearer $TOKEN" \
           -d '{"prompt":"Build user auth","answers":[{"question":"What framework?","answer":"Next.js"}]}'
      2. Assert: Content-Type header is "application/x-ndjson"
      3. Assert: Each line is valid JSON with title, description, priority fields
      4. Assert: 3-10 task objects received
    Expected Result: Stream of NDJSON task objects
    Evidence: Response body captured

  Scenario: Generate endpoint rejects unauthenticated requests
    Tool: Bash (curl)
    Preconditions: API server running
    Steps:
      1. curl -s -w "\n%{http_code}" -X POST http://localhost:3001/api/brainstorm/generate \
           -H "Content-Type: application/json" \
           -d '{"prompt":"test","answers":[]}'
      2. Assert: HTTP status is 401
    Expected Result: Unauthenticated request rejected
    Evidence: Response body captured
  ```

  **Commit**: YES
  - Message: `feat(api): add brainstorm route with questions and streaming task generation endpoints`
  - Files: `apps/api/src/routes/brainstorm.ts`, `apps/api/src/app.ts`
  - Pre-commit: TypeScript compilation check

---

- [x] 4. Rework `GlobalQuickCapture` — Add interview/questions phase

  **What to do**:
  - Modify `apps/desktop-ui/components/global-quick-capture.tsx` to add a new "questions" phase between "input" and "stream":
  
  **Phase Model Changes**:
  - Current phases: `ghost` → `input` → `stream`
  - New phases: `ghost` → `input` → `questions` → `stream`
  - Add new state: `phase` should include `'questions'` as a valid value
  - Add new state variables:
    - `questions: string[]` — the AI-generated questions
    - `answers: Record<string, string>` — user's answers keyed by question text
    - `questionsLoading: boolean` — loading state while questions are being generated
    - `brainstormAvailable: boolean | null` — whether AI provider is configured
  
  **Input Phase Changes**:
  - When user submits the prompt (presses Enter or clicks send):
    1. First call `checkBrainstormAvailability()` — if not available, show a toast error ("No AI provider configured. Go to Settings > AI Providers") and stay in input phase
    2. If available, set `questionsLoading = true` and call `generateBrainstormQuestions(prompt)`
    3. On success, set `questions` state and transition to `'questions'` phase
    4. On error, show toast error and stay in input phase
  
  **New Questions Phase UI**:
  - Display the original prompt at the top (read-only, styled as a quote/callout)
  - Below it, render each question as a labeled text input:
    - Question text as the label (styled like the existing `text-linear-text-secondary` pattern)
    - Text input or textarea for the answer (use the existing input styling from the component)
    - Questions should be numbered (1, 2, 3...)
  - At the bottom, two buttons:
    - "Back" — returns to input phase, clears questions/answers
    - "Generate Tasks" — enabled only when at least one answer is provided. Transitions to `stream` phase and triggers task generation
  - Show a loading skeleton while questions are being fetched (similar to the existing skeleton in the stream phase)
  - Animation: questions should stagger in with `framer-motion` (match existing `AnimatePresence` + `motion.div` patterns in the file)
  
  **Remove mock data**:
  - Delete the entire `MOCK_TASKS` array (lines around the top of the file)
  - Remove the `setTimeout` simulation logic in the stream trigger
  - Remove the `results` state initialization from mock data

  **Must NOT do**:
  - Do NOT change the ghost phase or the panel trigger mechanism
  - Do NOT modify the god-mode-overlay integration (custom event listener)
  - Do NOT change the panel's slide-in animation or positioning
  - Do NOT add the streaming logic yet (Task 5 handles that)
  - Do NOT touch the "Insert" button yet (Task 5 handles that)
  - Keep the existing stream phase skeleton/loading UI intact — it will be wired in Task 5

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: UI component rework with animations, form inputs, state management, and visual design matching Linear aesthetic
  - **Skills**: [`frontend-ui-ux`, `shadcn-ui`]
    - `frontend-ui-ux`: Component design matching existing Linear-style dark theme
    - `shadcn-ui`: Correct usage of shadcn Input, Button, Label components

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (after Tasks 1-3)
  - **Blocks**: Task 5
  - **Blocked By**: Task 2, Task 3

  **References** (CRITICAL):

  **Pattern References**:
  - `apps/desktop-ui/components/global-quick-capture.tsx:1-500` — THE file being modified. Understand ALL of it: the phase state machine (`ghost`→`input`→`stream`), the `AnimatePresence` animations, the `brainstorm-query` event listener, the panel positioning, the skeleton loading UI, and the existing task card rendering. This is the PRIMARY reference.
  - `apps/desktop-ui/components/global-quick-capture.tsx` — Look for `MOCK_TASKS` constant — this entire array must be deleted.
  - `apps/desktop-ui/components/global-quick-capture.tsx` — Look for the `setTimeout` that simulates streaming — this must be removed.
  - `apps/desktop-ui/components/provider-setup-dialog.tsx:123-156` — Loading state pattern with `Loader2` spinner and descriptive text. Reuse this pattern for the questions loading state.
  - `apps/desktop-ui/components/task-form.tsx` — TaskFormDialog shows the pattern for form inputs with labels in the Linear dark theme. Reference for input styling.

  **API/Type References**:
  - `apps/desktop-ui/lib/api/brainstorm.ts` — Import `checkBrainstormAvailability`, `generateBrainstormQuestions`, and types from here (created in Task 2).

  **External References**:
  - Framer Motion `AnimatePresence`: The file already uses this extensively. Follow the existing `motion.div` patterns with `initial`, `animate`, `exit` props.

  **Acceptance Criteria**:

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: Questions phase renders after prompt submission
    Tool: Playwright (playwright skill)
    Preconditions: Dev server running on localhost:3000, user logged in, BRAINSTORM_API_KEY configured
    Steps:
      1. Navigate to: http://localhost:3000
      2. Click the brain icon (god-mode overlay) or trigger with keyboard shortcut
      3. Wait for: brainstorm input field visible (timeout: 5s)
      4. Fill the brainstorm input with: "Build a user authentication system with OAuth"
      5. Press Enter or click send button
      6. Wait for: questions to appear (timeout: 15s) — look for numbered question labels
      7. Assert: 3-5 question inputs are visible
      8. Assert: Each question has a text input/textarea for answering
      9. Assert: "Generate Tasks" button exists and is visible
      10. Assert: "Back" button exists
      11. Screenshot: .sisyphus/evidence/task-4-questions-phase.png
    Expected Result: Questions phase shows with AI-generated questions and answer inputs
    Evidence: .sisyphus/evidence/task-4-questions-phase.png

  Scenario: Back button returns to input phase
    Tool: Playwright (playwright skill)
    Preconditions: In questions phase (after previous scenario)
    Steps:
      1. Click "Back" button
      2. Wait for: input field visible again (timeout: 3s)
      3. Assert: Questions are no longer visible
      4. Assert: Original prompt text is still in the input
      5. Screenshot: .sisyphus/evidence/task-4-back-to-input.png
    Expected Result: Returns to input phase cleanly
    Evidence: .sisyphus/evidence/task-4-back-to-input.png

  Scenario: MOCK_TASKS removed from source
    Tool: Bash
    Preconditions: File modified
    Steps:
      1. grep -c "MOCK_TASKS" apps/desktop-ui/components/global-quick-capture.tsx
      2. Assert: Count is 0 (no references to MOCK_TASKS)
      3. grep -c "setTimeout" apps/desktop-ui/components/global-quick-capture.tsx
      4. Assert: No setTimeout for mock streaming simulation remains
    Expected Result: All mock data and simulation code removed
    Evidence: grep output captured
  ```

  **Commit**: YES
  - Message: `feat(ui): add interview/questions phase to brainstorm panel, remove mock data`
  - Files: `apps/desktop-ui/components/global-quick-capture.tsx`
  - Pre-commit: TypeScript type check

---

- [x] 5. Wire streaming task generation, project picker, and real task insertion

  **What to do**:
  - Continue modifying `apps/desktop-ui/components/global-quick-capture.tsx`:

  **Stream Phase — Real Task Generation**:
  - When user clicks "Generate Tasks" from the questions phase:
    1. Transition to `'stream'` phase
    2. Show skeleton loading (keep existing skeleton UI)
    3. Call `streamBrainstormTasks(prompt, answersArray, onTask, onDone, onError)` from the brainstorm API client
    4. `onTask`: Append each incoming task to a `generatedTasks` state array. Use the existing stagger animation pattern (each card fades/slides in with `motion.div`)
    5. `onDone`: Mark streaming as complete, enable the "Add to Project" button
    6. `onError`: Show toast error, allow retry
  - Each task card should display:
    - Title (bold)
    - Description (the AI reasoning — smaller text below)
    - Priority badge (colored — use existing priority styling pattern from the kanban board)
    - Checkbox for selection (checked by default)
  - Users can uncheck tasks they don't want

  **Project Picker**:
  - Below the task list, add a project selector dropdown:
    - Use `fetchProjects()` from `apps/desktop-ui/lib/api/projects.ts` to load available projects
    - Render as a `Select` component (from `@/components/ui/select`) with project names
    - Show project color dot next to each name (follow existing project selector pattern from `apps/desktop-ui/components/auth/project-selector.tsx`)
    - Store selected project in state: `selectedProjectId: string | null`

  **"Add to Project" Button**:
  - Below the project picker, add an "Add to Project" button:
    - Disabled until: at least one task is selected AND a project is selected
    - On click:
      1. Set a `inserting` loading state
      2. For each selected task, call `fetch(POST /api/tasks)` with:
         - `title`: task.title
         - `description`: task.description (the AI reasoning)
         - `priority`: task.priority
         - `projectId`: selectedProjectId
      3. Use `Promise.all()` to create all tasks in parallel
      4. On success: show toast "X tasks added to [project name]", reset the panel to ghost phase
      5. On error: show toast error, keep the panel open so user can retry
    - Show `Loader2` spinner while inserting
  - The existing SSE `task:created` broadcast will automatically update the kanban board — no manual board refresh needed

  **State Cleanup**:
  - When panel closes (transitions to ghost): reset ALL state (prompt, questions, answers, generatedTasks, selectedProjectId)
  - Remove old `inserted` boolean toggle and old "Insert" button logic entirely

  **Must NOT do**:
  - Do NOT create a separate component file for the project picker — keep it inline in `global-quick-capture.tsx`
  - Do NOT modify `POST /api/tasks` endpoint — it already accepts all needed fields
  - Do NOT use batch creation API — create tasks individually via `POST /api/tasks` (the existing endpoint handles SSE broadcast per task)
  - Do NOT add React Query — use raw fetch + useState
  - Do NOT forget to import `fetchProjects` from the API client

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: Complex UI with streaming data, animations, form controls, and multi-step interaction
  - **Skills**: [`frontend-ui-ux`, `shadcn-ui`]
    - `frontend-ui-ux`: Task card design, project picker, button states, loading animations
    - `shadcn-ui`: Select dropdown, Checkbox, Button components

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3 (sequential)
  - **Blocks**: Task 6
  - **Blocked By**: Task 4

  **References** (CRITICAL):

  **Pattern References**:
  - `apps/desktop-ui/components/global-quick-capture.tsx` — The file being modified. At this point it has the questions phase from Task 4. Continue building on that.
  - `apps/desktop-ui/components/global-quick-capture.tsx` — Look for existing task card rendering (the `motion.div` cards with title, reasoning, priority). Adapt this for real data instead of mock.
  - `apps/desktop-ui/components/auth/project-selector.tsx` — Project selector dropdown pattern. Shows how projects are fetched and displayed with color dots.
  - `apps/desktop-ui/components/board/kanban-board.tsx` — Priority badge styling pattern (how `low`/`medium`/`high` are visually differentiated).
  - `apps/desktop-ui/components/task-form.tsx:100-150` — How the TaskFormDialog calls `POST /api/tasks` with fetch. Copy this exact pattern for task insertion.

  **API/Type References**:
  - `apps/desktop-ui/lib/api/brainstorm.ts` — Import `streamBrainstormTasks`, `BrainstormTask` from here.
  - `apps/desktop-ui/lib/api/projects.ts` — Import `fetchProjects` for the project picker. Returns `Project[]` with `id`, `name`, `color`.
  - `apps/desktop-ui/lib/api/client.ts:1-7` — `API_URL` for the `POST /api/tasks` fetch call.
  - `apps/desktop-ui/lib/api/types.ts` — `Project` type definition for project picker state.
  - `apps/api/src/routes/tasks.ts:11-19` — `CreateTaskSchema` showing the exact fields accepted by `POST /api/tasks`: `{ title, description, priority, projectId, teamId, labelIds, dueDate }`. Use only `title`, `description`, `priority`, `projectId`.

  **Acceptance Criteria**:

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: Full brainstorm flow — prompt → questions → tasks → add to project
    Tool: Playwright (playwright skill)
    Preconditions: Dev server running, user logged in, BRAINSTORM_API_KEY configured, at least one project exists
    Steps:
      1. Navigate to: http://localhost:3000
      2. Trigger brainstorm (click brain icon or keyboard shortcut)
      3. Enter prompt: "Build a REST API for a blog with posts and comments"
      4. Press Enter
      5. Wait for questions phase (timeout: 15s)
      6. Fill in answers for at least 2 questions (any reasonable text)
      7. Click "Generate Tasks"
      8. Wait for tasks to stream in (timeout: 30s)
      9. Assert: 3-10 task cards visible
      10. Assert: Each card has title, description, priority badge, checkbox
      11. Uncheck 1-2 tasks
      12. Assert: Project picker dropdown is visible
      13. Select a project from the dropdown
      14. Click "Add to Project"
      15. Wait for success toast (timeout: 10s)
      16. Assert: Toast contains "tasks added" message
      17. Assert: Panel resets to closed/ghost state
      18. Screenshot: .sisyphus/evidence/task-5-full-flow.png
    Expected Result: Complete brainstorm flow works end-to-end, tasks created in project
    Evidence: .sisyphus/evidence/task-5-full-flow.png

  Scenario: Tasks appear on kanban board after insertion
    Tool: Playwright (playwright skill)
    Preconditions: Previous scenario completed, on the home page
    Steps:
      1. Navigate to home page with the project that received the tasks
      2. Wait for kanban board to load (timeout: 5s)
      3. Assert: New task cards visible in the "Todo" column matching the brainstorm titles
      4. Screenshot: .sisyphus/evidence/task-5-kanban-after-insert.png
    Expected Result: Brainstorm-generated tasks visible on kanban board
    Evidence: .sisyphus/evidence/task-5-kanban-after-insert.png

  Scenario: Disabled state when no tasks selected or no project
    Tool: Playwright (playwright skill)
    Preconditions: In stream phase with generated tasks
    Steps:
      1. Uncheck ALL task checkboxes
      2. Assert: "Add to Project" button is disabled
      3. Re-check one task but ensure no project is selected
      4. Assert: "Add to Project" button is still disabled
      5. Select a project
      6. Assert: "Add to Project" button is now enabled
      7. Screenshot: .sisyphus/evidence/task-5-disabled-states.png
    Expected Result: Button only enabled when tasks + project selected
    Evidence: .sisyphus/evidence/task-5-disabled-states.png

  Scenario: Error handling when streaming fails
    Tool: Playwright (playwright skill)
    Preconditions: Dev server running, temporarily invalid API key
    Steps:
      1. Go through prompt → questions → click Generate Tasks
      2. Wait for error toast (timeout: 15s)
      3. Assert: Error message displayed (toast or inline)
      4. Assert: Panel stays open (doesn't crash or close)
      5. Screenshot: .sisyphus/evidence/task-5-stream-error.png
    Expected Result: Graceful error without crashes
    Evidence: .sisyphus/evidence/task-5-stream-error.png
  ```

  **Commit**: YES
  - Message: `feat(ui): wire streaming task generation, project picker, and real task insertion to brainstorm panel`
  - Files: `apps/desktop-ui/components/global-quick-capture.tsx`
  - Pre-commit: TypeScript type check

---

- [x] 6. Final wiring, error handling polish, and env configuration

  **What to do**:
  - **Verify route registration**: Ensure `apps/api/src/app.ts` has `app.use('/api/brainstorm', brainstormRouter)` properly mounted. If Task 3 didn't handle it inline, add it now.
  
  - **Add env vars to `.env.example`**: Add the following to `apps/api/.env.example` (or root `.env.example`):
    ```
    # Brainstorm AI Configuration
    BRAINSTORM_API_KEY=          # Your LLM API key (OpenAI or Anthropic)
    BRAINSTORM_MODEL=gpt-4o-mini # Model to use (default: gpt-4o-mini)
    BRAINSTORM_PROVIDER=openai   # Provider: openai or anthropic
    BRAINSTORM_BASE_URL=         # Optional: custom base URL
    ```

  - **Error state in brainstorm panel**: In `global-quick-capture.tsx`, add a check when the panel opens (transitions from ghost to input):
    - Call `checkBrainstormAvailability()` in the background
    - If not available, show a subtle banner at the top of the input phase: "AI provider not configured. Set up in Settings > AI Providers." with a link to `/settings?section=ai-providers`
    - The banner should not block usage — just inform. The actual error will show when they try to submit.

  - **Loading timeout**: Add a 30-second timeout to the questions generation call. If it takes longer, show an error toast.

  - **Panel cleanup on close**: Verify that when the panel closes (click outside, press Escape, or ghost transition), ALL state is properly reset: prompt, questions, answers, generatedTasks, selectedProjectId, loading states.

  - **Smoke test**: Start the API server and frontend, verify the complete flow works end-to-end.

  **Must NOT do**:
  - Do NOT change any other existing routes or components
  - Do NOT add environment variables to git-tracked files (only .env.example)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Small wiring tasks, env configuration, minor polish — no heavy implementation
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3 (final)
  - **Blocks**: None
  - **Blocked By**: Task 5

  **References** (CRITICAL):

  **Pattern References**:
  - `apps/api/src/app.ts` — Route registration. Check that brainstorm route is mounted.
  - `.env.example` or `apps/api/.env.example` — Existing env var documentation. Add brainstorm vars following the same format.
  - `apps/desktop-ui/components/global-quick-capture.tsx` — The fully modified file. Verify all state cleanup on close.

  **API/Type References**:
  - `apps/desktop-ui/lib/api/brainstorm.ts` — `checkBrainstormAvailability()` for the availability check.

  **Acceptance Criteria**:

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: Environment variables documented
    Tool: Bash
    Preconditions: None
    Steps:
      1. grep "BRAINSTORM" .env.example or apps/api/.env.example
      2. Assert: BRAINSTORM_API_KEY, BRAINSTORM_MODEL, BRAINSTORM_PROVIDER listed
    Expected Result: Env vars documented in example file
    Evidence: grep output captured

  Scenario: Route properly registered
    Tool: Bash (curl)
    Preconditions: API server running
    Steps:
      1. curl -s http://localhost:3001/api/brainstorm/availability
      2. Assert: Does NOT return 404 (route exists)
      3. Assert: Returns 401 (auth required) or 200 (if auth is optional)
    Expected Result: Route is reachable (not 404)
    Evidence: Response captured

  Scenario: Unavailable state shows banner
    Tool: Playwright (playwright skill)
    Preconditions: Dev server running, BRAINSTORM_API_KEY NOT set
    Steps:
      1. Navigate to http://localhost:3000
      2. Open brainstorm panel
      3. Wait for input phase (timeout: 5s)
      4. Assert: Banner or warning about AI provider visible
      5. Assert: Link to settings page exists
      6. Screenshot: .sisyphus/evidence/task-6-unavailable-banner.png
    Expected Result: User sees helpful message about configuring AI provider
    Evidence: .sisyphus/evidence/task-6-unavailable-banner.png

  Scenario: Full end-to-end smoke test
    Tool: Playwright (playwright skill)
    Preconditions: Dev server running, BRAINSTORM_API_KEY configured, user logged in, project exists
    Steps:
      1. Navigate to http://localhost:3000
      2. Open brainstorm (brain icon)
      3. Type: "Create a notification system for the app"
      4. Submit prompt
      5. Wait for questions (timeout: 15s)
      6. Answer at least 2 questions
      7. Click "Generate Tasks"
      8. Wait for tasks (timeout: 30s)
      9. Select at least 2 tasks
      10. Choose a project
      11. Click "Add to Project"
      12. Wait for success toast (timeout: 10s)
      13. Navigate to kanban board for the selected project
      14. Assert: Created tasks visible in Todo column
      15. Screenshot: .sisyphus/evidence/task-6-e2e-complete.png
    Expected Result: Full flow works — brainstorm creates real tasks in the selected project
    Evidence: .sisyphus/evidence/task-6-e2e-complete.png
  ```

  **Commit**: YES
  - Message: `feat: finalize brainstorm feature with env config, error handling, and polish`
  - Files: `.env.example`, `apps/desktop-ui/components/global-quick-capture.tsx`, `apps/api/src/app.ts` (if needed)
  - Pre-commit: Full app build check

---

## Commit Strategy

| After Task | Message | Files | Verification |
|------------|---------|-------|--------------|
| 1 | `feat(api): add brainstorm LLM service with question and task generation` | `apps/api/src/services/brainstorm.ts`, `apps/api/package.json` | TS compile |
| 2 | `feat(ui): add brainstorm API client with streaming support` | `apps/desktop-ui/lib/api/brainstorm.ts`, `apps/desktop-ui/lib/api/index.ts` | TS type check |
| 3 | `feat(api): add brainstorm route with questions and streaming endpoints` | `apps/api/src/routes/brainstorm.ts`, `apps/api/src/app.ts` | TS compile + curl test |
| 4 | `feat(ui): add interview/questions phase to brainstorm panel` | `apps/desktop-ui/components/global-quick-capture.tsx` | TS type check |
| 5 | `feat(ui): wire streaming tasks, project picker, and task insertion` | `apps/desktop-ui/components/global-quick-capture.tsx` | Playwright E2E |
| 6 | `feat: finalize brainstorm with env config and error handling` | `.env.example`, misc files | Full E2E smoke test |

---

## Success Criteria

### Verification Commands
```bash
# API server starts without errors
cd apps/api && pnpm dev  # Expected: Server running on port 3001

# Frontend builds without errors  
cd apps/desktop-ui && pnpm build  # Expected: Build succeeds

# Brainstorm availability endpoint responds
curl http://localhost:3001/api/brainstorm/availability -H "Authorization: Bearer $TOKEN"
# Expected: { "available": true/false, ... }

# Questions endpoint works
curl -X POST http://localhost:3001/api/brainstorm/questions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"prompt":"Build a blog"}'
# Expected: { "questions": ["...", "...", "..."] }

# Generate endpoint streams tasks
curl -N -X POST http://localhost:3001/api/brainstorm/generate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"prompt":"Build a blog","answers":[{"question":"Framework?","answer":"Next.js"}]}'
# Expected: Multiple NDJSON lines with task objects
```

### Final Checklist
- [x] All "Must Have" present: interview phase, streaming, project picker, real task creation
- [x] All "Must NOT Have" absent: no new DB models, no React Query, no SSE broadcast for streaming, no modified task schema
- [x] MOCK_TASKS completely removed from global-quick-capture.tsx
- [x] Brainstorm works end-to-end: prompt → questions → tasks → add to project → visible on kanban
- [x] Error state shown when no AI provider is configured
- [x] Panel state properly resets on close
- [x] Environment variables documented in .env.example
