import { randomUUID } from "node:crypto";
import type { PrismaClient, RtRole, User } from "@/generated/prisma/client";

/** Inserts a Better Auth User row directly (no network, no password). */
export async function createUser(db: PrismaClient, overrides: Partial<User> = {}): Promise<User> {
  const id = overrides.id ?? randomUUID();
  return db.user.create({
    data: { id, name: `User ${id.slice(0, 6)}`, email: `${id}@example.test`, ...overrides },
  });
}

/** A user who is a Buzzify platform admin. */
export async function createPlatformAdmin(db: PrismaClient): Promise<User> {
  const user = await createUser(db);
  await db.rtPlatformAdmin.create({ data: { userId: user.id } });
  return user;
}

/** A subscription plan (active, 3 branches unless overridden). */
export async function createPlan(db: PrismaClient, overrides: { code?: string; maxBranches?: number; active?: boolean } = {}) {
  return db.rtPlan.create({
    data: {
      code: overrides.code ?? "basic",
      name: "Basic",
      maxBranches: overrides.maxBranches ?? 3,
      maxTerminals: 5,
      maxUsers: 10,
      storageMb: 1024,
      aiMonthly: 100,
      active: overrides.active ?? true,
    },
  });
}

/** A business with the named branches, and one staff member per entry of `staff`. */
export async function createBusinessWithStaff(
  db: PrismaClient,
  opts: {
    branches?: string[];
    staff?: { key: string; role: RtRole; branches?: string[]; deactivated?: boolean }[];
  } = {},
) {
  const business = await db.rtBusiness.create({
    data: { name: "Test Business", activityType: "MARKET", defaultCurrency: "IQD", enabledCurrencies: ["IQD"] },
  });
  const branches: Record<string, { id: string }> = {};
  for (const name of opts.branches ?? ["Main"]) {
    branches[name] = await db.rtBranch.create({ data: { businessId: business.id, name } });
  }
  const staff: Record<string, { user: User; staffId: string }> = {};
  for (const s of opts.staff ?? []) {
    const user = await createUser(db);
    const row = await db.rtStaff.create({
      data: {
        businessId: business.id,
        userId: user.id,
        role: s.role,
        deactivatedAt: s.deactivated ? new Date() : null,
        branches: {
          create: (s.branches ?? []).map((n) => ({ branchId: branches[n]!.id })),
        },
      },
    });
    staff[s.key] = { user, staffId: row.id };
  }
  return { business, branches, staff };
}
