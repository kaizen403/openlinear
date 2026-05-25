# PRD: User Strengthening — Enterprise-Grade User System

## Introduction

Overhaul OpenLinear's user system from a single-user tool into a full enterprise-grade collaboration platform. This covers authentication hardening, role-based access control, team collaboration, task assignment, notifications, and audit logging. Designed for public launch where strangers sign up, form workspaces, invite teammates, and collaborate with proper security boundaries.

## Goals

- Implement granular RBAC with workspace/team/project scopes
- Add SSO (SAML/OIDC) and 2FA for enterprise security
- Enable email-based invitations with role assignment
- Support task assignment (multiple assignees + watchers)
- Build comprehensive in-app notification system with preferences
- Create audit trail for all destructive/sensitive actions
- Maintain single-user simplicity for solo users (progressive disclosure)

---

## Phase 1: Core User & RBAC Foundation

### US-001: Role hierarchy schema
**Description:** As a platform, I need a role system that maps permissions across workspace → team → project scopes.

**Acceptance Criteria:**
- [ ] New Prisma models: `Role` (name, scope, permissions[]), `WorkspaceMember` (userId, workspaceId, roleId), `TeamMember` (userId, teamId, roleId), `ProjectMember` (userId, projectId, roleId)
- [ ] Default roles seeded: Owner, Admin, Member, Guest (per scope)
- [ ] Permission enum covering: create, read, update, delete, manage_members, manage_roles, execute_agent, manage_billing
- [ ] Migration runs clean against Neon
- [ ] Typecheck passes

### US-002: RBAC middleware with CASL
**Description:** As a developer, I need a permission enforcement layer so every API route checks access before acting.

**Acceptance Criteria:**
- [ ] CASL ability builder that constructs permissions from user's roles across all scopes
- [ ] `requirePermission(action, subject)` middleware factory replacing ad-hoc ownership checks
- [ ] Existing `services/ownership.ts` logic migrated to CASL rules
- [ ] All existing routes continue to work (backward compatible)
- [ ] Unauthorized requests return 403 with `{ error: "Forbidden", code: "FORBIDDEN" }`
- [ ] Typecheck passes
- [ ] Existing tests pass

### US-003: User profile management
**Description:** As a user, I want to manage my profile (display name, avatar, email) so teammates can identify me.

**Acceptance Criteria:**
- [ ] `PATCH /api/users/me` endpoint (displayName, avatarUrl, email)
- [ ] Profile page in settings UI with editable fields
- [ ] Avatar displayed in sidebar, comments, and task assignments
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-004: Workspace invitation system
**Description:** As a workspace owner, I want to invite users by email so they can join my workspace with a specific role.

**Acceptance Criteria:**
- [ ] New model: `Invitation` (email, workspaceId, teamId?, roleId, token, status, expiresAt, invitedById)
- [ ] `POST /api/workspaces/:id/invitations` — creates invitation, sends email (or generates link for now)
- [ ] `POST /api/invitations/:token/accept` — creates membership, marks invitation used
- [ ] Invitation expires after 7 days
- [ ] Duplicate email to same workspace prevented
- [ ] Pending invitations listed in workspace settings
- [ ] Revoke invitation endpoint
- [ ] Typecheck passes

### US-005: Team member management UI
**Description:** As a team admin, I want to add/remove members and change their roles from the UI.

**Acceptance Criteria:**
- [ ] Team settings page with member list (avatar, name, role, joined date)
- [ ] "Add member" button — searches existing workspace members
- [ ] Role dropdown per member (Owner/Admin/Member/Guest)
- [ ] Remove member with confirmation dialog
- [ ] Only users with `manage_members` permission see controls
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

---

## Phase 2: Task Assignment & Collaboration

### US-006: Task assignment model (multiple assignees + watchers)
**Description:** As a user, I want to assign tasks to team members and watch tasks I care about.

**Acceptance Criteria:**
- [ ] New models: `TaskAssignee` (taskId, userId, role: 'assignee' | 'watcher')
- [ ] `PATCH /api/tasks/:id` accepts `assigneeIds[]` and `watcherIds[]`
- [ ] Bulk assign via `POST /api/tasks/bulk` supports assignees
- [ ] Assignees receive notifications on task status changes
- [ ] Watchers receive notifications but aren't "responsible"
- [ ] Backward compatible — tasks without assignees still work
- [ ] Typecheck passes

### US-007: Assignee picker UI
**Description:** As a user, I want to pick assignees when creating or editing a task.

