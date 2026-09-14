# Backups

Target: nightly `pg_dump` of production Neon into an immutable container in a
**separate** Azure subscription. RPO ≤ 24h, RTO: restore runbook below.

This runbook is the procedure. Provisioning the second subscription and the
immutable account is console work and is not performed from the app repo.

## Restore (rehearse in staging first)

1. Create a new Neon branch or empty Postgres 16 instance.
2. `pg_restore --no-owner` the latest dump.
3. `pnpm --filter @openlinear/db db:migrate:deploy` (should be a no-op if the
   dump is current).
4. Point a staging Container App at the restored URL and hit `/readyz`.
5. Only then consider a production cutover.

Never restore over the live primary.
