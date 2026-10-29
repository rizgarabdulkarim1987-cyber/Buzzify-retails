import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { archiveProduct, archiveUnit, createProduct } from "@/server/catalog/products";
import { getPriceAt, listPriceLists, listUnitPrices, setPrice, suggestedUnitPrice } from "@/server/catalog/prices";
import { mapPriceConstraintError, resolvePrice } from "@/server/catalog/price-core";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createPlan } from "../helpers/fixtures";

const { db } = useTestDb();

const key = () => randomUUID();
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
const daysAhead = (n: number) => new Date(Date.now() + n * DAY);

async function business(label: string) {
  const w = await createBusinessWithStaff(db, {
    branches: ["A"],
    staff: [
      { key: "owner", role: "OWNER" },
      { key: "manager", role: "MANAGER", branches: ["A"] },
      { key: "stock", role: "STOCK", branches: ["A"] },
      { key: "cashier", role: "CASHIER", branches: ["A"] },
    ],
  });
  await db.rtBusiness.update({ where: { id: w.business.id }, data: { status: "ACTIVE", name: label, enabledCurrencies: ["IQD", "USD"] } });
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

type Shop = Awaited<ReturnType<typeof business>>;

async function untilWaiting(n: number, stop: () => boolean = () => false, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end && !stop()) {
    const [row] = await db.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (Number(row!.count) >= n) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return false;
}

async function world() {
  await createPlan(db, { maxBranches: 3 });
  return { a: await business("A shop"), b: await business("B shop") };
}

/** A product with a piece and a carton of 24 and no prices; returns the unit ids. */
async function juice(w: Shop, name = "عصير") {
  const r = await createProduct({ nameAr: name, baseUnit: { name: "حبة" }, extraUnits: [{ name: "كرتون", factor: 24 }] }, w.as("stock"));
  if (!r.ok) throw new Error(`createProduct failed: ${r.code}`);
  const carton = await db.rtUnit.findFirstOrThrow({ where: { variantId: r.value.variantId, isBase: false } });
  return { ...r.value, cartonId: carton.id };
}

async function lists(w: Shop) {
  const r = await listPriceLists({}, w.as("owner"));
  if (!r.ok) throw new Error("listPriceLists failed");
  return Object.fromEntries(r.value.map((l) => [l.kind, l.id])) as { DEFAULT: string; WHOLESALE: string };
}

/** Inserts a price row directly (setPrice refuses back-dated prices, so history is seeded). */
async function seed(w: Shop, unitId: string, kind: "DEFAULT" | "WHOLESALE", currency: "IQD" | "USD", amountMinor: bigint, validFrom: Date, validTo: Date | null = null) {
  await db.rtPriceList.createMany({
    data: [
      { businessId: w.business.id, kind: "DEFAULT", name: "d" },
      { businessId: w.business.id, kind: "WHOLESALE", name: "w" },
    ],
    skipDuplicates: true,
  });
  const list = await db.rtPriceList.findFirstOrThrow({ where: { businessId: w.business.id, kind } });
  const row = await db.rtPrice.create({ data: { businessId: w.business.id, unitId, priceListId: list.id, currency, amountMinor, validFrom, validTo } });
  return { ok: true as const, value: { id: row.id } };
}

type Tracked<T> = { promise: Promise<T>; done: () => boolean };
function tracked<T>(p: Promise<T>): Tracked<T> {
  let settled = false;
  void p.then(
    () => (settled = true),
    () => (settled = true),
  );
  return { promise: p, done: () => settled };
}

describe("dated prices", () => {
  it("changing a price closes the old row and the old date still returns the old price", async () => {
    const { a } = await world();
    const p = await juice(a);
    const first = await seed(a, p.baseUnitId, "DEFAULT", "IQD", 500n, daysAgo(10));
    expect(first).toMatchObject({ ok: true });
    const l = await lists(a);
    const second = await setPrice({ unitId: p.baseUnitId, priceListId: l.DEFAULT, currency: "IQD", amountMinor: 750n }, a.as("owner"));
    expect(second).toMatchObject({ ok: true });
    if (!first.ok || !second.ok) return;

    const rows = await db.rtPrice.findMany({ where: { unitId: p.baseUnitId }, orderBy: { validFrom: "asc" } });
    expect(rows).toHaveLength(2);
    // The old row was closed at the new row's start and its amount never touched.
    expect(rows[0]).toMatchObject({ id: first.value.id, amountMinor: 500n });
    expect(rows[0]!.validTo?.getTime()).toBe(rows[1]!.validFrom.getTime());
    expect(rows[1]).toMatchObject({ id: second.value.id, amountMinor: 750n, validTo: null });
    expect(second.value).toMatchObject({ replacedPriceId: first.value.id, previousAmountMinor: 500n });

    const at = (d: Date) => getPriceAt({ unitId: p.baseUnitId, priceListId: l.DEFAULT, currency: "IQD", at: d }, a.as("cashier"));
    expect(await at(daysAgo(5))).toMatchObject({ ok: true, value: { amountMinor: 500n } });
    expect(await at(new Date(Date.now() + 1000))).toMatchObject({ ok: true, value: { amountMinor: 750n } });
    // The boundary instant belongs to the new row: [validFrom, validTo).
    expect(await at(rows[1]!.validFrom)).toMatchObject({ ok: true, value: { amountMinor: 750n } });
    expect(await at(new Date(rows[1]!.validFrom.getTime() - 1))).toMatchObject({ ok: true, value: { amountMinor: 500n } });
  });

  it("a historical instant before the first price returns null", async () => {
    const { a } = await world();
    const p = await juice(a);
    await seed(a, p.baseUnitId, "DEFAULT", "IQD", 500n, daysAgo(3));
    const l = await lists(a);
    const r = await getPriceAt({ unitId: p.baseUnitId, priceListId: l.DEFAULT, currency: "IQD", at: daysAgo(30) }, a.as("cashier"));
    expect(r).toEqual({ ok: true, value: null });
    // No price at all in USD either.
    expect(await getPriceAt({ unitId: p.baseUnitId, priceListId: l.DEFAULT, currency: "USD", at: new Date() }, a.as("cashier"))).toEqual({ ok: true, value: null });
  });

  it("a future validFrom schedules a price and the current one stays until then", async () => {
    const { a } = await world();
    const p = await juice(a);
    await seed(a, p.baseUnitId, "DEFAULT", "IQD", 500n, daysAgo(2));
    const l = await lists(a);
    const when = daysAhead(7);
    const sched = await setPrice({ unitId: p.baseUnitId, priceListId: l.DEFAULT, currency: "IQD", amountMinor: 900n, validFrom: when }, a.as("manager"));
    expect(sched).toMatchObject({ ok: true });
    const at = (d: Date) => getPriceAt({ unitId: p.baseUnitId, priceListId: l.DEFAULT, currency: "IQD", at: d }, a.as("cashier"));
    expect(await at(new Date())).toMatchObject({ ok: true, value: { amountMinor: 500n } });
    expect(await at(daysAhead(6))).toMatchObject({ ok: true, value: { amountMinor: 500n } });
    expect(await at(when)).toMatchObject({ ok: true, value: { amountMinor: 900n } });

    const rows = await listUnitPrices({ unitId: p.baseUnitId }, a.as("cashier"));
    expect(rows).toMatchObject({ ok: true });
    if (!rows.ok) return;
    expect(rows.value.map((r) => [r.amountMinor, r.status])).toEqual([
      [900n, "SCHEDULED"],
      [500n, "CURRENT"],
    ]);
    expect(rows.value[0]).toMatchObject({ listKind: "DEFAULT", currency: "IQD" });

    // Rule: one chain per key. A price starting now or before the scheduled one is refused (the
    // scheduled row is never deleted or edited); one starting after it chains behind it.
    expect(await setPrice({ unitId: p.baseUnitId, priceListId: l.DEFAULT, currency: "IQD", amountMinor: 600n }, a.as("manager"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await setPrice({ unitId: p.baseUnitId, priceListId: l.DEFAULT, currency: "IQD", amountMinor: 600n, validFrom: daysAhead(3) }, a.as("manager"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await setPrice({ unitId: p.baseUnitId, priceListId: l.DEFAULT, currency: "IQD", amountMinor: 1100n, validFrom: daysAhead(14) }, a.as("manager"))).toMatchObject({ ok: true });
    const all = await db.rtPrice.findMany({ where: { unitId: p.baseUnitId }, orderBy: { validFrom: "asc" } });
    expect(all.map((r) => [r.amountMinor, r.validTo === null])).toEqual([
      [500n, false],
      [900n, false],
      [1100n, true],
    ]);
    expect(await at(daysAhead(10))).toMatchObject({ ok: true, value: { amountMinor: 900n } });
    expect(await at(daysAhead(20))).toMatchObject({ ok: true, value: { amountMinor: 1100n } });
  });

  it("a price can not start before the current one started", async () => {
    const { a } = await world();
    const p = await juice(a);
    const start = daysAgo(5);
    await seed(a, p.baseUnitId, "DEFAULT", "IQD", 500n, start);
    const l = await lists(a);
    for (const validFrom of [daysAgo(6), start]) {
      const r = await setPrice({ unitId: p.baseUnitId, priceListId: l.DEFAULT, currency: "IQD", amountMinor: 1n, validFrom }, a.as("manager"));
      expect(r).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    }
    const rows = await db.rtPrice.findMany({ where: { unitId: p.baseUnitId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amountMinor: 500n, validTo: null, version: 1 });
    // Absurd dates are refused too.
    expect(await setPrice({ unitId: p.baseUnitId, priceListId: l.DEFAULT, currency: "IQD", amountMinor: 1n, validFrom: new Date("1970-01-01") }, a.as("manager"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await setPrice({ unitId: p.baseUnitId, priceListId: l.DEFAULT, currency: "IQD", amountMinor: 1n, validFrom: daysAhead(365 * 20) }, a.as("manager"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });

  it("a price can not be back-dated: history is never rewritten", async () => {
    const { a } = await world();
    const p = await juice(a);
    await seed(a, p.baseUnitId, "DEFAULT", "IQD", 500n, daysAgo(10));
    const l = await lists(a);
    const base = { unitId: p.baseUnitId, priceListId: l.DEFAULT, currency: "IQD" as const, amountMinor: 900n };
    const r = await setPrice({ ...base, validFrom: daysAgo(5) }, a.as("manager"));
    expect(r).toMatchObject({ ok: false, code: "INVALID_INPUT", details: { reason: "IN_PAST" } });
    const at = (d: Date) => getPriceAt({ unitId: p.baseUnitId, priceListId: l.DEFAULT, currency: "IQD", at: d }, a.as("cashier"));
    expect(await at(daysAgo(3))).toMatchObject({ ok: true, value: { amountMinor: 500n } });
    expect(await db.rtPrice.findMany({ where: { unitId: p.baseUnitId } })).toMatchObject([{ amountMinor: 500n, validTo: null, version: 1 }]);

    // A moment ago (UI latency, clock skew) is clamped to now: the old price keeps the past.
    const t0 = Date.now();
    const ok = await setPrice({ ...base, validFrom: new Date(t0 - 30_000) }, a.as("manager"));
    expect(ok).toMatchObject({ ok: true });
    if (!ok.ok) return;
    expect(ok.value.validFrom.getTime()).toBeGreaterThanOrEqual(t0);
    expect(await at(new Date(t0 - 20_000))).toMatchObject({ ok: true, value: { amountMinor: 500n } });
    // Just over a minute ago is refused.
    expect(await setPrice({ ...base, amountMinor: 1n, validFrom: new Date(Date.now() - 61_000) }, a.as("manager"))).toMatchObject({ ok: false, code: "INVALID_INPUT", details: { reason: "IN_PAST" } });
  });

  it("a first price can not be back-dated either", async () => {
    const { a } = await world();
    const p = await juice(a);
    const r = await setPrice({ unitId: p.baseUnitId, listKind: "DEFAULT", currency: "IQD", amountMinor: 500n, validFrom: daysAgo(1) }, a.as("manager"));
    expect(r).toMatchObject({ ok: false, code: "INVALID_INPUT", details: { reason: "IN_PAST" } });
    expect(await db.rtPrice.count({ where: { businessId: a.business.id } })).toBe(0);
  });

  it("rapid consecutive writes with no validFrom all work, even when the latest row starts a few ms ahead", async () => {
    const { a } = await world();
    const p = await juice(a);
    await seed(a, p.baseUnitId, "DEFAULT", "IQD", 1n, new Date(Date.now() + 3));
    const l = await lists(a);
    for (const amountMinor of [2n, 3n, 4n]) {
      expect(await setPrice({ unitId: p.baseUnitId, priceListId: l.DEFAULT, currency: "IQD", amountMinor }, a.as("manager"))).toMatchObject({ ok: true });
    }
    const rows = await db.rtPrice.findMany({ where: { unitId: p.baseUnitId }, orderBy: { validFrom: "asc" } });
    expect(rows.map((r) => r.amountMinor)).toEqual([1n, 2n, 3n, 4n]);
    expect(rows.filter((r) => r.validTo === null)).toHaveLength(1);
  });

  it("a database constraint violation becomes VERSION_CONFLICT or INVALID_INPUT, never an internal error", async () => {
    const { a } = await world();
    const p = await juice(a);
    // Corrupt-looking history the application lookup cannot see (closed, but covering the future):
    // the new open row overlaps it and the EXCLUDE constraint refuses.
    await seed(a, p.baseUnitId, "DEFAULT", "IQD", 1n, daysAgo(1), daysAhead(5));
    expect(await setPrice({ unitId: p.baseUnitId, listKind: "DEFAULT", currency: "IQD", amountMinor: 2n }, a.as("manager"))).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    expect(await db.rtPrice.count({ where: { unitId: p.baseUnitId } })).toBe(1);
    // The mapper itself, for the shapes a driver can raise.
    const exclusion = Object.assign(new Error("conflicting key value violates exclusion constraint"), { cause: { originalCode: "23P01" } });
    expect(() => mapPriceConstraintError(exclusion)).toThrow(expect.objectContaining({ name: "VersionConflictError" }));
    expect(() => mapPriceConstraintError({ code: "23514" })).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    const other = new Error("boom");
    expect(() => mapPriceConstraintError(other)).toThrow(other);
  });

  it("carton suggestion is factor times the base price per currency and is not applied automatically", async () => {
    const { a } = await world();
    const p = await juice(a);
    await seed(a, p.baseUnitId, "DEFAULT", "IQD", 500n, daysAgo(1));
    const l = await lists(a);
    const sug = (currency: "IQD" | "USD", unitId = p.cartonId) => suggestedUnitPrice({ unitId, currency }, a.as("cashier"));
    expect(await sug("IQD")).toMatchObject({ ok: true, value: { amountMinor: 12_000n, factor: 24, baseAmountMinor: 500n } });
    // No base price in USD yet: nothing to suggest.
    expect(await sug("USD")).toEqual({ ok: true, value: null });
    await setPrice({ unitId: p.baseUnitId, priceListId: l.DEFAULT, currency: "USD", amountMinor: 75n }, a.as("manager"));
    expect(await sug("USD")).toMatchObject({ ok: true, value: { amountMinor: 1800n } });
    // The base unit's own suggestion is its price (factor 1).
    expect(await sug("IQD", p.baseUnitId)).toMatchObject({ ok: true, value: { amountMinor: 500n, factor: 1 } });
    // Suggesting stored nothing: the carton has no price until someone sets one.
    expect(await db.rtPrice.count({ where: { unitId: p.cartonId } })).toBe(0);
    expect(await getPriceAt({ unitId: p.cartonId, priceListId: l.DEFAULT, currency: "IQD", at: new Date() }, a.as("cashier"))).toEqual({ ok: true, value: null });
  });

  it("raising the base price does not change the carton price", async () => {
    const { a } = await world();
    const p = await juice(a);
    await seed(a, p.baseUnitId, "DEFAULT", "IQD", 500n, daysAgo(3));
    const l = await lists(a);
    await seed(a, p.cartonId, "DEFAULT", "IQD", 11_000n, daysAgo(3));
    await setPrice({ unitId: p.baseUnitId, priceListId: l.DEFAULT, currency: "IQD", amountMinor: 650n }, a.as("manager"));
    const carton = await getPriceAt({ unitId: p.cartonId, priceListId: l.DEFAULT, currency: "IQD", at: new Date() }, a.as("cashier"));
    expect(carton).toMatchObject({ ok: true, value: { amountMinor: 11_000n } });
    // The suggestion moves with the base price; the stored carton price does not.
    expect(await suggestedUnitPrice({ unitId: p.cartonId, currency: "IQD" }, a.as("cashier"))).toMatchObject({ ok: true, value: { amountMinor: 15_600n } });
    expect(await db.rtPrice.count({ where: { unitId: p.cartonId } })).toBe(1);
  });

  it("dinar and dollar prices coexist for one unit", async () => {
    const { a } = await world();
    const p = await juice(a);
    await seed(a, p.baseUnitId, "DEFAULT", "IQD", 1500n, daysAgo(2));
    const l = await lists(a);
    expect(await seed(a, p.baseUnitId, "DEFAULT", "USD", 100n, daysAgo(2))).toMatchObject({ ok: true });
    // Changing the dinar price leaves the dollar one alone.
    await setPrice({ unitId: p.baseUnitId, priceListId: l.DEFAULT, currency: "IQD", amountMinor: 2000n }, a.as("manager"));
    const now = new Date();
    expect(await getPriceAt({ unitId: p.baseUnitId, priceListId: l.DEFAULT, currency: "IQD", at: now }, a.as("cashier"))).toMatchObject({ value: { amountMinor: 2000n } });
    expect(await getPriceAt({ unitId: p.baseUnitId, priceListId: l.DEFAULT, currency: "USD", at: now }, a.as("cashier"))).toMatchObject({ value: { amountMinor: 100n } });
    expect(await db.rtPrice.count({ where: { unitId: p.baseUnitId, validTo: null } })).toBe(2);
    // A currency the business has not enabled is refused.
    await db.rtBusiness.update({ where: { id: a.business.id }, data: { enabledCurrencies: ["IQD"] } });
    expect(await setPrice({ unitId: p.baseUnitId, priceListId: l.DEFAULT, currency: "USD", amountMinor: 120n }, a.as("manager"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });

  it("a unit with no wholesale price falls back to the default list", async () => {
    const { a } = await world();
    const p = await juice(a);
    await seed(a, p.baseUnitId, "DEFAULT", "IQD", 500n, daysAgo(2));
    const resolve = (unitId: string, wholesale: boolean, currency: "IQD" | "USD" = "IQD") =>
      db.$transaction((tx) => resolvePrice(tx, { unitId, currency, at: new Date(), wholesale }));
    expect(await resolve(p.baseUnitId, true)).toMatchObject({ amountMinor: 500n, listKind: "DEFAULT" });
    await seed(a, p.baseUnitId, "WHOLESALE", "IQD", 420n, daysAgo(1));
    expect(await resolve(p.baseUnitId, true)).toMatchObject({ amountMinor: 420n, listKind: "WHOLESALE" });
    // Retail never looks at the wholesale list.
    expect(await resolve(p.baseUnitId, false)).toMatchObject({ amountMinor: 500n, listKind: "DEFAULT" });
    // Wholesale in dollars: no wholesale and no default dollar price -> null.
    expect(await resolve(p.baseUnitId, true, "USD")).toBeNull();
    // The other unit has nothing at all.
    expect(await resolve(p.cartonId, true)).toBeNull();
  });

  it("a manager changes prices, a stock officer cannot", async () => {
    const { a } = await world();
    const p = await juice(a);
    const input = { unitId: p.baseUnitId, listKind: "DEFAULT" as const, currency: "IQD" as const, amountMinor: 500n };
    expect(await setPrice(input, a.as("stock"))).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await setPrice(input, a.as("cashier"))).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await db.rtPrice.count({ where: { businessId: a.business.id } })).toBe(0);
    expect(await setPrice(input, a.as("manager"))).toMatchObject({ ok: true });
    expect(await setPrice({ ...input, amountMinor: 600n }, a.as("owner"))).toMatchObject({ ok: true });
    // Reading is open to every member.
    expect(await listUnitPrices({ unitId: p.baseUnitId }, a.as("cashier"))).toMatchObject({ ok: true });
    expect(await listPriceLists({}, a.as("stock"))).toMatchObject({ ok: true });
  });

  it("a stale price edit gives VERSION_CONFLICT", async () => {
    const { a } = await world();
    const p = await juice(a);
    const first = await setPrice({ unitId: p.baseUnitId, listKind: "DEFAULT", currency: "IQD", amountMinor: 500n, expectedLatestPriceId: null }, a.as("manager"));
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) return;
    const l = await lists(a);
    const base = { unitId: p.baseUnitId, priceListId: l.DEFAULT, currency: "IQD" as const };
    // Two people both saw the first price; the second save is stale.
    const mine = await setPrice({ ...base, amountMinor: 600n, expectedLatestPriceId: first.value.id }, a.as("manager"));
    expect(mine).toMatchObject({ ok: true });
    const theirs = await setPrice({ ...base, amountMinor: 700n, expectedLatestPriceId: first.value.id }, a.as("owner"));
    expect(theirs).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    // "I saw no price yet" is stale as soon as one exists.
    expect(await setPrice({ ...base, amountMinor: 700n, expectedLatestPriceId: null }, a.as("owner"))).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    const open = await db.rtPrice.findMany({ where: { unitId: p.baseUnitId, validTo: null } });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ amountMinor: 600n });
    // Without the guard the last write simply wins (a new dated row), nothing is overwritten.
    if (!mine.ok) return;
    expect(await setPrice({ ...base, amountMinor: 800n }, a.as("owner"))).toMatchObject({ ok: true });
    expect(await db.rtPrice.count({ where: { unitId: p.baseUnitId } })).toBe(3);
  });
});

describe("price rules, isolation and safety", () => {
  it("another business's unit or list ids are rejected", async () => {
    const { a, b } = await world();
    const pa = await juice(a);
    const pb = await juice(b);
    await seed(b, pb.baseUnitId, "DEFAULT", "IQD", 500n, daysAgo(1));
    await seed(a, pa.baseUnitId, "DEFAULT", "IQD", 500n, daysAgo(1));
    const la = await lists(a);
    const lb = await lists(b);
    // A's manager names B's unit, or B's list.
    expect(await setPrice({ unitId: pb.baseUnitId, priceListId: la.DEFAULT, currency: "IQD", amountMinor: 1n }, a.as("manager"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await setPrice({ unitId: pa.baseUnitId, priceListId: lb.DEFAULT, currency: "IQD", amountMinor: 1n }, a.as("manager"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    // Reads too.
    expect(await getPriceAt({ unitId: pb.baseUnitId, priceListId: la.DEFAULT, currency: "IQD", at: new Date() }, a.as("manager"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await getPriceAt({ unitId: pa.baseUnitId, priceListId: lb.DEFAULT, currency: "IQD", at: new Date() }, a.as("manager"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await listUnitPrices({ unitId: pb.baseUnitId }, a.as("manager"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await suggestedUnitPrice({ unitId: pb.cartonId, currency: "IQD" }, a.as("manager"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await db.rtPrice.count({ where: { businessId: b.business.id } })).toBe(1);
    expect(await db.rtPrice.count({ where: { businessId: a.business.id } })).toBe(1);
    // Each business has exactly its own two lists.
    expect(await db.rtPriceList.count({ where: { businessId: a.business.id } })).toBe(2);
  });

  it("every write is refused in READ_ONLY, reads still work", async () => {
    const { a } = await world();
    const p = await juice(a);
    await seed(a, p.baseUnitId, "DEFAULT", "IQD", 500n, daysAgo(1));
    const l = await lists(a);
    await db.rtBusiness.update({ where: { id: a.business.id }, data: { status: "SUSPENDED" } });
    expect(await setPrice({ unitId: p.baseUnitId, priceListId: l.DEFAULT, currency: "IQD", amountMinor: 900n }, a.as("owner"))).toMatchObject({ ok: false, code: "READ_ONLY" });
    expect(await getPriceAt({ unitId: p.baseUnitId, priceListId: l.DEFAULT, currency: "IQD", at: new Date() }, a.as("cashier"))).toMatchObject({ ok: true, value: { amountMinor: 500n } });
    expect(await listUnitPrices({ unitId: p.baseUnitId }, a.as("cashier"))).toMatchObject({ ok: true });
    expect(await db.rtPrice.count({ where: { unitId: p.baseUnitId } })).toBe(1);
  });

  it("an archived unit, variant or product can not be priced", async () => {
    const { a } = await world();
    const p = await juice(a);
    await seed(a, p.baseUnitId, "DEFAULT", "IQD", 500n, daysAgo(1));
    const l = await lists(a);
    const archived = await archiveUnit({ id: p.cartonId, expectedVersion: 1 }, a.as("manager"));
    expect(archived).toMatchObject({ ok: true });
    const set = (unitId: string) => setPrice({ unitId, priceListId: l.DEFAULT, currency: "IQD", amountMinor: 9n }, a.as("manager"));
    expect(await set(p.cartonId)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await archiveProduct({ id: p.productId, expectedVersion: 1 }, a.as("manager"))).toMatchObject({ ok: true });
    expect(await set(p.baseUnitId)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await db.rtPrice.count({ where: { businessId: a.business.id } })).toBe(1);
    // History of an archived unit is still readable.
    expect(await listUnitPrices({ unitId: p.baseUnitId }, a.as("cashier"))).toMatchObject({ ok: true });
  });

  it("amounts: zero is allowed, negative and above the cap are refused, lists are created on demand", async () => {
    const { a } = await world();
    const p = await juice(a);
    expect(await listPriceLists({}, a.as("owner"))).toEqual({ ok: true, value: [] });
    expect(await db.rtPriceList.count({ where: { businessId: a.business.id } })).toBe(0);
    expect(await seed(a, p.baseUnitId, "DEFAULT", "IQD", 0n, daysAgo(1))).toMatchObject({ ok: true });
    const listed = await listPriceLists({}, a.as("owner"));
    expect(listed.ok && listed.value.map((x) => x.kind).sort()).toEqual(["DEFAULT", "WHOLESALE"]);
    const l = await lists(a);
    const base = { unitId: p.baseUnitId, priceListId: l.DEFAULT, currency: "IQD" as const };
    expect(await setPrice({ ...base, amountMinor: -1n }, a.as("manager"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await setPrice({ ...base, amountMinor: 10n ** 18n + 1n }, a.as("manager"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await setPrice({ ...base, amountMinor: 10n ** 18n }, a.as("manager"))).toMatchObject({ ok: true });
    // A string of digits is accepted as money, anything else is not.
    expect(await setPrice({ ...base, amountMinor: "250" as unknown as bigint }, a.as("manager"))).toMatchObject({ ok: true, value: { amountMinor: 250n } });
    expect(await setPrice({ ...base, amountMinor: "2.5" as unknown as bigint }, a.as("manager"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });

  it("replaying the same key returns the first result and writes nothing more", async () => {
    const { a } = await world();
    const p = await juice(a);
    const k = key();
    const input = { unitId: p.baseUnitId, listKind: "DEFAULT" as const, currency: "IQD" as const, amountMinor: 500n };
    const first = await setPrice(input, a.as("manager", k));
    const again = await setPrice(input, a.as("manager", k));
    expect(first).toMatchObject({ ok: true });
    expect(again).toEqual(first);
    expect(await db.rtPrice.count({ where: { unitId: p.baseUnitId } })).toBe(1);
    expect(await setPrice({ ...input, amountMinor: 501n }, a.as("manager", k))).toMatchObject({ ok: false, code: "IDEMPOTENCY_MISMATCH" });
  });
});

describe("concurrency: one product lock for every price change", () => {
  /** Holds the product's advisory lock while the callers queue behind it, then lets them run. */
  async function holdingProductLock<T>(a: Shop, productId: string, start: () => T, count: number): Promise<T> {
    let started: T | undefined;
    await db.$transaction(
      async (t) => {
        await t.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`business-lock:${a.business.id}:catalog.product:${productId}`}, 0))`;
        started = start();
        expect(await untilWaiting(count)).toBe(true);
      },
      { timeout: 20_000 },
    );
    return started as T;
  }

  it("concurrent setPrice on one unit leaves exactly one open period", async () => {
    const { a } = await world();
    const p = await juice(a);
    await seed(a, p.baseUnitId, "DEFAULT", "IQD", 500n, daysAgo(1));
    const l = await lists(a);
    const base = { unitId: p.baseUnitId, priceListId: l.DEFAULT, currency: "IQD" as const };
    const calls = await holdingProductLock(
      a,
      p.productId,
      () => [600n, 700n, 800n].map((amountMinor, i) => tracked(setPrice({ ...base, amountMinor }, a.as(i % 2 ? "owner" : "manager")))),
      3,
    );
    const results = await Promise.all(calls.map((c) => c.promise));
    // Without a guard every call succeeds one after the other (each gets a later instant).
    expect(results.every((r) => r.ok)).toBe(true);
    const rows = await db.rtPrice.findMany({ where: { unitId: p.baseUnitId }, orderBy: { validFrom: "asc" } });
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.validTo === null)).toHaveLength(1);
    for (let i = 0; i + 1 < rows.length; i += 1) expect(rows[i]!.validTo?.getTime()).toBe(rows[i + 1]!.validFrom.getTime());
  });

  it("two stale editors racing: exactly one wins, the other gets VERSION_CONFLICT", async () => {
    const { a } = await world();
    const p = await juice(a);
    const first = await seed(a, p.baseUnitId, "DEFAULT", "IQD", 500n, daysAgo(1));
    if (!first.ok) throw new Error("setup");
    const l = await lists(a);
    const base = { unitId: p.baseUnitId, priceListId: l.DEFAULT, currency: "IQD" as const, expectedLatestPriceId: first.value.id };
    const calls = await holdingProductLock(
      a,
      p.productId,
      () => [650n, 750n].map((amountMinor, i) => tracked(setPrice({ ...base, amountMinor }, a.as(i ? "owner" : "manager")))),
      2,
    );
    const results = await Promise.all(calls.map((c) => c.promise));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([expect.objectContaining({ code: "VERSION_CONFLICT" })]);
    const rows = await db.rtPrice.findMany({ where: { unitId: p.baseUnitId } });
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.validTo === null)).toHaveLength(1);
  });

  it("concurrent first prices of a business create the lists once", async () => {
    const { a } = await world();
    const p1 = await juice(a, "أول");
    const p2 = await juice(a, "ثاني");
    const r = await Promise.all([
      setPrice({ unitId: p1.baseUnitId, listKind: "DEFAULT", currency: "IQD", amountMinor: 1n }, a.as("manager")),
      setPrice({ unitId: p2.baseUnitId, listKind: "DEFAULT", currency: "IQD", amountMinor: 2n }, a.as("owner")),
    ]);
    expect(r.every((v) => v.ok)).toBe(true);
    expect(await db.rtPriceList.count({ where: { businessId: a.business.id } })).toBe(2);
  });
});
