import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Prisma, RtBusinessStatus, SubscriptionStatus } from "@/generated/prisma/client";
import { defineAction } from "@/server/framework/action";
import { gateOf } from "@/server/framework/gate";
import { updateVersioned } from "@/server/framework/versioned";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff } from "../helpers/fixtures";

const { db } = useTestDb();

const at = (iso: string) => new Date(iso);
const DAY = 86_400_000;
const daysFrom = (d: Date, n: number) => new Date(d.getTime() + n * DAY);

async function plan(code = "basic") {
  return db.rtPlan.upsert({
    where: { code },
    update: {},
    create: { code, name: code, maxBranches: 1, maxTerminals: 2, maxUsers: 5, storageMb: 500, aiMonthly: 0 },
  });
}

async function business(status: RtBusinessStatus = "ACTIVE") {
  const w = await createBusinessWithStaff(db, { branches: ["Main"], staff: [{ key: "owner", role: "OWNER" }] });
  await db.rtBusiness.update({ where: { id: w.business.id }, data: { status } });
  return w;
}

async function subscribe(
  businessId: string,
  over: Partial<Prisma.RtSubscriptionUncheckedCreateInput> & { status: SubscriptionStatus },
) {
  const p = await plan();
  return db.rtSubscription.create({
    data: {
      businessId,
      planCode: p.code,
      currentPeriodStart: at("2026-02-10T00:00:00+03:00"),
      currentPeriodEnd: at("2026-03-10T23:59:59+03:00"),
      ...over,
    },
  });
}

describe("gateOf", () => {
  it("a business without any subscription is CLOSED", async () => {
    const w = await business();
    expect(await gateOf(w.business.id, db, at("2026-03-01T00:00:00Z"))).toBe("CLOSED");
  });

  it("follows the subscription dates", async () => {
    const w = await business();
    await subscribe(w.business.id, { status: "ACTIVE" });
    expect(await gateOf(w.business.id, db, at("2026-03-12T00:00:00+03:00"))).toBe("FULL");
    expect(await gateOf(w.business.id, db, at("2026-03-18T00:00:00+03:00"))).toBe("READ_ONLY");
    expect(await gateOf(w.business.id, db, daysFrom(at("2026-03-18T00:00:00+03:00"), 90))).toBe("CLOSED");
  });

  it("defaults now to the current time", async () => {
    const w = await business();
    const now = Date.now();
    await subscribe(w.business.id, {
      status: "ACTIVE",
      currentPeriodStart: new Date(now - 10 * DAY),
      currentPeriodEnd: new Date(now + 10 * DAY),
    });
    expect(await gateOf(w.business.id, db)).toBe("FULL");
  });

  it("SUSPENDED is READ_ONLY and ARCHIVED is CLOSED, whatever the subscription says", async () => {
    const s = await business("SUSPENDED");
    const a = await business("ARCHIVED");
    for (const w of [s, a]) {
      await subscribe(w.business.id, {
        status: "ACTIVE",
        currentPeriodEnd: at("2026-06-10T23:59:59+03:00"),
      });
    }
    const now = at("2026-05-01T00:00:00+03:00");
    expect(await gateOf(s.business.id, db, now)).toBe("READ_ONLY");
    expect(await gateOf(a.business.id, db, now)).toBe("CLOSED");
  });

  it("uses the live subscription over an older ended one", async () => {
    const w = await business();
    await subscribe(w.business.id, {
      status: "EXPIRED",
      currentPeriodStart: at("2025-01-01T00:00:00+03:00"),
      currentPeriodEnd: at("2025-02-01T00:00:00+03:00"),
    });
    await subscribe(w.business.id, { status: "ACTIVE" });
    expect(await gateOf(w.business.id, db, at("2026-03-01T00:00:00+03:00"))).toBe("FULL");
  });

  it("without a live subscription it uses the most recent one", async () => {
    const w = await business();
    await subscribe(w.business.id, {
      status: "EXPIRED",
      currentPeriodStart: at("2025-01-01T00:00:00+03:00"),
      currentPeriodEnd: at("2025-02-01T00:00:00+03:00"),
    });
    await subscribe(w.business.id, {
      status: "CANCELLED",
      cancelledAt: at("2026-03-01T00:00:00+03:00"),
    });
    expect(await gateOf(w.business.id, db, at("2026-03-02T00:00:00+03:00"))).toBe("READ_ONLY");
    expect(await gateOf(w.business.id, db, daysFrom(at("2026-03-01T00:00:00+03:00"), 90))).toBe("CLOSED");
  });

  it("an unknown business is CLOSED", async () => {
    expect(await gateOf("nope", db)).toBe("CLOSED");
  });
});

