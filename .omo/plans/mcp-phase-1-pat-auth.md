# OpenLinear MCP — Phase 1: PAT Auth System + Settings UI

**Effort:** ~2 days  
**Blocks:** All MCP work (Phases 2-4)

---

## 1.1 Prisma Schema Addition

**File:** `packages/db/prisma/schema.prisma`

```prisma
model PersonalAccessToken {
  id          String    @id @default(uuid())
  userId      String
  user        User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  name        String    // user-given label, e.g. "OpenCode MCP"
  tokenHash   String    @unique // sha256 of the actual token
  tokenPrefix String    // first 8 chars for display: "ol_pat_a1b2..."
  scopes      String[]  // e.g. ["projects:write", "tasks:write"]
  lastUsedAt  DateTime?
  expiresAt   DateTime?
  createdAt   DateTime  @default(now())
  revokedAt   DateTime?

  @@index([userId])
  @@index([tokenHash])
  @@map("personal_access_tokens")
}
```

Add to User model:
```prisma
personalAccessTokens PersonalAccessToken[]
```

Token format: `ol_pat_<32-char-random-hex>` (total 40 chars with prefix).

---

## 1.2 PAT Auth Middleware

**File:** `apps/api/src/middleware/auth.ts`

Extend existing `requireAuth` (lines 47-64):

```typescript
// Before JWT check, add:
// 1. Extract token from Authorization: Bearer <token>
// 2. If token starts with "ol_pat_" →
//    a. Hash with sha256
//    b. Look up PersonalAccessToken by tokenHash
//    c. Verify: not revoked (revokedAt is null), not expired (expiresAt > now OR null)
//    d. Check scopes if endpoint requires specific scope
//    e. Set req.userId = pat.userId, req.authSource = 'pat'
//    f. Fire-and-forget: update lastUsedAt
// 3. Else: fall through to existing JWT logic
```

---

## 1.3 PAT CRUD Endpoints

**File:** `apps/api/src/routes/pats.ts` (new)

| Method | Path | Description |
|---|---|---|
| POST | `/api/pats` | Create PAT. Returns full token ONCE. Stores sha256 hash only. |
| GET | `/api/pats` | List user's PATs (prefix, name, scopes, lastUsedAt, createdAt). Never returns full token. |
| DELETE | `/api/pats/:id` | Revoke (sets revokedAt = now). Does NOT hard delete. |

**Zod schema for create:**
```typescript
z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.string()).optional(), // default: all scopes
  expiresAt: z.string().datetime().optional(), // default: never
})
```

**Response on create:**
```json
{
  "id": "uuid",
  "name": "OpenCode MCP",
  "token": "ol_pat_a1b2c3d4e5f6...",
  "prefix": "ol_pat_a1",
  "scopes": ["*"],
  "expiresAt": null,
  "createdAt": "2026-05-21T..."
}
```

---

## 1.4 Settings UI — Personal Access Tokens Page

**File:** `apps/desktop-ui/src/app/settings/tokens/page.tsx` (new)

### Features:
- **Create flow:** Name input + optional expiry picker → POST /api/pats → modal with one-time token reveal + copy button + "You won't see this again" warning.
- **List view:** Table showing name, prefix (`ol_pat_a1b2...`), scopes, last used (relative time), created date.
- **Revoke:** Confirmation dialog → DELETE /api/pats/:id → row shows "Revoked" badge.

### Design notes:
- Follow existing desktop-ui patterns (Next.js 16, shadcn components)
- Match the existing settings page layout
- Token reveal modal: monospace font, select-all on click, auto-dismiss after copy

---

## 1.5 Mount Route

**File:** `apps/api/src/app.ts` (around line 181-195)

```typescript
app.use('/api/pats', requireAuth, patsRouter);
```

---

## 1.6 Migration

```bash
cd packages/db && npx prisma migrate dev --name add-personal-access-tokens
```

---

## Acceptance Criteria

- [ ] `PersonalAccessToken` model in schema, migration applied
- [ ] `POST /api/pats` creates token, returns it once, stores hash
- [ ] `GET /api/pats` lists tokens without revealing full value
- [ ] `DELETE /api/pats/:id` revokes (soft delete)
- [ ] Auth middleware recognizes `ol_pat_*` tokens and resolves userId
- [ ] Revoked/expired tokens return 401
- [ ] Settings UI page: create, list, revoke tokens
- [ ] One-time token reveal with copy-to-clipboard
- [ ] `lastUsedAt` updates on each authenticated request via PAT
