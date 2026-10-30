import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RtTrackingMode } from "@/generated/prisma/client";
import { normalizeSearchText } from "@/server/domain/catalog";
import { businessToday } from "@/server/domain/stock";
import { adjustStock, writeOffStock } from "@/server/stock/adjust";
import { postStockDocument, saveStockDraft, type DraftLineInput } from "@/server/stock/documents";
import { getVariantStock, listExpiring, listMovements, listStock, stockContext } from "@/server/stock/queries";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createPlan } from "../helpers/fixtures";

const { db } = useTestDb();

const DAY = 86_400_000;
const key = () => randomUUID();
const U = 1000n; // one base unit (quantities are base x 1000)
let skuSeq = 0;

type ItemOpts = { name?: string; trackingMode?: RtTrackingMode; tracksExpiry?: boolean; alertDays?: number; barcode?: string };

/** An active business with branches Main and Second, one location each, and a few staff. */
async function shop(label = "A") {
  if ((await db.rtPlan.count()) === 0) await createPlan(db, { maxBranches: 3 });
  const w = await createBusinessWithStaff(db, {
    branches: ["Main", "Second"],
    staff: [
      { key: "owner", role: "OWNER" },
      { key: "manager", role: "MANAGER" },
      { key: "stock", role: "STOCK", branches: ["Main"] },
      { key: "cashier", role: "CASHIER", branches: ["Main"] },
    ],
  });
  const businessId = w.business.id;
  await db.rtBusiness.update({
    where: { id: businessId },
    data: { status: "ACTIVE", name: label, enabledCurrencies: ["IQD", "USD"], defaultCurrency: "IQD" },
  });
  await db.rtSubscription.create({
    data: {
      businessId,
      planCode: "basic",
      status: "ACTIVE",
      currentPeriodStart: new Date(Date.now() - DAY),
      currentPeriodEnd: new Date(Date.now() + 30 * DAY),
    },
  });
  const locations: Record<string, string> = {};
  for (const name of ["Main", "Second"]) {
    const l = await db.rtLocation.create({ data: { businessId, branchId: w.branches[name]!.id, name: "المخزن الرئيسي" } });
    locations[name] = l.id;
  }
  const as = (who: string, k = key()) => ({ userId: w.staff[who]!.user.id, businessId, idempotencyKey: k });

  /** A product with one variant: a base piece and a carton of 24. */
  async function item(o: ItemOpts = {}) {
    const nameAr = o.name ?? "حليب";
    const product = await db.rtProduct.create({
      data: {
        businessId,
        nameAr,
        trackingMode: o.trackingMode ?? (o.tracksExpiry ? "BATCH" : "NONE"),
        tracksExpiry: o.tracksExpiry ?? false,
        expiryAlertDays: o.alertDays ?? null,
      },
    });
    const sku = `Q-${++skuSeq}`;
    const variant = await db.rtVariant.create({
      data: { businessId, productId: product.id, sku, searchText: normalizeSearchText(`${nameAr} ${sku} ${o.barcode ?? ""}`) },
    });
    const piece = await db.rtUnit.create({ data: { businessId, variantId: variant.id, name: "حبة", factor: 1, isBase: true } });
    const carton = await db.rtUnit.create({ data: { businessId, variantId: variant.id, name: "كرتون", factor: 24 } });
    if (o.barcode) await db.rtBarcode.create({ data: { businessId, unitId: piece.id, code: o.barcode } });
    return { productId: product.id, variantId: variant.id, piece: piece.id, carton: carton.id, sku };
  }

  const balance = async (variantId: string) => {
    const s = await db.rtStockBalance.aggregate({ where: { businessId, variantId }, _sum: { qty: true, valueMinor: true } });
    return { qty: s._sum.qty ?? 0n, valueMinor: s._sum.valueMinor ?? 0n };
  };

  return { ...w, businessId, locations, as, item, balance };
}

type Shop = Awaited<ReturnType<typeof shop>>;
type Item = Awaited<ReturnType<Shop["item"]>>;

