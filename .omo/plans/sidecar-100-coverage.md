# Sidecar 100% Test Coverage Plan

> **Goal:** Push `apps/sidecar` to 100% statements, branches, functions, and lines coverage.
> **Status:** Complete as of 2026-05-23. `cd apps/sidecar && npx vitest run --coverage` reports 17 passing test files, 189 passing tests, and 100% statements / branches / functions / lines. The Vitest config now enforces 100% thresholds.
> **Baseline:** 66.21% stmts / 51.35% branch / 67.88% funcs / 67.67% lines (67 existing tests pass).
> **Test runner:** `cd apps/sidecar && npx vitest run --coverage`
> **Coverage reporter:** `@vitest/coverage-v8@4.0.18` (already installed).
> **Test pattern:** All test files use `.test.mjs` extension. Every test file uses `vi.hoisted()` for mock factories + `vi.mock()` for module-level mocks + dynamic `await import()` for the subject under test. See any existing `.test.mjs` file for the pattern.

---

## 1. Already-Installed / Configuration

- `@vitest/coverage-v8@4.0.18` is installed in `apps/sidecar`.
- Run tests: `cd apps/sidecar && npx vitest run --coverage`
- **Expected final command must show 100% across all four columns.**

---

## 2. Summary of Gaps by File

### 2.1 Small gap files (extend existing test files)

| File | Current coverage | Gap | Existing test file |
|---|---|---|---|
| `src/services/execution/exec.ts` | 100% stmts, 60% branch | Buffer-to-string fallback on lines 36-37 when stdout/stderr is Buffer | `exec.test.mjs` |
| `src/services/delta-buffer.ts` | 93.58% stmts | Idle timer cleanup on line 55 (`setTimeout(() => cleanupDeltaBuffer(taskId), 35 min)`) | `delta-buffer.test.mjs` |
| `src/services/execution-settings.ts` | 100% stmts, 75% branch | `??` operator branches on lines 48-51 — likely needs `null` values in row fields | `execution-settings.test.mjs` |
| `src/services/git-credentials.ts` | 100% stmts, 77.77% branch | Lines 15-18: URL parses successfully but protocol is NOT `http:`/`https:` (e.g. `ftp://`) | `git-credentials.test.mjs` |
| `src/services/execution/agent-run.ts` | 97.5% stmts, 55.17% branch | Line 117: `logger.error` inside `finalize()` catch block | `agent-run.test.mjs` |
| `src/services/execution/git.ts` | 88.46% stmts, 70.37% branch | Lines 135-136 (clone write-access fail path), lines 204-205 (createPullRequest network error catch) | `git.test.mjs` |
| `src/services/execution/recovery.ts` | 91.07% stmts, 66.66% branch | Line 146 (broadcastToTask catch in `markOrphan`), line 154 (outer catch in `markOrphan`), lines 189-190 (`recoverActiveBatches` no-stale path) | `recovery.test.mjs` |
| `src/services/execution/state.ts` | 81.94% stmts, 70% branch | Line ~149 (`getExecutionLogs` empty fallback), line 183 (`updateTaskStatus` catch), line 203 (`persistLogs` catch), line 221 (`eventStreamCleanup` throw) | `state.test.mjs` |
| `src/services/worktree.ts` | 78.61% stmts, 47.5% branch | Lines ~393-394, 406-407 (`mergeBranch` finally fallbacks) | `worktree.test.mjs` |
| `src/routes/execution.ts` | 81.37% stmts | Lines ~97, 210-212, 218 (refresh-pr error paths, /logs error path) | `routes/execution.test.mjs` |

### 2.2 Medium gap files (need targeted new tests in existing test files)

| File | Current coverage | Major uncovered areas | Existing test file |
|---|---|---|---|
| `src/services/execution/lifecycle.ts` | 70.63% stmts, 48.52% branch | Line ~266 (`decryptToken` catch), lines 272-274 (no project found error), line 306 (prompt rejection catch with `isAuth=false`), line ~317 (`cancelTask` abort failure) | `lifecycle.test.mjs` |
| `src/services/execution/exec.ts` | (see above) | Also test `execFileAsync` with custom options object | (same file) |

