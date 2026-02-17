# God Mode — Web Search & Voice Typing

## TL;DR

> **Quick Summary**: Wire up the dead Globe and Mic buttons in God Mode (and sidebar brainstorm panel) with real functionality — web search via OpenAI's built-in `web_search_options` in Chat Completions, and voice typing via MediaRecorder + Whisper API transcription.
> 
> **Deliverables**:
> - Working web search toggle in God Mode pill + sidebar brainstorm panel
> - Working voice typing (record → transcribe) in God Mode pill + sidebar brainstorm panel
> - Backend `/api/transcribe` endpoint (Whisper)
> - Backend brainstorm service enhanced with `webSearch` parameter
> - Updated CustomEvent contract between god-mode-overlay and global-quick-capture
> - Vitest tests for new API endpoints
> 
> **Estimated Effort**: Medium
> **Parallel Execution**: YES — 3 waves
> **Critical Path**: Task 1 → Task 3 → Task 5 → Task 7 → Task 8 → F1–F4

---

## Context

### Original Request
User wants the dead Globe (web search) and Mic (voice typing) buttons in God Mode to actually work. Currently they are pure decorative icons with no onClick handlers, no state, and no backend support.

### Interview Summary
**Key Discussions**:
- **Web Search API**: User chose OpenAI's built-in web_search over Tavily (zero new deps, already have openai SDK)
- **Voice Typing**: User chose Whisper API over Web Speech API (Web Speech broken in Tauri/WKWebView)
- **Scope**: Both God Mode pill AND sidebar brainstorm panel
- **Tests**: Yes, tests after implementation using existing vitest setup

**Research Findings**:
- OpenAI SDK v6.22.0 supports `web_search_options` param in Chat Completions — one-line addition, no migration to Responses API needed
- Web search only works when `BRAINSTORM_PROVIDER=openai` (not Anthropic) — must handle gracefully
- MediaRecorder API works in Tauri v2 (WKWebView supports it, unlike SpeechRecognition)
- WKWebView only supports `audio/mp4` MIME type for MediaRecorder — must detect and handle
- `express.raw()` is built into Express 5 — no new packages needed for audio upload
- CustomEvent contract is currently `detail: string` — needs upgrade to object to pass `webSearch` flag

### Metis Review
**Identified Gaps** (addressed):
- Chat Completions vs Responses API → Resolved: Use Chat Completions `web_search_options` (simpler)
- Audio upload handling → Resolved: Use `express.raw({ type: 'audio/*', limit: '10mb' })` (built into Express)
- CustomEvent contract change → Addressed: Must update producer AND consumer atomically
- Anthropic + web search toggle → Addressed: Disable Globe when provider ≠ openai
- MediaRecorder availability → Addressed: Feature-detect and disable Mic if unsupported
- Audio format in WKWebView → Addressed: Detect supported MIME type

---

## Work Objectives

### Core Objective
Make the Globe and Mic buttons in God Mode and sidebar brainstorm panel fully functional — web search enriches brainstorm AI context, voice typing transcribes speech into the input field.

### Concrete Deliverables
- `apps/api/src/services/brainstorm.ts` — enhanced with `webSearch` option
- `apps/api/src/routes/brainstorm.ts` — updated schema accepting `webSearch` param
- `apps/api/src/routes/transcribe.ts` — new endpoint for Whisper transcription
- `apps/api/src/app.ts` — register transcribe router
- `apps/desktop-ui/lib/api/brainstorm.ts` — updated client functions + `transcribeAudio()`
- `apps/desktop-ui/components/god-mode-overlay.tsx` — wired Globe + Mic buttons
- `apps/desktop-ui/components/global-quick-capture.tsx` — added Globe + Mic buttons with same logic
- `apps/api/src/__tests__/brainstorm-search.test.ts` — web search tests
- `apps/api/src/__tests__/transcribe.test.ts` — transcription tests

### Definition of Done
- [ ] Globe button toggles web search on/off with visual indicator in both components
- [ ] Mic button records audio → transcribes → fills input in both components
- [ ] `pnpm --filter @openlinear/api test` passes (all tests including new ones)
- [ ] `pnpm --filter @openlinear/api typecheck` passes
- [ ] Web search disabled/hidden when BRAINSTORM_PROVIDER ≠ openai
- [ ] Mic button disabled when MediaRecorder unavailable

### Must Have
- Web search toggle state with active/inactive visual styling
- Voice recording with visual recording indicator (pulsing/red state)
- Error handling for permission denied (microphone)
- Error handling for transcription failures
- Graceful degradation when features aren't available
- No new npm packages

### Must NOT Have (Guardrails)
- No migration to OpenAI Responses API (out of scope — a separate refactor)
- No global state management (Zustand/context) — keep using local useState
- No new npm dependencies
- No changes to existing brainstorm task generation logic (only augment with web search context)
- No changes to kanban board, task execution, or other features
- No over-engineered error handling (functional is enough)
- No JSDoc comments on every function (follow existing sparse style)

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES
- **Automated tests**: Tests after implementation
- **Framework**: vitest + supertest (existing pattern in `apps/api/src/__tests__/`)

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

| Deliverable Type | Verification Tool | Method |
|------------------|-------------------|--------|
| API endpoints | Bash (curl) | Send requests, assert status + response fields |
| Frontend UI | Playwright (playwright skill) | Navigate, interact, assert DOM, screenshot |
| TypeScript | Bash (tsc) | `pnpm --filter @openlinear/api typecheck` |
| Tests | Bash (vitest) | `pnpm --filter @openlinear/api test` |

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — backend foundation, MAX PARALLEL):
├── Task 1: Backend web search support in brainstorm service + route [quick]
├── Task 2: Backend /api/transcribe endpoint (Whisper) [quick]
└── Task 3: Frontend API client updates (brainstorm + transcribe) [quick]

