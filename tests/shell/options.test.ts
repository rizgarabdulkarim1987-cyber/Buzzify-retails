import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { listMemberships } from "@/server/framework/memberships";
import { shellOptions } from "@/server/shell/options";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createPlan } from "../helpers/fixtures";

const { db } = useTestDb();

const DAY = 86_400_000;

async function activate(client: PrismaClient, businessId: string) {
  if (!(await client.rtPlan.findUnique({ where: { code: "basic" } }))) await createPlan(client);
  const now = Date.now();
  await client.rtSubscription.create({
    data: {
      businessId,
      planCode: "basic",
      status: "ACTIVE",
      currentPeriodStart: new Date(now - DAY),
      currentPeriodEnd: new Date(now + 30 * DAY),
    },
  });
}

async function terminal(businessId: string, branchId: string, name: string, active = true) {
  const location = await db.rtLocation.create({ data: { businessId, branchId, name: `${name} store` } });
  return db.rtTerminal.create({ data: { businessId, branchId, locationId: location.id, name, active } });
}

async function shop() {
  const s = await createBusinessWithStaff(db, {
    branches: ["A", "B", "Closed"],
    staff: [
      { key: "owner", role: "OWNER" },
      { key: "cashierA", role: "CASHIER", branches: ["A"] },
      { key: "gone", role: "CASHIER", branches: ["A"], deactivated: true },
    ],
  });
  await db.rtBranch.update({ where: { id: s.branches.Closed!.id }, data: { active: false } });
  await activate(db, s.business.id);
  const tA = await terminal(s.business.id, s.branches.A!.id, "Till A1");
  await terminal(s.business.id, s.branches.A!.id, "Retired till", false);
  const tB = await terminal(s.business.id, s.branches.B!.id, "Till B1");
  return { ...s, tA, tB };
}

const read = (userId: string, businessId: string) => shellOptions({}, { userId, businessId, idempotencyKey: "" });

describe("shell options", () => {
  it("a cashier of branch A gets only branch A and its active terminals", async () => {
    const s = await shop();
    const result = await read(s.staff.cashierA!.user.id, s.business.id);
    expect(result).toEqual({
      ok: true,
      value: {
        business: { id: s.business.id, name: "Test Business", activityType: "MARKET" },
        role: "CASHIER",
        branches: [{ id: s.branches.A!.id, name: "A", terminals: [{ id: s.tA.id, name: "Till A1" }] }],
      },
    });
  });

  it("an owner gets every active branch with its terminals", async () => {
    const s = await shop();
    const result = await read(s.staff.owner!.user.id, s.business.id);
    if (!result.ok) throw new Error(result.code);
    expect(result.value.branches.map((b) => b.name)).toEqual(["A", "B"]);
    expect(result.value.branches[1]!.terminals).toEqual([{ id: s.tB.id, name: "Till B1" }]);
  });

  it("a deactivated member or a stranger is refused, and a closed business reads as READ_ONLY", async () => {
    const s = await shop();
    expect(await read(s.staff.gone!.user.id, s.business.id)).toMatchObject({ ok: false, code: "FORBIDDEN" });
    const other = await createBusinessWithStaff(db, { staff: [{ key: "x", role: "OWNER" }] });
    expect(await read(other.staff.x!.user.id, s.business.id)).toMatchObject({ ok: false, code: "FORBIDDEN" });
    // `other` has no subscription: the gate is CLOSED.
    expect(await read(other.staff.x!.user.id, other.business.id)).toMatchObject({ ok: false, code: "READ_ONLY" });
  });
});

describe("memberships", () => {
  it("lists the businesses a user is active staff of, never archived ones or deactivated memberships", async () => {
    const s = await shop();
    const second = await createBusinessWithStaff(db);
    await db.rtBusiness.update({ where: { id: second.business.id }, data: { name: "Another shop" } });
    await db.rtStaff.create({ data: { businessId: second.business.id, userId: s.staff.owner!.user.id, role: "CASHIER" } });
    const archived = await createBusinessWithStaff(db);
    await db.rtBusiness.update({ where: { id: archived.business.id }, data: { status: "ARCHIVED" } });
    await db.rtStaff.create({ data: { businessId: archived.business.id, userId: s.staff.owner!.user.id, role: "OWNER" } });

    expect(await listMemberships(s.staff.owner!.user.id)).toEqual([
      { businessId: second.business.id, name: "Another shop", role: "CASHIER", activityType: "MARKET" },
      { businessId: s.business.id, name: "Test Business", role: "OWNER", activityType: "MARKET" },
    ]);
    expect(await listMemberships(s.staff.gone!.user.id)).toEqual([]);
    expect(await listMemberships("")).toEqual([]);
    expect(await listMemberships("no-such-user")).toEqual([]);
  });
});
