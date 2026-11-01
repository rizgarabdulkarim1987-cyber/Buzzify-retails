import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAction } from "@/server/framework/action";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createPlan } from "../helpers/fixtures";

const { db } = useTestDb();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A promise a test resolves by hand. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const events: string[] = [];
let hold: Promise<void> = Promise.resolve();

const locked = defineAction({
  name: "test.locked",
  permission: null,
  input: z.object({ lock: z.string(), tag: z.string() }),
  writes: true,
  async run({ input, lockBusiness }) {
    await lockBusiness(input.lock);
    events.push(`in:${input.tag}`);
    await hold;
    events.push(`out:${input.tag}`);
    return input.tag;
  },
});

async function world() {
  events.length = 0;
  await createPlan(db, { maxBranches: 3 });
  const w = await createBusinessWithStaff(db, { staff: [{ key: "o", role: "OWNER" }] });
  await db.rtBusiness.update({ where: { id: w.business.id }, data: { status: "ACTIVE" } });
  await db.rtSubscription.create({
    data: {
      businessId: w.business.id,
      planCode: "basic",
      status: "ACTIVE",
      currentPeriodStart: new Date(Date.now() - 86_400_000),
      currentPeriodEnd: new Date(Date.now() + 86_400_000 * 30),
    },
  });
  return (k: string) => ({ userId: w.staff.o!.user.id, businessId: w.business.id, idempotencyKey: k });
}

describe("lockBusiness", () => {
  it("serializes callers with the same name and lets different names through", async () => {
    const meta = await world();
    const gate = deferred();
    hold = gate.promise;
    const first = locked({ lock: "x", tag: "1" }, meta("k1"));
    await sleep(300);
    const same = locked({ lock: "x", tag: "2" }, meta("k2"));
    const other = locked({ lock: "y", tag: "3" }, meta("k3"));
    await sleep(500);
    // 1 holds "x"; 3 holds "y" (a different name); 2 is still waiting for "x".
    expect(events).toContain("in:1");
    expect(events).toContain("in:3");
    expect(events).not.toContain("in:2");
    gate.resolve();
    await Promise.all([first, same, other]);
    expect(events.indexOf("out:1")).toBeLessThan(events.indexOf("in:2"));
  });

  it("is scoped per business", async () => {
    const m1 = await world();
    const gate = deferred();
    hold = gate.promise;
    const first = locked({ lock: "x", tag: "1" }, m1("k1"));
    await sleep(300);
    const w2 = await createBusinessWithStaff(db, { staff: [{ key: "o", role: "OWNER" }] });
    await db.rtBusiness.update({ where: { id: w2.business.id }, data: { status: "ACTIVE" } });
    await db.rtSubscription.create({
      data: {
        businessId: w2.business.id,
        planCode: "basic",
        status: "ACTIVE",
        currentPeriodStart: new Date(Date.now() - 86_400_000),
        currentPeriodEnd: new Date(Date.now() + 86_400_000 * 30),
      },
    });
    const second = locked({ lock: "x", tag: "2" }, { userId: w2.staff.o!.user.id, businessId: w2.business.id, idempotencyKey: "k2" });
    await sleep(500);
    expect(events).toContain("in:2");
    gate.resolve();
    await Promise.all([first, second]);
  });
});
