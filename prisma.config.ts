import { defineConfig } from "prisma/config";
import { guardDatabaseUrl } from "./scripts/local-db";

// Local embedded Postgres by default (see scripts/db.ts). A non-local DATABASE_URL (or
// SHADOW_DATABASE_URL) is refused unless ALLOW_REMOTE_DATABASE=1 is set on purpose (deployments).
const DEFAULT_DATABASE_URL = "postgresql://postgres:postgres@localhost:54329/retails_dev";

const url = guardDatabaseUrl(process.env.DATABASE_URL, process.env) ?? DEFAULT_DATABASE_URL;
// Only needed by `prisma migrate diff --from-migrations` (the CI drift check).
const shadowDatabaseUrl = guardDatabaseUrl(process.env.SHADOW_DATABASE_URL, process.env, "SHADOW_DATABASE_URL");

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: shadowDatabaseUrl ? { url, shadowDatabaseUrl } : { url },
});
