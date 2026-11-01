import { describe, expect, it } from "vitest";
import { resolveActor, ActorError } from "@/server/framework/actor";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createUser } from "../helpers/fixtures";

const { db } = useTestDb();

describe("resolveActor", () => {
  it("resolveActor refuses a deactivated staff member", async () => {
    const f = await createBusinessWithStaff(db, { staff: [{ key: "x", role: "CASHIER", deactivated: true }] });
    await expect(resolveActor(f.staff.x!.user.id, f.business.id)).rejects.toMatchObject({
      name: "ActorError",
      code: "DEACTIVATED",
    });
  });

  it("resolveActor refuses a user who belongs to another business", async () => {
    const a = await createBusinessWithStaff(db, { staff: [{ key: "x", role: "OWNER" }] });
    const b = await createBusinessWithStaff(db, {});
    const err = await resolveActor(a.staff.x!.user.id, b.business.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActorError);
    expect(err).toMatchObject({ code: "NOT_A_MEMBER" });
    await expect(resolveActor((await createUser(db)).id, a.business.id)).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
  });

  it("a CASHIER's branchIds contain only the linked branch", async () => {
    const f = await createBusinessWithStaff(db, {
      branches: ["Main", "Second"],
      staff: [{ key: "c", role: "CASHIER", branches: ["Second"] }],
    });
    const actor = await resolveActor(f.staff.c!.user.id, f.business.id);
    expect(actor).toEqual({
      userId: f.staff.c!.user.id,
      businessId: f.business.id,
      role: "CASHIER",
      branchIds: [f.branches.Second!.id],
    });
  });

  it("an inactive branch is excluded from a CASHIER's branchIds", async () => {
    const f = await createBusinessWithStaff(db, {
      branches: ["Main", "Old"],
      staff: [{ key: "c", role: "CASHIER", branches: ["Main", "Old"] }],
    });
    await db.rtBranch.update({ where: { id: f.branches.Old!.id }, data: { active: false } });
    const actor = await resolveActor(f.staff.c!.user.id, f.business.id);
    expect(actor.branchIds).toEqual([f.branches.Main!.id]);
  });

  it("multi-branch roles get ALL", async () => {
    const f = await createBusinessWithStaff(db, {
      staff: [{ key: "o", role: "OWNER" }, { key: "m", role: "MANAGER" }, { key: "a", role: "AUDITOR" }, { key: "s", role: "STOCK" }],
    });
    for (const k of ["o", "m", "a"]) {
      expect((await resolveActor(f.staff[k]!.user.id, f.business.id)).branchIds).toBe("ALL");
    }
    expect((await resolveActor(f.staff.s!.user.id, f.business.id)).branchIds).toEqual([]);
  });

  it("a user with staff rows in two businesses resolves each separately", async () => {
    const a = await createBusinessWithStaff(db, { branches: ["A1"], staff: [{ key: "u", role: "CASHIER", branches: ["A1"] }] });
    const b = await createBusinessWithStaff(db, { branches: ["B1"] });
    const userId = a.staff.u!.user.id;
    await db.rtStaff.create({
      data: { businessId: b.business.id, userId, role: "STOCK", branches: { create: [{ branchId: b.branches.B1!.id }] } },
    });
    const ra = await resolveActor(userId, a.business.id);
    const rb = await resolveActor(userId, b.business.id);
    expect(ra).toMatchObject({ role: "CASHIER", businessId: a.business.id, branchIds: [a.branches.A1!.id] });
    expect(rb).toMatchObject({ role: "STOCK", businessId: b.business.id, branchIds: [b.branches.B1!.id] });
  });
});

describe("RtStaffBranch composite foreign keys", () => {
  it("accepts a branch of the staff's own business", async () => {
    const f = await createBusinessWithStaff(db, { staff: [{ key: "s", role: "CASHIER" }] });
    await expect(
      db.rtStaffBranch.create({
        data: { staffId: f.staff.s!.staffId, businessId: f.business.id, branchId: f.branches.Main!.id },
      }),
    ).resolves.toBeTruthy();
  });

  it("rejects a branch of another business", async () => {
    const a = await createBusinessWithStaff(db, { staff: [{ key: "s", role: "CASHIER" }] });
    const b = await createBusinessWithStaff(db, {});
    await expect(
      db.rtStaffBranch.create({
        data: { staffId: a.staff.s!.staffId, businessId: a.business.id, branchId: b.branches.Main!.id },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("rejects a businessId that differs from the staff's business", async () => {
    const a = await createBusinessWithStaff(db, { staff: [{ key: "s", role: "CASHIER" }] });
    const b = await createBusinessWithStaff(db, {});
    await expect(
      db.rtStaffBranch.create({
        data: { staffId: a.staff.s!.staffId, businessId: b.business.id, branchId: b.branches.Main!.id },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("rejects a branch that does not exist", async () => {
    const f = await createBusinessWithStaff(db, { staff: [{ key: "s", role: "CASHIER" }] });
    await expect(
      db.rtStaffBranch.create({
        data: { staffId: f.staff.s!.staffId, businessId: f.business.id, branchId: "no-such-branch" },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
  });
});
