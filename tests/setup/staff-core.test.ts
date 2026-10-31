import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreClientError } from "@/server/core/client";
import { createFakeCoreClient, setCoreClientFake } from "@/server/core/client-fake";
import { completeSetupStep } from "@/server/setup/progress";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createPlan, createUser } from "../helpers/fixtures";

const { db } = useTestDb();

afterEach(() => setCoreClientFake(undefined));

async function business(linked: boolean) {
  await createPlan(db, { maxBranches: 3 });
  const w = await createBusinessWithStaff(db, { branches: ["A"], staff: [{ key: "owner", role: "OWNER" }] });
  await db.rtBusiness.update({
    where: { id: w.business.id },
    data: { status: "ACTIVE", coreBusinessId: linked ? `cb_${randomUUID()}` : null },
  });
  await db.rtSubscription.create({
    data: {
      businessId: w.business.id,
      planCode: "basic",
      status: "ACTIVE",
      currentPeriodStart: new Date(Date.now() - 86_400_000),
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    },
  });
  const meta = { userId: w.staff.owner!.user.id, businessId: w.business.id, idempotencyKey: randomUUID() };
  return { w, meta };
}

const addStaff = (meta: Parameters<typeof completeSetupStep>[1], email: string, branchId: string) =>
  completeSetupStep({ step: 5, data: { staff: [{ email, role: "CASHIER", branchIds: [branchId] }] } }, { ...meta, idempotencyKey: randomUUID() });

describe("staff add with a Studio identity", () => {
  it("linked business: ensures the identity and links it to the existing local user", async () => {
    const { w, meta } = await business(true);
    const user = await createUser(db, { email: "Cash.Ier@Example.test" });
    const ensureIdentity = vi.fn(async () => ({ coreUserId: "cu_cash", created: false, emailVerified: true }));
    setCoreClientFake({ ...createFakeCoreClient(), ensureIdentity });
    const r = await addStaff(meta, "cash.ier@example.test", w.branches.A!.id);
    expect(r.ok).toBe(true);
    expect(ensureIdentity).toHaveBeenCalledWith("cash.ier@example.test", user.name);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).coreUserId).toBe("cu_cash");
    expect(await db.rtStaff.count({ where: { userId: user.id } })).toBe(1);
  });

  it("already linked user: Studio is not called at all (also on a replay while Studio is down), the add proceeds", async () => {
    const { w, meta } = await business(true);
    const user = await createUser(db, { coreUserId: "cu_same" });
    const ensureIdentity = vi.fn(async () => {
      throw new CoreClientError("network");
    });
    setCoreClientFake({ ...createFakeCoreClient(), ensureIdentity });
    expect((await addStaff(meta, user.email, w.branches.A!.id)).ok).toBe(true);
    expect(ensureIdentity).not.toHaveBeenCalled();
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).coreUserId).toBe("cu_same");
  });

  it("unverified Studio email: not linked, the staff add proceeds as today", async () => {
    const { w, meta } = await business(true);
    const user = await createUser(db);
    setCoreClientFake({ ...createFakeCoreClient(), ensureIdentity: async () => ({ coreUserId: "cu_u", created: true, emailVerified: false }) });
    expect((await addStaff(meta, user.email, w.branches.A!.id)).ok).toBe(true);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).coreUserId).toBeNull();
  });

  it("platform admin is never linked", async () => {
    const { w, meta } = await business(true);
    const admin = await createUser(db);
    await db.rtPlatformAdmin.create({ data: { userId: admin.id } });
    setCoreClientFake({ ...createFakeCoreClient(), ensureIdentity: async () => ({ coreUserId: "cu_admin", created: false, emailVerified: true }) });
    expect((await addStaff(meta, admin.email, w.branches.A!.id)).ok).toBe(true);
    expect((await db.user.findUniqueOrThrow({ where: { id: admin.id } })).coreUserId).toBeNull();
  });

  it("refuses when the Studio id already belongs to another local user", async () => {
    const { w, meta } = await business(true);
    await createUser(db, { coreUserId: "cu_taken" });
    const user = await createUser(db);
    setCoreClientFake({ ...createFakeCoreClient(), ensureIdentity: async () => ({ coreUserId: "cu_taken", created: false, emailVerified: true }) });
    expect(await addStaff(meta, user.email, w.branches.A!.id)).toMatchObject({ ok: false, code: "IDENTITY_CONFLICT" });
  });

  it("no local user: Studio is still asked, nothing is stored, and the existing USER_NOT_FOUND path stays", async () => {
    const { w, meta } = await business(true);
    const ensureIdentity = vi.fn(async () => ({ coreUserId: "cu_x", created: true, emailVerified: true }));
    setCoreClientFake({ ...createFakeCoreClient(), ensureIdentity });
    const users = await db.user.count();
    expect(await addStaff(meta, "nobody@example.test", w.branches.A!.id)).toMatchObject({ ok: false, code: "USER_NOT_FOUND" });
    expect(ensureIdentity).toHaveBeenCalledTimes(1);
    expect(await db.user.count()).toBe(users);
  });

  it("Studio unreachable: a retryable CORE_UNAVAILABLE and no staff row, no silent fallback", async () => {
    const { w, meta } = await business(true);
    const user = await createUser(db);
    setCoreClientFake({
      ...createFakeCoreClient(),
      ensureIdentity: async () => {
        throw new CoreClientError("timeout");
      },
    });
    expect(await addStaff(meta, user.email, w.branches.A!.id)).toMatchObject({ ok: false, code: "CORE_UNAVAILABLE" });
    expect(await db.rtStaff.count({ where: { userId: user.id } })).toBe(0);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).coreUserId).toBeNull();
  });

  it("standalone business: Studio is never called and the flow is unchanged", async () => {
    const { w, meta } = await business(false);
    const user = await createUser(db);
    const ensureIdentity = vi.fn(async () => ({ coreUserId: "cu_x", created: false, emailVerified: true }));
    setCoreClientFake({ ...createFakeCoreClient(), ensureIdentity });
    expect((await addStaff(meta, user.email, w.branches.A!.id)).ok).toBe(true);
    expect(ensureIdentity).not.toHaveBeenCalled();
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).coreUserId).toBeNull();
  });
});
