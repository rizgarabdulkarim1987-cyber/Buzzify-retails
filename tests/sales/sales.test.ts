import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RtTrackingMode } from "@/generated/prisma/client";
import { businessToday } from "@/server/domain/stock";
import { currentUnitPrices, listSellCategories, listSellItems } from "@/server/sales/catalog";
import { createSale, getSale } from "@/server/sales/sales";
import { closeShift, myOpenShift, openShift, shiftSummary, tillState } from "@/server/sales/shifts";
import { rebuildBalances } from "@/server/stock/ledger";
import { postStockDocument, saveStockDraft, type DraftLineInput } from "@/server/stock/documents";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createPlan } from "../helpers/fixtures";

const { db } = useTestDb();

const DAY = 86_400_000;
const key = () => randomUUID();
const U = 1000n; // one base unit (quantities are base x 1000)
let skuSeq = 0;

type ItemOpts = { trackingMode?: RtTrackingMode; tracksExpiry?: boolean; price?: bigint | null; cartonPrice?: bigint; quantityScale?: number; name?: string };

/** An active IQD business with branches Main and Second (one location each), an owner, a manager and two cashiers of Main. */
async function shop() {
  if ((await db.rtPlan.count()) === 0) await createPlan(db, { maxBranches: 3 });
  const w = await createBusinessWithStaff(db, {
    branches: ["Main", "Second"],
    staff: [
      { key: "owner", role: "OWNER" },
      { key: "manager", role: "MANAGER" },
      { key: "cashier", role: "CASHIER", branches: ["Main"] },
      { key: "cashier2", role: "CASHIER", branches: ["Main"] },
      { key: "stock", role: "STOCK", branches: ["Main"] },
    ],
  });
  const businessId = w.business.id;
  await db.rtBusiness.update({ where: { id: businessId }, data: { status: "ACTIVE" } });
  await db.rtSubscription.create({
    data: { businessId, planCode: "basic", status: "ACTIVE", currentPeriodStart: new Date(Date.now() - DAY), currentPeriodEnd: new Date(Date.now() + 30 * DAY) },
  });
  const locations: Record<string, string> = {};
  for (const name of ["Main", "Second"]) {
    const l = await db.rtLocation.create({ data: { businessId, branchId: w.branches[name]!.id, name: "المخزن" } });
    locations[name] = l.id;
  }
  const list = await db.rtPriceList.create({ data: { businessId, name: "الأسعار", kind: "DEFAULT" } });
  const as = (who: string, k = key()) => ({ userId: w.staff[who]!.user.id, businessId, idempotencyKey: k });

  async function price(unitId: string, amountMinor: bigint, validFrom = new Date(Date.now() - DAY)) {
    await db.rtPrice.create({ data: { businessId, unitId, priceListId: list.id, currency: "IQD", amountMinor, validFrom } });
  }

  /** A product with one variant: a base unit (piece, or kg with quantityScale 3) and a carton of 24, priced. */
  async function item(o: ItemOpts = {}) {
    const product = await db.rtProduct.create({
      data: {
        businessId,
        nameAr: o.name ?? "حليب",
        nameEn: "Milk",
        trackingMode: o.trackingMode ?? (o.tracksExpiry ? "BATCH" : "NONE"),
        tracksExpiry: o.tracksExpiry ?? false,
      },
    });
    const variant = await db.rtVariant.create({ data: { businessId, productId: product.id, sku: `S-${++skuSeq}` } });
    const piece = await db.rtUnit.create({
      data: { businessId, variantId: variant.id, name: o.quantityScale ? "كغم" : "حبة", factor: 1, isBase: true, quantityScale: o.quantityScale ?? 0 },
    });
    const carton = await db.rtUnit.create({ data: { businessId, variantId: variant.id, name: "كرتون", factor: 24 } });
    if (o.price !== null) await price(piece.id, o.price ?? 1000n);
    if (o.cartonPrice !== undefined) await price(carton.id, o.cartonPrice);
    return { productId: product.id, variantId: variant.id, piece: piece.id, carton: carton.id };
  }

  const onHand = async (variantId: string, location = locations.Main) => {
    const s = await db.rtStockBalance.aggregate({ where: { businessId, locationId: location, variantId }, _sum: { qty: true } });
    return s._sum.qty ?? 0n;
  };

  return { ...w, businessId, locations, as, item, price, onHand };
}

type Shop = Awaited<ReturnType<typeof shop>>;
type Item = Awaited<ReturnType<Shop["item"]>>;

const isoDay = (offsetDays: number) => new Date(businessToday(new Date(), "Asia/Baghdad").getTime() + offsetDays * DAY).toISOString().slice(0, 10);

