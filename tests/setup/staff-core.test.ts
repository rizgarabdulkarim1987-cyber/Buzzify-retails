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
    const ensureIdentity = vi.fn(async () => ({ coreUserId: "cu_cash", created: false }));
    setCoreClientFake({ ...createFakeCoreClient(), ensureIdentity });
    const r = await addStaff(meta, "cash.ier@example.test", w.branches.A!.id);
    expect(r.ok).toBe(true);
    expect(ensureIdentity).toHaveBeenCalledWith("cash.ier@example.test", user.name);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).coreUserId).toBe("cu_cash");
    expect(await db.rtStaff.count({ where: { userId: user.id } })).toBe(1);
  });

  it("an already linked user with the same id passes; a different id is refused and nothing is added", async () => {
    const { w, meta } = await business(true);
    const same = await createUser(db, { coreUserId: "cu_same" });
    setCoreClientFake({ ...createFakeCoreClient(), ensureIdentity: async () => ({ coreUserId: "cu_same", created: false }) });
    expect((await addStaff(meta, same.email, w.branches.A!.id)).ok).toBe(true);

    const other = await createUser(db, { coreUserId: "cu_old" });
    setCoreClientFake({ ...createFakeCoreClient(), ensureIdentity: async () => ({ coreUserId: "cu_new", created: false }) });
    const r = await addStaff(meta, other.email, w.branches.A!.id);
    expect(r).toMatchObject({ ok: false, code: "IDENTITY_CONFLICT" });
    expect((await db.user.findUniqueOrThrow({ where: { id: other.id } })).coreUserId).toBe("cu_old");
    expect(await db.rtStaff.count({ where: { userId: other.id } })).toBe(0);
  });

  it("refuses when the Studio id already belongs to another local user", async () => {
    const { w, meta } = await business(true);
    await createUser(db, { coreUserId: "cu_taken" });
    const user = await createUser(db);
    setCoreClientFake({ ...createFakeCoreClient(), ensureIdentity: async () => ({ coreUserId: "cu_taken", created: false }) });
    expect(await addStaff(meta, user.email, w.branches.A!.id)).toMatchObject({ ok: false, code: "IDENTITY_CONFLICT" });
  });

  it("no local user: Studio is still asked, nothing is stored, and the existing USER_NOT_FOUND path stays", async () => {
    const { w, meta } = await business(true);
    const ensureIdentity = vi.fn(async () => ({ coreUserId: "cu_x", created: true }));
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
    const ensureIdentity = vi.fn(async () => ({ coreUserId: "cu_x", created: false }));
    setCoreClientFake({ ...createFakeCoreClient(), ensureIdentity });
    expect((await addStaff(meta, user.email, w.branches.A!.id)).ok).toBe(true);
    expect(ensureIdentity).not.toHaveBeenCalled();
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).coreUserId).toBeNull();
  });
});
