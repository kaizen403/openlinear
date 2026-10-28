# Ship — make the API image build, the worker run, and PRs gated

**Round:** 1 (2026-10-26) · **Engineer ID:** ship · **Status:** done for the local scope
**Owner constraint (mid-task):** no deployment or Azure work. `.github/workflows/deploy-azure.yml`
is byte-identical to the integration base, and no Azure runbook was written. What that workflow
would need later is in section 7.

## 1. Outcome

- `apps/api/Dockerfile` builds from a clean checkout again. It was verified locally with Docker
  (build, run, smoke). The runtime image has no `node_modules` and runs as uid 10001.
- One image serves two processes: `node dist/index.js` for the API and `node dist/worker.js`
  for the worker. The worker is now built, and it was run in a container against Postgres.
  pg-boss created its queues and executed jobs.
- Background jobs run exactly once. Only one process type runs them, chosen by
  `OPENLINEAR_JOBS_RUNNER` (default `worker`). Inside that process, either pg-boss or the
  interval fallback runs, never both.
- `/readyz` now checks that the database is reachable **and** that every migration shipped in
  the build has been applied. It returns 503 `MIGRATIONS_PENDING` or `DATABASE_UNAVAILABLE`
  using the standard error envelope. `/livez` stays dependency-free.
- `dev.yml` now runs on pull requests to `dev` and `main`. The migration-safety review diffs
  against the real base. A new path-filtered job builds the API image (no push, no registry
  login) and smoke-tests the API and worker containers.

## 2. What changed and why

