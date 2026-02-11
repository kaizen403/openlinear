# Learnings - dual-auth-project-repo

## 2026-02-11 Initial Analysis

### Codebase Structure
- Monorepo with pnpm workspaces and turbo
- API: `apps/api/` - Express backend, runs on port 3001
- Frontend: `apps/desktop-ui/` - Next.js app
- DB: `packages/db/` - Prisma schema + client
- Seed script: `packages/db/prisma/seed.ts` - currently only seeds dummy tasks

### Schema (already correct)
- User: id, githubId? (unique), username (unique), email?, avatarUrl?, accessToken?, passwordHash?, repositories[], teamMemberships[], ledProjects[]
- Project: id, name, description?, status, color, icon?, startDate?, targetDate?, leadId?, repositoryId?, repository? (relation), localPath?, repoUrl?, projectTeams[], tasks[]
- Repository: @@map("projects") - confusing! The table is named "projects" but model is "Repository"

### Auth (already implemented)
- POST /auth/register with bcrypt + zod validation
- POST /auth/login with bcrypt compare
- GET /auth/me with JWT
- GitHub OAuth at /auth/github and /auth/github/callback
- JWT_SECRET from env or default dev secret
- bcryptjs is installed but NOT listed in API package.json (needs adding)
- @types/bcryptjs NOT in devDependencies either

### Frontend Auth
- AuthProvider in hooks/use-auth.tsx wraps entire app via layout.tsx
- Token stored in localStorage
- Token also received via URL query param (from GitHub OAuth callback)
- useAuth hook provides: user, activeRepository, isAuthenticated, logout, refreshUser, refreshActiveRepository
- No login page exists - auth only via sidebar GitHub button

### API Client
- apps/desktop-ui/lib/api.ts has all fetch functions
- getAuthHeader() reads token from localStorage
- createProject does NOT include repoUrl/localPath in its type signature
- getLoginUrl() returns API_URL + /api/auth/github

### Execution Engine
- executeTask() in execution.ts lines 579-726
- Gets repo via: prisma.repository.findFirst({ where: { userId, isActive: true } }) - lines 601-607
- Uses project.cloneUrl, project.name for paths
- cloneRepository, createBranch, commitAndPush helpers
- batch.ts has same pattern at lines 40-43

### UI Libraries
- shadcn/ui components: Dialog, Select, Button, Input, Label, Badge, Checkbox
- Tailwind CSS with custom linear-* theme vars
- lucide-react for icons
- Dark mode theme (class="dark" on html)
- sonner for toasts

### Project Creation (Backend)
- POST /projects in routes/projects.ts already handles repoUrl and localPath
- If repoUrl provided: calls addRepositoryByUrl() to clone and create Repository record
- If localPath provided: stores directly on project
- Schema accepts both via zod validation
