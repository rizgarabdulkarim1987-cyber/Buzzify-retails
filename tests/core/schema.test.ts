import { describe, expect, it } from "vitest";
import { useTestDb } from "../helpers/db";
import { createUser } from "../helpers/fixtures";

const { db } = useTestDb();

/** The error a promise rejects with, as text, so a test can name the constraint. */
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    return JSON.stringify(e, Object.getOwnPropertyNames(e));
  }
  throw new Error("expected the database to refuse this write");
}

const biz = (name: string, coreBusinessId?: string | null) =>
  db.rtBusiness.create({
    data: { name, activityType: "MARKET", defaultCurrency: "IQD", enabledCurrencies: ["IQD"], coreBusinessId },
  });

describe("core link schema", () => {
  it("refuses two businesses with the same coreBusinessId", async () => {
    await biz("A", "core-1");
    expect(await failure(biz("B", "core-1"))).toMatch(/Unique constraint|P2002/);
  });

  it("allows many businesses without a coreBusinessId", async () => {
    await biz("A", null);
    await biz("B", null);
    expect(await db.rtBusiness.count()).toBe(2);
  });

  it("stores the core owner and state version", async () => {
    const b = await db.rtBusiness.create({
      data: {
        name: "C", activityType: "MARKET", defaultCurrency: "IQD", enabledCurrencies: ["IQD"],
        coreBusinessId: "core-2", coreOwnerUserId: "cu-1", coreStateVersion: 5,
      },
    });
    expect(b.coreOwnerUserId).toBe("cu-1");
    expect(b.coreStateVersion).toBe(5);
  });

  it("refuses two users with the same coreUserId but allows many without", async () => {
    await createUser(db, { coreUserId: "cu-1" });
    expect(await failure(createUser(db, { coreUserId: "cu-1" }))).toMatch(/Unique constraint|P2002/);
    await createUser(db);
    await createUser(db);
  });

  it("refuses a repeated nonce jti", async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    await db.rtCoreNonce.create({ data: { jti: "j1", expiresAt } });
    expect(await failure(db.rtCoreNonce.create({ data: { jti: "j1", expiresAt } }))).toMatch(/Unique constraint|P2002/);
  });
});