Wave 2 (After Wave 1 — frontend wiring, PARALLEL):
├── Task 4: God Mode overlay — wire Globe + Mic buttons [visual-engineering]
├── Task 5: Sidebar brainstorm panel — add + wire Globe + Mic buttons [visual-engineering]
└── Task 6: Update CustomEvent contract between components [quick]

Wave 3 (After Wave 2 — tests + verification):
├── Task 7: API tests for web search + transcribe [quick]
└── Task 8: Full integration verification (typecheck + test + build) [unspecified-high]

Wave FINAL (After ALL tasks — independent review, 4 parallel):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)

Critical Path: Task 1 → Task 3 → Task 5 → Task 7 → Task 8 → F1–F4
Parallel Speedup: ~50% faster than sequential
Max Concurrent: 3 (Waves 1 & 2)
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
|------|------------|--------|------|
| 1 | — | 3, 7 | 1 |
| 2 | — | 3, 7 | 1 |
| 3 | 1, 2 | 4, 5, 6 | 1 |
| 4 | 3 | 6, 8 | 2 |
| 5 | 3 | 6, 8 | 2 |
| 6 | 4, 5 | 8 | 2 |
| 7 | 1, 2 | 8 | 3 |
| 8 | 6, 7 | F1–F4 | 3 |
| F1–F4 | 8 | — | FINAL |

### Agent Dispatch Summary

| Wave | # Parallel | Tasks → Agent Category |
|------|------------|----------------------|
| 1 | **3** | T1 → `quick`, T2 → `quick`, T3 → `quick` |
| 2 | **3** | T4 → `visual-engineering`, T5 → `visual-engineering`, T6 → `quick` |
| 3 | **2** | T7 → `quick`, T8 → `unspecified-high` |
| FINAL | **4** | F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep` |

---

## TODOs

- [x] 1. Backend: Add `webSearch` parameter to brainstorm service + route

  **What to do**:
  - In `apps/api/src/services/brainstorm.ts`:
    - Modify `generateQuestions(prompt, webSearch?)` to accept optional `webSearch: boolean` param
    - When `webSearch === true` AND provider is `openai`, add `web_search_options: { search_context_size: 'medium' }` to the `client.chat.completions.create()` call in `generateQuestions`
    - Modify `generateTasks(prompt, answers, webSearch?)` similarly — add `web_search_options` when enabled
    - When provider is `anthropic` and `webSearch` is true, ignore the flag silently (Anthropic doesn't support it)
  - In `apps/api/src/routes/brainstorm.ts`:
    - Add `webSearch: z.boolean().optional().default(false)` to both `QuestionsSchema` and `GenerateSchema`
    - Pass `webSearch` through to service functions
  - In `apps/api/src/services/brainstorm.ts`:
    - Update `checkBrainstormAvailability()` return type to include `webSearchAvailable: boolean` — true only when provider is `openai`

  **Must NOT do**:
  - Do NOT migrate to OpenAI Responses API
  - Do NOT change the existing streaming logic or NDJSON format
  - Do NOT add any new npm dependencies
  - Do NOT modify the Anthropic code path beyond silently ignoring webSearch

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Single-service modification, small scope, well-defined changes
  - **Skills**: []
    - No specialized skills needed — straightforward TypeScript/Express work
  - **Skills Evaluated but Omitted**:
    - `fastapi-expert`: Wrong framework (Express, not FastAPI)
    - `api-design-principles`: Overkill for a param addition

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3)
  - **Blocks**: Task 3, Task 7
  - **Blocked By**: None (can start immediately)

  **References** (CRITICAL):

  **Pattern References**:
  - `apps/api/src/services/brainstorm.ts:74-84` — OpenAI `chat.completions.create()` call to augment with `web_search_options`
  - `apps/api/src/services/brainstorm.ts:122-143` — OpenAI streaming `chat.completions.create()` for task generation (same augmentation)
  - `apps/api/src/services/brainstorm.ts:40-49` — `checkBrainstormAvailability()` pattern to extend with `webSearchAvailable`

  **API/Type References**:
  - `apps/api/src/routes/brainstorm.ts:6-16` — Zod schemas to add `webSearch` field
  - `apps/api/src/routes/brainstorm.ts:30-50` — Route handler pattern for passing params to service

  **External References**:
  - OpenAI Chat Completions `web_search_options` — `{ search_context_size: 'low' | 'medium' | 'high' }` param added to `create()` call

  **WHY Each Reference Matters**:
  - `brainstorm.ts:74-84`: This is the exact `create()` call where `web_search_options` gets added — executor must see current params
  - `brainstorm.ts:40-49`: Executor needs to see current return shape to add `webSearchAvailable` field
  - `brainstorm.ts:6-16`: Executor needs to see existing Zod schemas to add `webSearch` field consistently

  **Acceptance Criteria**:
  - [ ] `webSearch` field added to Zod schemas in route
  - [ ] `web_search_options` conditionally added to OpenAI `create()` calls
  - [ ] `checkBrainstormAvailability()` returns `webSearchAvailable: boolean`
  - [ ] Anthropic path ignores `webSearch` flag silently
  - [ ] Existing brainstorm flow works identically when `webSearch` is false/omitted

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Web search param accepted by API
    Tool: Bash (curl)
    Preconditions: API running on localhost:3001, BRAINSTORM_API_KEY set
    Steps:
      1. curl -s -X POST http://localhost:3001/api/brainstorm/questions \
         -H "Content-Type: application/json" \
         -H "Authorization: Bearer <valid-jwt>" \
         -d '{"prompt":"latest TypeScript features","webSearch":true}'
      2. Assert HTTP 200 response
      3. Assert response contains "questions" array
    Expected Result: HTTP 200 with JSON containing questions array
    Failure Indicators: HTTP 400/500, missing questions field
    Evidence: .sisyphus/evidence/task-1-web-search-questions.json

  Scenario: Availability endpoint reports webSearchAvailable
    Tool: Bash (curl)
    Preconditions: API running, BRAINSTORM_PROVIDER=openai in .env
    Steps:
      1. curl -s http://localhost:3001/api/brainstorm/availability \
         -H "Authorization: Bearer <valid-jwt>"
      2. Assert response contains "webSearchAvailable": true
    Expected Result: {"available":true,"provider":"openai","webSearchAvailable":true}
    Failure Indicators: Missing webSearchAvailable field
    Evidence: .sisyphus/evidence/task-1-availability.json

  Scenario: Regression — brainstorm without webSearch still works
    Tool: Bash (curl)
    Preconditions: API running
    Steps:
      1. curl -s -X POST http://localhost:3001/api/brainstorm/questions \
         -H "Content-Type: application/json" \
         -H "Authorization: Bearer <valid-jwt>" \
         -d '{"prompt":"help me plan a feature"}'
      2. Assert HTTP 200 with questions array
    Expected Result: Identical behavior to before — HTTP 200, questions array
    Failure Indicators: HTTP 400 (validation rejecting missing webSearch)
    Evidence: .sisyphus/evidence/task-1-regression.json
  ```

  **Commit**: YES
  - Message: `feat(api): add web search support to brainstorm service`
  - Files: `apps/api/src/services/brainstorm.ts`, `apps/api/src/routes/brainstorm.ts`
  - Pre-commit: `cd apps/api && pnpm typecheck`