const iqd = (amount: string) => ({ amount, currency: "IQD" as const });
const line = (it: Item, quantity: string, extra: Partial<DraftLineInput> = {}): DraftLineInput => ({
  variantId: it.variantId,
  unitId: it.piece,
  quantity,
  ...extra,
});
const dayIn = (zone: string, offsetDays: number) => new Date(businessToday(new Date(), zone).getTime() + offsetDays * DAY).toISOString().slice(0, 10);
const isoDay = (offsetDays: number) => dayIn("Asia/Baghdad", offsetDays);

async function post(s: Shop, lines: DraftLineInput[], kind: "OPENING" | "RECEIPT" = "RECEIPT", who = "owner") {
  const d = await saveStockDraft({ kind, lines }, s.as(who));
  if (!d.ok) throw new Error(`draft refused: ${d.code}`);
  const r = await postStockDocument({ documentId: d.value.documentId, expectedVersion: d.value.version }, s.as(who));
  if (!r.ok) throw new Error(`post refused: ${r.code} ${JSON.stringify(r.details ?? {})}`);
  return r.value;
}

const text = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

function ok<T>(r: { ok: true; value: T } | { ok: false; code: string }): T {
  if (!r.ok) throw new Error(`refused: ${r.code}`);
  return r.value;
}