/** Receives stock into Main as the owner (fails the test on refusal). */
async function receive(s: Shop, lines: DraftLineInput[], kind: "OPENING" | "RECEIPT" = "RECEIPT") {
  const d = await saveStockDraft({ kind, lines }, s.as("owner"));
  if (!d.ok) throw new Error(`draft refused: ${d.code}`);
  const r = await postStockDocument({ documentId: d.value.documentId, expectedVersion: d.value.version }, s.as("owner"));
  if (!r.ok) throw new Error(`post refused: ${r.code} ${JSON.stringify(r.details ?? {})}`);
  return r.value;
}

const stockOf = (it: Item, quantity: string, extra: Partial<DraftLineInput> = {}): DraftLineInput => ({
  variantId: it.variantId,
  unitId: it.piece,
  quantity,
  cost: { amount: "600", currency: "IQD" },
  ...extra,
});

async function open(s: Shop, who = "cashier", opening = 50_000n, branch = "Main") {
  const r = await openShift({ branchId: s.branches[branch]!.id, openingCashMinor: opening }, s.as(who));
  if (!r.ok) throw new Error(`open refused: ${r.code}`);
  return r.value;
}

type SaleLine = { variantId: string; unitId: string; quantity: string; unitPriceMinor?: bigint };
const sell = (s: Shop, lines: SaleLine[], payments: { method: "CASH" | "CARD"; amountMinor: bigint }[], who = "cashier", saleKey = key(), extra: { expectedTotalMinor?: bigint } = {}) =>
  createSale({ saleKey, lines, payments, ...extra }, s.as(who, saleKey));
const pieces = (it: Item, quantity: string): SaleLine => ({ variantId: it.variantId, unitId: it.piece, quantity });
const cash = (amountMinor: bigint) => ({ method: "CASH" as const, amountMinor });
const card = (amountMinor: bigint) => ({ method: "CARD" as const, amountMinor });

describe("cash-desk shifts", () => {
  it("a cashier opens one shift; a second open is refused until it is closed", async () => {
    const s = await shop();
    const shift = await open(s);
    expect(shift.status).toBe("OPEN");
    expect(shift.openingCashMinor).toBe(50_000n);
    expect(shift.locationId).toBe(s.locations.Main);
    const again = await openShift({ branchId: s.branches.Main!.id, openingCashMinor: 0n }, s.as("cashier"));
    expect(again.ok ? "ok" : again.code).toBe("SHIFT_ALREADY_OPEN");
    // Another cashier opens their own shift on the same branch.
    await open(s, "cashier2");
  });

  it("a cashier cannot open a shift in a branch they do not belong to", async () => {
    const s = await shop();
    const r = await openShiftAs(s, "cashier", "Second");
    expect(r.ok ? "ok" : r.code).toBe("NOT_FOUND");
  });

  it("closing counts the cash: expected = opening + cash kept, difference = counted - expected", async () => {
    const s = await shop();
    const it1 = await s.item({ price: 1500n });
    await receive(s, [stockOf(it1, "20")]);
    const shift = await open(s, "cashier", 10_000n);
    expect((await sell(s, [pieces(it1, "2")], [cash(5000n)])).ok).toBe(true); // 3000, change 2000
    expect((await sell(s, [pieces(it1, "3")], [card(4500n)])).ok).toBe(true);
    expect((await sell(s, [pieces(it1, "1")], [cash(500n), card(1000n)])).ok).toBe(true);

    const mine = await myOpenShift({}, s.as("cashier"));
    if (!mine.ok || !mine.value) throw new Error("no open shift");
    expect(mine.value).toMatchObject({ salesCount: 3, totalMinor: 9000n, cashMinor: 3500n, cardMinor: 5500n, expectedCashMinor: 13_500n });

    const closed = await closeShift({ shiftId: shift.id, countedCashMinor: 13_250n, expectedVersion: shift.version }, s.as("cashier"));
    if (!closed.ok) throw new Error(closed.code);
    expect(closed.value.expectedCashMinor).toBe(13_500n);
    expect(closed.value.differenceMinor).toBe(-250n);
    expect(closed.value.salesCount).toBe(3);
    const row = await db.rtShift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(row).toMatchObject({ status: "CLOSED", countedCashMinor: 13_250n, expectedCashMinor: 13_500n, differenceMinor: -250n });

    // Closed: no more sales on it, no second close; a new shift can open.
    expect(await codeOf(sell(s, [pieces(it1, "1")], [cash(1500n)]))).toBe("SHIFT_NOT_OPEN");
    expect(await codeOf(closeShift({ shiftId: shift.id, countedCashMinor: 0n, expectedVersion: shift.version + 1 }, s.as("cashier")))).toBe("SHIFT_NOT_OPEN");
    await open(s);
  });

  it("only the owner of a shift or a shift.manage role closes it", async () => {
    const s = await shop();
    const shift = await open(s);
    expect(await codeOf(closeShift({ shiftId: shift.id, countedCashMinor: 0n, expectedVersion: 1 }, s.as("cashier2")))).toBe("FORBIDDEN");
    expect(await codeOf(shiftSummary({ shiftId: shift.id }, s.as("cashier2")))).toBe("FORBIDDEN");
    const r = await closeShift({ shiftId: shift.id, countedCashMinor: 50_000n, expectedVersion: 1 }, s.as("manager"));
    expect(r.ok && r.value.differenceMinor).toBe(0n);
  });

  it("a stock officer cannot open a shift or sell", async () => {
    const s = await shop();
    expect(await codeOf(openShiftAs(s, "stock", "Main"))).toBe("FORBIDDEN");
  });
});