| File | Change | Why |
|---|---|---|
| `apps/api/Dockerfile` | Rewritten as four stages: `pruner` (`turbo prune @openlinear/api --docker`) → `deps` (frozen install from the pruned manifests) → `build` (Prisma generate + esbuild) → `runtime` (digest-pinned `node:22-bookworm-slim`, `ca-certificates` + `tini`, `dist/` + `prisma/migrations/` only). Non-root `10001:10001`; code owned by root and read-only to the app; only `/app/uploads` (0700) is writable. HEALTHCHECK calls `/livez` through `node -e fetch(...)`, so `curl`/`openssl` are dropped. `OPENLINEAR_MIGRATIONS_DIR=/app/prisma/migrations`. | The old file copied a deleted `packages/types` and omitted `packages/execution-core` (reproduced: `"/packages/types": not found`). `turbo prune` derives the workspace slice from `package.json`, so a new workspace dependency cannot go missing again. The old runtime would also have crashed as non-root: `routes/chat-attachments.ts` runs `mkdirSync('/app/uploads')` at import time, and `/app` was root-owned. |
| `.dockerignore` | Rewritten: secrets section (`**/.env`, `**/.env.*` except `.env.example`, keys/certs, `.npmrc`, `.dev.vars`), build output, `packages/db/generated`, desktop artifacts, non-build directories. Keeps `apps/intro-video/package.json`, because `turbo prune` reads every workspace manifest. | The prune stage copies the whole context. The old file let `.env.dev`/`.env.prod` (gitignored, present on dev machines) into the context. Context is now about 7 MB. |
| `apps/api/esbuild.config.js` | Two entry points, `dist/index.js` and `dist/worker.js`. No externals: every dependency is bundled. | The worker was never built. The previous externals (express, cors, jsonwebtoken, dotenv, zod) forced the image to ship `pnpm deploy --prod` output, measured at **378 MB** (Prisma CLI, Studio, React and PGlite came in as an auto-installed peer of `@prisma/client`). The fully bundled API was verified with no `node_modules` present (section 4). |
| `apps/api/src/worker.ts` | Wiring rewritten. Validates env and resolves `OPENLINEAR_JOBS_RUNNER`. Starts jobs only when the runner is `worker`. Starts the outbox relay only when the event bus is distributed (`REDIS_URL`) and `OPENLINEAR_OUTBOX_RELAY != 0`. Keep-alive timer; a clear "idle" warning when there is nothing to do. 25 s forced-exit guard; `unhandledRejection`/`uncaughtException` logging; `startTelemetry()`. | Previously the worker ran the interval loop **and** pg-boss, and pg-boss always failed (see section 5). Without Redis, a worker relay would claim outbox rows and "deliver" them to an empty SSE client map, so live events would be lost. Without the keep-alive, interval mode exits once the database pool goes idle, because its timers are `unref()`'d. |
| `apps/api/src/jobs/runner.ts` (new) | `resolveJobsRunner()` accepts `worker` (default), `api` or `off` and throws on anything else. `startBackgroundJobs()` returns pg-boss when it starts cleanly, otherwise the interval loop. | One switch, one documented default; the exclusivity lives in one place. |
| `apps/api/src/jobs/index.ts` | Wiring in `startPgBoss` only (job functions unchanged): `createQueue` before `work`/`schedule`; a table of schedules; new `idempotency-prune` queue (`pruneIdempotencyKeys` + `pruneIdempotencyRecords`, `30 * * * *`); `on('error')` listener; a partially started pg-boss is stopped (`graceful: false`) before returning `null`. Handlers take no arguments. | pg-boss v10 requires queues to exist, so `schedule()` threw `Queue session-purge not found` on every start. pg-boss mode must cover everything the interval covers; the two idempotency prunes were missing. Leaving registered workers running beside the fallback would double-run jobs. |
| `apps/api/src/index.ts` | Resolves `OPENLINEAR_JOBS_RUNNER` at boot. Runs `startBackgroundJobs()` only for `api`, and stops it on shutdown. `node:path`. | Explicit switch. API replicas never run job handlers under the default. |
| `apps/api/src/readiness.ts` (new), `app.ts` (`/readyz` only) | Readiness = `SELECT 1` plus "all migration directories shipped in this build are in `_prisma_migrations` (finished, not rolled back)". Extra applied migrations are fine (expand/contract). A positive migration result is cached for 60 s; the ping always runs. A missing history table counts as pending. `/livez`, `/readyz` and `/health` are exempt from the default rate limiter. | A revision deployed before its migration should not take traffic. `/readyz` and `/livez` were already declared in `registry.ts`; no new routes. |
| `apps/api/package.json` | `start:worker` script; package `lint` list adds `src/index.ts`, `src/readiness.ts` and the three new tests. | |
| `.github/workflows/dev.yml` | Adds `pull_request` for `[dev, main]`, keeping push to `dev` and dispatch. Concurrency group `dev-<event>-<PR number or ref>`, cancel-in-progress. `permissions: contents: read`. Migration safety runs `scripts/ci/migration-safety.sh` with base `pull_request.base.sha` or `github.event.before`, with full history. New `changes` job (git-diff path filter) and new `api-image` job: buildx build with `push: false`, `load: true` and a GHA cache; Postgres service; `prisma migrate deploy`; `scripts/ci/smoke-api-image.sh`. | PRs were never checked. The safety review always saw an empty diff (default branch is `dev`). Docker builds were unchecked. |
| `scripts/ci/migration-safety.sh` (new) | The same rules as before (destructive DDL; `CREATE [UNIQUE] INDEX` without `CONCURRENTLY`; `migration-safety: allow` opt-out), applied to `base...head`. Reads contents from the head commit. Warns when an existing migration is edited. Falls back to the last commit, with a warning, when the base is unknown. `--files` mode for local use. | One implementation, reused by any workflow. |
| `scripts/ci/smoke-api-image.sh` (new) | Starts the API and worker containers from one image against a migrated DB. Asserts `/livez` 200, `/readyz` 200 with `migrations:"ok"`, 401 when unauthenticated, `[worker] started` with the worker still running, and exit 0 on SIGTERM for both. Throwaway secrets; always cleans up. | Catches runtime-only failures in CI (bundling, permissions, Prisma). |
| Tests (new) | `readiness.test.ts` (14), `jobs.runner.test.ts` (5), `jobs.pgboss.test.ts` (5) | Readiness logic and HTTP behaviour against the test DB; runner selection and exclusivity; pg-boss wiring order, idempotency queue, job batch never reaching `maxAgeHours`, stop on partial failure. |

