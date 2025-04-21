# npm Package

## Overview

The `openlinear` npm package (`packages/openlinear`) serves two purposes. As a CLI, it launches the pre-built desktop app on macOS and Linux. As a library, it exports TypeScript utilities for execution metadata validation, payload sanitization, and feature flag management used by the OpenLinear platform internals.

---

## Architecture

```
packages/openlinear/
  bin/
    openlinear.js          CLI entry point (Node.js, no build step)
    github-auth.js         GitHub OAuth/device flow commands
  src/
    types/
      execution-metadata.ts  Zod schemas + validation functions
      index.ts               Re-exports
    validation/
      security.ts            Forbidden fields + sanitizePayload
      index.ts               Re-exports
    config/
      feature-flags.ts       Feature flag parsing + rollout logic
      index.ts               Re-exports
    index.ts                 Root re-export
```

The `bin/openlinear.js` file is plain CommonJS and runs directly without compilation. The `src/` tree is TypeScript and compiled to `dist/` before publishing.

---

## Implementation Details

### 1. CLI Launcher (`packages/openlinear/bin/openlinear.js`)

The CLI entry point is a single async `main()` function. It handles three cases:

#### GitHub subcommand

```
openlinear github <login|logout|whoami|status> [--browser|--device]
```

Delegates immediately to `runGitHubAuthCommand` from `./github-auth.js`.

#### Help flag

`--help` or `-h` prints usage and exits.

#### App launch

The launcher searches for the desktop binary in a priority-ordered list:

| Priority | Path | Platform |
|---|---|---|
| 1 | `~/.openlinear/openlinear-linux-x64/openlinear-desktop` | Linux (extracted) |
| 2 | `~/.openlinear/openlinear` | Linux (generic) |
| 3 | `~/.openlinear/openlinear.AppImage` | Linux (AppImage) |
| 4 | macOS bundle via `findMacosBundleBinary()` | macOS |

`findMacosBundleBinary()` checks three bundle locations in order:

1. `~/Applications/OpenLinear.app`
2. `/Applications/OpenLinear.app`
3. `~/.openlinear/OpenLinear.app`

Inside each bundle's `Contents/MacOS/` directory it looks for `OpenLinear` or `openlinear-desktop` first, then falls back to any file that doesn't contain `sidecar` in its name.

If no binary is found, the CLI prints installation instructions and exits with code 1.

#### Linux environment setup

Before spawning on Linux, the launcher sets environment variables to work around WebKit rendering issues:

- `WEBKIT_DISABLE_DMABUF_RENDERER=1` — always set on Linux
- Wayland detection: checks `XDG_SESSION_TYPE === 'wayland'` or `WAYLAND_DISPLAY`
  - If Wayland and no `LD_PRELOAD`: tries to preload `libwayland-client.so` from common paths; falls back to `GDK_BACKEND=x11` + `WEBKIT_DISABLE_COMPOSITING_MODE=1`
  - If X11: sets `WEBKIT_DISABLE_COMPOSITING_MODE=1`
- AppImage: sets `APPIMAGE_EXTRACT_AND_RUN=1`

The app is spawned detached with `stdio: 'ignore'` and `child.unref()` so the CLI process exits immediately after launch.

---

### 2. Execution Metadata Types (`packages/openlinear/src/types/execution-metadata.ts`)

This module defines the shape of data synced between the local agent and the cloud dashboard. It uses Zod for runtime validation.

#### Schema

`ExecutionMetadataSyncSchema` is a strict Zod object (`.strict()` rejects unknown keys):

| Field | Type | Required | Constraints |
|---|---|---|---|
| `version` | `'1.0'` | No | Literal |
| `taskId` | `string` | Yes | — |
| `runId` | `string` | Yes | — |
| `status` | `ExecutionStatus` | Yes | enum |
| `startedAt` | `string` | No | ISO 8601 datetime |
| `completedAt` | `string` | No | ISO 8601 datetime |
| `durationMs` | `number` | No | int, min 0 |
| `branch` | `string` | No | — |
| `commitSha` | `string` | No | — |
| `prUrl` | `string` | No | valid URL |
| `prNumber` | `number` | No | int, positive |
| `outcome` | `string` | No | max 500 chars |
| `errorCategory` | `ErrorCategory` | No | enum |

`ExecutionStatus` values: `pending`, `running`, `completed`, `failed`, `cancelled`

`ErrorCategory` values: `AUTH`, `RATE_LIMIT`, `MERGE_CONFLICT`, `TIMEOUT`, `UNKNOWN`

#### Validation Functions

Three functions cover different call sites:

**`validateExecutionMetadataSync(payload)`** — throws `ZodError` on failure. Use when an invalid payload is a hard error (e.g., internal pipeline).

**`safeValidateExecutionMetadataSync(payload)`** — returns a discriminated union `{ success: true, data } | { success: false, error }`. Never throws. Use when you need to handle errors gracefully.

**`checkExecutionMetadataSync(payload)`** — returns `{ valid: boolean, issues?: string[] }` with human-readable issue strings like `"prUrl: Invalid url"`. Use for logging or UI display.

#### Express Middleware

