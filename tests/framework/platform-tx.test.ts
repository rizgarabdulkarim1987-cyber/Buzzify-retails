import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { defineAction } from "@/server/framework/action";
import { planAiMonthly } from "@/server/framework/business-info";
import { currentPlatformTx } from "@/server/framework/platform-tx";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createPlan } from "../helpers/fixtures";

const { db } = useTestDb();

const DAY = 86_400_000;

async function shop() {
  const w = await createBusinessWithStaff(db, { branches: ["Main"], staff: [{ key: "owner", role: "OWNER" }] });
  const businessId = w.business.id;
  await db.rtBusiness.update({ where: { id: businessId }, data: { status: "ACTIVE" } });
  const code = `plan-${businessId}`;
  await createPlan(db, { code });
  await db.rtSubscription.create({
    data: { businessId, planCode: code, status: "ACTIVE", currentPeriodStart: new Date(Date.now() - DAY), currentPeriodEnd: new Date(Date.now() + 30 * DAY) },
  });
  return { businessId, userId: w.staff.owner!.user.id };
}

type Seen = { own: Prisma.TransactionClient | undefined; other: Prisma.TransactionClient | undefined };
let gate: Promise<void> = Promise.resolve();
const probeSeen: Seen[] = [];
let later: Promise<{ tx: Prisma.TransactionClient | undefined; plan: number }> | null = null;

const probe = defineAction({
  name: "test.platformTx",
  permission: null,
  input: z.object({ other: z.string(), wait: z.boolean() }),
  writes: true,
  async run({ actor, input }): Promise<boolean> {
    const seen: Seen = { own: currentPlatformTx(actor.businessId), other: currentPlatformTx(input.other) };
    if (input.wait) await gate; // keeps two runs open at the same time
    probeSeen.push(seen);
    // A continuation scheduled inside run that fires after the transaction committed.
    later = new Promise((resolve, reject) => {
      setTimeout(() => {
        planAiMonthly(actor.businessId)
          .then((plan) => resolve({ tx: currentPlatformTx(actor.businessId), plan }))
          .catch(reject);
      }, 50);
    });
    return true;
  },
});
let n = 0;
const call = (s: { businessId: string; userId: string }, other: string, wait = false) =>
  probe({ other, wait }, { userId: s.userId, businessId: s.businessId, idempotencyKey: `p${++n}` });

describe("platform-tx", () => {
  it("is set inside run for the action's business only, and unset outside", async () => {
    const a = await shop();
    const b = await shop();
    probeSeen.length = 0;
    expect(await call(a, b.businessId)).toEqual({ ok: true, value: true });
    expect(probeSeen[0]!.own).toBeDefined();
    expect(probeSeen[0]!.other).toBeUndefined();
    expect(currentPlatformTx(a.businessId)).toBeUndefined();
  });

  it("closes when the run settles: a later continuation falls back to db and does not throw", async () => {
    const a = await shop();
    expect((await call(a, "x")).ok).toBe(true);
    const r = await later!;
    expect(r.tx).toBeUndefined();
    expect(r.plan).toBe(100);
  });

  it("two concurrent actions each see their own transaction", async () => {
    const a = await shop();
    const b = await shop();
    probeSeen.length = 0;
    let open!: () => void;
    gate = new Promise((resolve) => (open = resolve));
    const both = Promise.all([call(a, b.businessId, true), call(b, a.businessId, true)]);
    setTimeout(open, 100);
    expect((await both).every((r) => r.ok)).toBe(true);
    gate = Promise.resolve();
    await later;
    expect(probeSeen).toHaveLength(2);
    expect(probeSeen[0]!.own).toBeDefined();
    expect(probeSeen[1]!.own).toBeDefined();
    expect(probeSeen[0]!.own).not.toBe(probeSeen[1]!.own);
    expect(probeSeen.every((s) => s.other === undefined)).toBe(true);
  });
});