## 3. How it behaves now

**Image.** `docker build -f apps/api/Dockerfile .` from the repo root. Default `CMD node dist/index.js`;
the worker is the same image with the command `node dist/worker.js` (`docker run --no-healthcheck … node dist/worker.js`).

**Process roles (env).**

| Variable | API | Worker |
|---|---|---|
| `OPENLINEAR_JOBS_RUNNER` (default `worker`; set the same value on both) | `api` ⇒ runs jobs; otherwise none | `worker` ⇒ runs jobs; `api`/`off` ⇒ idle with a warning |
| `OPENLINEAR_JOBS=0` (existing) | — | forces the interval fallback instead of pg-boss |
| `REDIS_URL` | Redis pub/sub fan-out | enables the worker's outbox relay |
| `OPENLINEAR_OUTBOX_RELAY=0` (existing) | API stops relaying; set it only when Redis is set **and** the worker relays | worker never relays |
| `OPENLINEAR_MIGRATIONS_DIR` | set in the image; dev/test resolve `packages/db/prisma/migrations` from the working directory | — |

Without Redis, as in today's production plan: the API relays, the worker runs jobs only, and
the worker runs as a single replica. Uploads still go to the container's ephemeral disk
(`/app/uploads`). Mount a volume to keep them until attachments move to object storage.

**CI.** For PRs to `dev`/`main` and pushes to `dev`: lint/typecheck plus the migration-safety
diff, tests on migrated Postgres, build, and a path-filtered image build plus smoke. A
`dev` → `main` release PR is checked twice on purpose: the push run checks `dev`, and the PR
run checks the merge with `main`.

## 4. Validation (local; Postgres 14 on 127.0.0.1:54330, private DB `openlinear_ship_test`)

| Command | Result |
|---|---|
| `pnpm typecheck` (root) | 11/11 tasks successful |
| `pnpm lint` (root) | 42 files, no diagnostics (`jobs/runner.ts` is covered by the root `apps/api/src/jobs` entry) |
| `pnpm --filter @openlinear/api lint` | 28 files, clean |
| `TEST_DATABASE_URL=… pnpm --filter @openlinear/api test` | **34 files, 310 passed, 2 skipped** (baseline before changes: 31 files, 286 passed, 2 skipped; +24 new tests; no existing test changed). Ran twice, identical. |
| `pnpm --filter @openlinear/sidecar test` (imports `@openlinear/api/app`) | 38 files, 661 passed (baseline 661) |
| `pnpm --filter @openlinear/api build` | `dist/index.js` 10 MB, `dist/worker.js` 6.8 MB (plus source maps) |
| Workflows | PyYAML parse OK for all four. `actionlint` 1.7.12 (Docker image, with shellcheck): **0 findings** in `dev.yml`, `deploy-azure.yml` (the unchanged base version) and `deploy.yml`. Only pre-existing findings in `release.yml` (SC2012 info ×4; unknown runner label `macos-13`, see section 6). shellcheck is clean on both new scripts. |
| `scripts/ci/migration-safety.sh` | `4862dc7^ 4862dc7` → exit 1 (2 plain `CREATE INDEX`; 1 file skipped via allow). `5018f18^ 5018f18` → exit 1 (`DROP TABLE` + index). `922dbd7 922dbd7` → "No migration changes". Zero or unknown base → falls back to the last commit with a warning. `--files` on the three base-patch migrations → exit 0 (w04a skipped via allow). Synthetic `DROP COLUMN` → 1, `CONCURRENTLY` → 0, plain unique index → 1. |

## 5. Image build proof (Docker Desktop 4.91, linux/arm64)