const openShiftAs = (s: Shop, who: string, branch: string) => openShift({ branchId: s.branches[branch]!.id, openingCashMinor: 0n }, s.as(who));
async function codeOf(p: Promise<{ ok: boolean; code?: string }>) {
  const r = await p;
  return r.ok ? "ok" : r.code;
}

describe("selling", () => {
  it("a cash sale posts the sale, its lines, payment and a SALE stock document in one go", async () => {
    const s = await shop();
    const it1 = await s.item({ price: 1250n, cartonPrice: 28_000n });
    await receive(s, [stockOf(it1, "48")]);
    const shift = await open(s);
    const r = await sell(s, [pieces(it1, "2"), { variantId: it1.variantId, unitId: it1.carton, quantity: "1" }], [cash(35_000n)]);
    if (!r.ok) throw new Error(`${r.code} ${JSON.stringify(r.details ?? {})}`);
    const sale = r.value;
    expect(sale.number).toBe(1);
    expect(sale.totalMinor).toBe(30_500n);
    expect(sale.changeMinor).toBe(4500n);
    expect(sale.paidMinor).toBe(35_000n);
    expect(sale.shiftId).toBe(shift.id);
    expect(sale.lines.map((l) => [l.unitName, l.enteredQuantity, l.unitPriceMinor, l.lineTotalMinor])).toEqual([
      ["حبة", "2", 1250n, 2500n],
      ["كرتون", "1", 28_000n, 28_000n],
    ]);
    expect(sale.payments).toEqual([{ method: "CASH", amountMinor: 30_500n, tenderedMinor: 35_000n, tenderedCurrency: null, tenderedForeignMinor: null, rateMicro: null }]);
    expect(await s.onHand(it1.variantId)).toBe(48n * U - 26n * U);

    const row = await db.rtSale.findUniqueOrThrow({ where: { id: sale.saleId } });
    const doc = await db.rtStockDocument.findUniqueOrThrow({ where: { id: row.stockDocumentId } });
    expect(doc).toMatchObject({ kind: "SALE", status: "POSTED", locationId: s.locations.Main });
    const moves = await db.rtStockMovement.findMany({ where: { documentId: doc.id } });
    expect(moves.reduce((t, m) => t + m.qtyDelta, 0n)).toBe(-26n * U);
    // The cost went out at the average (600 a piece) and is kept on the lines, not on the receipt.
    const lines = await db.rtSaleLine.findMany({ where: { saleId: sale.saleId }, orderBy: { lineNo: "asc" } });
    expect(lines.map((l) => l.costMinor)).toEqual([1200n, 14_400n]);
    expect(JSON.stringify(sale, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))).not.toContain("cost");
    // The ledger still rebuilds to the same balances.
    expect((await rebuildBalances(db, s.businessId, { fix: false })).mismatches).toEqual([]);
    const read = await getSale({ saleId: sale.saleId }, s.as("cashier"));
    expect(read.ok && read.value.number).toBe(1);
  });

  it("a double tap or a retry with the same key posts one sale", async () => {
    const s = await shop();
    const it1 = await s.item({ price: 1000n });
    await receive(s, [stockOf(it1, "10")]);
    await open(s);
    const k = key();
    const [a, b] = await Promise.all([sell(s, [pieces(it1, "1")], [cash(1000n)], "cashier", k), sell(s, [pieces(it1, "1")], [cash(1000n)], "cashier", k)]);
    expect(a.ok && b.ok).toBe(true);
    const again = await sell(s, [pieces(it1, "1")], [cash(1000n)], "cashier", k);
    expect(again.ok && again.value.number).toBe(1);
    expect(await db.rtSale.count({ where: { businessId: s.businessId } })).toBe(1);
    expect(await s.onHand(it1.variantId)).toBe(9n * U);
    // The same sale key under a new idempotency key (a reload) still returns the sale already posted.
    const reload = await createSale({ saleKey: k, lines: [pieces(it1, "1")], payments: [cash(1000n)] }, s.as("cashier", key()));
    expect(reload.ok && reload.value.replayed).toBe(true);
    expect(await db.rtSale.count({ where: { businessId: s.businessId } })).toBe(1);
  });

  it("never oversells: the last piece goes to one of two tills, the other is refused", async () => {
    const s = await shop();
    const it1 = await s.item({ price: 1000n });
    await receive(s, [stockOf(it1, "1")]);
    await open(s, "cashier");
    await open(s, "cashier2");
    const results = await Promise.all([sell(s, [pieces(it1, "1")], [cash(1000n)], "cashier"), sell(s, [pieces(it1, "1")], [cash(1000n)], "cashier2")]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const refused = results.find((r) => !r.ok);
    expect(refused && !refused.ok && refused.code).toBe("STOCK_NEGATIVE");
    expect(await s.onHand(it1.variantId)).toBe(0n);
    // Refused sales consume no sale number.
    expect(await codeOf(sell(s, [pieces(it1, "1")], [cash(1000n)]))).toBe("STOCK_NEGATIVE");
    expect((await db.rtSaleCounter.findFirstOrThrow({ where: { businessId: s.businessId } })).nextNumber).toBe(2);
  });

  it("FEFO: takes the batch that expires first; an expired batch is never sold", async () => {
    const s = await shop();
    const it1 = await s.item({ tracksExpiry: true, price: 2000n });
    await receive(s, [stockOf(it1, "5", { expiryDate: isoDay(-2), batchCode: "OLD" })], "OPENING");
    await receive(s, [stockOf(it1, "3", { expiryDate: isoDay(40), batchCode: "LATE" }), stockOf(it1, "2", { expiryDate: isoDay(10), batchCode: "SOON" })]);
    await open(s);
    const r = await sell(s, [pieces(it1, "3")], [cash(6000n)]);
    if (!r.ok) throw new Error(r.code);
    const doc = (await db.rtSale.findUniqueOrThrow({ where: { id: r.value.saleId } })).stockDocumentId;
    const moves = await db.rtStockMovement.findMany({ where: { documentId: doc } });
    const batches = await db.rtBatch.findMany({ where: { businessId: s.businessId } });
    const codeOfBatch = (id: string | null) => batches.find((b) => b.id === id)?.code;
    expect(moves.map((m) => [codeOfBatch(m.batchId), m.qtyDelta]).sort()).toEqual([
      ["LATE", -1n * U],
      ["SOON", -2n * U],
    ]);
    // 2 left on LATE and 5 on the expired OLD batch: 3 more cannot be sold.
    expect(await codeOf(sell(s, [pieces(it1, "3")], [cash(6000n)]))).toBe("STOCK_EXPIRED");
    expect(await codeOf(sell(s, [pieces(it1, "9")], [cash(18_000n)]))).toBe("STOCK_NEGATIVE");
    expect((await sell(s, [pieces(it1, "2")], [cash(4000n)])).ok).toBe(true);
  });

  it("mixed payment: card and cash, change only on the cash part", async () => {
    const s = await shop();
    const it1 = await s.item({ price: 7500n });
    await receive(s, [stockOf(it1, "10")]);
    await open(s);
    const r = await sell(s, [pieces(it1, "2")], [card(10_000n), cash(10_000n)]);
    if (!r.ok) throw new Error(r.code);
    expect(r.value.totalMinor).toBe(15_000n);
    expect(r.value.changeMinor).toBe(5000n);
    expect(r.value.payments).toEqual([
      { method: "CASH", amountMinor: 5000n, tenderedMinor: 10_000n, tenderedCurrency: null, tenderedForeignMinor: null, rateMicro: null },
      { method: "CARD", amountMinor: 10_000n, tenderedMinor: 10_000n, tenderedCurrency: null, tenderedForeignMinor: null, rateMicro: null },
    ]);
    expect(await codeOf(sell(s, [pieces(it1, "1")], [card(8000n)]))).toBe("PAYMENT_RULE");
    expect(await codeOf(sell(s, [pieces(it1, "1")], [card(5000n), cash(2000n)]))).toBe("PAYMENT_SHORT");
    expect(await codeOf(sell(s, [pieces(it1, "1")], []))).toBe("PAYMENT_SHORT");
    expect(await s.onHand(it1.variantId)).toBe(8n * U);
  });

  it("rounding: a weighed line is price x quantity, half up, in whole dinars", async () => {
    const s = await shop();
    const it1 = await s.item({ price: 1500n, quantityScale: 3, name: "طماطم" });
    await receive(s, [stockOf(it1, "10")]);
    await open(s);
    const r = await sell(s, [pieces(it1, "0.333"), pieces(it1, "٠٫٢٥١")], [cash(1000n)]);
    if (!r.ok) throw new Error(r.code);
    // 1500 x 0.333 = 499.5 -> 500; 1500 x 0.251 = 376.5 -> 377
    expect(r.value.lines.map((l) => l.lineTotalMinor)).toEqual([500n, 377n]);
    expect(r.value.totalMinor).toBe(877n);
    expect(r.value.changeMinor).toBe(123n);
    expect(await s.onHand(it1.variantId)).toBe(10n * U - 584n);
    expect(await codeOf(sell(s, [pieces(it1, "0.0001")], [cash(1000n)]))).toBe("INVALID_INPUT");
  });

  it("the price is the dated list price at sale time, frozen on the line; a changed total is refused", async () => {
    const s = await shop();
    const it1 = await s.item({ price: 1000n });
    await receive(s, [stockOf(it1, "10")]);
    await open(s);
    const first = await sell(s, [pieces(it1, "1")], [cash(1000n)], "cashier", key(), { expectedTotalMinor: 1000n });
    if (!first.ok) throw new Error(first.code);
    // A new price from now on: the old line keeps 1000, a cart that still shows 1000 is refused.
    await db.rtPrice.updateMany({ where: { unitId: it1.piece, validTo: null }, data: { validTo: new Date() } });
    await s.price(it1.piece, 1250n, new Date());
    const stale = await sell(s, [pieces(it1, "1")], [cash(1000n)], "cashier", key(), { expectedTotalMinor: 1000n });
    expect(!stale.ok && stale.code).toBe("PRICE_CHANGED");
    expect(!stale.ok && stale.details?.totalMinor).toBe("1250");
    const second = await sell(s, [pieces(it1, "1")], [cash(1250n)], "cashier", key(), { expectedTotalMinor: 1250n });
    expect(second.ok && second.value.totalMinor).toBe(1250n);
    const lines = await db.rtSaleLine.findMany({ where: { businessId: s.businessId }, orderBy: { createdAt: "asc" } });
    expect(lines.map((l) => l.unitPriceMinor)).toEqual([1000n, 1250n]);
    expect(lines.every((l) => l.priceId !== null && l.listPriceMinor === l.unitPriceMinor)).toBe(true);
  });

  it("an item without a price cannot be sold; a cashier cannot override a price, a manager can", async () => {
    const s = await shop();
    const noPrice = await s.item({ price: null });
    const it1 = await s.item({ price: 1000n });
    await receive(s, [stockOf(noPrice, "5"), stockOf(it1, "5")]);
    await open(s);
    await open(s, "manager");
    expect(await codeOf(sell(s, [pieces(noPrice, "1")], [cash(1000n)]))).toBe("PRICE_MISSING");
    expect(await codeOf(sell(s, [{ ...pieces(it1, "1"), unitPriceMinor: 500n }], [cash(500n)]))).toBe("FORBIDDEN");
    const r = await sell(s, [{ ...pieces(it1, "1"), unitPriceMinor: 800n }], [cash(800n)], "manager");
    expect(r.ok && r.value.lines[0]!.unitPriceMinor).toBe(800n);
    const line = await db.rtSaleLine.findFirstOrThrow({ where: { businessId: s.businessId } });
    expect(line).toMatchObject({ listPriceMinor: 1000n, unitPriceMinor: 800n });
  });

  it("selling needs an open shift; sale numbers count per branch", async () => {
    const s = await shop();
    const it1 = await s.item({ price: 1000n });
    await receive(s, [stockOf(it1, "10")]);
    expect(await codeOf(sell(s, [pieces(it1, "1")], [cash(1000n)]))).toBe("SHIFT_NOT_OPEN");
    await open(s);
    for (let i = 0; i < 3; i++) expect((await sell(s, [pieces(it1, "1")], [cash(1000n)])).ok).toBe(true);
    const numbers = (await db.rtSale.findMany({ where: { businessId: s.businessId }, orderBy: { number: "asc" } })).map((x) => x.number);
    expect(numbers).toEqual([1, 2, 3]);
  });

  it("isolation: another business's or branch's ids are not found, and a cashier reads only their branch", async () => {
    const a = await shop();
    const b = await shop();
    const itemA = await a.item({ price: 1000n });
    const itemB = await b.item({ price: 1000n });
    await receive(a, [stockOf(itemA, "5")]);
    await receive(b, [stockOf(itemB, "5")]);
    await open(a);
    // A's cashier cannot sell B's item, nor open a shift in B's branch.
    expect(await codeOf(sell(a, [pieces(itemB, "1")], [cash(1000n)]))).toBe("NOT_FOUND");
    expect(await codeOf(openShift({ branchId: b.branches.Main!.id, openingCashMinor: 0n }, a.as("cashier", key())))).toBe("NOT_FOUND");
    // B's owner cannot read A's sale; a cashier of A's Main cannot read a sale of A's Second.
    const saleA = await sell(a, [pieces(itemA, "1")], [cash(1000n)]);
    if (!saleA.ok) throw new Error(saleA.code);
    expect(await codeOf(getSale({ saleId: saleA.value.saleId }, b.as("owner")))).toBe("NOT_FOUND");
    expect(await codeOf(getSale({ saleId: saleA.value.saleId }, a.as("cashier2")))).toBe("ok");
    await receive(a, [stockOf(itemA, "5")]); // Main again (the owner's default place)
    const ownerShift = await open(a, "owner", 0n, "Second");
    expect(ownerShift.branchId).toBe(a.branches.Second!.id);
    // Second has no stock: the owner's sale there is refused, Main's stock is not touched.
    expect(await codeOf(sell(a, [pieces(itemA, "1")], [cash(1000n)], "owner"))).toBe("STOCK_NEGATIVE");
    expect(await a.onHand(itemA.variantId)).toBe(9n * U);
  });

  it("a suspended (read-only) business can neither sell nor open or close a shift; the summary still reads", async () => {
    const s = await shop();
    const it1 = await s.item({ price: 1000n });
    await receive(s, [stockOf(it1, "5")]);
    const shift = await open(s);
    await db.rtBusiness.update({ where: { id: s.businessId }, data: { status: "SUSPENDED" } });
    expect(await codeOf(sell(s, [pieces(it1, "1")], [cash(1000n)]))).toBe("READ_ONLY");
    expect(await codeOf(openShiftAs(s, "cashier2", "Main"))).toBe("READ_ONLY");
    expect(await codeOf(closeShift({ shiftId: shift.id, countedCashMinor: 0n, expectedVersion: 1 }, s.as("cashier")))).toBe("READ_ONLY");
    expect(await codeOf(myOpenShift({}, s.as("cashier")))).toBe("ok");
    expect(await s.onHand(it1.variantId)).toBe(5n * U);
  });

  it("refuses trial and archived items, and a unit of another item", async () => {
    const s = await shop();
    const it1 = await s.item({ price: 1000n });
    const it2 = await s.item({ price: 1000n });
    await receive(s, [stockOf(it1, "5"), stockOf(it2, "5")]);
    await open(s);
    expect(await codeOf(sell(s, [{ variantId: it1.variantId, unitId: it2.piece, quantity: "1" }], [cash(1000n)]))).toBe("STOCK_RULE");
    await db.rtProduct.update({ where: { id: it2.productId }, data: { archivedAt: new Date() } });
    expect(await codeOf(sell(s, [pieces(it2, "1")], [cash(1000n)]))).toBe("STOCK_RULE");
    await db.rtProduct.update({ where: { id: it1.productId }, data: { isTestData: true } });
    expect(await codeOf(sell(s, [pieces(it1, "1")], [cash(1000n)]))).toBe("TEST_ITEM");
  });
});

