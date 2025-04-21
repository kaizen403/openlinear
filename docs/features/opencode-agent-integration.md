# OpenCode Agent Integration

## Overview

OpenLinear integrates with [OpenCode](https://opencode.ai) as its AI execution backend. The sidecar process manages the OpenCode server lifecycle, exposes a model catalog to the desktop UI, and routes task prompts through OpenCode sessions. The integration spans three layers: server management, model catalog, and the desktop UI client.

---

## Architecture

```
Desktop UI (Next.js)
  └── apps/desktop-ui/lib/api/opencode.ts        HTTP client
  └── apps/desktop-ui/components/board/model-selector.tsx  UI

Sidecar (Express)
  └── apps/sidecar/src/routes/opencode.ts        REST routes
  └── apps/sidecar/src/services/opencode.ts      Server lifecycle
  └── apps/sidecar/src/services/opencode-catalog.ts  Model catalog
```

The sidecar owns the OpenCode process. The desktop UI never talks to OpenCode directly — all requests go through the sidecar's `/api/opencode/*` routes.

---

## Implementation Details

### 1. Server Lifecycle (`apps/sidecar/src/services/opencode.ts`)

#### Binary Resolution

`resolveOpencodeBinary()` finds the OpenCode binary in three steps:

1. `OPENCODE_BIN` env var — explicit override for development or custom installs
2. Bundled binary next to the sidecar executable, named with a Tauri target triple:
   - `opencode-aarch64-apple-darwin` (macOS Apple Silicon)
   - `opencode-x86_64-apple-darwin` (macOS Intel)
   - `opencode-aarch64-unknown-linux-gnu` (Linux ARM64)
   - `opencode-x86_64-unknown-linux-gnu` (Linux x64)
3. `opencode` on the system `PATH` — fallback for dev mode

#### Server Startup

`spawnOpencodeServer(bin, hostname, port, timeout)` spawns the binary with:

```
opencode serve --hostname=<host> --port=<port>
```

It watches stdout for the line `opencode server listening on <url>` and resolves the promise with the parsed URL. If the process exits before emitting that line, or the timeout fires, the promise rejects.

#### Reuse Detection

Before spawning, `resolveOpenCodeServerHandle()` probes the preferred port with a short timeout (`OPENCODE_PROBE_TIMEOUT`, default 1500ms). If an existing server responds to `client.config.get()`, the sidecar reuses it without spawning a new process. This handles the case where the user already has OpenCode running.

If the preferred port is busy and the probe fails, the sidecar retries with port `0` (OS-assigned).

#### Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `OPENCODE_BIN` | — | Override binary path |
| `OPENCODE_PORT` | `4096` | Preferred port |
| `OPENCODE_HOST` | `127.0.0.1` | Bind address |
| `OPENCODE_TIMEOUT` | `10000` | Startup timeout (ms) |
| `OPENCODE_PROBE_TIMEOUT` | `1500` | Probe timeout (ms) |

#### Client Factory

`getClientForUser(userId, directory?)` returns an `OpencodeClient` from `@opencode-ai/sdk` pointed at the running server. The optional `directory` parameter sets the working directory for the session — the execution engine passes the cloned repo path here.

#### Shutdown

`shutdownOpenCode()` calls `serverHandle.close()` (which kills the spawned process) and broadcasts `opencode:status: stopped` over SSE. `registerShutdownHandlers()` wires this to `SIGINT`, `SIGTERM`, and `beforeExit`.

---

### 2. Model Catalog (`apps/sidecar/src/services/opencode-catalog.ts`)

The catalog service aggregates provider and model data from the OpenCode SDK into a normalized structure the UI can render directly.

#### Data Flow

```
buildOpenCodeCatalog(userId)
  ├── resolveOpenCodeModelSelection()   reads opencode config + legacy DB setting
  ├── client.provider.list()            all providers + connected set
  ├── client.provider.auth()            auth methods per provider
  └── client.config.providers()         per-provider default models
```

All four calls run in parallel with `Promise.all`.

#### Model Normalization

`normalizeModel(providerId, rawModel, selection, source)` converts the SDK's snake_case fields to camelCase and fills in defaults:

- `tool_call` → `toolCall`
- Missing `name` falls back to `id`
- Missing `status` becomes `'unknown'`
- `isDefault` is `true` when `selection.model === "${providerId}/${model.id}"`

#### Fallback Models

If the `opencode` provider is not returned by the SDK, the catalog injects three free fallback models:

| ID | Name | Reasoning |
|---|---|---|
| `minimix` | Minimix (Free) | No |
| `glm5` | GLM5 (Free) | No |
| `kimik2.5` | KimiK2.5 (Free) | Yes |

These are marked `source: 'fallback'` so the UI can display them differently.

#### Model Selection Resolution

`resolveOpenCodeModelSelection(userId)` determines the active model with a priority chain:

1. `configuredModel` — from `client.config.get()` (source: `'opencode'`)
2. `legacyModel` — from `prisma.settings.executionModel` (source: `'legacy-openlinear'`)
3. `null` (source: `'unset'`)

The `source` field tells the UI where the selection came from, which affects the label shown in the model selector.

#### Setting a Model

`setOpenCodeModelSelection(userId, model)` writes the model to OpenCode config via `client.config.update({ body: { model } })` and clears the legacy `executionModel` field in the database so the two sources don't conflict.

#### Model Reference Format

Models are referenced as `provider/model` strings (e.g., `anthropic/claude-opus-4-5`). `parseModelReference(model)` splits on the first `/` and returns `{ providerID, modelID }` for use in session prompts.

---

### 3. REST Routes (`apps/sidecar/src/routes/opencode.ts`)

All routes are mounted at `/api/opencode` in `app.ts`.

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/status` | None | Server running state |
| `GET` | `/setup-status` | Required | Provider auth summary |
| `GET` | `/providers` | Required | Raw provider list from SDK |
| `GET` | `/providers/auth` | Required | Auth methods per provider |
| `POST` | `/auth` | Required | Set API key for a provider |
| `POST` | `/auth/oauth/authorize` | Required | Start OAuth flow |
| `POST` | `/auth/oauth/callback` | Required | Complete OAuth flow |
| `GET` | `/models` | Required | Full model catalog |
| `GET` | `/catalog` | Required | Full catalog (alias) |
| `GET` | `/config` | Required | Current model selection |
| `POST` | `/config/model` | Required | Set active model |

The OAuth routes resolve the correct method index by scanning the provider's auth methods array for an entry with `type === 'oauth'`, falling back to the client-supplied index.

---

### 4. Desktop UI Client (`apps/desktop-ui/lib/api/opencode.ts`)

The UI client talks to the sidecar at `NEXT_PUBLIC_SIDECAR_URL` (default `http://localhost:3001`).

`getModels()` fetches `/api/opencode/models` and normalizes the response defensively — it handles both `payload.providers` and `payload.catalog.providers` shapes, and normalizes each model through `normalizeModelInfo()` which coerces unknown types rather than throwing.

`normalizeModelSelection()` reads the selection from multiple possible key names (`effective_model`, `effectiveModel`, `configured_model`, `configuredModel`, etc.) to stay compatible across sidecar versions.

---

### 5. Model Selector UI (`apps/desktop-ui/components/board/model-selector.tsx`)

The `ModelSelector` component uses the `useOpenCodeModel` hook from `@/lib/opencode-model-selection`. It renders a shadcn `Select` grouped by provider, with a `reasoning` badge on models that support extended thinking. The selector is disabled while loading or saving, and shows an `AlertCircle` icon on error.

---

## Key Files

| File | Role |
|---|---|
| `apps/sidecar/src/services/opencode.ts` | Binary resolution, server spawn, client factory, shutdown |
| `apps/sidecar/src/services/opencode-catalog.ts` | Model catalog, selection resolution, model writes |
| `apps/sidecar/src/routes/opencode.ts` | REST API surface for the desktop UI |
| `apps/desktop-ui/lib/api/opencode.ts` | HTTP client with response normalization |
| `apps/desktop-ui/components/board/model-selector.tsx` | Model picker UI component |