**Acceptance Criteria:**
- [ ] Assignee picker component (searchable dropdown of team members)
- [ ] Shows avatar + name, supports multi-select
- [ ] Available in: task creation form, task detail drawer, board card quick-actions
- [ ] "Assign to me" shortcut button
- [ ] Keyboard shortcut `A` on selected task opens assignee picker
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-008: Filter and group by assignee
**Description:** As a user, I want to filter the board by assignee so I can see my tasks or a teammate's tasks.

**Acceptance Criteria:**
- [ ] Filter bar on board with assignee multi-select
- [ ] "My tasks" quick filter (pre-selects current user)
- [ ] URL param persistence (`?assignee=userId1,userId2`)
- [ ] Group-by-assignee view option (swim lanes per person)
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-009: @Mentions in comments
**Description:** As a user, I want to @mention teammates in comments to notify them.

**Acceptance Criteria:**
- [ ] `@` trigger in comment composer shows member autocomplete
- [ ] Mentioned users stored as `CommentMention` (commentId, userId)
- [ ] Mentioned users receive notification
- [ ] Mentions rendered as clickable chips in comment display
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

---

## Phase 3: Notifications

### US-010: Notification preferences
**Description:** As a user, I want to control which notifications I receive so I'm not overwhelmed.

**Acceptance Criteria:**
- [ ] New model: `NotificationPreference` (userId, eventType, channel, enabled)
- [ ] Event types: task_assigned, task_status_changed, task_commented, mentioned, invitation_received
- [ ] Settings page with toggle grid (event × channel)
- [ ] Default: all in-app notifications enabled
- [ ] Preferences respected by notification creation logic
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-011: Enhanced notification inbox
**Description:** As a user, I want a proper notification inbox with mark-read, filters, and bulk actions.

**Acceptance Criteria:**
- [ ] `GET /api/notifications` with pagination, `?read=false` filter, `?type=` filter
- [ ] `PATCH /api/notifications/:id` — mark read/unread
- [ ] `POST /api/notifications/mark-all-read`
- [ ] Notification bell in header with unread count badge
- [ ] Dropdown panel showing recent notifications grouped by time
- [ ] Click notification navigates to relevant task/comment
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-012: Real-time notification delivery
**Description:** As a user, I want notifications to appear instantly without refreshing.

**Acceptance Criteria:**
- [ ] Existing SSE stream (`/api/events`) delivers `notification:new` events
- [ ] Client updates unread count + shows toast for high-priority notifications
- [ ] Toast auto-dismisses after 5s, click navigates to source
- [ ] No polling — pure SSE push
- [ ] Typecheck passes

---

## Phase 4: Security Hardening

### US-013: Two-factor authentication (TOTP)
**Description:** As a security-conscious user, I want to enable 2FA so my account is protected even if my password leaks.

**Acceptance Criteria:**
- [ ] New model fields: `User.totpSecret`, `User.totpEnabled`, `User.backupCodes[]`
- [ ] Setup flow: generate secret → show QR → verify code → enable
- [ ] Login flow: after OAuth, if 2FA enabled, prompt for TOTP code before issuing JWT
- [ ] Backup codes (8 single-use codes) generated on setup
- [ ] Disable 2FA requires current TOTP code
- [ ] Settings UI for setup/disable
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-014: SSO / OIDC provider support
**Description:** As an enterprise admin, I want to configure SSO so my team authenticates via our identity provider.

**Acceptance Criteria:**
- [ ] New model: `SSOConfig` (workspaceId, provider: 'saml' | 'oidc', metadata, clientId, clientSecret, enabled)
- [ ] `POST /api/workspaces/:id/sso` — configure SSO (Owner only)
- [ ] Login flow detects email domain → redirects to SSO if configured
- [ ] OIDC authorization code flow implemented (Google Workspace, Okta, Azure AD)
- [ ] Auto-provision users on first SSO login (create User + WorkspaceMember)
- [ ] Workspace setting: "Require SSO" (disables password login for members)
- [ ] Typecheck passes

### US-015: Audit log
**Description:** As a workspace owner, I want an audit trail of all sensitive actions for compliance and debugging.