- **Before:** `docker build -f apps/api/Dockerfile .` → `failed to calculate checksum … "/packages/types": not found`.
- **After:** the build succeeds. Cold build 2 min 8 s (dependency install 104 s, apt 118 s, in parallel). A source-only rebuild reuses the deps layer; a manifest change re-installs (about 105 s).
- **Size:** 411,409,962 bytes content size, against 346,373,948 for the base image in the same store. Added layers: `dist/` 38.9 MB (about 21 MB of it source maps), apt 11.2 MB, migrations 205 kB. Compressed (`docker save | gzip`): 93,962,571 bytes, about 90 MiB.
- **API container** (`--env-file` with throwaway secrets; DB via `host.docker.internal:54330`):
  - Docker reports the container `healthy`.
  - `/livez` 200.
  - `/readyz` 200 `{"database":"ok","migrations":"ok","secrets":"ok"}`.
  - `/health` 200.
  - `GET /api/users/me` returns 401 with no auth and 200 with a PAT seeded in the test DB.
  - `POST /api/workspaces` 201; `GET /api/workspaces` 200.
  - Multipart upload to `/api/chat/attachments` 201 (written as uid 10001); `GET /uploads/<file>` 200.
  - `docker stop` → "SIGTERM received, draining…" → exit 0.
- **Readiness negatives (real image, real DB):**
  - Marking `20261025120000_w04a_idempotency_records` rolled back → 503 `MIGRATIONS_PENDING` with `details.missing` naming it. Restoring the row → 200 on the next probe.
  - DB port closed → `/livez` 200, `/readyz` 503 `DATABASE_UNAVAILABLE`.
- **Worker container** (`node dist/worker.js`):
  - Logs `[jobs] pg-boss started` with six queues, then `[worker] started` with `{"jobs":"pg-boss","outboxRelay":"off"}`.
  - `pgboss.queue`/`pgboss.schedule` hold all six queues and crons.
  - Inserting `session-purge` and `idempotency-prune` jobs → both `completed` within 6 s.
  - SIGTERM → exit 0.
  - `OPENLINEAR_JOBS=0` → `jobs:"interval"`, maintenance ran, still up after 20 s.
  - `OPENLINEAR_JOBS_RUNNER=api` → idle warning, stays up.
  - `OPENLINEAR_JOBS_RUNNER=both` → exit 1 with a clear error.
  - With a local `redis:7-alpine` → `outboxRelay:"on"`, `distributedBus:true`.
- **API with `OPENLINEAR_JOBS_RUNNER=api`:** pg-boss starts in the API, `/readyz` 200, exit 0.
- **`scripts/ci/smoke-api-image.sh`** (`SMOKE_NETWORK=bridge`) against the final image passes. With an unreachable DB it fails with logs and cleans up.

## 6. Decisions and findings

- **`turbo prune` instead of hand-listed COPYs.** It is self-maintaining; its pruned lockfile installs with `--frozen-lockfile`. turbo is pinned at 2.8.9 (the lockfile version) through `pnpm dlx`.
- **No runtime `node_modules`.** All dependencies are bundled, which is about 380 MB smaller and drops the Prisma CLI, Studio and React from production. The bundled API was exercised end to end (auth, Prisma transactions, multer, pg-boss).
- **Finding (pre-existing, not fixed): chat PDF text extraction never works in a bundled build, old or new.** pdfjs needs `DOMMatrix` from the native `@napi-rs/canvas`. A bundled probe throws `ReferenceError: DOMMatrix is not defined`; the same code works from `node_modules`. `services/chat.ts` swallows the error, so PDFs are silently skipped. The fix needs `pdf-parse` external plus its native closure in the image (about 80 MB), or a different extractor. Left for the chat owner.
- **Finding:** before this change pg-boss never ran in any process (missing `createQueue`), and the worker always fell back to the interval by accident.
- **Finding:** `release.yml` uses runner label `macos-13`, which actionlint flags as unknown (the image was retired). I reverted my one-line fix when the owner constraint arrived. Suggested: `macos-15-intel`.
- **Migration check source.** The expected list is read from the image's `prisma/migrations` directory names. A build without the directory reports `migrations:"unchecked"` and stays ready.
- **Docker HEALTHCHECK** targets the API. The worker must run with `--no-healthcheck`.
- **Base-image digest pin** (`sha256:83f487e0…`, multi-arch index, Node 22.23.2, created 2026-08-25) gives reproducible builds. Renovate should bump it. The digest is two months old; bump it before a production release.

