import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createProduct } from "@/server/catalog/products";
import { AVAILABLE_STEPS, SETUP_STEPS, completeSetupStep, getSetupProgress, setupOverview } from "@/server/setup/progress";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createPlan, createUser } from "../helpers/fixtures";

const { db } = useTestDb();

const key = () => randomUUID();
const DAY = 86_400_000;

/** A business with an ACTIVE subscription (gate FULL), two branches and an owner, manager and cashier. */
async function business(label: string) {
  const w = await createBusinessWithStaff(db, {
    branches: ["A", "B"],
    staff: [
      { key: "owner", role: "OWNER" },
      { key: "manager", role: "MANAGER", branches: ["A", "B"] },
      { key: "cashier", role: "CASHIER", branches: ["A"] },
    ],
  });
  await db.rtBusiness.update({ where: { id: w.business.id }, data: { status: "ACTIVE", name: label } });
  await db.rtSubscription.create({
    data: {
      businessId: w.business.id,
      planCode: "basic",
      status: "ACTIVE",
      currentPeriodStart: new Date(Date.now() - DAY),
      currentPeriodEnd: new Date(Date.now() + 30 * DAY),
    },
  });
  const as = (who: string, k = key()) => ({ userId: w.staff[who]!.user.id, businessId: w.business.id, idempotencyKey: k });
  return { ...w, as };
}

async function world() {
  await createPlan(db, { maxBranches: 3 });
  return { a: await business("A shop"), b: await business("B shop") };
}

const statusOf = (steps: { step: number; status: string }[]) => Object.fromEntries(steps.map((s) => [s.step, s.status]));

const step1 = (version: number) => ({
  step: 1 as const,
  data: { name: "متجر النور", defaultCurrency: "IQD", enabledCurrencies: ["IQD", "USD"], timezone: "Asia/Baghdad", expectedVersion: version },
});

