# Decisions — openlinear-80-percent

## [BOOTSTRAP] Confirmed by user
- **Priority**: Parallel everything (most aggressive)
- **Scope**: Feature-heavy (fix critical bugs + rebrand + 6-10 SaaS features)
- **Trust**: User said "feel free to make any changes you like"
- **Plan execution**: High Accuracy Review path chosen → plan audited and APPROVED

## [BOOTSTRAP] Defaults applied (override if user objects)
- GitHub org migration: `kaizen403/openlinear` → `openlinear/openlinear` (npm `@kaizen403/openlinear-cli` → `@openlinear/cli`) — flagged in T41
- Brand accent: KEEP existing blue `#1d4ed8` as canonical OpenLinear (T37)
- Domain: unify on `openlinear.tech` (T40 fixes 5 `.dev` refs)
- Theme switcher: Dark + System only — light theme deferred (T29)

## [BOOTSTRAP] Out of scope (deferred)
- Tauri Rust changes (no toolchain locally)
- OpenCode binary bundling in container (separate effort)
- Apple Developer cert / notarization (no cert)
- File attachments (needs storage backend)
- Full notifications system (push/email/digest) — only in-app notification stream
- Real 2FA implementation + session management — settings UI hides as "coming soon" (T47)
- Cycles / roadmap / templates / saved views (P2)
- Light theme

## [BOOTSTRAP] Architectural seams introduced
- `apps/desktop-ui/lib/api/fetch.ts` — `apiFetch()` single client wrapper (T3)
- `apps/api/src/services/ownership.ts` — `assertTaskOwned/assertProjectOwned/assertTeamRole/assertCommentOwned` (T7)
- `apps/sidecar/src/services/execution/exec.ts` — `execFileAsync()` shell-safe helper (T6)
- `apps/desktop-ui/lib/design-tokens.ts` — `STATUS_COLORS/PRIORITY_COLORS/SHADOWS` (T2)
- `apps/api/src/services/activity.ts:logActivity()` — activity emission helper (T13)

## [2026-05-01] T7 — Ownership model decisions

- **Personal tasks (teamId=null) remain accessible to any authenticated user** — preserves legacy/no-team flow, doesn't gate every existing user's data behind a migration. Trade-off: all authenticated users see each other's null-team tasks. Acceptable because UI flows always create with a team in the new code.
- **Existence-leak collapse for `assertTeamRole`**: 404 vs 403 distinction sacrificed for security. Documented in OwnershipError JSDoc.
- **Settings made per-user, not deprecated**: plan said "deprecate singleton" but T7 just makes it per-user via `userId @unique` — same behavior, scoped correctly. No client breakage.
- **Labels gain `teamId` (nullable)**: enables per-team labels + shared global labels. Existing labels migrate as global (teamId=null). Composite `@@unique([teamId, name])` allows same name in different teams.
- **Sidecar uses optionalAuth + conditional ownership**: matches T7 spec; allows legacy unauth local-dev to keep working but enforces ownership when token IS present. Production deployments should set `requireAuth` upstream via reverse proxy if needed.
- **Removed `optionalAuth` from team mutation routes**: PATCH/DELETE/member-add/member-remove all switched to `requireAuth`. The previous `optionalAuth` was the most critical bug — anyone could rename/delete teams.

## [2026-05-01] T15 — OpenCode isolation: Path B (document + enforce)

**Decision**: Document single-tenant constraint instead of implementing per-user spawn.

**Why not Path A (per-user OpenCode subprocess)**:
- @opencode-ai/sdk@1.2.5 has no in-process auth namespacing. Auth state lives in `$XDG_DATA_HOME/opencode/auth.json` at process scope.
- Per-user spawn requires THREE coordinated changes: (1) per-user XDG_DATA_HOME directories, (2) port pool, (3) concurrent-process cap (each subprocess ~150–250 MB RAM).
- Primary deployment is Tauri desktop sidecar (one user per machine). Multi-tenant cloud is secondary.
- Out of scope for T15 brief; deserves its own deep task.

**What shipped**:
1. `docs/limitations.md` — full constraint write-up + operator mitigations.
2. `apps/sidecar/src/index.ts` — boot banner (stdout + structured warn) on every start; multi-user DB guard that exits with code 2 unless `OPENLINEAR_ALLOW_SHARED_OPENCODE=1`.
3. `apps/sidecar/src/services/opencode.ts` — `_userId` → `userId` (the param now carries semantic intent for future isolation; `void userId;` marker + comment prevent future maintainers from deleting it under `noUnusedParameters`).

**Failure mode the guard prevents**: Operator deploys a multi-tenant sidecar without realizing User A's OpenAI key is visible to User B via shared `auth.json`.