**Acceptance Criteria:**
- [ ] New model: `AuditLog` (id, workspaceId, actorId, action, resourceType, resourceId, metadata, ipAddress, timestamp)
- [ ] Logged actions: member_added, member_removed, role_changed, task_deleted, project_deleted, sso_configured, invitation_sent, settings_changed
- [ ] Append-only (no UPDATE/DELETE on audit_logs table)
- [ ] `GET /api/workspaces/:id/audit-log` with pagination, date range filter, actor filter, action filter
- [ ] UI: table view in workspace settings (Owner/Admin only)
- [ ] Retained for 1 year minimum
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-016: Session management
**Description:** As a user, I want to see and revoke active sessions so I can secure my account if a device is lost.

**Acceptance Criteria:**
- [ ] New model: `Session` (userId, token, deviceInfo, ipAddress, lastActiveAt, createdAt, revokedAt)
- [ ] Settings page shows active sessions (device, IP, last active, created)
- [ ] "Revoke" button per session, "Revoke all other sessions" bulk action
- [ ] Revoked sessions immediately invalid (token blacklist or DB check)
- [ ] Current session highlighted
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

---

## Functional Requirements

- FR-1: Roles are hierarchical: Owner > Admin > Member > Guest. Higher roles inherit all lower permissions.
- FR-2: A workspace must always have at least one Owner. Transferring ownership requires confirmation.
- FR-3: Permission checks happen at the middleware layer before any route handler logic executes.
- FR-4: Task assignment creates a notification for the assignee.
- FR-5: Watchers are notified on: status change, new comment, assignee change.
- FR-6: @mentions trigger notifications regardless of notification preferences (cannot be muted).
- FR-7: 2FA is per-user, not per-workspace. Workspace admins can require it via policy.
- FR-8: Audit logs are immutable. No API endpoint allows deletion.
- FR-9: SSO auto-provisioned users get "Member" role by default.
- FR-10: Invitation tokens are cryptographically random (32 bytes hex), single-use, expire in 7 days.
- FR-11: All permission/role changes are audit-logged.
- FR-12: Guest role can view tasks but cannot create, edit, delete, or execute agents.

---

## Non-Goals (Out of Scope)

- Email notifications (in-app only for now, channel infrastructure planned but not wired)
- Slack/Discord webhook integrations
- Custom permission definitions (fixed role→permission mapping)
- Organization-level billing or seat management
- SCIM provisioning
- Custom fields on user profiles
- User groups/departments beyond teams
- API rate limiting per user/role (existing rate limiter stays as-is)

---

## Technical Considerations

- **CASL** (`@casl/ability` + `@casl/prisma`) for permission enforcement — allows Prisma query filtering by permission
- **TOTP**: Use `otpauth` or `speakeasy` library for TOTP generation/verification
- **Audit logs**: Append-only table, consider partitioning by month if volume grows. Index on (workspaceId, timestamp).
- **SSO/OIDC**: Use `openid-client` library. Store encrypted client secrets (AES-256-GCM with `JWT_SECRET` derived key).
- **Session tokens**: Stored as SHA-256 hash (same pattern as PATs). Device info from User-Agent parsing.
- **Migration strategy**: All new tables are additive. No breaking changes to existing schema. Feature flags for SSO/2FA (off by default).
- **Performance**: Cache CASL abilities per request (build once in middleware, attach to `req`). Don't cache across requests — permissions can change.

---

## Success Metrics

- Users can invite teammates and collaborate within 2 minutes of workspace creation
- Permission violations caught at API layer with zero leaked data
- 2FA setup completes in under 60 seconds
- Audit log query returns results in < 500ms for 100k entries
- Notification delivery latency < 1 second (SSE push)
- Zero regression in existing single-user workflows

---

## Open Questions

1. Should we support "workspace-level" 2FA enforcement (admin requires all members to enable)?
2. OIDC: which providers to support at launch? (Google Workspace + Okta covers 80% of enterprise)
3. Should watchers auto-include the task creator?
4. Audit log retention: hard delete after 1 year, or archive to cold storage?
5. Guest users: can they be invited to specific projects only, or always workspace-wide?

---

## Implementation Order

| Phase | Stories | Dependencies |
|-------|---------|-------------|
| 1 — Foundation | US-001 → US-002 → US-003 → US-004 → US-005 | None (greenfield) |
| 2 — Collaboration | US-006 → US-007 → US-008 → US-009 | Phase 1 (roles + members) |
| 3 — Notifications | US-010 → US-011 → US-012 | Phase 2 (assignment triggers notifications) |
| 4 — Security | US-013 → US-014 → US-015 → US-016 | Phase 1 (roles for audit/SSO enforcement) |

Phases 3 and 4 can run in parallel after Phase 2.