describe("setup progress", () => {
  it("progress survives a reload, only step 4 completes from the catalog, and steps 6, 7, 8, 9 stay PENDING", async () => {
    const { a } = await world();

    // Nothing stored yet: all nine steps read as PENDING.
    const fresh = await getSetupProgress({}, a.as("owner"));
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.value.map((s) => s.step)).toEqual([...SETUP_STEPS]);
    expect(fresh.value.every((s) => s.status === "PENDING")).toBe(true);
    expect(fresh.value.filter((s) => s.available).map((s) => s.step)).toEqual([...AVAILABLE_STEPS]);

    const v = (await db.rtBusiness.findUniqueOrThrow({ where: { id: a.business.id } })).version;
    expect(await completeSetupStep(step1(v), a.as("owner"))).toEqual({ ok: true, value: null });
    const branches = await db.rtBranch.findMany({ where: { businessId: a.business.id }, orderBy: { name: "asc" } });
    expect(
      await completeSetupStep(
        {
          step: 2,
          data: {
            branches: [
              { id: branches[0]!.id, name: "الفرع الرئيسي", expectedVersion: branches[0]!.version },
              { name: "فرع المنصور", storeName: "مخزن المنصور" },
            ],
          },
        },
        a.as("owner"),
      ),
    ).toMatchObject({ ok: true });
    expect(
      await completeSetupStep({ step: 3, data: { activityType: "CLOTHING", capabilities: ["VARIANTS", "HOLDS"], expectedVersion: v + 1 } }, a.as("owner")),
    ).toMatchObject({ ok: true });
    const cashier = await createUser(db, { email: "New.Cashier@example.test" });
    expect(
      await completeSetupStep(
        { step: 5, data: { staff: [{ email: "new.cashier@example.test", role: "CASHIER", branchIds: [branches[1]!.id] }] } },
        a.as("owner"),
      ),
    ).toMatchObject({ ok: true });

    // Step 4 follows the catalog: a trial item does not complete it, a real product does.
    const before = await getSetupProgress({}, a.as("owner"));
    expect(before.ok && statusOf(before.value)[4]).toBe("PENDING");
    const product = (nameAr: string, isTestData: boolean) =>
      createProduct({ nameAr, isTestData, baseUnit: { name: "قطعة", barcodes: [] } }, a.as("owner"));
    expect(await product("صنف تجربة", true)).toMatchObject({ ok: true });
    const trialOnly = await getSetupProgress({}, a.as("owner"));
    expect(trialOnly.ok && statusOf(trialOnly.value)[4]).toBe("PENDING");
    expect(await product("سكر", false)).toMatchObject({ ok: true });

    // "Reload": a new read from the database, nothing kept in memory.
    const reloaded = await getSetupProgress({}, a.as("manager"));
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(statusOf(reloaded.value)).toEqual({
      1: "DONE",
      2: "DONE",
      3: "DONE",
      4: "DONE",
      5: "DONE",
      6: "PENDING",
      7: "PENDING",
      8: "PENDING",
      9: "PENDING",
    });
    expect(await db.rtSetupProgress.count({ where: { businessId: a.business.id } })).toBe(9);
    expect(await db.rtSetupProgress.count({ where: { businessId: a.business.id, isTestData: true } })).toBe(0);

    // What each step wrote is really there.
    const biz = await db.rtBusiness.findUniqueOrThrow({ where: { id: a.business.id } });
    expect(biz).toMatchObject({ name: "متجر النور", defaultCurrency: "IQD", enabledCurrencies: ["IQD", "USD"], activityType: "CLOTHING", version: v + 2 });
    const caps = await db.rtCapability.findMany({ where: { businessId: a.business.id, enabled: true } });
    expect(caps.map((c) => c.capability).sort()).toEqual(["HOLDS", "VARIANTS"]);
    const newBranch = await db.rtBranch.findFirstOrThrow({ where: { businessId: a.business.id, name: "فرع المنصور" } });
    expect(await db.rtLocation.findMany({ where: { branchId: newBranch.id }, select: { name: true } })).toEqual([{ name: "مخزن المنصور" }]);
    expect((await db.rtBranch.findUniqueOrThrow({ where: { id: branches[0]!.id } })).name).toBe("الفرع الرئيسي");
    const staff = await db.rtStaff.findFirstOrThrow({ where: { businessId: a.business.id, userId: cashier.id }, include: { branches: true } });
    expect(staff.role).toBe("CASHIER");
    expect(staff.branches.map((b) => b.branchId)).toEqual([branches[1]!.id]);

    // Each completion is audited.
    const audits = await db.rtAuditLog.findMany({ where: { businessId: a.business.id, action: "setup.step.complete" } });
    expect(audits).toHaveLength(4);

    // The overview the page renders reflects the same state.
    const overview = await setupOverview({}, a.as("owner"));
    expect(overview).toMatchObject({ ok: true, value: { business: { name: "متجر النور", version: v + 2 } } });
  });

  it("refuses steps 6, 7, 8 and 9 with STEP_NOT_AVAILABLE and never marks them DONE", async () => {
    const { a } = await world();
    for (const step of [6, 7, 8, 9]) {
      expect(await completeSetupStep({ step, data: {} }, a.as("owner"))).toMatchObject({ ok: false, code: "STEP_NOT_AVAILABLE" });
    }
    expect(await completeSetupStep({ step: 10, data: {} }, a.as("owner"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await completeSetupStep({ step: 0, data: {} }, a.as("owner"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await db.rtSetupProgress.count({ where: { status: "DONE" } })).toBe(0);
    expect(await db.rtAuditLog.count()).toBe(0);
  });

  it("is idempotent: a replayed key changes nothing twice", async () => {
    const { a } = await world();
    const k = key();
    const input = { step: 2 as const, data: { branches: [{ name: "فرع جديد" }] } };
    expect(await completeSetupStep(input, a.as("owner", k))).toMatchObject({ ok: true });
    expect(await completeSetupStep(input, a.as("owner", k))).toMatchObject({ ok: true });
    expect(await db.rtBranch.count({ where: { businessId: a.business.id, name: "فرع جديد" } })).toBe(1);
    expect(await db.rtAuditLog.count({ where: { action: "setup.step.complete" } })).toBe(1);
  });

  it("validates step data: currencies, timezone, capability conflicts, plan limit and stale versions", async () => {
    const { a } = await world();
    const v = (await db.rtBusiness.findUniqueOrThrow({ where: { id: a.business.id } })).version;
    const bad1 = (patch: Record<string, unknown>) => ({ step: 1, data: { ...step1(v).data, ...patch } });
    expect(await completeSetupStep(bad1({ defaultCurrency: "EUR" }), a.as("owner"))).toMatchObject({ code: "INVALID_INPUT" });
    expect(await completeSetupStep(bad1({ defaultCurrency: "USD", enabledCurrencies: ["IQD"] }), a.as("owner"))).toMatchObject({ code: "INVALID_INPUT" });
    expect(await completeSetupStep(bad1({ timezone: "Mars/Olympus" }), a.as("owner"))).toMatchObject({ code: "INVALID_INPUT" });
    expect(await completeSetupStep(bad1({ expectedVersion: v + 5 }), a.as("owner"))).toMatchObject({ code: "VERSION_CONFLICT" });
    expect(
      await completeSetupStep({ step: 3, data: { activityType: "ELECTRONICS", capabilities: ["SERIAL", "BATCH"], expectedVersion: v } }, a.as("owner")),
    ).toMatchObject({ code: "CAPABILITY_CONFLICT" });
    // Plan allows 3 branches; the business has 2.
    expect(
      await completeSetupStep({ step: 2, data: { branches: [{ name: "ثالث" }, { name: "رابع" }] } }, a.as("owner")),
    ).toMatchObject({ code: "PLAN_LIMIT" });
    expect(await completeSetupStep({ step: 5, data: { staff: [{ email: "nobody@example.test", role: "CASHIER", branchIds: [a.branches.A!.id] }] } }, a.as("owner"))).toMatchObject({
      code: "USER_NOT_FOUND",
    });
    expect(await db.rtSetupProgress.count({ where: { status: "DONE" } })).toBe(0);
    expect((await db.rtBusiness.findUniqueOrThrow({ where: { id: a.business.id } })).version).toBe(v);
  });

  it("permissions: a cashier can neither read nor complete steps; a manager cannot add a manager or anyone as owner", async () => {
    const { a } = await world();
    expect(await getSetupProgress({}, a.as("cashier"))).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await completeSetupStep({ step: 2, data: { branches: [] } }, a.as("cashier"))).toMatchObject({ ok: false, code: "FORBIDDEN" });
    const u = await createUser(db, { email: "m2@example.test" });
    const grant = (role: string) =>
      completeSetupStep({ step: 5, data: { staff: [{ email: u.email, role, branchIds: [a.branches.A!.id] }] } }, a.as("manager"));
    // MANAGER is a real role the manager may not give; OWNER is never a valid wizard role.
    expect(await grant("MANAGER")).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await grant("OWNER")).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await db.rtStaff.count({ where: { userId: u.id } })).toBe(0);
    // A manager may add a cashier.
    expect(
      await completeSetupStep({ step: 5, data: { staff: [{ email: u.email, role: "CASHIER", branchIds: [a.branches.A!.id] }] } }, a.as("manager")),
    ).toMatchObject({ ok: true });
  });

  it("the gate: READ_ONLY refuses every step but still reads; CLOSED refuses reads too", async () => {
    const { a } = await world();
    await db.rtBusiness.update({ where: { id: a.business.id }, data: { status: "SUSPENDED" } });
    const v = (await db.rtBusiness.findUniqueOrThrow({ where: { id: a.business.id } })).version;
    expect(await completeSetupStep(step1(v), a.as("owner"))).toMatchObject({ ok: false, code: "READ_ONLY" });
    expect(await completeSetupStep({ step: 2, data: { branches: [] } }, a.as("owner"))).toMatchObject({ ok: false, code: "READ_ONLY" });
    expect(await getSetupProgress({}, a.as("owner"))).toMatchObject({ ok: true });
    await db.rtBusiness.update({ where: { id: a.business.id }, data: { status: "ARCHIVED" } });
    expect(await getSetupProgress({}, a.as("owner"))).toMatchObject({ ok: false, code: "READ_ONLY" });
    expect(await db.rtSetupProgress.count()).toBe(0);
  });

  it("isolation: one business's progress and branches are invisible and untouchable from another", async () => {
    const { a, b } = await world();
    const v = (await db.rtBusiness.findUniqueOrThrow({ where: { id: a.business.id } })).version;
    expect(await completeSetupStep(step1(v), a.as("owner"))).toMatchObject({ ok: true });

    const fromB = await getSetupProgress({}, b.as("owner"));
    expect(fromB.ok && fromB.value.every((s) => s.status === "PENDING")).toBe(true);
    // B's owner cannot act inside A (not a member) ...
    expect(await getSetupProgress({}, { ...b.as("owner"), businessId: a.business.id })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    // ... nor rename A's branch from B, nor assign staff to A's branch from B.
    const branchA = await db.rtBranch.findUniqueOrThrow({ where: { id: a.branches.A!.id } });
    expect(
      await completeSetupStep({ step: 2, data: { branches: [{ id: branchA.id, name: "مسروق", expectedVersion: branchA.version }] } }, b.as("owner")),
    ).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    const u = await createUser(db, { email: "x@example.test" });
    expect(
      await completeSetupStep({ step: 5, data: { staff: [{ email: u.email, role: "CASHIER", branchIds: [branchA.id] }] } }, b.as("owner")),
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect((await db.rtBranch.findUniqueOrThrow({ where: { id: branchA.id } })).name).toBe("A");
    expect(await db.rtStaff.count({ where: { userId: u.id } })).toBe(0);
  });
  it("step 4: completeSetupStep refuses CATALOG_EMPTY until a real product or a real import exists, and an archived catalog reopens it", async () => {
    const { a, b } = await world();
    expect(await completeSetupStep({ step: 4, data: {} }, a.as("owner"))).toMatchObject({ ok: false, code: "CATALOG_EMPTY" });
    const trial = await createProduct({ nameAr: "تجربة", isTestData: true, baseUnit: { name: "قطعة", barcodes: [] } }, a.as("owner"));
    expect(trial.ok).toBe(true);
    expect(await completeSetupStep({ step: 4, data: {} }, a.as("owner"))).toMatchObject({ ok: false, code: "CATALOG_EMPTY" });
    const real = await createProduct({ nameAr: "رز", baseUnit: { name: "قطعة", barcodes: [] } }, a.as("owner"));
    expect(real.ok).toBe(true);
    if (!real.ok) return;
    expect(await completeSetupStep({ step: 4, data: {} }, a.as("owner"))).toEqual({ ok: true, value: null });
    expect(await db.rtSetupProgress.findFirst({ where: { businessId: a.business.id, step: 4 } })).toMatchObject({ status: "DONE" });
    const overview = await setupOverview({}, a.as("owner"));
    expect(overview).toMatchObject({ ok: true, value: { catalog: { products: 1, testProducts: 1, ready: true } } });

    // Another business's catalog never completes this one's step.
    const fromB = await getSetupProgress({}, b.as("owner"));
    expect(fromB.ok && statusOf(fromB.value)[4]).toBe("PENDING");

    // The page shows the live catalog: archiving the only real product reopens step 4.
    await db.rtProduct.update({ where: { id: real.value.productId }, data: { archivedAt: new Date() } });
    const after = await getSetupProgress({}, a.as("owner"));
    expect(after.ok && after.value.find((s) => s.step === 4)).toMatchObject({ status: "PENDING", completedAt: null });
  });
});