describe("the gate in defineAction (real gateOf)", () => {
  const rename = defineAction({
    name: "branch.rename",
    permission: "staff.manage",
    input: z.object({ branchId: z.string(), name: z.string().min(1), expectedVersion: z.number().int() }),
    writes: true,
    async run({ tx, input }) {
      await updateVersioned(tx.rtBranch, { id: input.branchId }, input.expectedVersion, { name: input.name });
      return input.name;
    },
  });
  const list = defineAction({
    name: "branch.list",
    permission: null,
    input: z.object({}),
    writes: false,
    run: ({ tx }) => tx.rtBranch.findMany({ select: { name: true } }),
  });

  it("a write action on a READ_ONLY business returns READ_ONLY and a read action succeeds", async () => {
    const w = await business();
    // 40 days past the period end: 33 days past grace, READ_ONLY (retention is 90 days).
    const now = Date.now();
    await subscribe(w.business.id, {
      status: "ACTIVE",
      currentPeriodStart: new Date(now - 70 * DAY),
      currentPeriodEnd: new Date(now - 40 * DAY),
    });
    const meta = { userId: w.staff.owner!.user.id, businessId: w.business.id, idempotencyKey: "k1" };
    const branchId = w.branches.Main!.id;

    expect(await rename({ branchId, name: "X", expectedVersion: 1 }, meta)).toMatchObject({
      ok: false,
      code: "READ_ONLY",
    });
    expect(await list({}, meta)).toEqual({ ok: true, value: [{ name: "Main" }] });
    expect((await db.rtBranch.findUnique({ where: { id: branchId } }))!.name).toBe("Main");
    expect(await db.rtAuditLog.count()).toBe(0);
  });

  it("a FULL business can write; SUSPENDED refuses writes and ARCHIVED refuses reads", async () => {
    const w = await business();
    const now = Date.now();
    await subscribe(w.business.id, {
      status: "ACTIVE",
      currentPeriodStart: new Date(now - 5 * DAY),
      currentPeriodEnd: new Date(now + 25 * DAY),
    });
    const meta = { userId: w.staff.owner!.user.id, businessId: w.business.id, idempotencyKey: "k1" };
    const branchId = w.branches.Main!.id;
    expect(await rename({ branchId, name: "X", expectedVersion: 1 }, meta)).toMatchObject({ ok: true });

    await db.rtBusiness.update({ where: { id: w.business.id }, data: { status: "SUSPENDED" } });
    expect(await rename({ branchId, name: "Y", expectedVersion: 2 }, { ...meta, idempotencyKey: "k2" })).toMatchObject({
      ok: false,
      code: "READ_ONLY",
    });
    expect(await list({}, meta)).toMatchObject({ ok: true });

    await db.rtBusiness.update({ where: { id: w.business.id }, data: { status: "ARCHIVED" } });
    expect(await list({}, meta)).toMatchObject({ ok: false, code: "READ_ONLY" });
  });

  it("a business without a subscription is refused", async () => {
    const w = await business();
    const meta = { userId: w.staff.owner!.user.id, businessId: w.business.id, idempotencyKey: "" };
    expect(await list({}, meta)).toMatchObject({ ok: false, code: "READ_ONLY" });
  });
});
