import { describe, expect, it } from "vitest";
import { useTestDb } from "../helpers/db";

const { db } = useTestDb();

async function makeBusiness(name: string) {
  return db.rtBusiness.create({
    data: { name, activityType: "MARKET", defaultCurrency: "IQD", enabledCurrencies: ["IQD"] },
  });
}

describe("structure schema", () => {
  it("applies business defaults", async () => {
    const b = await makeBusiness("A");
    expect(b.timezone).toBe("Asia/Baghdad");
    expect(b.status).toBe("SETUP");
    expect(b.version).toBe(1);
  });

  it("a location cannot point at a branch of another business", async () => {
    const a = await makeBusiness("A");
    const b = await makeBusiness("B");
    await db.rtBranch.create({ data: { businessId: a.id, name: "A1" } });
    const branchB = await db.rtBranch.create({ data: { businessId: b.id, name: "B1" } });

    await expect(
      db.rtLocation.create({ data: { businessId: a.id, branchId: branchB.id, name: "Cross" } }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("a terminal cannot use a location of another branch", async () => {
    const a = await makeBusiness("A");
    const branch1 = await db.rtBranch.create({ data: { businessId: a.id, name: "A1" } });
    const branch2 = await db.rtBranch.create({ data: { businessId: a.id, name: "A2" } });
    const loc2 = await db.rtLocation.create({
      data: { businessId: a.id, branchId: branch2.id, name: "Shelf" },
    });

    await expect(
      db.rtTerminal.create({
        data: { businessId: a.id, branchId: branch1.id, locationId: loc2.id, name: "T1" },
      }),
    ).rejects.toMatchObject({ code: "P2003" });

    const ok = await db.rtTerminal.create({
      data: { businessId: a.id, branchId: branch2.id, locationId: loc2.id, name: "T2" },
    });
    expect(ok.active).toBe(true);
  });
});