### 2.3 Large uncovered files (need brand-new test files)

| File | Current coverage | Size | New test file to create |
|---|---|---|---|
| `src/services/opencode.ts` | **6.8% stmts** | 288 lines | `opencode.test.mjs` |
| `src/services/execution/events.ts` | **53.63% stmts, 41.23% branch** | 698 lines | `events.test.mjs` (already exists but very incomplete) |
| `src/index.ts` (sidecar entry) | **0%** | ~170 lines | `index.test.mjs` |

### 2.4 Excluded / no-runtime-code files

| File | Why 0% | Action |
|---|---|---|
| `src/services/execution/index.ts` | Only 3 re-export lines | Add to `vitest.config.ts` coverage `exclude` array |

---

## 3. Detailed Test Specifications

### 3.1 exec.ts — Add 1 test to `exec.test.mjs`

**Current test file:** `apps/sidecar/src/services/execution/exec.test.mjs`

**Gap:** Lines 36-37 — `stdout.toString('utf8')` branch when stdout/stderr is a Buffer.

**Test to add:**
```js
it('coerces Buffer stdout/stderr to utf8 strings', async () => {
  const result = await execFileAsync(
    process.execPath,
    ['-e', 'process.stdout.write("buf"); process.stderr.write("err");'],
    { encoding: 'buffer' },
  );
  expect(result.stdout).toBe('buf');
  expect(result.stderr).toBe('err');
});
```

---

### 3.2 delta-buffer.ts — Add 1 test to `delta-buffer.test.mjs`

**Current test file:** `apps/sidecar/src/services/delta-buffer.test.mjs`

**Gap:** Line 55 — idle timer fires `cleanupDeltaBuffer(taskId)` after `BUFFER_IDLE_TTL_MS` (35 minutes = 2,100,000 ms).

**Test to add (inside `describe('delta buffer', ...)`):**
```js
it('cleans up buffer after idle TTL expires', () => {
  getOrCreateBuffer('task-idle', emit);
  // Timer was started by getOrCreateBuffer via touchBuffer
  expect(emit).not.toHaveBeenCalled();

  vi.advanceTimersByTime(35 * 60 * 1000);

  // Buffer should now be deleted; further appends are no-ops
  appendTextDelta('task-idle', 'hello');
  vi.advanceTimersByTime(800);
  expect(emit).not.toHaveBeenCalled();
});
```

---

### 3.3 execution-settings.ts — Add 1 test to `execution-settings.test.mjs`

**Current test file:** `apps/sidecar/src/services/execution-settings.test.mjs`

**Gap:** `??` default branches on lines 48-51. When `row` has `null` values for `parallelLimit`, `maxBatchSize`, `queueAutoApprove`, `stopOnFailure`, the `??` operator should fall back to `DEFAULTS`. Current tests use `0` which is truthy-falsy but not `null`.

**Test to add:**
```js
it('uses hardcoded defaults when row fields are null', async () => {
  mocks.findUnique.mockResolvedValue({
    parallelLimit: null,
    maxBatchSize: null,
    queueAutoApprove: null,
    stopOnFailure: null,
    conflictBehavior: 'fail',
  });

  await expect(getExecutionSettings('user-1')).resolves.toEqual({
    parallelLimit: 3,
    maxBatchSize: 3,
    queueAutoApprove: false,
    stopOnFailure: false,
    conflictBehavior: 'fail',
  });
});
```

---

### 3.4 git-credentials.ts — Add 1 test to `git-credentials.test.mjs`

**Current test file:** `apps/sidecar/src/services/git-credentials.test.mjs`

**Gap:** Lines 15-18 — `remoteUrl` is provided, `new URL(remoteUrl)` succeeds, but `protocol` is neither `https:` nor `http:` (e.g. `ftp://` or `file://`). Falls through to `// Fall through to GitHub`.