`validateExecutionMetadataMiddleware()` is a factory that returns an Express middleware function. On success it sets `req.validatedMetadata` (typed as `ExecutionMetadataSync`). On failure it responds `400` with:

```json
{
  "error": "Invalid sync payload",
  "code": "FORBIDDEN_FIELDS | VALIDATION_ERROR",
  "details": [{ "field": "prUrl", "message": "Invalid url" }]
}
```

The `FORBIDDEN_FIELDS` code is used when the Zod error includes `"Unrecognized key"` — this distinguishes attempts to sync forbidden fields from ordinary type errors.

---

### 3. Payload Sanitization (`packages/openlinear/src/validation/security.ts`)

This module enforces the trust boundary between local execution and the cloud sync pipeline.

#### Forbidden Fields

`FORBIDDEN_SYNC_FIELDS` is a readonly const array of 17 field names blocked from cloud sync:

| Category | Fields |
|---|---|
| Raw agent output | `prompt`, `logs`, `toolLogs`, `executionLogs`, `rawOutput`, `diff` |
| Local paths | `repoPath`, `fileContents` |
| Credentials | `accessToken`, `apiKey`, `passwordHash`, `jwt` |
| Runtime internals | `client`, `timeoutId` |
| Environment | `env`, `environment`, `processEnv` |

Note: `security.ts` and `types/execution-metadata.ts` both define `FORBIDDEN_SYNC_FIELDS` and the Zod schema. The `types/` file is the public API; `validation/security.ts` is the implementation backing `openlinear/validation`.

#### `isForbiddenField(field)`

Returns `true` if the field name is in `FORBIDDEN_SYNC_FIELDS`. Uses `Array.includes` with a type assertion.

#### `sanitizePayload(payload)`

Iterates `Object.entries(payload)` and partitions keys into allowed and forbidden:

```typescript
const { sanitized, removed } = sanitizePayload({
  taskId: 'tsk_123',
  accessToken: 'ghp_...',
});
// sanitized → { taskId: 'tsk_123' }
// removed   → ['accessToken']
```

Returns both the clean object and the list of removed keys so callers can log what was stripped.

---

### 4. Feature Flags (`packages/openlinear/src/config/feature-flags.ts`)

Feature flags control the gradual rollout of local execution mode. All flags are parsed from environment variables with safe defaults.

#### Schema

`FeatureFlagsSchema` uses Zod with `.transform()` to convert string env vars to typed values:

| Flag | Env Var | Default | Type |
|---|---|---|---|
| `LOCAL_EXECUTION_ENABLED` | `LOCAL_EXECUTION_ENABLED` | `false` | boolean |
| `SERVER_EXECUTION_ENABLED` | `SERVER_EXECUTION_ENABLED` | `true` | boolean |
| `CANARY_PERCENTAGE` | `CANARY_PERCENTAGE` | `0` | number (0–100) |
| `FORCE_LOCAL_EXECUTION` | `FORCE_LOCAL_EXECUTION` | `false` | boolean |
| `KILL_SWITCH_LOCAL_EXECUTION` | `KILL_SWITCH_LOCAL_EXECUTION` | `false` | boolean |

#### Rollout Logic

`isLocalExecutionEnabled(userId, flags)` applies rules in priority order:

1. Kill switch active → `false` (immediate rollback)
2. Force flag active → `true` (override for all users)
3. `LOCAL_EXECUTION_ENABLED` is `false` → `false`
4. `CANARY_PERCENTAGE >= 100` → `true`
5. `CANARY_PERCENTAGE <= 0` → `false`
6. Hash `userId` to a number, compute `(hash % 100) + 1`, return `true` if `<= CANARY_PERCENTAGE`

The hash function is a simple djb2-style integer hash over the userId string, ensuring consistent per-user bucketing across restarts.

#### Migration Phases

`getMigrationPhase(flags)` maps the current flag state to a named phase:

| Phase | Condition |
|---|---|
| `rollback` | Kill switch active |
| `cutover` | Server execution disabled |
| `canary` | Local enabled, `CANARY_PERCENTAGE > 0` |
| `shadow` | Local enabled, `CANARY_PERCENTAGE === 0` |
| `unknown` | No recognizable state |

#### Validation

`validateFlagConfiguration(flags)` catches two invalid combinations:

- `FORCE_LOCAL_EXECUTION` and `KILL_SWITCH_LOCAL_EXECUTION` both `true` — contradictory
- Both `LOCAL_EXECUTION_ENABLED` and `SERVER_EXECUTION_ENABLED` `false` — no execution mode active

---

## Key Files

| File | Role |
|---|---|
| `packages/openlinear/bin/openlinear.js` | CLI entry point, binary discovery, app launch |
| `packages/openlinear/bin/github-auth.js` | GitHub OAuth and device flow commands |
| `packages/openlinear/src/types/execution-metadata.ts` | Zod schema, types, validation functions, Express middleware |
| `packages/openlinear/src/validation/security.ts` | Forbidden field list, `isForbiddenField`, `sanitizePayload` |
| `packages/openlinear/src/config/feature-flags.ts` | Feature flag parsing, rollout logic, migration phase |
