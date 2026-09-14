# Canary vs schema rollback

Traffic rollback and schema rollback are different operations.

## Traffic rollback (safe, fast)

Container Apps multiple-revision mode: shift weight 100% → previous revision.
This does **not** undo a Prisma migration. Use it when the new app is crashing
or returning 5xx with an already-compatible schema.

## Schema rollback (slow, explicit)

1. Snapshot or Neon branch the database **before** `prisma migrate deploy`.
2. If a migration must be undone, restore that snapshot / branch. Do not
   `prisma migrate down` in production.
3. Only then redeploy the previous app revision.

A destructive migration without the snapshot + escape hatch must fail CI
(`docs/runbooks` is the human gate until the lint job exists).