**Test to add:**
```js
it('falls back to GitHub for non-http/https URLs that still parse', () => {
  const config = createGitCredentialConfig('token', 'ftp://example.com/repo.git');
  const credentialsFile = config.args[1].slice('credential.helper=store --file='.length);

  try {
    expect(readFileSync(credentialsFile, 'utf8')).toBe('https://oauth2:token@github.com\n');
  } finally {
    config.cleanup();
  }
});
```

---

### 3.5 agent-run.ts — Add tests to `agent-run.test.mjs`

**Current test file:** `apps/sidecar/src/services/execution/agent-run.test.mjs`

**Gap:** Line 117 — `logger.error` inside `finalize()` catch block. Need to make `logger.error` throw or make the body inside the `try` of `finalize()` throw so the catch runs.

Read `agent-run.ts` to find `finalize()` and determine what mock to manipulate.

**Approach:**
- Mock `logger.error` with `vi.fn()` so you can assert it was called.
- Force the `try` block in `finalize()` to throw (e.g., by making `prisma.agentRun.update` reject).
- Assert `logger.error` was called.

---

### 3.6 git.ts — Add tests to `git.test.mjs`

**Current test file:** `apps/sidecar/src/services/execution/git.test.mjs`

**Gaps:**
- Lines 135-136: `cloneRepository` write-access fail path (occurs when `git` clone succeeds but write check fails).
- Lines 204-205: `createPullRequest` network error catch.

Read `git.ts` to understand the exact code paths. Use `vi.mock()` on `@openlinear/api/logger` to spy on `logger.error`. Force `execFileAsync` to throw in the second case, and force `fs.accessSync` or equivalent write check to throw in the first case.

---

### 3.7 recovery.ts — Add tests to `recovery.test.mjs`

**Current test file:** `apps/sidecar/src/services/execution/recovery.test.mjs`

**Gaps:**
- Line 146: `broadcastToTask` throws inside `markOrphan`.
- Line 154: Outer catch of `markOrphan`.
- Lines 189-190: `recoverActiveBatches` no-stale path (when no stale batches exist).

Read `recovery.ts` to confirm exact functions and mock `broadcastToTask` (from `@openlinear/api/sse`) to throw. The no-stale path likely means mocking `prisma.batch.findMany` to return `[]`.

---

### 3.8 state.ts — Add tests to `state.test.mjs`

**Current test file:** `apps/sidecar/src/services/execution/state.test.mjs`

**Gaps:**
- Line ~149: `getExecutionLogs` empty fallback (returns `[]` or default object when no logs).
- Line 183: `updateTaskStatus` catch block (prisma update fails).
- Line 203: `persistLogs` catch block.
- Line 221: `eventStreamCleanup` throws.

Read `state.ts` for exact function signatures. Mock `prisma` methods to reject, mock logger, assert catch behavior. For `getExecutionLogs` empty path, call it with a taskId that has no logs.

---

### 3.9 worktree.ts — Add tests to `worktree.test.mjs`

**Current test file:** `apps/sidecar/src/services/worktree.test.mjs`

**Gaps:** Lines ~393-394, 406-407 — `mergeBranch` finally fallbacks. These are catch/finally blocks inside the merge logic.

Read `worktree.ts` around those line numbers. Determine which helper function contains them (likely `mergeBranch`). Mock `execFileAsync` or `prisma` to trigger the error paths, assert logger calls or returned errors.

---

### 3.10 routes/execution.ts — Add tests to `routes/execution.test.mjs`

**Current test file:** `apps/sidecar/src/routes/execution.test.mjs`

**Gaps:**
- Line ~97: Error path in refresh-pr route (when `git.ts` `createPullRequest` or `refreshPullRequest` throws).
- Lines 210-212: Error path in `/logs` route.
- Line 218: Additional error handler.

Read `routes/execution.ts`. Use `supertest` (or existing test pattern) to hit those routes. Mock the underlying service to throw, assert 500 status and error JSON shape `{ error: string, code: string }`.

---