## 7. Left to do

Owner-only or future work; none of it was done here.

1. **`deploy-azure.yml` (unchanged by owner decision).** Later it needs:
   - Build and push the image **once**, and deploy by digest.
   - A single `migrate` job between push and rollout that runs `prisma migrate deploy` from the same commit, with a **direct (non-pooled)** URL secret (for example `DIRECT_DATABASE_URL`). Prisma's advisory lock guards overlapping runs.
   - A `deploy-api` job (`--set-env-vars OPENLINEAR_JOBS_RUNNER=worker`, single replica), then wait for `latestReadyRevisionName`, then check `/readyz` on the revision URL and the public URL.
   - A `deploy-worker` job: same digest, command `node`, args `dist/worker.js`, one replica, no ingress. It should check the app exists first.
   - The migration-safety step should call `bash scripts/ci/migration-safety.sh "${{ github.event.before }}"` with `fetch-depth: 0`. Today it is shallow and always sees an empty diff.
   - `timeout-minutes` on every job, and `permissions: contents: read`.
2. **Infrastructure:** create the worker app; configure probes (liveness `/livez`, readiness `/readyz`, startup `/livez`); add a volume or object storage for `/app/uploads`; finish secret rotation (`docs/runbooks/rotate-leaked-secrets.md`) and the out-of-band indexes (`docs/runbooks/apply-hot-path-indexes.md`) before any production rollout.
3. **Root `package.json` `lint` list** (not mine): add `apps/api/src/readiness.ts`, `apps/api/src/index.ts` and the three new test files.
4. When Redis lands: set `OPENLINEAR_OUTBOX_RELAY=0` on the API so only the worker relays. A durable claim/ack (W04b) is still needed before more than one relay is safe.
5. Fix the PDF extraction finding (section 6), bump the `macos-13` runner label, and consider a `trivy` scan on the CI image.

## 8. Merge hazards

- `apps/api/src/worker.ts` imports `startRealtime`, `stopOutboxRelay` (from `events/relay.ts`) and `startEventBus`, `stopEventBus` and `bus.distributed` (from `events/bus.ts`). If the outbox engineer renames these or changes their signatures, update `worker.ts`. It also relies on `startRealtime()` honouring `OPENLINEAR_OUTBOX_RELAY`.
- `apps/api/src/jobs/index.ts`: the W04a base already edited `runScheduledJobs`. My edit is limited to `JOB_NAMES.idempotencyPrune`, the `import type PgBoss` line and `startPgBoss`. Any new job must be added to **both** `runScheduledJobs` and `PG_BOSS_SCHEDULE`.
- `apps/api/src/app.ts`: limiter skip line (`PROBE_PATHS`), `/readyz` handler, one import.
- `apps/api/esbuild.config.js`: externals removed. Anyone adding a dependency with native or asset files must test the bundle (`node dist/index.js` from a directory without `node_modules`).
- `.github/workflows/dev.yml` was wholly restructured. Root `package.json` was not touched.
- `.dockerignore` excludes `docs/`, `tasks/` and `packaging/` from the Docker context. That is harmless to `turbo prune`, but any future Dockerfile that needs them must adjust it.

## Coordinator note — relay wiring superseded by W04b (2026-10-26)

After the W04b durable-outbox merge, relay ownership is a deployment-wide role: `OPENLINEAR_OUTBOX_RELAY = api | worker | off` (default `api`, same value in every container; see `apps/api/src/events/config.ts`). `index.ts` starts `startRealtime({ role: 'api' })`; `worker.ts` starts `startRealtime({ role: 'worker' })` only when the owner is `worker`, and both stop with `stopRealtime()`. API replicas read the commit-ordered stream from Postgres (and Redis when `REDIS_URL` is set), so a worker-owned relay no longer requires Redis. The `OPENLINEAR_OUTBOX_RELAY=0` guidance above is legacy (`0` still means `off` for the process that reads it).