describe("stock queries", () => {
  it("the list searches by Arabic name and barcode and shows cartons and pieces", async () => {
    const s = await shop();
    const milk = await s.item({ name: "حليب طازج", barcode: "6281000000011" });
    const juice = await s.item({ name: "عصير برتقال" });
    await post(s, [line(milk, "2", { unitId: milk.carton, cost: iqd("2400") }), line(milk, "5", { cost: iqd("100") }), line(juice, "7", { cost: iqd("50") })]);

    const byName = ok(await listStock({ query: "حليب" }, s.as("owner")));
    expect(byName.rows.map((r) => r.variantId)).toEqual([milk.variantId]);
    expect(byName.rows[0]).toMatchObject({
      nameAr: "حليب طازج",
      sku: milk.sku,
      qty: 53n * U,
      availableQty: 53n * U,
      breakdown: { parts: [{ name: "كرتون", count: 2n }, { name: "حبة", count: 5n }], remainder: 0n },
      nearestExpiry: null,
      status: "NONE",
    });
    // 2 cartons at 2,400 (100 a piece) and 5 pieces at 100: 53 pieces worth 5,300, 100 each.
    expect(byName.rows[0]).toMatchObject({ valueMinor: 5_300n, avgUnitCostMinor: 100n });

    const byBarcode = ok(await listStock({ query: "6281000000011" }, s.as("owner")));
    expect(byBarcode.rows.map((r) => r.variantId)).toEqual([milk.variantId]);
    expect(ok(await listStock({ query: "لا يوجد" }, s.as("owner"))).rows).toEqual([]);

    // A variant without stock is listed with zero and no average.
    const empty = await s.item({ name: "ماء" });
    const all = ok(await listStock({}, s.as("owner")));
    expect(all.rows.map((r) => r.variantId).sort()).toEqual([milk.variantId, juice.variantId, empty.variantId].sort());
    const zero = all.rows.find((r) => r.variantId === empty.variantId)!;
    expect(zero).toMatchObject({ qty: 0n, availableQty: 0n, breakdown: { parts: [], remainder: 0n }, valueMinor: 0n });
    expect("avgUnitCostMinor" in zero).toBe(false);

    // A cashier reads quantities.
    expect(ok(await listStock({ query: "حليب" }, s.as("cashier"))).rows[0]).toMatchObject({ qty: 53n * U });
  });

  it("expired batches are not counted as available", async () => {
    const s = await shop();
    const m = await s.item({ tracksExpiry: true });
    const fresh = await s.item({ tracksExpiry: true, name: "لبن" });
    const opening = await post(s, [line(m, "5", { cost: iqd("100"), expiryDate: isoDay(-3), batchCode: "OLD" })], "OPENING");
    await post(s, [line(m, "7", { cost: iqd("100"), expiryDate: isoDay(10), batchCode: "NEW" }), line(fresh, "4", { cost: iqd("10"), expiryDate: isoDay(200) })]);

    const row = ok(await listStock({ query: "حليب" }, s.as("owner"))).rows[0]!;
    expect(row).toMatchObject({ qty: 12n * U, availableQty: 7n * U, status: "EXPIRED" });
    expect(row.nearestExpiry?.toISOString().slice(0, 10)).toBe(isoDay(-3));
    const detail = ok(await getVariantStock({ variantId: m.variantId }, s.as("owner")));
    expect(detail.batches.map((b) => [b.code, b.status, b.qty])).toEqual([
      ["OLD", "EXPIRED", 5n * U],
      ["NEW", "SOON", 7n * U],
    ]);
    expect(detail.total).toMatchObject({ qty: 12n * U, availableQty: 7n * U, status: "EXPIRED" });

    const expiring = ok(await listStock({ expiringOnly: true }, s.as("owner")));
    expect(expiring.rows.map((r) => r.variantId)).toEqual([m.variantId]);

    // Writing the expired batch off: nothing expired holds stock any more.
    const oldBatch = opening.lines[0]!.batchId!;
    ok(await writeOffStock({ variantId: m.variantId, unitId: m.piece, batchId: oldBatch, quantity: "5", reason: "EXPIRED" }, s.as("owner")));
    const after = ok(await listStock({ query: "حليب" }, s.as("owner"))).rows[0]!;
    expect(after).toMatchObject({ qty: 7n * U, availableQty: 7n * U, status: "SOON" });
    expect(ok(await getVariantStock({ variantId: m.variantId }, s.as("owner"))).batches.map((b) => b.code)).toEqual(["NEW"]);
  });

  it("listExpiring honours each product's alert days and the business timezone", async () => {
    const s = await shop();
    const a = await s.item({ name: "جبن", tracksExpiry: true, alertDays: 5 });
    const b = await s.item({ name: "زبدة", tracksExpiry: true });
    await post(s, [line(b, "3", { cost: iqd("10"), expiryDate: isoDay(-2), batchCode: "BOLD" })], "OPENING");
    await post(s, [
      line(a, "1", { cost: iqd("10"), expiryDate: isoDay(4), batchCode: "A4" }),
      line(a, "1", { cost: iqd("10"), expiryDate: isoDay(6), batchCode: "A6" }),
      line(b, "1", { cost: iqd("10"), expiryDate: isoDay(20), batchCode: "B20" }),
      line(b, "1", { cost: iqd("10"), expiryDate: isoDay(40), batchCode: "B40" }),
    ]);

    const codes = (r: { rows: { code: string | null }[] }) => r.rows.map((x) => x.code);
    expect(codes(ok(await listExpiring({}, s.as("owner"))))).toEqual(["BOLD", "A4", "B20"]);
    const old = ok(await listExpiring({}, s.as("owner"))).rows[0]!;
    expect(old).toMatchObject({ status: "EXPIRED", qty: 3n * U, nameAr: "زبدة" });
    expect(old.daysLeft).toBeLessThan(0);
    // An explicit window replaces the per-product days.
    expect(codes(ok(await listExpiring({ withinDays: 10 }, s.as("owner"))))).toEqual(["BOLD", "A4", "A6"]);
    expect(codes(ok(await listExpiring({ withinDays: 100 }, s.as("owner"))))).toEqual(["BOLD", "A4", "A6", "B20", "B40"]);

    // The same expiry date is SOON in the last time zone of the day and EXPIRED in the first.
    const c = await s.item({ name: "قشطة", tracksExpiry: true });
    await db.rtBusiness.update({ where: { id: s.businessId }, data: { timezone: "Pacific/Pago_Pago" } });
    const edge = dayIn("Pacific/Pago_Pago", 0);
    await post(s, [line(c, "1", { cost: iqd("10"), expiryDate: edge, batchCode: "EDGE" })], "OPENING");
    const find = async () => ok(await listExpiring({ withinDays: 0 }, s.as("owner"))).rows.find((r) => r.code === "EDGE");
    expect(await find()).toMatchObject({ status: "SOON", daysLeft: 0 });
    await db.rtBusiness.update({ where: { id: s.businessId }, data: { timezone: "Pacific/Kiritimati" } });
    expect(await find()).toMatchObject({ status: "EXPIRED" });
    expect((await find())!.daysLeft).toBeLessThan(0);
  });

  it("the movement history shows a running balance that matches the ledger", async () => {
    const s = await shop();
    const it1 = await s.item();
    await post(s, [line(it1, "10", { cost: iqd("100") })]);
    await post(s, [line(it1, "5", { cost: iqd("160") })]);
    ok(await writeOffStock({ variantId: it1.variantId, unitId: it1.piece, quantity: "3", reason: "DAMAGED" }, s.as("owner")));
    ok(await adjustStock({ variantId: it1.variantId, unitId: it1.piece, direction: "IN", quantity: "2", reason: "COUNT_FIX" }, s.as("owner")));
    ok(await adjustStock({ variantId: it1.variantId, unitId: it1.piece, direction: "OUT", quantity: "4", reason: "LOST" }, s.as("owner")));

    const all = ok(await listMovements({ variantId: it1.variantId }, s.as("owner")));
    expect(all.nextCursor).toBeNull();
    expect(all.rows.map((r) => r.qtyDelta)).toEqual([-4n * U, 2n * U, -3n * U, 5n * U, 10n * U]);
    expect(all.rows.map((r) => r.qtyAfter)).toEqual([10n * U, 14n * U, 12n * U, 15n * U, 10n * U]);
    expect(all.rows.map((r) => r.documentNumber)).toEqual([5, 4, 3, 2, 1]);
    expect(all.rows.map((r) => r.documentKind)).toEqual(["ADJUSTMENT", "ADJUSTMENT", "WRITE_OFF", "RECEIPT", "RECEIPT"]);
    const bal = await s.balance(it1.variantId);
    expect(all.rows[0]).toMatchObject({ qtyAfter: bal.qty, valueAfterMinor: bal.valueMinor });
    expect(all.rows.at(-1)).toMatchObject({ qtyAfter: 10n * U, valueAfterMinor: 1_000n, valueDeltaMinor: 1_000n });

    // Paging two at a time gives the same rows in the same order, with the same balances.
    const paged: typeof all.rows = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const p = ok(await listMovements({ variantId: it1.variantId, limit: 2, ...(cursor ? { cursor } : {}) }, s.as("owner")));
      paged.push(...p.rows);
      if (!p.nextCursor) break;
      cursor = p.nextCursor;
    }
    expect(paged).toEqual(all.rows);
  });

  it("without cost.view no value or cost field exists in any response", async () => {
    const s = await shop();
    const it1 = await s.item({ tracksExpiry: true });
    await post(s, [line(it1, "10", { cost: iqd("100"), expiryDate: isoDay(3), batchCode: "X" })]);
    ok(await writeOffStock({ variantId: it1.variantId, unitId: it1.piece, quantity: "2", reason: "DAMAGED", batchId: (await db.rtBatch.findFirstOrThrow({ where: { variantId: it1.variantId } })).id }, s.as("owner")));

    const reads = async (who: string) => ({
      list: ok(await listStock({}, s.as(who))),
      expiring: ok(await listStock({ expiringOnly: true }, s.as(who))),
      variant: ok(await getVariantStock({ variantId: it1.variantId }, s.as(who))),
      moves: ok(await listMovements({ variantId: it1.variantId }, s.as(who))),
      soon: ok(await listExpiring({}, s.as(who))),
      context: ok(await stockContext({}, s.as(who))),
    });
    const keys = ["valueMinor", "avgUnitCostMinor", "valueDeltaMinor", "valueAfterMinor", "unitCostMinor", "cost", "value"];
    for (const who of ["stock", "cashier", "manager"]) {
      const r = await reads(who);
      expect(r.list.rows).toHaveLength(1);
      expect(r.list.rows[0]!.qty).toBe(8n * U);
      for (const [name, v] of Object.entries(r)) {
        for (const k of keys) expect(text(v), `${who} ${name} ${k}`).not.toContain(`"${k}"`);
      }
      expect(r.context.canSeeCost).toBe(false);
    }

    // The owner sees the totals, never a value per batch.
    const o = await reads("owner");
    expect(o.list.rows[0]).toMatchObject({ valueMinor: 800n, avgUnitCostMinor: 100n });
    expect(o.variant.total).toMatchObject({ valueMinor: 800n, avgUnitCostMinor: 100n });
    expect(text(o.variant.batches)).not.toContain("alue");
    expect(text(o.soon)).not.toContain("alue");
    expect(o.moves.rows[0]).toMatchObject({ valueDeltaMinor: -200n, valueAfterMinor: 800n });
    expect(o.context.canSeeCost).toBe(true);
  });

  it("1500 variants page without gaps or repeats", async () => {
    const s = await shop();
    const names = ["أرز", "سكر", "شاي"];
    const products = Array.from({ length: 1500 }, (_, i) => ({ id: `p${i}`, businessId: s.businessId, nameAr: names[i % 3]! }));
    await db.rtProduct.createMany({ data: products });
    await db.rtVariant.createMany({ data: products.map((p, i) => ({ id: `v${i}`, businessId: s.businessId, productId: p.id, sku: `BULK-${i}` })) });
    await db.rtUnit.createMany({ data: products.map((_, i) => ({ id: `u${i}`, businessId: s.businessId, variantId: `v${i}`, name: "حبة", factor: 1, isBase: true })) });

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 40; i++) {
      const page = ok(await listStock({ limit: 50, ...(cursor ? { cursor } : {}) }, s.as("owner")));
      expect(page.rows.length).toBeLessThanOrEqual(50);
      seen.push(...page.rows.map((r) => r.variantId));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(1500);
    expect(new Set(seen).size).toBe(1500);
    expect(await listStock({ limit: 51 }, s.as("owner"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  }, 120_000);

  it("stockContext gives the role, the location, the permissions and the last foreign rate", async () => {
    const s = await shop();
    const it1 = await s.item();
    expect(ok(await stockContext({}, s.as("owner")))).toMatchObject({
      role: "OWNER",
      locationId: s.locations.Main,
      canReceive: true,
      canAdjust: true,
      canSeeCost: true,
      defaultCurrency: "IQD",
      enabledCurrencies: ["IQD", "USD"],
      lastRateMicro: null,
    });
    // A draft with a rate is not a posted line; the posted one counts, the newest wins.
    ok(await saveStockDraft({ kind: "RECEIPT", lines: [line(it1, "1", { cost: { amount: "1.00", currency: "USD" }, rate: "1300" })] }, s.as("owner")));
    expect(ok(await stockContext({}, s.as("owner"))).lastRateMicro).toBeNull();
    await post(s, [line(it1, "1", { cost: { amount: "1.00", currency: "USD" }, rate: "1450" })]);
    await post(s, [line(it1, "1", { cost: { amount: "1.00", currency: "USD" }, rate: "1500.5" })]);
    expect(ok(await stockContext({}, s.as("owner"))).lastRateMicro).toBe(1_500_500_000n);
    const cashier = ok(await stockContext({}, s.as("cashier")));
    expect(cashier).toMatchObject({ role: "CASHIER", canReceive: false, canAdjust: false, canSeeCost: false });
    expect("lastRateMicro" in cashier).toBe(false);
  });

  it("another business never appears", async () => {
    const a = await shop("A");
    const b = await shop("B");
    const ia = await a.item({ name: "حليب خاص" });
    await post(a, [line(ia, "5", { cost: iqd("10") })]);
    expect(ok(await listStock({ query: "حليب" }, b.as("owner"))).rows).toEqual([]);
    expect(ok(await listStock({}, b.as("owner"))).rows).toEqual([]);
    expect(await getVariantStock({ variantId: ia.variantId }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await listMovements({ variantId: ia.variantId }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(ok(await listExpiring({ withinDays: 3650 }, b.as("owner"))).rows).toEqual([]);
    expect(ok(await listStock({}, a.as("owner"))).rows).toHaveLength(1);
  });
});