### 3.11 lifecycle.ts — Add tests to `lifecycle.test.mjs`

**Current test file:** `apps/sidecar/src/services/execution/lifecycle.test.mjs`

**Gaps:**
- Line ~266: `decryptToken` catch (when decryption of a GitHub token fails).
- Lines 272-274: No project found error (when projectId does not resolve to a project).
- Line 306: Prompt rejection catch with `isAuth=false`.
- Line ~317: `cancelTask` abort failure (when `abortController.abort()` fails or subsequent cleanup throws).

Read `lifecycle.ts` carefully. Mock `decryptToken` from `@openlinear/api/crypto` to throw. Mock `prisma.project.findUnique` to return `null`. For prompt rejection, mock the SSE / prompt function to reject. For cancel, mock `abortController` or the underlying task state so the abort path throws.

---

### 3.12 events.ts — Extend `events.test.mjs` significantly

**Current test file:** `apps/sidecar/src/services/execution/events.test.mjs` (exists but incomplete)

**File:** `apps/sidecar/src/services/execution/events.ts` (698 lines)

**Current coverage:** 53.63% stmts, 41.23% branch.

This is the largest single gap. Read the file and add tests for every uncovered branch. Key uncovered paths (from coverage report):

1. `failExecutionFromEventStream` with **recoverable stream failure** + `hasCommittableChanges=true`.
2. `handleSessionComplete` with:
   - `backgroundTaskRunning=true`
   - `backgroundTaskFailure`
   - `no_changes` (nothing to commit)
   - `no repoInfo` (missing repo metadata)
   - Commit failure
   - Post-execution error
   - `compare-link` path
3. Background task launch/completion/failure/cancellation observers.
4. `session.error` when status is `committing` or `done` (should skip).
5. `session.status` retry type.
6. `message.part.updated` reasoning branch.
7. `tool.error` status.
8. `tool.running` status.
9. `tool.execute.before`, `tool.execute.after`.
10. `file.edited` cases.
11. `subscribeToSessionEvents` error in the subscribe call itself.

**Mock pattern:**
```js
const mocks = vi.hoisted(() => ({
  broadcastToTask: vi.fn(),
  broadcastToTaskById: vi.fn(),
  prisma: { task: { update: vi.fn(), findUnique: vi.fn() }, agentRun: { ... } },
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('@openlinear/api/sse', () => ({
  broadcastToTask: mocks.broadcastToTask,
  broadcastToTaskById: mocks.broadcastToTaskById,
}));

vi.mock('@openlinear/db', () => ({ prisma: mocks.prisma }));
vi.mock('@openlinear/api/logger', () => ({ logger: mocks.logger }));
```

For each event handler, construct the exact event payload shape (read `events.ts` for type definitions) and call the handler, then assert the mocks.

---

### 3.13 opencode.ts — Create `opencode.test.mjs`

**File:** `apps/sidecar/src/services/opencode.ts` (288 lines)
**New test file:** `apps/sidecar/src/services/opencode.test.mjs`

**Current coverage:** 6.8% stmts.

**What it does:** Spawns a Node.js child process (`node` or `opencode` binary), manages its lifecycle, restarts it on crash, exposes `initOpenCode()`, `shutdownOpenCode()`, `getOpenCodeClient()`, `registerShutdownHandlers()`.

**Mockable surfaces:**
- `node:child_process` `spawn` — returns `ChildProcess` (EventEmitter with `.stdout`, `.stderr`, `.kill()`, `.once('exit', ...)`).
- `node:fs` `existsSync` — to resolve binary path.
- `@opencode-ai/sdk` `createOpencodeClient` — returns a mock client.
- `@openlinear/api/sse` `broadcastToAll` — mock function.
- `process.env` values: `OPENCODE_PORT`, `OPENCODE_HOST`, `OPENCODE_BIN`.
- `process.platform`, `process.arch`, `process.execPath`.

