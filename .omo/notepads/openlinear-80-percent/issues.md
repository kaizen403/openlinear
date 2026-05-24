# Issues & Gotchas — openlinear-80-percent

(Append findings during execution. Format: `## [TIMESTAMP] Task: T## — {issue}`)

## [2026-04-30T21:40Z] Task: T2 — shadcn primitives + design tokens

- **NODE_ENV=production was leaked into the shell** — caused pnpm to skip devDependencies on install (`tailwindcss` etc.) and produce cryptic `ERR_PNPM_INCLUDED_DEPS_CONFLICT`. Workaround: `NODE_ENV=development pnpm install`. Fix: orchestrator should `unset NODE_ENV` before invoking sub-agents that need to install deps.
- **node_modules required full wipe** to recover from the dev/prod includedDeps conflict (`rm -rf node_modules apps/*/node_modules packages/*/node_modules && pnpm install`). Cost ~30s.
- **Test page route convention gotcha**: plan said `apps/desktop-ui/app/_dev/primitives/page.tsx` but Next.js treats `_*` folders as private (no route). Renamed to `app/dev-primitives/` for the QA pass, deleted after.
- **Pre-existing T3-WIP errors in workspace at T2 start time**: `lib/api/fetch.ts` (untracked, broken — references undefined `buildHeaders`), `components/board/use-kanban-board.ts` and `app/archived/page.tsx` (modified, broken — reference removed `API_BASE_URL`/`getSidecarApiUrl`). NOT introduced by T2; T3 owns these.
- **Build passes despite tsc errors**: Next.js (with `ignoreBuildErrors: false`) successfully compiled the static pages — the `tsc --noEmit` errors are in dead-code paths the build tree-shakes out. Need T3 to land before tsc is fully green.
- **`pnpm install` triggers `openlinear-cli postinstall` warning** "supports Linux x64 only" (we're on darwin). Harmless but noisy.

## [2026-05-01] Task: T1 — Migration history bootstrap gotcha

- DB tables existed without `_prisma_migrations` (created via `db:push` historically). Running `prisma migrate dev` would prompt for DB reset (data-destructive). Instead used the baseline + manual + `migrate resolve --applied` pattern documented in learnings.md. Future migrations CAN now use `prisma migrate dev` normally because the history table is consistent.
- The auto-generated diff DROPPED the `projects` table (which holds Repository data) instead of renaming. Caught before applying. Manual migration uses `ALTER TABLE RENAME` to preserve all rows.
- `pnpm db:migrate dev --name 80_percent_foundation` (per package.json script) was NOT used — it would have done the data-destructive DROP+CREATE for the rename and prompted for reset. Manual SQL was required.