---

- [x] 2. Backend: Add `/api/transcribe` endpoint (Whisper)

  **What to do**:
  - Create `apps/api/src/routes/transcribe.ts`:
    - POST `/` endpoint accepting raw audio body (Content-Type: `audio/*`)
    - Use `express.raw({ type: ['audio/mp4', 'audio/webm', 'audio/mpeg', 'audio/wav'], limit: '10mb' })` middleware on this route only
    - Create an OpenAI client (reuse pattern from brainstorm service)
    - Call `openai.audio.transcriptions.create({ model: 'whisper-1', file: ... })` with the raw buffer
    - Convert the raw Buffer to a File object via `openai.toFile(buffer, 'audio.mp4', { type: contentType })`
    - Return `{ text: transcription.text }`
    - Require auth (`requireAuth` middleware)
    - Handle errors: missing body, unsupported content type, Whisper API failure
  - In `apps/api/src/app.ts`:
    - Import and register: `app.use('/api/transcribe', transcribeRouter)`
    - IMPORTANT: Register the transcribe route BEFORE the `express.json()` middleware, or use route-specific middleware

  **Must NOT do**:
  - Do NOT install multer or any file upload package
  - Do NOT accept base64-encoded audio in JSON body
  - Do NOT add audio processing or format conversion

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Single new endpoint, well-defined input/output, straightforward implementation
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `nodejs-backend-patterns`: Useful but overkill for one endpoint

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3)
  - **Blocks**: Task 3, Task 7
  - **Blocked By**: None (can start immediately)

  **References** (CRITICAL):

  **Pattern References**:
  - `apps/api/src/routes/brainstorm.ts:1-91` — Route structure pattern (Router, requireAuth, Zod validation, try/catch)
  - `apps/api/src/services/brainstorm.ts:26-31` — OpenAI client creation pattern to reuse
  - `apps/api/src/app.ts:14,37` — Router import and registration pattern

  **API/Type References**:
  - `apps/api/src/middleware/auth.ts` — `requireAuth` middleware and `AuthRequest` type

  **External References**:
  - OpenAI Whisper API: `openai.audio.transcriptions.create({ model: 'whisper-1', file })` — returns `{ text: string }`
  - `openai.toFile(buffer, filename, options)` — converts Buffer to uploadable File object

  **WHY Each Reference Matters**:
  - `brainstorm.ts:1-91`: Executor must match exact route patterns (Router(), try/catch, res.status() usage)
  - `brainstorm.ts:26-31`: Shows how to create OpenAI client with env vars — must reuse same pattern
  - `app.ts:14,37`: Shows exact import/registration pattern — executor must register transcribe router consistently

  **Acceptance Criteria**:
  - [ ] POST `/api/transcribe` accepts raw audio body and returns `{ text: "..." }`
  - [ ] Route uses `express.raw()` middleware (not multer)
  - [ ] Route is auth-protected with `requireAuth`
  - [ ] Returns 400 for missing/empty body
  - [ ] Returns 400 for unsupported content type
  - [ ] Returns 500 with error message on Whisper API failure

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Transcribe audio file successfully
    Tool: Bash (curl)
    Preconditions: API running, BRAINSTORM_API_KEY set (same OpenAI key)
    Steps:
      1. Create a short test audio: echo "test" | base64 > /dev/null (or use a real .mp4 file)
      2. curl -s -X POST http://localhost:3001/api/transcribe \
         -H "Content-Type: audio/mp4" \
         -H "Authorization: Bearer <valid-jwt>" \
         --data-binary @test-audio.mp4
      3. Assert HTTP 200
      4. Assert response has "text" field
    Expected Result: {"text":"<transcribed text>"}
    Failure Indicators: HTTP 400/500, missing text field
    Evidence: .sisyphus/evidence/task-2-transcribe-success.json

  Scenario: Reject request with no body
    Tool: Bash (curl)
    Preconditions: API running
    Steps:
      1. curl -s -X POST http://localhost:3001/api/transcribe \
         -H "Content-Type: audio/mp4" \
         -H "Authorization: Bearer <valid-jwt>"
      2. Assert HTTP 400
    Expected Result: HTTP 400 with error message
    Failure Indicators: HTTP 200 or 500
    Evidence: .sisyphus/evidence/task-2-no-body-error.json

  Scenario: Reject unauthenticated request
    Tool: Bash (curl)
    Preconditions: API running
    Steps:
      1. curl -s -X POST http://localhost:3001/api/transcribe \
         -H "Content-Type: audio/mp4" \
         --data-binary @test-audio.mp4
      2. Assert HTTP 401
    Expected Result: HTTP 401
    Failure Indicators: HTTP 200
    Evidence: .sisyphus/evidence/task-2-auth-required.json
  ```

  **Commit**: YES
  - Message: `feat(api): add /api/transcribe endpoint for Whisper voice typing`
  - Files: `apps/api/src/routes/transcribe.ts`, `apps/api/src/app.ts`
  - Pre-commit: `cd apps/api && pnpm typecheck`

---

- [x] 3. Frontend: Update API client with web search + transcribe functions

  **What to do**:
  - In `apps/desktop-ui/lib/api/brainstorm.ts`:
    - Update `generateBrainstormQuestions(prompt, webSearch?)` to accept and pass `webSearch` boolean
    - Update `streamBrainstormTasks(prompt, answers, onTask, onDone, onError, webSearch?)` to accept and pass `webSearch` boolean
    - Update `BrainstormAvailability` interface to include `webSearchAvailable?: boolean`
    - Add new exported function `transcribeAudio(audioBlob: Blob): Promise<{ text: string }>` that:
      - Sends the blob as raw body with correct Content-Type header
      - Returns parsed `{ text }` response
    - Export all new types/functions from `apps/desktop-ui/lib/api/index.ts`

  **Must NOT do**:
  - Do NOT convert audio to base64 (send as raw blob)
  - Do NOT add any npm packages

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: API client update — straightforward function signatures
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO (depends on Task 1, 2 to know exact API shapes)
  - **Parallel Group**: Wave 1 (sequential after T1+T2)
  - **Blocks**: Tasks 4, 5, 6
  - **Blocked By**: Tasks 1, 2

  **References** (CRITICAL):

  **Pattern References**:
  - `apps/desktop-ui/lib/api/brainstorm.ts:1-91` — Full file: existing fetch patterns, error handling, streaming logic
  - `apps/desktop-ui/lib/api/client.ts` — `API_URL` and `getAuthHeader()` exports used in all API calls
  - `apps/desktop-ui/lib/api/index.ts:20-21` — Re-export pattern for brainstorm functions

  **WHY Each Reference Matters**:
  - `brainstorm.ts:1-91`: Executor must match exact fetch() patterns, error handling, and streaming reader logic
  - `client.ts`: Executor needs `API_URL` and `getAuthHeader()` for the new transcribe function
  - `index.ts:20-21`: New exports must follow same re-export barrel pattern

  **Acceptance Criteria**:
  - [ ] `generateBrainstormQuestions` accepts optional `webSearch` boolean
  - [ ] `streamBrainstormTasks` accepts optional `webSearch` boolean
  - [ ] `transcribeAudio(blob)` sends raw audio and returns `{ text }`
  - [ ] `BrainstormAvailability` includes `webSearchAvailable`
  - [ ] All functions exported from index barrel
  - [ ] TypeScript compiles without errors

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: TypeScript compilation passes
    Tool: Bash
    Preconditions: Dependencies installed
    Steps:
      1. cd apps/desktop-ui && npx tsc --noEmit
      2. Assert exit code 0
    Expected Result: No TypeScript errors
    Failure Indicators: Type errors in brainstorm.ts or index.ts
    Evidence: .sisyphus/evidence/task-3-typecheck.txt
  ```

  **Commit**: YES
  - Message: `feat(ui): update brainstorm API client with web search + transcribe`
  - Files: `apps/desktop-ui/lib/api/brainstorm.ts`, `apps/desktop-ui/lib/api/index.ts`
  - Pre-commit: `cd apps/desktop-ui && npx tsc --noEmit`