describe("the till's catalog", () => {
  it("lists categories, priced tiles with stock, and finds a carton by its barcode", async () => {
    const s = await shop();
    const dairy = await db.rtCategory.create({ data: { businessId: s.businessId, nameAr: "ألبان" } });
    const cheese = await db.rtCategory.create({ data: { businessId: s.businessId, nameAr: "أجبان", parentId: dairy.id } });
    const milk = await s.item({ price: 1000n, cartonPrice: 22_000n, name: "حليب" });
    const cheeseItem = await s.item({ price: 3000n, name: "جبن" });
    await s.item({ price: null, name: "خبز" });
    await db.rtProduct.update({ where: { id: milk.productId }, data: { categoryId: dairy.id } });
    await db.rtProduct.update({ where: { id: cheeseItem.productId }, data: { categoryId: cheese.id } });
    await db.rtBarcode.create({ data: { businessId: s.businessId, unitId: milk.carton, code: "0062800123" } });
    await receive(s, [stockOf(milk, "30")]);

    const cats = await listSellCategories({}, s.as("cashier"));
    expect(cats.ok && cats.value.map((c) => c.nameAr)).toEqual(["ألبان"]);
    // The department tile quietly shows how many products it holds (sub-categories included).
    expect(cats.ok && cats.value.map((c) => c.itemCount)).toEqual([2]);
    const inDairy = await listSellItems({ categoryId: dairy.id, locationId: s.locations.Main }, s.as("cashier"));
    if (!inDairy.ok) throw new Error(inDairy.code);
    expect(inDairy.value.map((i) => [i.nameAr, i.priceMinor, i.onHand])).toEqual([
      ["جبن", 3000n, 0n],
      ["حليب", 1000n, 30n * U],
    ]);
    const all = await listSellItems({}, s.as("cashier"));
    expect(all.ok && all.value.find((i) => i.nameAr === "خبز")?.priceMinor).toBeNull();
    const scan = await listSellItems({ query: "0062800123" }, s.as("cashier"));
    if (!scan.ok) throw new Error(scan.code);
    expect(scan.value[0]).toMatchObject({ unitId: milk.carton, unitName: "كرتون", priceMinor: 22_000n, factor: 24, matchedBarcode: "0062800123" });
    // A tile carries its top-level category (a sub-category's item is coloured by its parent).
    expect(inDairy.value.map((i) => i.categoryId)).toEqual([dairy.id, dairy.id]);
    expect(all.ok && all.value.find((i) => i.nameAr === "خبز")?.categoryId).toBeNull();
  });

  it("browsing pages with offset: the pages do not overlap and together hold every item", async () => {
    const s = await shop();
    for (const n of ["أ", "ب", "ت", "ث", "ج"]) await s.item({ price: 500n, name: `مادة ${n}` });
    const page = async (offset: number) => {
      const r = await listSellItems({ limit: 2, offset }, s.as("cashier"));
      if (!r.ok) throw new Error(r.code);
      return r.value.map((i) => i.variantId);
    };
    const [a, b, c] = [await page(0), await page(2), await page(4)];
    expect([a.length, b.length, c.length]).toEqual([2, 2, 1]);
    expect(new Set([...a, ...b, ...c]).size).toBe(5);
    expect(await page(5)).toEqual([]);
  });

  it("current prices refresh a cart (null without a price); the till state gives the currency and the open shift", async () => {
    const s = await shop();
    const milk = await s.item({ price: 1000n });
    const bread = await s.item({ price: null, name: "خبز" });
    const change = new Date(Date.now() - 1000);
    await db.rtPrice.updateMany({ where: { unitId: milk.piece }, data: { validTo: change } });
    await s.price(milk.piece, 1250n, change);
    const p = await currentUnitPrices({ unitIds: [milk.piece, bread.piece] }, s.as("cashier"));
    expect(p.ok && p.value).toEqual({ [milk.piece]: 1250n, [bread.piece]: null });
    expect(await codeOf(currentUnitPrices({ unitIds: [milk.piece] }, s.as("stock")))).toBe("FORBIDDEN");

    const before = await tillState({}, s.as("cashier"));
    expect(before.ok && before.value).toEqual({ currency: "IQD", open: null, usdEnabled: false, lastUsdRateMicro: null });
    const shift = await open(s);
    const after = await tillState({}, s.as("cashier"));
    expect(after.ok && after.value.open?.shift.id).toBe(shift.id);
    expect(after.ok && after.value.open?.expectedCashMinor).toBe(50_000n);
  });
});

