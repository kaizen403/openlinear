import { defineConfig } from "prisma/config";

const shadowDatabaseUrl = process.env.SHADOW_DATABASE_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DATABASE_URL!,
    // Prisma 7 removed the `--shadow-database-url` CLI flag; `migrate diff
    // --from-migrations` (CI drift check) and `migrate dev` read it from here.
    // Must be a separate, disposable database: Prisma resets it on every use.
    ...(shadowDatabaseUrl ? { shadowDatabaseUrl } : {}),
  },
});