---

- [x] 4. Frontend: Wire God Mode overlay Globe + Mic buttons

  **What to do**:
  - In `apps/desktop-ui/components/god-mode-overlay.tsx`:
    - Add state: `const [webSearchEnabled, setWebSearchEnabled] = useState(false)`
    - Add state: `const [isRecording, setIsRecording] = useState(false)`
    - Add ref: `const mediaRecorderRef = useRef<MediaRecorder | null>(null)`
    - Add ref: `const audioChunksRef = useRef<Blob[]>([])`
    - Add state: `const [micSupported, setMicSupported] = useState(true)`
    - Add state: `const [webSearchAvailable, setWebSearchAvailable] = useState(false)`
    - On mount: check `navigator.mediaDevices?.getUserMedia` availability → set `micSupported`
    - On mount: call `checkBrainstormAvailability()` → set `webSearchAvailable` from response
    - **Globe button**: Add `onClick={() => setWebSearchEnabled(prev => !prev)}`. Add active styling when enabled (e.g., `text-blue-400` instead of `text-zinc-600`). Only show/enable when `webSearchAvailable` is true.
    - **Mic button**: Add `onClick` handler that:
      - If not recording: Request microphone permission, create MediaRecorder (detect supported MIME type: try `audio/webm` first, fallback to `audio/mp4`), start recording, set `isRecording(true)`
      - If recording: Stop MediaRecorder, collect chunks into Blob, call `transcribeAudio(blob)`, set transcribed text into `query` state, set `isRecording(false)`
    - Add recording indicator: When `isRecording`, show pulsing red dot or change Mic icon color to red
    - Disable Mic button when `!micSupported`
    - Update `handleSubmit` to include `webSearchEnabled` in the dispatched CustomEvent

  **Must NOT do**:
  - Do NOT add Zustand or React context
  - Do NOT move recording logic to a separate hook file (keep it inline, matching component style)
  - Do NOT add audio visualization or waveforms

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: UI component with visual states (active/recording indicators), animation, styling
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: Toggle states, recording indicator, conditional button styling

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 5, 6)
  - **Blocks**: Task 6
  - **Blocked By**: Task 3

  **References** (CRITICAL):

  **Pattern References**:
  - `apps/desktop-ui/components/god-mode-overlay.tsx:1-179` — Full file: current button layout, state pattern, animation style
  - `apps/desktop-ui/components/god-mode-overlay.tsx:148-159` — Exact Globe and Mic button elements to modify
  - `apps/desktop-ui/components/god-mode-overlay.tsx:66-76` — `handleSubmit` dispatching CustomEvent (must update)
  - `apps/desktop-ui/components/god-mode-overlay.tsx:98-107` — Button styling pattern (cn(), tailwind classes)

  **API/Type References**:
  - `apps/desktop-ui/lib/api/brainstorm.ts` — `checkBrainstormAvailability()`, `transcribeAudio()` functions

  **WHY Each Reference Matters**:
  - Lines 148-159: These are the exact dead buttons — executor must replace them with wired versions
  - Lines 66-76: handleSubmit dispatches CustomEvent — must be updated to include webSearchEnabled
  - Lines 98-107: Existing button styling uses `cn()` + Tailwind — new active states must match this pattern

  **Acceptance Criteria**:
  - [ ] Globe button toggles `webSearchEnabled` state on click
  - [ ] Globe button shows active styling (blue/highlighted) when enabled
  - [ ] Globe button hidden/disabled when `webSearchAvailable` is false
  - [ ] Mic button starts recording on first click
  - [ ] Mic button stops recording + transcribes on second click
  - [ ] Recording indicator visible during recording (pulsing/color change)
  - [ ] Transcribed text fills the input field
  - [ ] Mic button disabled when MediaRecorder unavailable
  - [ ] CustomEvent includes webSearchEnabled in detail

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Globe toggle visual state
    Tool: Playwright (playwright skill)
    Preconditions: App running on localhost:3000, user logged in
    Steps:
      1. Press Option+Space to open God Mode
      2. Assert Globe button exists: selector `button:has(.lucide-globe)`
      3. Click the Globe button
      4. Assert Globe button has active styling (check for `text-blue-400` or similar class)
      5. Click again
      6. Assert active styling removed
      7. Screenshot
    Expected Result: Globe toggles between active (blue) and inactive (zinc) states
    Failure Indicators: No visual change, button not clickable
    Evidence: .sisyphus/evidence/task-4-globe-toggle.png

  Scenario: Mic button recording indicator
    Tool: Playwright (playwright skill)
    Preconditions: App running, user logged in, microphone permission granted
    Steps:
      1. Press Option+Space to open God Mode
      2. Click the Mic button: selector `button:has(.lucide-mic)`
      3. Assert recording indicator visible (pulsing dot or red color)
      4. Wait 2 seconds
      5. Click Mic button again to stop
      6. Assert recording indicator disappears
      7. Assert input field contains text (from transcription) — may be empty if no actual speech
      8. Screenshot
    Expected Result: Recording indicator appears during recording, disappears after
    Failure Indicators: No indicator, button doesn't respond, error toast
    Evidence: .sisyphus/evidence/task-4-mic-recording.png
  ```

  **Commit**: YES
  - Message: `feat(ui): wire God Mode Globe (web search) and Mic (voice typing) buttons`
  - Files: `apps/desktop-ui/components/god-mode-overlay.tsx`
  - Pre-commit: `cd apps/desktop-ui && npx tsc --noEmit`

---

- [x] 5. Frontend: Add Globe + Mic buttons to sidebar brainstorm panel

  **What to do**:
  - In `apps/desktop-ui/components/global-quick-capture.tsx`:
    - Add same state variables as Task 4: `webSearchEnabled`, `isRecording`, `micSupported`, `webSearchAvailable`, `mediaRecorderRef`, `audioChunksRef`
    - Add same feature detection on mount (MediaRecorder, brainstorm availability)
    - Add Globe and Mic buttons to the input bar area (bottom of sidebar, next to the Plus icon and input)
    - Match the styling from god-mode-overlay (cn(), same icon sizes, same active/recording indicators)
    - Wire same onClick handlers (toggle web search, start/stop recording + transcribe)
    - Pass `webSearchEnabled` through to `streamBrainstormTasks()` and `generateBrainstormQuestions()` calls
    - The sidebar handles its own brainstorm flow (no CustomEvent needed here — it calls API directly)

  **Must NOT do**:
  - Do NOT extract shared logic into a custom hook (keep inline, match codebase style)
  - Do NOT change the sidebar layout significantly — just add 2 small icon buttons next to existing input area
  - Do NOT add audio visualization

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: UI changes with button placement, styling, recording states
  - **Skills**: [`frontend-ui-ux`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 4, 6)
  - **Blocks**: Task 6
  - **Blocked By**: Task 3

  **References** (CRITICAL):

  **Pattern References**:
  - `apps/desktop-ui/components/global-quick-capture.tsx:742-774` — Bottom input bar where Globe+Mic buttons go
  - `apps/desktop-ui/components/global-quick-capture.tsx:257-282` — `handleSubmit` calling brainstorm APIs (must pass webSearch)
  - `apps/desktop-ui/components/global-quick-capture.tsx:290-321` — `startStreaming` calling `streamBrainstormTasks` (must pass webSearch)
  - `apps/desktop-ui/components/god-mode-overlay.tsx:148-159` — Globe+Mic button HTML/styling to replicate

  **WHY Each Reference Matters**:
  - Lines 742-774: This is where buttons must be inserted — executor needs exact layout context
  - Lines 257-282, 290-321: These are the API call sites where `webSearch` param must be added
  - god-mode-overlay 148-159: The styling template to replicate for consistency

  **Acceptance Criteria**:
  - [ ] Globe and Mic buttons visible in sidebar brainstorm input area
  - [ ] Globe toggles web search with same visual indicator as God Mode
  - [ ] Mic records → transcribes → fills input
  - [ ] Recording indicator visible during recording
  - [ ] `webSearch` param passed to brainstorm API calls
  - [ ] Globe hidden/disabled when webSearchAvailable is false
  - [ ] Mic disabled when MediaRecorder unavailable

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Sidebar brainstorm Globe + Mic buttons visible
    Tool: Playwright (playwright skill)
    Preconditions: App running, user logged in
    Steps:
      1. Click the ghost trigger (right edge vertical bar) to open sidebar
      2. Assert sidebar is visible
      3. Assert Globe button exists in sidebar: `.fixed.right-0 button:has(.lucide-globe)`
      4. Assert Mic button exists in sidebar: `.fixed.right-0 button:has(.lucide-mic)`
      5. Screenshot
    Expected Result: Both buttons visible in sidebar input area
    Failure Indicators: Buttons not rendered, sidebar doesn't open
    Evidence: .sisyphus/evidence/task-5-sidebar-buttons.png

  Scenario: Sidebar web search toggle works
    Tool: Playwright (playwright skill)
    Preconditions: App running, user logged in
    Steps:
      1. Open sidebar
      2. Click Globe button
      3. Assert active styling applied
      4. Type "latest TypeScript features" in input
      5. Press Enter
      6. Assert brainstorm flow starts (questions or loading state visible)
      7. Screenshot
    Expected Result: Web search enabled, brainstorm initiated with web search context
    Failure Indicators: No visual feedback, API error
    Evidence: .sisyphus/evidence/task-5-sidebar-search.png
  ```

  **Commit**: YES
  - Message: `feat(ui): add web search + voice typing to sidebar brainstorm panel`
  - Files: `apps/desktop-ui/components/global-quick-capture.tsx`
  - Pre-commit: `cd apps/desktop-ui && npx tsc --noEmit`

