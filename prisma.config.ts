import { defineConfig } from "prisma/config";

// Local embedded Postgres by default (see scripts/db.ts). Never point this at a remote
// database from a developer machine.
const DEFAULT_DATABASE_URL = "postgresql://postgres:postgres@localhost:54329/retails_dev";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL },
});
