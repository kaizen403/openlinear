# FE-03 — Explicit, scoped, expiring trust grants (sandbox preflight)

Date: 2026-10-27. Status: **implemented and locally tested; not committed, not deployed.** No API or schema changes.

Acceptance: *an unavailable sandbox blocks execution; host access needs an explicit scoped trust grant.*

## What changed

| Area | Change |
|---|---|
| Grants store — `apps/sidecar/src/sandbox/trust-grants.ts` | Device-local: `<app data>/trust-grants/grants.json` (atomic rewrite, 0600, dir 0700) and `audit.jsonl` (append-only, 0600, rotated at 1 MiB). A grant has id, project id/name, covered realpaths, reason (10–500 chars), `createdBy`, `createdAt`, `expiresAt` (1–168 h, required), `revokedAt`/`revokedBy`, use count. Audit events: `created`, `revoked`, `used`, `expired` (recorded once, when first observed). A grants file that is not a regular file owned by this user with mode 0600, or does not parse, is ignored (no grant applies) and set aside on the next write. One active grant per user and project; at most 20 active per user. Ended grants are dropped from the file after 30 days; the audit keeps them. `OPENLINEAR_SANDBOX_USER_GRANTS=0` turns stored grants off. |
| Scope — `sandbox/trust-grant-scope.ts` | Checkouts are laid out by run, not project (`<repos>/worktrees/<runId>`, `<repos>/verify/<runId>`). A grant covers those two roots **and** its project: the checkout's run is looked up in the durable run journal (read-only connection; `user_id`, `snapshot_json.projectId`; a follow-up that adopted a worktree resolves to the newest run using it). Unknown run, no project, or an unreadable journal: not covered. |
| Mode — `sandbox/mode.ts` | `resolveSandboxMode(env, now)` (unchanged signature): the environment decides first (`resolveEnvSandboxMode`, previous behaviour, env grant unchanged and takes precedence). Only in enforce mode, only when the **cached preflight failed**, and only if an active grant exists does it return `trusted-host` with a `source: 'store'` grant spanning the active grants. No preflight yet, or a verified sandbox → `enforce` (grants ignored). A failure older than 30 s triggers a background re-check, so a fixed sandbox stops grants from applying. `grantCovers(grant, dir)` (unchanged signature) is the point of use for stored grants: finds the checkout's project+user grant, writes the `used` audit entry (refuses if it cannot), and narrows the grant so attempt metadata and logs name it. Repeated decisions for the same run and kind within 10 min are one use. |
| Routes — `routes/sandbox-grants.ts`, mounted at `/api/sandbox/grants` | `GET /` — sandbox state (`verified` / `unavailable` / `unknown` / `env-grant` / `invalid` / `disabled`, after running the live preflight if needed, ≤ 20 s), the caller's active grants, their last 50 audit entries. `POST /` `{projectId, projectName?, reason, hours}` — session only (PAT → 403 `SESSION_REQUIRED`), only while `unavailable` (`TRUST_GRANT_NOT_NEEDED` / `TRUST_GRANT_NOT_APPLICABLE` / `SANDBOX_CHECK_PENDING` otherwise), zod-validated (`VALIDATION_ERROR`). `POST /:id/revoke` — own grants only (others: 404 `TRUST_GRANT_NOT_FOUND`), idempotent. Authenticated by `requireSidecarAuth`. The app installs the device store when it is built and, if active grants exist, starts the preflight so the first run after a restart already knows the sandbox state. |
| Desktop — Settings → Agents | New `components/settings/sandbox-trust-grants.tsx` card. Unavailable: explains the block, offers "Allow runs without the sandbox for a project…" (project picker, reason, 1 hour / 1 day / 7 days, warning that the agent runs with the user's own permissions, required confirmation checkbox), lists active grants with expiry, use count and Revoke, and recent activity. Verified: "Trust grants aren't needed"; existing grants still listed with Revoke. The sandbox headline uses the live check and stays "Sandbox unavailable" (not "Trusted-host mode") when only project grants are in effect. Client: `lib/api/sandbox-grants.ts`; routing: `/api/sandbox/grants/**` → sidecar; error copy for the new codes. |
| Routing fix | `GET /api/runners` was missing from `SIDECAR_ROUTES`, so the runner catalogue (Settings → Agents, runner picker) went to the cloud API, which has no such route. Added. |

Callers in `runners/shared/sandboxed-process.ts`, `sandbox/opencode-attempts.ts` and `run/verification/executor.ts` are unchanged; tests drive the first and last end to end.

## Tests

- `sandbox/trust-grants.test.ts` (13): creation and file modes, validation, limits, control characters, expiry audited once, revoke (owner only, idempotent), use audit and dedupe, owner-filtered audit with a torn line, insecure/corrupt file ignored and set aside, retention, opt-out.
- `sandbox/trust-grant-mode.test.ts` (14): grant roots resolve to realpaths before the first run; verified sandbox ignores grants; no preflight = enforce; unavailable without grant = enforce; unavailable + covering grant = trusted-host, audited and named; other project / other user / legacy run / no project / outside roots refused; follow-up attribution; expired, revoked and revoked-after-decision refused; unauditable use refused; opt-out and unconfigured inert; env grant unchanged; stale failure re-checked and grants stop once the sandbox works; real `launchRunnerProcess` and verification executor refused without a grant, run on the host under it.
- `routes/sandbox-grants.test.ts` (12): auth on every route, create/list, validation, PAT refused, refused unless unavailable, one per project, own grants only, expiry in the listing, view shape, live status states, store installation.
- Desktop: `sandbox-trust-grants.test.mjs` (8), `agents-section.test.mjs` (+2), `routes.test.mjs` (+cases for runners and grants).

## Limits and follow-ups

- Grants cover runs of the v2 engine only (the legacy engine does not journal a project; its runs stay refused).
- The mode decision is synchronous, so it reads the cached preflight. After the sandbox is fixed, runs of a granted project that start before the background re-check completes (it starts on the first decision ≥ 30 s after the cached failure and takes seconds) still use their grant.
- Project ids are not checked against the control plane at creation (no sidecar endpoint for project access); a grant only ever applies to its creator's own, already-authorized runs of that project.
- The grants query key lives in the component (`['ol','sandbox','grants']`); `lib/query/keys.ts` was not edited.

## Security review fixes (2026-10-27)

An independent review of the trust grants and setup steps (W16a) found one high, two medium and five low issues. Fixed:

- **High: setup steps and checks could reach the host's own services through the egress proxy.**
  - A network allow list could name an IP address, such as `127.0.0.1:4096`. The proxy connected to allowed IP addresses without the loopback / link-local / metadata check that hostnames get.
  - That reached the shared OpenCode server, which ran unsandboxed and without a password and can run commands as the user. The local database, the sidecar and cloud metadata were reachable the same way.
  - Allow lists come from project settings (workspace admins) and from `.openlinear/checks.json` in the repository (honoured by default).
  - Now there are three layers:
    1. Check and setup allow lists refuse IP addresses when they are parsed (`execution-core` `normalizeNetwork`: "use a host name").
    2. The egress proxy refuses an allowlisted IP address in a denied class (`denied-address-<class>`) unless it is built with `allowLocalTargets`. Only the sandbox self-test sets that, because its canary listens on loopback.
    3. The shared OpenCode server now gets a per-launch random password (`OPENCODE_SERVER_PASSWORD`), like the per-attempt servers, and every client sends it.
  - Proved under real Seatbelt: a check whose sealed allow list names a loopback service fails and the service sees no request. With local targets allowed the same check reaches it (`verification.realsandbox.test.ts`).
- **Medium: revoking or expiring a grant did not stop runs it had let start.**
  - The store now tells listeners which runs used a grant (from its audit) when it is revoked or its expiry is recorded. The sidecar cancels the ones still active (`RunService.cancelRuns`, reason "trust grant ended").
  - The store is re-read every 30 s, so expiry is noticed on time.
  - The UI copy says runs are stopped.
- **Low: the grants file is re-checked on read.**
  - A grant is ignored if it is longer than 168 h, created in the future, or has a reason under 10 characters.
  - At most the newest 20 grants per user apply.
  - Reason: an unsandboxed agent runs as the same user and could plant a dormant grant.

Not changed (low):
- The runners' status and resume lookups resolve the sandbox mode globally (`resolveSandboxMode().mode`). There is no isolation impact, because process start re-checks grant coverage.

Tests:
- `trust-grants.test.ts` +3: ended-grant listeners, plausibility, per-user cap.
- `sandbox.unit.test.ts` +1: local IP addresses refused.
- `approvals.service.test.ts` +1: `cancelRuns`.
- `opencode.test.mjs`: the password is sent.
- `verification.test.ts` +1: IP addresses refused.
- Real-sandbox test +1.