---

- [x] 6. Frontend: Update CustomEvent contract between components

  **What to do**:
  - In `apps/desktop-ui/components/god-mode-overlay.tsx`:
    - Change `handleSubmit` to dispatch: `new CustomEvent("brainstorm-query", { detail: { query: trimmed, webSearch: webSearchEnabled } })`
  - In `apps/desktop-ui/components/global-quick-capture.tsx`:
    - Update the `handleBrainstorm` event listener (line ~200-236) to:
      - Accept `detail` as `{ query: string, webSearch: boolean }` instead of plain `string`
      - Extract `query` and `webSearch` from detail
      - Set `webSearchEnabled` state from the incoming event
      - Pass `webSearch` to `generateBrainstormQuestions()` call
    - Add backward compatibility: if `typeof detail === 'string'`, treat as `{ query: detail, webSearch: false }`

  **Must NOT do**:
  - Do NOT create a shared types file for the event (keep it simple, inline types)
  - Do NOT change any other CustomEvent types in the codebase

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Small contract change across two files
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO (depends on Tasks 4, 5 being complete)
  - **Parallel Group**: Wave 2 (after T4+T5)
  - **Blocks**: Task 8
  - **Blocked By**: Tasks 4, 5

  **References** (CRITICAL):

  **Pattern References**:
  - `apps/desktop-ui/components/god-mode-overlay.tsx:66-76` — Producer: dispatches CustomEvent
  - `apps/desktop-ui/components/global-quick-capture.tsx:200-236` — Consumer: listens for CustomEvent

  **WHY Each Reference Matters**:
  - god-mode-overlay 66-76: This is the producer that must change from `detail: trimmed` to `detail: { query, webSearch }`
  - global-quick-capture 200-236: This is the consumer that must destructure the new object shape

  **Acceptance Criteria**:
  - [ ] CustomEvent detail is `{ query: string, webSearch: boolean }`
  - [ ] Sidebar correctly reads both `query` and `webSearch` from event
  - [ ] Backward compatible: string detail still works (treated as `{ query: string, webSearch: false }`)
  - [ ] God Mode → sidebar brainstorm flow works end-to-end with web search toggle

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: God Mode → Sidebar brainstorm with web search
    Tool: Playwright (playwright skill)
    Preconditions: App running, user logged in
    Steps:
      1. Press Option+Space to open God Mode
      2. Click Globe button to enable web search
      3. Type "latest React 19 features" in input
      4. Press Enter
      5. Assert God Mode closes
      6. Assert sidebar opens with brainstorm flow started
      7. Assert web search was passed through (check network request or Globe button state in sidebar)
      8. Screenshot
    Expected Result: Sidebar opens, brainstorm starts with web search context
    Failure Indicators: Sidebar doesn't open, webSearch not passed, error
    Evidence: .sisyphus/evidence/task-6-custom-event-flow.png

  Scenario: Backward compat — plain string event still works
    Tool: Bash (browser console simulation)
    Preconditions: App running
    Steps:
      1. In browser console: window.dispatchEvent(new CustomEvent("brainstorm-query", { detail: "test plain string" }))
      2. Assert sidebar opens and handles the string correctly
    Expected Result: Sidebar opens, treats as query with webSearch=false
    Failure Indicators: Error in console, sidebar crashes
    Evidence: .sisyphus/evidence/task-6-backward-compat.txt
  ```

  **Commit**: YES
  - Message: `feat(ui): update CustomEvent contract to include web search flag`
  - Files: `apps/desktop-ui/components/god-mode-overlay.tsx`, `apps/desktop-ui/components/global-quick-capture.tsx`
  - Pre-commit: `cd apps/desktop-ui && npx tsc --noEmit`

---

- [x] 7. Backend: API tests for web search + transcribe

  **What to do**:
  - Create `apps/api/src/__tests__/brainstorm-search.test.ts`:
    - Test: POST `/api/brainstorm/questions` with `webSearch: true` → 200
    - Test: POST `/api/brainstorm/questions` with `webSearch: false` → 200 (regression)
    - Test: POST `/api/brainstorm/questions` without `webSearch` field → 200 (backward compat, defaults false)
    - Test: GET `/api/brainstorm/availability` returns `webSearchAvailable` field
    - Mock OpenAI calls to avoid real API calls in CI
  - Create `apps/api/src/__tests__/transcribe.test.ts`:
    - Test: POST `/api/transcribe` with audio body → 200 (mock Whisper)
    - Test: POST `/api/transcribe` with no body → 400
    - Test: POST `/api/transcribe` without auth → 401
    - Mock OpenAI Whisper to avoid real API calls
  - Follow existing test patterns from `apps/api/src/__tests__/auth.test.ts` (supertest + vitest)

  **Must NOT do**:
  - Do NOT make real API calls to OpenAI in tests (mock the SDK)
  - Do NOT create test utility files (keep tests self-contained like existing ones)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Standard vitest/supertest test files, well-defined patterns to follow
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Task 8, after Wave 2)
  - **Parallel Group**: Wave 3 (with Task 8)
  - **Blocks**: Task 8
  - **Blocked By**: Tasks 1, 2

  **References** (CRITICAL):

  **Pattern References**:
  - `apps/api/src/__tests__/auth.test.ts` — Test structure: describe/it blocks, supertest usage, app import
  - `apps/api/src/__tests__/tasks.test.ts:20-40` — Test user creation pattern for auth
  - `apps/api/vitest.config.ts` — Test configuration

  **WHY Each Reference Matters**:
  - `auth.test.ts`: Shows exact supertest pattern (import app, `request(app).get/post`, assertions)
  - `tasks.test.ts:20-40`: Shows how to create a test user with JWT for auth-protected routes

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @openlinear/api test` → all tests pass
  - [ ] New test files created and running
  - [ ] OpenAI SDK is mocked (no real API calls)
  - [ ] Tests cover: web search on/off, backward compat, transcribe success/error/auth

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: All tests pass
    Tool: Bash
    Preconditions: Dependencies installed, database available
    Steps:
      1. cd apps/api && pnpm vitest run
      2. Assert exit code 0
      3. Assert output shows new test files running
    Expected Result: All tests pass, including new brainstorm-search and transcribe tests
    Failure Indicators: Non-zero exit code, test failures
    Evidence: .sisyphus/evidence/task-7-test-results.txt
  ```

  **Commit**: YES
  - Message: `test(api): add tests for web search brainstorm + transcribe endpoints`
  - Files: `apps/api/src/__tests__/brainstorm-search.test.ts`, `apps/api/src/__tests__/transcribe.test.ts`
  - Pre-commit: `cd apps/api && pnpm vitest run`

---

- [x] 8. Full integration verification

  **What to do**:
  - Run full verification pipeline:
    - `pnpm --filter @openlinear/api typecheck` → pass
    - `pnpm --filter @openlinear/api test` → pass
    - `pnpm --filter @openlinear/api build` → pass
    - `pnpm --filter @openlinear/desktop-ui build` → pass (with `NEXT_PUBLIC_API_URL=http://localhost:3001`)
  - Verify end-to-end flow manually via Playwright:
    - God Mode: Open → toggle Globe → type query → submit → sidebar opens with web search
    - God Mode: Open → click Mic → speak → click Mic → text appears
    - Sidebar: Open → toggle Globe → type query → submit → tasks generated
    - Sidebar: Open → click Mic → speak → click Mic → text appears

  **Must NOT do**:
  - Do NOT fix unrelated issues found during verification
  - Do NOT modify any files in this task (verification only)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Multi-step verification across backend + frontend, needs build + test + E2E
  - **Skills**: [`playwright`]
    - `playwright`: End-to-end UI verification

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3 (sequential after T6+T7)
  - **Blocks**: F1–F4
  - **Blocked By**: Tasks 6, 7

  **References** (CRITICAL):

  **Pattern References**:
  - `apps/desktop-ui/components/god-mode-overlay.tsx` — God Mode UI to test
  - `apps/desktop-ui/components/global-quick-capture.tsx` — Sidebar UI to test

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @openlinear/api typecheck` → exit 0
  - [ ] `pnpm --filter @openlinear/api test` → all pass
  - [ ] `pnpm --filter @openlinear/api build` → exit 0
  - [ ] `pnpm --filter @openlinear/desktop-ui build` → exit 0
  - [ ] God Mode Globe button works end-to-end
  - [ ] God Mode Mic button works end-to-end
  - [ ] Sidebar Globe button works end-to-end
  - [ ] Sidebar Mic button works end-to-end

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Full build pipeline passes
    Tool: Bash
    Preconditions: All previous tasks committed
    Steps:
      1. pnpm --filter @openlinear/api typecheck
      2. pnpm --filter @openlinear/api test
      3. pnpm --filter @openlinear/api build
      4. NEXT_PUBLIC_API_URL=http://localhost:3001 pnpm --filter @openlinear/desktop-ui build
      5. Assert all exit code 0
    Expected Result: Clean build with no errors
    Failure Indicators: Non-zero exit codes, type errors, test failures
    Evidence: .sisyphus/evidence/task-8-build-pipeline.txt

  Scenario: End-to-end God Mode flow
    Tool: Playwright (playwright skill)
    Preconditions: API running on :3001, UI running on :3000, user logged in
    Steps:
      1. Press Option+Space → God Mode opens
      2. Click Globe → active styling
      3. Type "React 19 server components"
      4. Press Enter
      5. Assert sidebar opens with brainstorm in progress
      6. Screenshot
    Expected Result: Full flow from God Mode input to sidebar brainstorm with web search
    Failure Indicators: Any step fails, error messages visible
    Evidence: .sisyphus/evidence/task-8-e2e-god-mode.png

  Scenario: End-to-end sidebar voice typing
    Tool: Playwright (playwright skill)
    Preconditions: App running, microphone permission granted
    Steps:
      1. Click ghost trigger to open sidebar
      2. Click Mic button → recording indicator
      3. Wait 3 seconds (simulate speech)
      4. Click Mic → recording stops, transcription happens
      5. Assert input field has text
      6. Screenshot
    Expected Result: Voice recording → transcription → text in input
    Failure Indicators: No recording indicator, transcription fails, empty input
    Evidence: .sisyphus/evidence/task-8-e2e-voice.png
  ```

  **Commit**: NO (verification only)

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Rejection → fix → re-run.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, curl endpoint, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `tsc --noEmit` + linter + `pnpm --filter @openlinear/api test`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names (data/result/item/temp).
  Output: `Build [PASS/FAIL] | Lint [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real Manual QA** — `unspecified-high` (+ `playwright` skill)
  Start from clean state. Execute EVERY QA scenario from EVERY task — follow exact steps, capture evidence. Test cross-task integration (God Mode → sidebar flow). Test edge cases: empty recording, permission denied, no API key. Save to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff (git log/diff). Verify 1:1 — everything in spec was built (no missing), nothing beyond spec was built (no creep). Check "Must NOT do" compliance. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

| After Task | Message | Files | Verification |
|------------|---------|-------|--------------|
| 1 | `feat(api): add web search support to brainstorm service` | services/brainstorm.ts, routes/brainstorm.ts | typecheck |
| 2 | `feat(api): add /api/transcribe endpoint for Whisper voice typing` | routes/transcribe.ts, app.ts | typecheck |
| 3 | `feat(ui): update brainstorm API client with web search + transcribe` | lib/api/brainstorm.ts, lib/api/index.ts | tsc --noEmit |
| 4 | `feat(ui): wire God Mode Globe and Mic buttons` | components/god-mode-overlay.tsx | tsc --noEmit |
| 5 | `feat(ui): add web search + voice typing to sidebar brainstorm` | components/global-quick-capture.tsx | tsc --noEmit |
| 6 | `feat(ui): update CustomEvent contract with web search flag` | god-mode-overlay.tsx, global-quick-capture.tsx | tsc --noEmit |
| 7 | `test(api): add tests for web search + transcribe endpoints` | __tests__/brainstorm-search.test.ts, __tests__/transcribe.test.ts | vitest run |

---

## Success Criteria

### Verification Commands
```bash
pnpm --filter @openlinear/api typecheck     # Expected: exit 0
pnpm --filter @openlinear/api test          # Expected: all pass
pnpm --filter @openlinear/api build         # Expected: exit 0
pnpm --filter @openlinear/desktop-ui build  # Expected: exit 0
```

### Final Checklist
- [ ] Globe button toggles web search in God Mode + sidebar
- [ ] Mic button records + transcribes in God Mode + sidebar
- [ ] Web search disabled when provider ≠ openai
- [ ] Mic disabled when MediaRecorder unavailable
- [ ] No new npm dependencies added
- [ ] All tests pass
- [ ] All builds pass
- [ ] CustomEvent contract updated with backward compatibility