**Tests to write:**
1. `initOpenCode()` spawns process, waits for "ready" message, creates client.
2. `initOpenCode()` skips spawn if already running.
3. `initOpenCode()` retries/resets on crash (stdout "error" or process exit).
4. `shutdownOpenCode()` kills process and resets state.
5. `getOpenCodeClient()` returns client when ready, throws when not ready.
6. `registerShutdownHandlers()` registers SIGTERM/SIGINT handlers.
7. Process stdout/stderr parsing logic.
8. Binary resolution logic (`existsSync` branches for platform).

**Mock `ChildProcess` as EventEmitter:**
```js
const cpMock = new EventEmitter();
cpMock.stdout = new EventEmitter();
cpMock.stderr = new EventEmitter();
cpMock.kill = vi.fn(() => true);
cpMock.once = vi.fn((event, cb) => { /* capture cb */ });
vi.mocked(spawn).mockReturnValue(cpMock);
```

---

### 3.14 src/index.ts — Create `index.test.mjs`

**File:** `apps/sidecar/src/index.ts` (~170 lines)
**New test file:** `apps/sidecar/src/index.test.mjs`

**What it does:** `start()`, `closeServer()`, `loadDotenvIfPresent()`, `printOpenCodeSingleTenantBanner()`, shutdown handler. **Auto-invokes `start()` at module level** (bottom of file: `start().catch(...)`), so importing it starts the server. This makes it tricky to test.

**Strategy:**
1. Do NOT import the module directly in tests.
2. Mock `createSidecarApp` to return a fake Express app with `.listen()` that returns a mock Server.
3. Mock `initOpenCode` to resolve immediately.
4. Mock `prisma.$connect`, `prisma.$disconnect`, `prisma.user.count`.
5. Mock `process.on` to capture signal handlers without actually registering them.
6. Use `vi.doMock()` or isolate the module in a `vi.resetModules()` block, then dynamically import inside an async test with mocks already in place.

**Alternatively**, if testing `src/index.ts` is too integration-heavy, **add it to vitest coverage exclude** and document why. But the user asked for 100%, so attempt it.

**Tests:**
1. `loadDotenvIfPresent` — mock `import('dotenv')` to resolve/reject.
2. `closeServer` — with listening server (calls `.close(cb)`) and already-closed server.
3. `start()` flow — mocks for prisma, recovery, opencode, server creation.
4. Shutdown handler — SIGTERM triggers closeServer, prisma disconnect.
5. Multi-user guard — when `userCount > 1` and `OPENLINEAR_ALLOW_SHARED_OPENCODE` not set, exits with code 2.

---

### 3.15 vitest.config.ts — Exclude pure re-export files

