# Learnings - Parallel Execution Plan

## Conventions
- Monorepo: pnpm workspaces with `apps/api`, `apps/desktop-ui`, `packages/db`
- API service pattern: export functions from `apps/api/src/services/`, register routes in `apps/api/src/routes/`
- DB: Prisma ORM, schema at `packages/db/prisma/schema.prisma`
- UI: Next.js + Tailwind, Linear dark theme styling
- SSE: `broadcast()` function in execution service for real-time events
- Settings: singleton row with `id = "default"` in Settings table
- Font: Geist (recently changed from Inter)
- Sidebar: neutral tones only, no colorful icons

## Patterns
- Route registration: `app.use('/api/...', router)` in main app
- Prisma generate: `pnpm --filter @openlinear/db db:generate`
- Prisma push: `pnpm --filter @openlinear/db db:push`
- API restart: `lsof -ti :3001 | xargs kill -9 2>/dev/null; cd apps/api && pnpm dev > /tmp/api-output.log 2>&1 &`

## Worktree Service
- Services use `const execAsync = promisify(exec)` and `const REPOS_DIR = process.env.REPOS_DIR || '/tmp/openlinear-repos'`
- Auth URL pattern: `cloneUrl.replace('https://', \`https://oauth2:${accessToken}@\`)`
- Log prefix convention: `[ServiceName]` (e.g. `[Worktree]`, `[Execution]`, `[OpenCode]`)
- Services export functions, not classes
- Bare clones go to `.main` subdir; worktrees branch off from there
- Git porcelain output: lines starting with `worktree ` contain the path
- Empty catch blocks are fine for best-effort cleanup (e.g. merge --abort)
