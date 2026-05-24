# Issues - dual-auth-project-repo

- 2026-02-12: api build failed in apps/api/src/routes/repos.ts (AuthUser accessToken expects string, got string | null) when running `pnpm --filter @openlinear/api build`.