describe("paying in dollars", () => {
  const RATE = 1450_000000n;

  /** A shift with a dollar rate (set directly: opening with a rate is the shifts' own test) and a 29,250 dinar item in stock. */
  async function usdShop() {
    const s = await shop();
    const it1 = await s.item({ price: 29_250n });
    await receive(s, [stockOf(it1, "50")]);
    const shift = await open(s);
    await db.rtShift.update({ where: { id: shift.id }, data: { usdRateMicro: RATE } });
    return { s, it1, shift };
  }
  const usd = (usdMinor: bigint, amountMinor: bigint) => ({ method: "CASH" as const, currency: "USD" as const, usdMinor, amountMinor });
  type Pay = { method: "CASH"; currency?: "IQD"; amountMinor: bigint } | { method: "CASH"; currency: "USD"; usdMinor: bigint; amountMinor: bigint } | { method: "CARD"; amountMinor: bigint };
  const sellPay = (s: Shop, it1: Item, payments: Pay[], saleKey = key()) =>
    createSale({ saleKey, lines: [pieces(it1, "1")], payments }, s.as("cashier", saleKey));
  const rowsOf = (saleId: string) => db.rtPayment.findMany({ where: { saleId }, orderBy: [{ method: "asc" }, { id: "asc" }] });

  it("dollars that exactly cover the due (the ceil chip) leave only a few dinars of change", async () => {
    const { s, it1 } = await usdShop();
    // 29,250 / 1450 = 20.172 dollars: 20.17 would be 29,246 (short), so the chip is 20.18 = 29,261.
    const r = await sellPay(s, it1, [usd(2018n, 29_261n)]);
    if (!r.ok) throw new Error(`${r.code} ${JSON.stringify(r.details ?? {})}`);
    expect(r.value).toMatchObject({ totalMinor: 29_250n, paidMinor: 29_261n, changeMinor: 11n });
    const [row] = await rowsOf(r.value.saleId);
    expect(row).toMatchObject({ method: "CASH", amountMinor: 29_250n, tenderedMinor: 29_261n, tenderedCurrency: "USD", tenderedForeignMinor: 2018n, rateMicro: RATE });
    expect(r.value.payments).toEqual([
      { method: "CASH", amountMinor: 29_250n, tenderedMinor: 29_261n, tenderedCurrency: "USD", tenderedForeignMinor: 2018n, rateMicro: RATE },
    ]);
  });

  it("20.17 dollars is a few dinars short and is refused as short", async () => {
    const { s, it1 } = await usdShop();
    expect(await codeOf(sellPay(s, it1, [usd(2017n, 29_246n)]))).toBe("PAYMENT_SHORT");
  });

  it("an overpay in dollars gives the change in dinars", async () => {
    const { s, it1 } = await usdShop();
    const r = await sellPay(s, it1, [usd(5000n, 72_500n)]);
    if (!r.ok) throw new Error(r.code);
    expect(r.value).toMatchObject({ paidMinor: 72_500n, changeMinor: 43_250n });
    expect((await rowsOf(r.value.saleId))[0]).toMatchObject({ amountMinor: 29_250n, tenderedMinor: 72_500n, tenderedForeignMinor: 5000n });
  });

  it("dollars and dinars together: two cash rows, the change comes off the dinar row", async () => {
    const { s, it1 } = await usdShop();
    const r = await sellPay(s, it1, [usd(1000n, 14_500n), cash(20_000n)]);
    if (!r.ok) throw new Error(r.code);
    expect(r.value).toMatchObject({ paidMinor: 34_500n, changeMinor: 5250n });
    const rows = await rowsOf(r.value.saleId);
    expect(rows).toHaveLength(2);
    expect(rows.find((p) => p.tenderedCurrency === null)).toMatchObject({ amountMinor: 14_750n, tenderedMinor: 20_000n });
    expect(rows.find((p) => p.tenderedCurrency === "USD")).toMatchObject({ amountMinor: 14_500n, tenderedMinor: 14_500n });
  });

  it("dollars and card", async () => {
    const { s, it1 } = await usdShop();
    const r = await sellPay(s, it1, [usd(1000n, 14_500n), card(14_750n)]);
    if (!r.ok) throw new Error(r.code);
    expect(r.value).toMatchObject({ paidMinor: 29_250n, changeMinor: 0n });
    const rows = await rowsOf(r.value.saleId);
    expect(rows.find((p) => p.method === "CARD")).toMatchObject({ amountMinor: 14_750n, tenderedForeignMinor: null, rateMicro: null });
    expect(rows.find((p) => p.method === "CASH")).toMatchObject({ amountMinor: 14_500n, tenderedForeignMinor: 1000n });
  });

  it("dollars that overpay plus dinars that are not needed: refused, the dinars would all be change", async () => {
    const { s, it1 } = await usdShop();
    const r = await sellPay(s, it1, [usd(5000n, 72_500n), cash(10_000n)]);
    expect(r.ok ? "ok" : [r.code, r.details?.reason]).toEqual(["PAYMENT_RULE", "CASH_NOT_NEEDED"]);
  });

  it("a wrong dinar value for the dollars is refused and nothing is written", async () => {
    const { s, it1 } = await usdShop();
    const r = await sellPay(s, it1, [usd(2018n, 40_000n)]);
    expect(r.ok ? "ok" : [r.code, r.details?.reason]).toEqual(["PAYMENT_RULE", "RATE_MISMATCH"]);
    expect(await db.rtSale.count()).toBe(0);
    expect(await db.rtPayment.count()).toBe(0);
  });

  it("no rate on the shift: dollars are not available", async () => {
    const s = await shop();
    const it1 = await s.item({ price: 29_250n });
    await receive(s, [stockOf(it1, "5")]);
    await open(s);
    const r = await sellPay(s, it1, [usd(2018n, 29_261n)]);
    expect(r.ok ? "ok" : [r.code, r.details?.reason]).toEqual(["PAYMENT_RULE", "USD_NOT_AVAILABLE"]);
    expect(await db.rtSale.count()).toBe(0);
  });

  it("a retry with the same saleKey returns the posted sale and writes no second dollar row", async () => {
    const { s, it1 } = await usdShop();
    const k = key();
    const a = await sellPay(s, it1, [usd(2018n, 29_261n)], k);
    const b = await createSale({ saleKey: k, lines: [pieces(it1, "1")], payments: [usd(2018n, 29_261n)] }, s.as("cashier"));
    if (!a.ok || !b.ok) throw new Error("refused");
    expect(b.value.saleId).toBe(a.value.saleId);
    expect(b.value.replayed).toBe(true);
    expect(await db.rtPayment.count({ where: { tenderedCurrency: "USD" } })).toBe(1);
    expect(await db.rtSale.count()).toBe(1);
  });

  it("more than one dollar entry is refused; a dinar entry may name its currency", async () => {
    const { s, it1 } = await usdShop();
    expect(await codeOf(sellPay(s, it1, [usd(1000n, 14_500n), usd(1000n, 14_500n)]))).toBe("INVALID_INPUT");
    const r = await sellPay(s, it1, [{ method: "CASH", currency: "IQD", amountMinor: 29_250n }]);
    expect(r.ok && r.value.payments[0]).toMatchObject({ tenderedCurrency: null, tenderedForeignMinor: null, rateMicro: null });
  });
});