**File:** `apps/sidecar/vitest.config.ts` (or create one if it doesn't exist)

Add `coverage.exclude` to ignore `src/services/execution/index.ts` (only re-exports, 3 lines). Also exclude any other files that have no runtime code (type-only files, barrel files).

```ts
test: {
  coverage: {
    exclude: [
      'src/services/execution/index.ts',
      // add others if they are pure re-exports
    ],
  },
}
```

---

## 4. Step-by-Step Execution Order (Recommended for Codex)

**Phase 1 — Quick wins (extend existing tests)**
1. exec.test.mjs → add Buffer test (3.1)
2. delta-buffer.test.mjs → add idle TTL test (3.2)
3. execution-settings.test.mjs → add null-defaults test (3.3)
4. git-credentials.test.mjs → add ftp:// fallback test (3.4)
5. Run `npx vitest run --coverage`, verify all pass.

**Phase 2 — Medium gaps (extend existing tests, needs reading source)**
6. agent-run.test.mjs → add finalize catch test (3.5)
7. git.test.mjs → add clone write-fail + PR network-error tests (3.6)
8. recovery.test.mjs → add markOrphan catches + no-stale batch test (3.7)
9. state.test.mjs → add empty logs, updateTaskStatus catch, persistLogs catch, eventStreamCleanup throw (3.8)
10. worktree.test.mjs → add mergeBranch finally fallbacks (3.9)
11. routes/execution.test.mjs → add refresh-pr error, /logs error (3.10)
12. lifecycle.test.mjs → add decrypt catch, no-project, prompt reject, cancel abort (3.11)
13. Run `npx vitest run --coverage`, verify all pass.

**Phase 3 — Large new test files**
14. Create `opencode.test.mjs` (3.13)
15. Extend `events.test.mjs` significantly (3.12)
16. Create `index.test.mjs` (3.14)
17. Run `npx vitest run --coverage`, verify all pass.

**Phase 4 — Config & final verification**
18. Add `vitest.config.ts` coverage excludes for barrel files (3.15)
19. Run final `npx vitest run --coverage`
20. Verify 100% across stmts/branch/funcs/lines.
21. Update `ISSUES.md` with completion log.

---

## 5. Mock Reference (Copy-Paste Pattern)

Every existing sidecar test uses this exact pattern. Codex must follow it:

```js
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  broadcastToTask: vi.fn(),
  broadcastToTaskById: vi.fn(),
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  // add whatever you need
}));

vi.mock('@openlinear/db', () => ({
  prisma: {
    task: { update: mocks.update, findUnique: mocks.findUnique },
    project: { findUnique: mocks.findUnique },
    // ...
  },
}));

vi.mock('@openlinear/api/sse', () => ({
  broadcastToTask: mocks.broadcastToTask,
  broadcastToTaskById: mocks.broadcastToTaskById,
}));

vi.mock('@openlinear/api/logger', () => ({ logger: mocks.logger }));

// Import the subject AFTER all vi.mock calls
const { someFunction } = await import('./module');
```

**Important:**
- `.test.mjs` extension (not `.test.ts`).
- Use `vi.useFakeTimers()` when testing timers (delta-buffer, any timeout logic).
- Use `vi.useRealTimers()` in `afterEach`.
- Reset mocks in `beforeEach`.

---

## 6. Expected Final Output

```
Coverage report:
 Statements   : 100%
 Branches     : 100%
 Functions    : 100%
 Lines        : 100%
```

All 67+ existing tests must continue to pass. New tests must not break existing ones.

---

## 7. Files to Read for Context

Before writing any test, read the **source file** and the **existing test file** for that module. Here is the mapping:

| Source | Existing Test |
|---|---|
| `apps/sidecar/src/services/execution/exec.ts` | `apps/sidecar/src/services/execution/exec.test.mjs` |
| `apps/sidecar/src/services/delta-buffer.ts` | `apps/sidecar/src/services/delta-buffer.test.mjs` |
| `apps/sidecar/src/services/execution-settings.ts` | `apps/sidecar/src/services/execution-settings.test.mjs` |
| `apps/sidecar/src/services/git-credentials.ts` | `apps/sidecar/src/services/git-credentials.test.mjs` |
| `apps/sidecar/src/services/execution/agent-run.ts` | `apps/sidecar/src/services/execution/agent-run.test.mjs` |
| `apps/sidecar/src/services/execution/git.ts` | `apps/sidecar/src/services/execution/git.test.mjs` |
| `apps/sidecar/src/services/execution/recovery.ts` | `apps/sidecar/src/services/execution/recovery.test.mjs` |
| `apps/sidecar/src/services/execution/state.ts` | `apps/sidecar/src/services/execution/state.test.mjs` |
| `apps/sidecar/src/services/worktree.ts` | `apps/sidecar/src/services/worktree.test.mjs` |
| `apps/sidecar/src/routes/execution.ts` | `apps/sidecar/src/routes/execution.test.mjs` |
| `apps/sidecar/src/services/execution/lifecycle.ts` | `apps/sidecar/src/services/execution/lifecycle.test.mjs` |
| `apps/sidecar/src/services/execution/events.ts` | `apps/sidecar/src/services/execution/events.test.mjs` |
| `apps/sidecar/src/services/opencode.ts` | *(none — create new)* |
| `apps/sidecar/src/index.ts` | *(none — create new)* |

---

*Plan generated: 2026-05-23*
*Target: `apps/sidecar` 100% test coverage*
