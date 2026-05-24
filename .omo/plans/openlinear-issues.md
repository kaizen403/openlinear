# OpenLinear Issue Plan

---

## Issue 1: Hardcoded Branch List in "Pick Default Branch" Step ✅ COMPLETED

### Summary
The branch picker showed hardcoded branches (`main`, `develop`, `master`, `trunk`) instead of fetching actual branches from the selected repository.

### Fix Applied
- Added `fetchRepoBranches()` API client function in `apps/desktop-ui/lib/api/repos.ts`
- Added `GET /api/repos/:owner/:repo/branches` backend endpoint in `apps/api/src/routes/repos.ts`
- Added `fetchRepoBranches()` service function in `apps/api/src/services/github.ts`
- Added `GitHubBranch` type in `apps/desktop-ui/lib/api/types.ts`
- Modified `BranchStep` in `onboarding-wizard.tsx` to load branches asynchronously
- Replaced hardcoded `getDefaultBranchSuggestions()` with dynamic branch fetching

### Files Modified
- `apps/desktop-ui/components/onboarding/onboarding-wizard.tsx`
- `apps/desktop-ui/lib/api/repos.ts`
- `apps/desktop-ui/lib/api/types.ts`
- `apps/api/src/routes/repos.ts`
- `apps/api/src/services/github.ts`

---

## Issue 2: Thin Fonts Unreadable on Linux ✅ COMPLETED

### Summary
Font rendering on Linux was inconsistent. Very thin weights (`font-thin`, `font-extralight`, `font-light`) and small sizes (`text-[10px]`) appeared almost invisible due to antialiasing artifacts and system font fallback.

