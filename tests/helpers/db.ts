import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";

const LOCAL_TEST_DATABASE_URL = "postgresql://postgres:postgres@localhost:54329/retails_test";

/** Test-only client (never the production singleton); truncates every app table (all but _prisma_migrations) before each test. */
export function useTestDb(): { db: PrismaClient } {
  const connectionString = process.env.TEST_DATABASE_URL ?? LOCAL_TEST_DATABASE_URL;
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  beforeEach(async () => {
    const tables = await db.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    if (tables.length > 0) {
      const list = tables.map((t) => `"public"."${t.tablename}"`).join(", ");
      await db.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    }
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  return { db };
}