### Root Cause
- Anthropic Sans only supports weights 300–800, but Tailwind allows 100–900
- When weights 100/200 are requested, browser falls back to Linux system fonts (DejaVu Sans / Liberation Sans) which render poorly at small sizes with grayscale antialiasing
- `-webkit-font-smoothing: antialiased` forces grayscale AA, worsening the issue on Linux
- `text-linear-text-tertiary` (#6a6a6a) on #111111 background had insufficient contrast

### Fix Applied
- Restricted Tailwind font weights to 300–800 minimum in `tailwind.config.ts`
- Added Linux-specific font stack fallbacks: `Noto Sans`, `DejaVu Sans`, `Liberation Sans`
- Bumped `linear-text-tertiary` from `#6a6a6a` to `#888888` for better contrast
- Replaced all `font-thin` / `font-extralight` / `font-light` usage with `font-normal` (400) or `font-medium` (500)

### Files Modified
- `apps/desktop-ui/tailwind.config.ts`
- `apps/desktop-ui/app/globals.css`
- `apps/desktop-ui/components/onboarding/onboarding-wizard.tsx` (removed thin font classes)
- `apps/landing/app/globals.css`

---

## Issue 3: Team Name & Key Not Editable in Onboarding "Team Ready" Step ✅ COMPLETED

### Summary
When onboarding reached the "Team Ready" step with an existing team, the team name and key were displayed as read-only text. Users could not edit them without leaving the onboarding flow.

### Fix Applied
- Added inline edit mode to `TeamStep` when `team` prop is present
- Added `Edit` button that reveals input fields for name and key
- Added `Save` / `Cancel` actions with validation
- Updated `updateTeam` API type to include `key` field
- Updated backend `PATCH /teams/:id` to regenerate `inviteCode` when key changes
- Updated backend `updateTeamBodySchema` to accept `key` with validation

### Files Modified
- `apps/desktop-ui/components/onboarding/onboarding-wizard.tsx`
- `apps/desktop-ui/lib/api/teams.ts`
- `apps/api/src/routes/teams.ts`
- `apps/api/src/schemas/teams.ts`

---

## Issue 4: Onboarding Timeline Redesign (Slider → Minimal Timeline) ✅ COMPLETED

### Summary
The onboarding step indicator used a slider-style horizontal scroll (`overflow-x-auto`) with tiny bordered pills. It felt cramped, generic, and had a visible scrollbar.

### Fix Applied
Replaced with a clean, minimal timeline:
- **Track**: 3px horizontal line, bg-linear-border, with accent fill that grows as steps complete
- **Nodes**: 28px circles sitting directly on the line, no shadows, no glow, no scale animations
  - Completed: solid accent fill, white checkmark
  - Active: transparent fill with accent border, accent-colored number
  - Upcoming: transparent fill with border-linear-border, muted text
- **Labels**: Static text below each node, color-coded by state (no motion)
- No spring physics, no pulsing rings, no opacity transitions — just simple CSS color transitions

### Files Modified
- `apps/desktop-ui/components/onboarding/onboarding-wizard.tsx` — `StepIndicator` component replaced

---

## Issue 5: Invite Flow — Proper Web-Based Invites with Domain + OAuth ✅ COMPLETED

### Problem
Current invite flow is broken:
- Invite link uses `window.location.origin` (localhost or tauri://localhost in desktop app), not `openlinear.tech`
- "Copy invite link" just copies a code, doesn't actually invite anyone
- No web accept page exists — invitees have nowhere to go
- If invitee doesn't have a GitHub account linked, there's no path to join
- `openlinear.tech` landing page lacks GitHub OAuth, so web users can't sign up

### Current Code (Broken)
`apps/desktop-ui/components/onboarding/onboarding-wizard.tsx` lines ~1088–1108:
```tsx
const inviteLink = typeof window !== "undefined" && inviteCode
  ? `${window.location.origin}/teams?invite=${inviteCode}`  // ← wrong domain in desktop app
  : inviteCode
```

### Requirements

1. **Invite Link Domain**
   - Use `https://openlinear.tech/invite?code={inviteCode}` instead of `window.location.origin`
   - Make domain configurable (env var or build-time constant)

2. **Actual Invitation System**
   - Add `POST /api/teams/:id/invite` endpoint that creates an `Invitation` record
   - `Invitation` model: `id`, `teamId`, `code`, `status` (pending/accepted/expired), `expiresAt`, `createdAt`
   - Rate-limit invite generation
   - ~~Send email invites~~ (moved to future plan)

3. **Web Accept Page**
   - Create `apps/landing/app/invite/page.tsx` (or similar)
   - URL: `https://openlinear.tech/invite?code=KT-ABC123`
   - Reads invite code from query param
   - Calls `GET /api/invite/:code` to validate (check exists, not expired, not accepted)
   - Shows team name, who invited them
   - If user is already authenticated → auto-join team via `POST /api/teams/join`
   - If not authenticated → show GitHub OAuth button → redirect back to accept page after auth → auto-join

4. **GitHub OAuth on openlinear.tech**
   - Add GitHub OAuth login to the landing/marketing site
   - Reuse existing OAuth flow from `apps/api/src/routes/auth.ts`
   - Ensure `GITHUB_REDIRECT_URI` handles both desktop and web callbacks
   - Desktop uses `tauri://localhost` or `https://tauri.localhost` origin
   - Web uses `https://openlinear.tech/api/auth/github/callback`

5. **Download App Prompt for New Users**
   - If invitee accepts invite but doesn't have desktop app installed:
   - After successful web join, show "Download OpenLinear desktop app for full experience" CTA
   - Link to GitHub releases or `openlinear.tech/download`

### Database Changes Needed
```prisma
model Invitation {
  id        String   @id @default(uuid())
  teamId    String
  team      Team     @relation(fields: [teamId], references: [id], onDelete: Cascade)
  code      String   @unique
  email     String?
  status    String   @default("pending") // pending, accepted, expired
  expiresAt DateTime @default(dbgenerated("now() + interval '7 days'"))
  createdAt DateTime @default(now())
  acceptedAt DateTime?
  acceptedBy User?   @relation(fields: [acceptedById], references: [id])
  acceptedById String?
}
```

### API Endpoints Needed
- `POST /api/teams/:id/invite` — Create invitation (owner/admin only)
- `GET /api/invite/:code` — Validate invitation (public, returns team info)
- `POST /api/invite/:code/accept` — Accept invitation (requires auth)

### Frontend Pages Needed
- `apps/landing/app/invite/page.tsx` — Accept invitation landing page
- Update `InviteStep` in onboarding to use correct domain + call new invite API

### Files to Modify (when implemented)
- `apps/desktop-ui/components/onboarding/onboarding-wizard.tsx` — fix invite link domain, call invite API
- `apps/api/src/routes/teams.ts` — add invite creation endpoint
- `apps/api/src/routes/` — add invite accept/validate endpoints (new file)
- `packages/db/prisma/schema.prisma` — add `Invitation` model
- `apps/landing/app/invite/page.tsx` — new accept page
- `apps/landing/app/` — add GitHub OAuth login button somewhere (header or dedicated)
- `apps/api/src/routes/auth.ts` — ensure redirect URI handles web vs desktop

### Effort Estimate
Medium-Large — requires database migration, new API endpoints, new web page, OAuth integration on landing site, and invite flow redesign.

---

---

## Issue 6: Sidebar Collapsed by Default on App Launch ✅ COMPLETED

### Summary
When the app launches (both desktop and web), the navigation sidebar is collapsed by default. Users see only the main content area with a small toggle icon, missing the full navigation context (Home, Inbox, My Issues, Teams, etc.). The sidebar should be visible/opened by default so users immediately see where they are and how to navigate.

### Screenshot
Current state on launch: sidebar is collapsed/minimized. Expected: sidebar fully expanded showing all navigation items.

### Requirements
- Sidebar state should default to `expanded` / `open` on first app launch
- If user explicitly collapses the sidebar, persist that preference (localStorage or settings)
- Respect the user's previous choice on subsequent launches
- Ensure the layout doesn't break when sidebar is open by default (content area should adapt)

### Files to Modify
- `apps/desktop-ui/app/(app)/page.tsx` or layout file containing sidebar — check default state of sidebar component
- `apps/desktop-ui/components/sidebar.tsx` or equivalent sidebar component — likely has `useState(false)` or similar for collapse state
- Look for any `sidebarOpen`, `sidebarCollapsed`, `isOpen` state in sidebar/navigation components

### Effort Estimate
Small — likely a single state default change + localStorage persistence hook.

---

## Issue 7: Replace Project Color Dots & Team Badges with User Avatars ✅ COMPLETED

### Summary
Currently UI shows generic color indicators instead of people:
- **Projects** show a colored dot (`project.color`) next to the project name — looks impersonal and generic
- **Teams** show a colored letter badge (team name's first initial) — doesn't show who owns/runs the team

### Screenshot References
- Image 1: Project list showing "accent-ai" with a purple dot — should show user's avatar instead
- Image 2: Sidebar showing "kaizen403's Team" with a "K" badge — should show team owner's avatar instead

### Requirements

1. **Project List (app/(app)/page.tsx)**
   - Replace the colored dot (`<div style={{ backgroundColor: project.color }}>`) with the current user's avatar
   - Use the `useAuth()` hook to get `user.avatarUrl`
   - Show a small circular avatar (20-24px) instead of the 12px colored dot
   - Fallback to user's initials if no avatar

2. **Team Sidebar (components/layout/sidebar.tsx)**
   - Replace the team key badge (the colored square with team initial letter "K") with the team owner's avatar
   - Team data already includes `members?: TeamMember[]` — find the member with `role: 'owner'`
   - Use `member.user.avatarUrl` for the avatar image
   - Show a small circular avatar (16-20px) instead of the 16px colored badge
   - Fallback to owner user's initials if no avatar
   - If no owner found (edge case), fallback to current team badge behavior

3. **Remove Generic Color Indicators**
   - Don't show `project.color` as a dot anymore — the avatar replaces it entirely
   - Don't show team key letter badges anymore — the owner avatar replaces it entirely
   - The `color` field can still be used elsewhere (project detail page, settings, etc.) but not in these list views

### Data Available
- `Project` type has no direct user field, but `useAuth()` provides current user
- `Team` type has `members?: TeamMember[]` with nested `user: { avatarUrl: string | null, username: string }`
- `TeamMember.role` is `'owner' | 'admin' | 'member'`

### Files to Modify
- `apps/desktop-ui/app/(app)/page.tsx` — project list, replace color dot with user avatar
- `apps/desktop-ui/components/layout/sidebar.tsx` — TeamSection, replace letter badge with owner avatar

### Effort Estimate
Small — no backend changes, just swapping visuals.

---

## Issue 8: macOS Auth Deep-Link & Repo Loading Broken ✅ COMPLETED

### Summary
On macOS, the GitHub OAuth flow did not redirect back into the desktop app after browser authentication. The user authenticated in the browser, but the app never received the auth token via the `openlinear://` deep link. Additionally, even when auth appeared to succeed, GitHub repositories did not appear in the onboarding "Connect repo" step.

### Changes Made

#### 1. Desktop OAuth Browser Bridge Fallback
**File:** `apps/api/src/routes/auth.ts`
- Desktop OAuth now returns a browser bridge page instead of directly redirecting to `openlinear://callback`
- The bridge page attempts `openlinear://callback` and shows a copyable fallback token if the deep link fails
- This provides a manual token paste path for unsigned/ad-hoc macOS builds

#### 2. Manual Callback Token Paste Flow
**File:** `apps/desktop-ui/app/login/page.tsx`
- Added manual callback-token paste flow on the login page
- Users can paste the token from the browser bridge page directly into the app

#### 3. Tauri API Client Routing Fix
**File:** `apps/desktop-ui/lib/api/client.ts`
- Tauri default API calls now use the sidecar URL, matching where desktop OAuth starts
- Ensures the auth flow and subsequent API calls hit the same backend instance

#### 4. GitHub ID Schema Migration
**File:** `packages/db/prisma/schema.prisma`
**Migration:** `packages/db/prisma/migrations/20260517000100_github_user_ids_as_text/migration.sql`
- `User.githubId` changed from `Int?` to `String?`
- GitHub user IDs can exceed 32-bit integer range, causing silent failures before
- String storage handles all GitHub ID formats correctly

#### 5. Desktop Loopback Redirect & Error Surfacing
**File:** `apps/api/src/services/github.ts`
- Sends the desktop loopback `redirect_uri` during token exchange to match the OAuth callback
- Stores GitHub IDs as strings (matching the schema change)
- Surfaces clearer error messages when repo fetch fails (rate limits, auth issues, etc.)

#### 6. Frontend GitHub Connection Check
**File:** `apps/desktop-ui/components/onboarding/onboarding-wizard.tsx`
- Changed `GitHubRepoTab` to use `githubLinked` instead of only `githubId` for connection detection
- More robust check that handles edge cases where `githubId` exists but the token is invalid

### Verification
- `pnpm --filter @openlinear/api typecheck` — passed
- `pnpm --filter @openlinear/desktop-ui typecheck` — passed
- `pnpm --filter @openlinear/db typecheck` — passed
- `pnpm --filter @openlinear/api test -- src/__tests__/auth.test.ts src/__tests__/repos.test.ts` — passed
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml deeplink` — passed
- `git diff --check` — passed

### Remaining Risk
Proper macOS deep-link reliability still needs real Developer ID signing/notarization. This implementation adds a working **fallback** for unsigned/ad-hoc builds, but it does not replace Apple signing. The browser bridge page ensures users can still authenticate even when `openlinear://` deep links are blocked by the OS.

Full DB-backed API tests need a database with the new migration applied; local Postgres was not running during verification.

---

## Completed Issues Summary

| # | Issue | Status |
|---|-------|--------|
| 1 | Hardcoded branch list → dynamic branch fetching | ✅ Done |
| 2 | Thin fonts unreadable on Linux | ✅ Done |
| 3 | Team name/key not editable in onboarding | ✅ Done |
| 4 | Onboarding timeline slider → branded timeline | ✅ Done |
| 5 | Invite flow: proper domain, accept page, OAuth on web | ⏳ Planned |
| 6 | Sidebar collapsed by default → should be open | ⏳ Planned |
| 7 | Replace project color dots & team badges with user avatars | ⏳ Planned |
| 8 | macOS auth deep-link & repo loading broken | ✅ Done |
| 9 | Kanban drag-and-drop: cards disappearing/misplacing during drag | ✅ Done |
| 10 | Pages not scrollable (team settings, etc.) | ✅ Done |
| 11 | Show assignee/creator avatar badge on task cards | ✅ Done |
| 12 | Remove duplicate "Add task" button at bottom of Kanban columns | ⏳ Planned |
| 13 | Remove blue accent focus outline/border from input elements | ⏳ Planned |
| 14 | Fix validation error showing in comments section on task detail | ✅ Done |
| 15 | Onboarding wizard flashes briefly on homepage before project selector | ✅ Done |

---

## Issue 9: Kanban Drag-and-Drop — Cards Disappearing/Misplacing During Drag ✅ COMPLETED

### Summary
Drag-and-drop in the Kanban board is inconsistent. When dragging cards between columns (e.g., from "In Progress" to "Done"), cards appear to go to the wrong place, disappear, or are not visible during the drag operation.

### Symptoms
1. Cards "go somewhere else" when selected for dragging
2. Card not visible when dragging over other columns
3. Inconsistent behavior when dragging from "In Progress" column specifically
4. Card placement after drop does not match where user intended

### Current Implementation
- Library: `@hello-pangea/dnd` v18.0.1 (fork of `react-beautiful-dnd`)
- Board: `kanban-board.tsx` uses `DragDropContext`, `Droppable`, `Draggable`
- State updates: Optimistic update in `updateTaskStatus()` — updates local state immediately, reverts on API failure
- Drag handler: `handleDragEnd()` in `use-kanban-board.ts` — updates task status via API PATCH

### Potential Root Causes
1. **No DragOverlay/Portal**: The library uses the default React portal which may have z-index issues or be clipped by parent containers with `overflow: hidden`
2. **Parent overflow clipping**: The board container uses `overflow-hidden` and `flex` layout — the dragged item (rendered in a portal) may be visually clipped or positioned incorrectly
3. **Optimistic update timing**: The optimistic state update (`setTasks`) happens before the drag animation completes, causing a visual jump
4. **Missing `snapshot.isDragging` styles**: The `TaskCard` receives `isDragging` prop but only changes border/shadow — may need transform/position fixes
5. **Nested flex/grid containers**: The columns use `flex-1 min-h-0` with `overflow-x-auto snap-x` on mobile — complex layout may interfere with drag positioning
6. **Batch group tasks**: The "In Progress" column has special handling for batch tasks (`InProgressBatchGroup`) which may conflict with regular draggable items

### Files Involved
- `apps/desktop-ui/components/board/kanban-board.tsx` — DragDropContext, Droppable, Draggable setup
- `apps/desktop-ui/components/board/use-kanban-board.ts` — `handleDragEnd`, `updateTaskStatus`
- `apps/desktop-ui/components/board/task-card.tsx` — `isDragging` prop, card rendering
- `apps/desktop-ui/components/board/column.tsx` — Column container, droppable area
- `apps/desktop-ui/components/board/in-progress-batch-group.tsx` — Special batch rendering in "In Progress"

### Proposed Fixes
1. Add `overflow: visible` or proper z-index to dragged item portal
2. Ensure `DragDropContext` is not inside a scrollable/clipping container
3. Add proper `snapshot.isDragging` styles with `position: fixed` or transform
4. Delay optimistic state update until drag animation completes (use `onDragEnd` instead of immediate update)
5. Test specifically with batch tasks in "In Progress" column
6. Consider upgrading `@hello-pangea/dnd` or switching to `@dnd-kit/core` if issues persist

### Effort Estimate
Medium — requires understanding the exact visual bug (may need screen recording), testing different fixes.

---

## Issue 10: Pages Not Scrollable (Team Settings, etc.) ✅ COMPLETED

### Summary
Certain pages in the app (e.g., team settings page `/teams/manage`) do not allow scrolling down. The content extends beyond the viewport but there is no scrollbar or scroll functionality.

### Symptoms
- On `/teams/manage` and potentially other settings/admin pages, content is cut off at the bottom
- No scrollbar appears
- User cannot scroll down to see remaining content

### Potential Root Causes
1. **Missing `overflow-y-auto`**: The page container or main layout wrapper may not have vertical scrolling enabled
2. **`h-screen` or `h-full` without overflow**: A parent container may have `height: 100vh` or `height: 100%` but no `overflow-y-auto`, clipping child content
3. **Global `overscroll-behavior: none`**: The `globals.css` sets `overscroll-behavior: none` on `html` and `body` which can interfere with scrolling
4. **Flexbox layout issue**: A flex container may be constraining height without allowing overflow

### Files to Check
- `apps/desktop-ui/app/(app)/teams/manage/page.tsx` — team settings page
- `apps/desktop-ui/app/(app)/layout.tsx` — main app layout
- `apps/desktop-ui/app/globals.css` — global overflow/scroll styles
- Any page-specific layout components

### Proposed Fixes
1. Add `overflow-y-auto` to the main content container in the app layout
2. Ensure pages that extend beyond viewport have scrolling enabled
3. Check if `h-screen` or fixed height containers are clipping content
4. Review `overscroll-behavior` settings — may need to allow scroll on content areas while keeping it on body

### Effort Estimate
Small — likely a single CSS class addition to the layout container.

---

## Issue 11: Show Assignee/Creator Avatar Badge on Task Cards ✅ COMPLETED

### Summary
Add a tiny circular avatar image to the bottom of each task card on the Kanban board, showing the GitHub profile photo of the assignee (or creator if no assignee). This adds a human/personal touch and makes it easy to see who is working on what at a glance.

### Current Card Layout
The task card bottom row (in `task-card.tsx` line 221+) currently shows:
- Task identifier/number
- Due date (if set)
- Execution elapsed time
- Action buttons (Move, Execute, Cancel, Archive)

### Requirements
1. Add a tiny circular avatar (16-18px) at the bottom-left of the card, next to the identifier
2. Show `task.assignee?.avatarUrl` if assignee exists, otherwise `task.creator?.avatarUrl`
3. Fallback to initials if no avatar URL
4. Add a tooltip or title showing the username on hover
5. Keep the existing layout compact — don't expand card height significantly

### Data Available
`Task` type already includes:
```typescript
assignee?: { id: string; username: string; avatarUrl: string | null } | null
creator?: { id: string; username: string; avatarUrl: string | null } | null
```

### Files to Modify
- `apps/desktop-ui/components/board/task-card.tsx` — Add avatar to bottom row

### Reusable Components
- `Avatar`, `AvatarImage`, `AvatarFallback` from `@/components/ui/avatar` (shadcn) — already used in sidebar, user menu, etc.

### Effort Estimate
Small — single component modification, using existing data and existing UI components.

---

## Issue 12: Remove Duplicate "Add Task" Button at Bottom of Kanban Columns ⏳ NOT STARTED

**GitHub Issue:** https://github.com/kaizen403/openlinear/issues/2

### Summary
Each Kanban column currently shows **two** "Add task" buttons:
1. **Top** (header): A `+` icon button in the column header — this opens the task form dialog
2. **Middle** (empty state): An "Add task" button inside the empty state when no tasks exist — this also opens the task form dialog
3. **Bottom** (inline create): An inline "+ Add task" button at the bottom of the column, below all tasks — this opens an inline text input for fast entry

The user wants to **remove the bottom inline "+ Add task" button** (the `InlineAddTask` component), keeping only:
- The `+` button in the column header
- The "Add task" button inside the empty state (which opens the same form)

### Screenshot Reference
Shows 4 columns (All Issues, In Progress, Done, Cancelled), each with:
- Column header with `+` button (top-right)
- Empty state with "Add task" button (center)
- Bottom of column with "+ Add task" button (this is the one to remove)

### Current Implementation
**File:** `apps/desktop-ui/components/board/column.tsx`

The `InlineAddTask` component is rendered at line 95 inside the column's droppable area:
```tsx
{onInlineCreate && <InlineAddTask columnId={id} columnTitle={title} onCreate={onInlineCreate} />}
```

The `InlineAddTask` component (lines 107-181) renders:
- When not editing: a "+ Add task" button at the bottom of the column
- When editing: an inline text input for quick task creation

The `onInlineCreate` prop is passed from `kanban-board.tsx` (line 324):
```tsx
onInlineCreate={(title) => handleInlineCreateTask(column.status, title)}
```

### Proposed Fix
1. **Option A**: Remove `onInlineCreate` prop entirely from all Column usages in `kanban-board.tsx`
   - Simplest — removes the inline add from all columns completely
   
2. **Option B**: Conditionally render `InlineAddTask` only when a column has tasks (not in empty state)
   - More complex — might still show duplicate when going from 1 task to empty
   
3. **Option C**: Change `InlineAddTask` to only appear on hover/focus
   - Keeps functionality but hides until user interacts

**Recommended**: Option A — remove the bottom inline add entirely. The header `+` button and empty-state button provide sufficient ways to add tasks. Users can also use the keyboard shortcut or global quick capture.

### Files to Modify
- `apps/desktop-ui/components/board/kanban-board.tsx` — Remove `onInlineCreate` prop from `Column` components (line 324)
- `apps/desktop-ui/components/board/column.tsx` — Optionally remove `onInlineCreate` from `ColumnProps` interface if no longer used anywhere else

### Effort Estimate
Tiny — single prop removal, ~1-2 lines changed.

---

## Issue 13: Remove Blue Accent Focus Outline/Border from Input Elements ⏳ NOT STARTED

**GitHub Issue:** https://github.com/kaizen403/openlinear/issues/3

### Summary
All interactive elements (inputs, textareas, selects, buttons, etc.) show a bright blue focus outline when focused. The user wants to remove this blue border entirely — it appears on every input box, text area, and interactive element across the app.

### Screenshot Reference
Shows an input field with "Ask anything..." placeholder, surrounded by a bright blue (#1d4ed8) border/outline when focused.

### Root Cause
**File:** `apps/desktop-ui/app/globals.css` (lines 152-163)

```css
/* ── Focus outlines ──────────────────────────────────── */
:focus-visible {
  outline: 1px solid var(--linear-accent);
  outline-offset: -1px;
}

input:focus-visible,
textarea:focus-visible,
select:focus-visible {
  outline: 2px solid var(--linear-accent);
  outline-offset: 1px;
}
```

The `var(--linear-accent)` resolves to `#1d4ed8` (blue) — this is applied globally to all focus-visible elements via CSS `:focus-visible` pseudo-class.

### Potential Approaches

1. **Remove entirely**: Delete or comment out the focus outline rules
   - Pro: Clean look, no blue borders anywhere
   - Con: Loses accessibility — keyboard users can't see which element is focused

2. **Make subtle**: Change to a thin, neutral border (e.g., `outline: 1px solid #3a3a3a` using `linear-border-hover` color)
   - Pro: Maintains accessibility while keeping it understated
   - Con: Still visible, just less prominent

3. **Make transparent**: Use `outline: transparent` or `outline: none`
   - Pro: Completely invisible
   - Con: Worst for accessibility

4. **Use box-shadow instead**: Replace outline with a subtle inset shadow using neutral colors
   - Pro: More control over appearance, can be very subtle
   - Con: Still some visual change on focus

**Recommendation**: Option 2 — keep a focus indicator for accessibility but make it neutral/subtle. Use `border-linear-border-hover` color (`#3a3a3a`) or a thin `linear-text-tertiary` outline instead of the bright blue accent.

### Files to Modify
- `apps/desktop-ui/app/globals.css` — Lines 152-163: Update or remove focus outline rules

### Accessibility Note
If removing the focus outline entirely, ensure there is some other visual indicator for keyboard navigation (e.g., background color change, subtle border). Completely removing focus indicators harms keyboard and screen-reader users.

### Effort Estimate
Tiny — 2-4 lines of CSS changed.

---

## Issue 14: Fix Validation Error Showing in Comments Section on Task Detail ✅ COMPLETED

### Summary
When clicking on a task card from the home page/Kanban board to open the task detail view, a red "validation_error" box appears in the comments section. This is a backend validation error being surfaced in the UI without proper handling.

### Screenshot Reference
Shows task detail view (e.g., "KT-1" — "Set up footer") with a red error box containing raw text "validation_error" in the comments section, above the "No comments yet" message and comment input field.

### Root Cause Analysis

**Backend error format:**
- `ValidationError` class (`apps/api/src/errors.ts`) produces errors with `code: 'VALIDATION_ERROR'` and `statusCode: 400`
- The `fromZod` method wraps Zod validation failures with `error.flatten()` details

**Comments API endpoint:**
- `GET /api/tasks/:taskId/comments` uses `validateQuery(listCommentsQuerySchema)` (line 37 in `comments.ts`)
- The schema validates `page` (coerced number, min 1, default 1) and `pageSize` (coerced number, min 1, max 100, default 50)
- If query parameters are malformed (e.g., non-numeric page/pageSize), Zod validation fails and returns a 400 with `validation_error` message

**Frontend handling:**
The `CommentsThread` component (in `task-detail-view.tsx`) likely shows this raw error without proper formatting or user-friendly messaging.

### Potential Causes
1. **Frontend passing invalid query params**: The comments fetch might be passing `page` or `pageSize` as strings or undefined values that Zod rejects
2. **Raw error display**: The frontend displays the raw error code (`validation_error`) instead of a human-readable message or silently handling it
3. **Missing default query handling**: The frontend may not be providing default page/pageSize values, causing the API to fail

### Files Involved
- `apps/desktop-ui/components/task-detail-view.tsx` — Renders comments section
- `apps/desktop-ui/components/comments-thread.tsx` — Likely fetches and displays comments
- `apps/api/src/routes/comments.ts` — Comments API with query validation
- `apps/api/src/schemas/comments.ts` — `listCommentsQuerySchema`
- `apps/api/src/middleware/validate.ts` — `validateQuery` middleware
- `apps/api/src/errors.ts` — `ValidationError` class

### Proposed Fixes
1. **Ensure frontend sends valid query params**: Always include `page=1` and `pageSize=50` (or appropriate defaults) when fetching comments
2. **Better error display in UI**: Show a user-friendly message like "Failed to load comments" instead of raw `validation_error`
3. **Silently handle validation errors for defaults**: If the API rejects defaults, that's an API bug — but the frontend should still show a friendly error
4. **Check if query params are strings vs numbers**: The Zod schema uses `.coerce.number()` but the frontend might be sending something unexpected

### Effort Estimate
Small — likely a frontend query parameter fix + error message formatting.

---

## Issue 15: Onboarding Wizard Flashes Briefly on Homepage Before Project Selector ✅ COMPLETED

### Summary
Even after completing onboarding and having existing projects, the onboarding wizard (`OnboardingWizard` component) briefly flashes on the homepage for about a second before the app realizes the user has projects and switches to the "Select a project" screen. This creates a jarring visual glitch where the user sees the onboarding flow (Welcome → Connect repo → etc.) flash before seeing their project list.

### Root Cause
**File:** `apps/desktop-ui/app/(app)/page.tsx` (lines 106-133)

The homepage logic:
1. `projects` state starts as an empty array `[]` (line 58)
2. `fetchProjects()` is called in a `useEffect` only after `isAuthenticated` becomes true (lines 65-69)
3. The conditional render at line 108 checks `if (projects.length === 0)` — this is `true` while projects are still loading
4. So the `OnboardingWizard` renders immediately
5. Once `fetchProjects()` resolves (with actual projects), `projects` updates, `projects.length > 0`, and the UI switches to the "Select a project" view (lines 136-204)

**The race condition:**
```
[Auth loads] → [projects = []] → [renders OnboardingWizard] → [fetchProjects resolves] → [projects = [...]] → [renders Select a project]
                                          ↑
                                    Flash happens here (1-2 seconds)
```

### Current Code (Problematic)
```tsx
const [projects, setProjects] = useState<Project[]>([])

useEffect(() => {
  if (!isAuthenticated) return
  fetchProjects().then(setProjects).catch(() => setProjects([]))
}, [isAuthenticated])

// ...

if (!selectedProjectId && !urlProjectId && !urlTeamId) {
  if (projects.length === 0) {  // ← TRUE while loading!
    return <OnboardingWizard ... />
  }
  return <SelectProjectView ... />
}
```

### Proposed Fixes

1. **Add a loading state for projects**
   - Add `const [isProjectsLoading, setIsProjectsLoading] = useState(true)`
   - Set `false` after `fetchProjects()` resolves (success or error)
   - In the render: `if (isProjectsLoading) return <HomePageSkeleton />` or a spinner
   - Only check `projects.length === 0` after loading is complete

2. **Combine with auth loading**
   - The existing `isLoading` from `useAuth()` covers auth state
   - Keep showing `HomePageSkeleton` until BOTH auth AND projects are loaded
   - `if (isLoading || isProjectsLoading) return <HomePageSkeleton />`

3. **Alternative: Delay onboarding check**
   - Only render `OnboardingWizard` if `!isProjectsLoading && projects.length === 0`
   - While loading, show skeleton or nothing

### Files to Modify
- `apps/desktop-ui/app/(app)/page.tsx` — Add `isProjectsLoading` state, update loading condition

### Effort Estimate
Tiny — add a single `useState` boolean and update the conditional render (~3-5 lines).

---

## Issue 16: Sidebar Should Default to Open (Expanded) on App Launch ✅ COMPLETED

**GitHub Issue:** https://github.com/kaizen403/openlinear/issues/4

### Summary
Currently, the sidebar in the desktop app appears to default to a closed/collapsed state when OpenLinear is opened. The user expects the sidebar to always be open by default when the app launches, and only be closed if the user explicitly toggles it off.

### Desired Behavior
- When OpenLinear starts (fresh launch), the sidebar should be **expanded/open** by default
- The sidebar should remain open across sessions unless the user manually closes it
- If the user explicitly closes the sidebar, that preference should be remembered for subsequent launches

### Fix Applied
- `apps/desktop-ui/components/layout/app-shell.tsx` already uses `readStoredBoolean(STORAGE_KEY_OPEN, true)` as the initial state
- The fallback value of `true` ensures the sidebar is open on first launch (no localStorage entry)
- User preference is persisted to `localStorage` via the `useEffect` on `sidebarOpen` changes
- This was originally implemented as part of Issue 6; Issue 16 is the same requirement

### Files Modified
- `apps/desktop-ui/components/layout/app-shell.tsx` — already had correct default (`true`) and persistence logic

---

## Issue 17: Add "+" Button and "Add More Projects" Hint to Project Selector

**GitHub Issue:** https://github.com/kaizen403/openlinear/issues/5

### Summary
The "Select a project" screen currently only shows existing projects with no visible way to add more. Users need a clear CTA to create or connect additional projects.

### Desired Behavior
1. **"+" button**: Add a `+` icon button below the existing project list cards (or as the last item in the list) with text like "Add more" or "New project"
2. **Small badge/hint**: Below the button, add a subtle, compact badge or text note saying something like "You can add more projects anytime" or similar — styled to match the dark theme
3. **Styling**: Must be consistent with existing OpenLinear branding:
   - Dark background (`bg-[#111111]` or similar)
   - Subtle border (`border-white/10` or `border-[#222222]`)
   - Rounded corners (`rounded-md` or `rounded-lg`)
   - Muted text color (`text-linear-text-tertiary` or `#888888`)
   - Hover state with slight lift or brightness change
4. **On click**: Should trigger the same project creation/connect flow as the existing "New Project" option (likely opens the onboarding wizard or a project creation modal)

### Files to Modify
- `apps/desktop-ui/app/(app)/page.tsx` — The project selector view (around lines 136-204 where `SelectProjectView` is rendered)
- Or the `SelectProjectView` component itself if extracted

### Effort Estimate
Small — likely 10-20 lines of JSX + styling, reusing existing button/icon components.

---
