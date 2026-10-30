import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RtTrackingMode } from "@/generated/prisma/client";
import { businessToday } from "@/server/domain/stock";
import { adjustStock, reverseStockDocument, writeOffStock } from "@/server/stock/adjust";
import { getStockDocument, postStockDocument, saveStockDraft, type DraftLineInput } from "@/server/stock/documents";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createPlan } from "../helpers/fixtures";

const { db } = useTestDb();

const DAY = 86_400_000;
const key = () => randomUUID();
const U = 1000n; // one base unit (quantities are base x 1000)
let skuSeq = 0;

type ItemOpts = { trackingMode?: RtTrackingMode; tracksExpiry?: boolean; isTestData?: boolean };

/**
 * An active business with branches Main and Second (one location each) and staff: owner and
 * manager (cost.view), a stock officer, a purchasing officer and a cashier limited to Main.
 */
async function shop() {
  if ((await db.rtPlan.count()) === 0) await createPlan(db, { maxBranches: 3 });
  const w = await createBusinessWithStaff(db, {
    branches: ["Main", "Second"],
    staff: [
      { key: "owner", role: "OWNER" },
      { key: "manager", role: "MANAGER" },
      { key: "stock", role: "STOCK", branches: ["Main"] },
      { key: "purchasing", role: "PURCHASING", branches: ["Main"] },
      { key: "cashier", role: "CASHIER", branches: ["Main"] },
    ],
  });
  const businessId = w.business.id;
  await db.rtBusiness.update({ where: { id: businessId }, data: { status: "ACTIVE", enabledCurrencies: ["IQD", "USD"], defaultCurrency: "IQD" } });
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
    const product = await db.rtProduct.create({
      data: {
        businessId,
        nameAr: "حليب",
        trackingMode: o.trackingMode ?? (o.tracksExpiry ? "BATCH" : "NONE"),
        tracksExpiry: o.tracksExpiry ?? false,
        isTestData: o.isTestData ?? false,
      },
    });
    const variant = await db.rtVariant.create({ data: { businessId, productId: product.id, sku: `A-${++skuSeq}` } });
    const piece = await db.rtUnit.create({ data: { businessId, variantId: variant.id, name: "حبة", factor: 1, isBase: true } });
    const carton = await db.rtUnit.create({ data: { businessId, variantId: variant.id, name: "كرتون", factor: 24 } });
    return { productId: product.id, variantId: variant.id, piece: piece.id, carton: carton.id };
  }

  const balance = async (variantId: string, batchId?: string | null) => {
    const s = await db.rtStockBalance.aggregate({
      where: { businessId, locationId: locations.Main, variantId, ...(batchId === undefined ? {} : { batchId }) },
      _sum: { qty: true, valueMinor: true },
    });
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
const isoDay = (offsetDays: number) => new Date(businessToday(new Date(), "Asia/Baghdad").getTime() + offsetDays * DAY).toISOString().slice(0, 10);

/** Saves and posts a document as the owner; returns the post result (fails the test on refusal). */
async function receive(s: Shop, lines: DraftLineInput[], kind: "OPENING" | "RECEIPT" = "RECEIPT") {
  const d = await saveStockDraft({ kind, lines }, s.as("owner"));
  if (!d.ok) throw new Error(`draft refused: ${d.code}`);
  const r = await postStockDocument({ documentId: d.value.documentId, expectedVersion: d.value.version }, s.as("owner"));
  if (!r.ok) throw new Error(`post refused: ${r.code} ${JSON.stringify(r.details ?? {})}`);
  return r.value;
}

async function versionOf(documentId: string) {
  return (await db.rtStockDocument.findFirstOrThrow({ where: { id: documentId } })).version;
}

async function reverse(s: Shop, documentId: string, who = "owner", k = key()) {
  return reverseStockDocument({ documentId, expectedVersion: await versionOf(documentId) }, s.as(who, k));
}

async function movements(documentId: string) {
  const rows = await db.rtStockMovement.findMany({ where: { documentId }, orderBy: { id: "asc" } });
  return rows.map((m) => ({ lineId: m.lineId, batchId: m.batchId, qtyDelta: m.qtyDelta, valueDeltaMinor: m.valueDeltaMinor }));
}

const counter = async (s: Shop) => (await db.rtStockCounter.findFirstOrThrow({ where: { businessId: s.businessId } })).nextNumber;

describe("stock adjustments, write-offs and reversals", () => {
  it("a write-off of damaged goods lowers qty and value proportionally", async () => {
    const s = await shop();
    const it1 = await s.item();
    // 10 at 100 and 2 cartons (48) at 3,600 a carton (150 each): 58 pieces worth 8,200.
    await receive(s, [line(it1, "10", { cost: iqd("100") }), line(it1, "2", { unitId: it1.carton, cost: iqd("3600") })]);
    const r = await writeOffStock({ variantId: it1.variantId, unitId: it1.piece, quantity: "3", reason: "DAMAGED" }, s.as("owner"));
    // 3 of 58 at the average: 8200 x 3 / 58 = 424.1 -> 424.
    expect(r).toMatchObject({
      ok: true,
      value: { kind: "WRITE_OFF", direction: "OUT", number: 2, warnings: [], lines: [{ lineNo: 1, quantity: 3n * U, enteredQuantity: "3", valueMinor: 424n }] },
    });
    expect(await s.balance(it1.variantId)).toEqual({ qty: 55n * U, valueMinor: 7_776n });
    const docId = r.ok ? r.value.documentId : "";
    expect(await db.rtStockDocument.findFirstOrThrow({ where: { id: docId } })).toMatchObject({
      kind: "WRITE_OFF",
      direction: "OUT",
      status: "POSTED",
      reason: "DAMAGED",
      note: null,
      locationId: s.locations.Main,
    });
    expect(await movements(docId)).toMatchObject([{ qtyDelta: -3n * U, valueDeltaMinor: -424n }]);

    // A carton is written off in base units, and the last pieces take all the value that is left.
    await writeOffStock({ variantId: it1.variantId, unitId: it1.carton, quantity: "1", reason: "DAMAGED" }, s.as("owner"));
    expect(await s.balance(it1.variantId)).toEqual({ qty: 31n * U, valueMinor: 4_383n });
    await writeOffStock({ variantId: it1.variantId, unitId: it1.piece, quantity: "31", reason: "OTHER", note: "سرقة" }, s.as("owner"));
    expect(await s.balance(it1.variantId)).toEqual({ qty: 0n, valueMinor: 0n });

    // A batch product: the write-off names the batch and takes the variant's average.
    const milk = await s.item({ tracksExpiry: true });
    const rec = await receive(s, [
      line(milk, "10", { cost: iqd("100"), expiryDate: isoDay(5), batchCode: "CHEAP" }),
      line(milk, "10", { cost: iqd("300"), expiryDate: isoDay(9), batchCode: "DEAR" }),
    ]);
    const cheap = rec.lines[0]!.batchId!;
    const off = await writeOffStock({ variantId: milk.variantId, unitId: milk.piece, batchId: cheap, quantity: "4", reason: "EXPIRED" }, s.as("owner"));
    expect(off).toMatchObject({ ok: true, value: { lines: [{ batchId: cheap, valueMinor: 800n, expiryDate: isoDay(5), batchCode: "CHEAP" }] } });
    expect(await s.balance(milk.variantId, cheap)).toEqual({ qty: 6n * U, valueMinor: 200n });
    expect(await s.balance(milk.variantId)).toEqual({ qty: 16n * U, valueMinor: 3_200n });
  });

  it("an adjustment IN uses the current average cost", async () => {
    const s = await shop();
    const it1 = await s.item();
    await receive(s, [line(it1, "10", { cost: iqd("100") })]);
    await receive(s, [line(it1, "10", { cost: iqd("300") })]);
    const r = await adjustStock({ variantId: it1.variantId, unitId: it1.piece, direction: "IN", quantity: "5", reason: "COUNT_FIX" }, s.as("owner"));
    expect(r).toMatchObject({
      ok: true,
      value: { kind: "ADJUSTMENT", direction: "IN", warnings: [], lines: [{ quantity: 5n * U, valueMinor: 1_000n, currency: "IQD", unitCostMinor: 200n }] },
    });
    expect(await s.balance(it1.variantId)).toEqual({ qty: 25n * U, valueMinor: 5_000n });

    // OUT goes at the average too.
    const out = await adjustStock({ variantId: it1.variantId, unitId: it1.carton, direction: "OUT", quantity: "1", reason: "LOST" }, s.as("owner"));
    expect(out).toMatchObject({ ok: true, value: { direction: "OUT", lines: [{ quantity: 24n * U, valueMinor: 4_800n }] } });
    expect(await s.balance(it1.variantId)).toEqual({ qty: 1n * U, valueMinor: 200n });

    // No stock, so no average: valued 0 with a warning.
    const fresh = await s.item();
    const unknown = await adjustStock({ variantId: fresh.variantId, unitId: fresh.piece, direction: "IN", quantity: "2", reason: "COUNT_FIX" }, s.as("owner"));
    expect(unknown).toMatchObject({ ok: true, value: { warnings: [{ lineNo: 1, code: "COST_UNKNOWN" }], lines: [{ quantity: 2n * U, valueMinor: 0n }] } });
    expect(await s.balance(fresh.variantId)).toEqual({ qty: 2n * U, valueMinor: 0n });

    // The stock officer (no cost.view) sees no value, in the result or the stored idempotency row.
    const k = key();
    const own = await adjustStock({ variantId: it1.variantId, unitId: it1.piece, direction: "IN", quantity: "1", reason: "COUNT_FIX" }, s.as("stock", k));
    const text = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
    expect(own).toMatchObject({ ok: true, value: { lines: [{ quantity: 1n * U }] } });
    for (const t of [text(own), text((await db.rtIdempotency.findUniqueOrThrow({ where: { scope_key: { scope: s.businessId, key: k } } })).result)]) {
      for (const f of ["valueMinor", "unitCostMinor", "currency", "rateMicro"]) expect(t).not.toContain(f);
    }
    expect(await s.balance(it1.variantId)).toEqual({ qty: 2n * U, valueMinor: 400n });
  });

  it("a reason is required and OTHER needs a note", async () => {
    const s = await shop();
    const it1 = await s.item();
    await receive(s, [line(it1, "10", { cost: iqd("100") })]);
    const base = { variantId: it1.variantId, unitId: it1.piece, quantity: "1" };
    const refused = [
      await adjustStock({ ...base, direction: "OUT" } as never, s.as("owner")),
      await adjustStock({ ...base, direction: "OUT", reason: "DAMAGED" } as never, s.as("owner")),
      await adjustStock({ ...base, direction: "OUT", reason: "OTHER" }, s.as("owner")),
      await adjustStock({ ...base, direction: "OUT", reason: "OTHER", note: "   " }, s.as("owner")),
      await adjustStock({ ...base, direction: "SIDEWAYS", reason: "LOST" } as never, s.as("owner")),
      await writeOffStock({ ...base } as never, s.as("owner")),
      await writeOffStock({ ...base, reason: "LOST" } as never, s.as("owner")),
      await writeOffStock({ ...base, reason: "OTHER" }, s.as("owner")),
      // A quantity the unit cannot hold (pieces have no decimals), and zero.
      await writeOffStock({ ...base, quantity: "1.5", reason: "DAMAGED" }, s.as("owner")),
      await writeOffStock({ ...base, quantity: "0", reason: "DAMAGED" }, s.as("owner")),
    ];
    for (const r of refused) expect(r).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await db.rtStockDocument.count({ where: { kind: { in: ["ADJUSTMENT", "WRITE_OFF"] } } })).toBe(0);

    const ok = await adjustStock({ ...base, direction: "OUT", reason: "OTHER", note: " عينة للعرض " }, s.as("owner"));
    expect(ok).toMatchObject({ ok: true });
    const doc = await db.rtStockDocument.findFirstOrThrow({ where: { id: ok.ok ? ok.value.documentId : "" } });
    expect(doc).toMatchObject({ reason: "OTHER", note: "عينة للعرض", direction: "OUT" });
    const read = await getStockDocument({ documentId: doc.id }, s.as("cashier"));
    expect(read).toMatchObject({ ok: true, value: { kind: "ADJUSTMENT", direction: "OUT", reason: "OTHER", note: "عينة للعرض" } });
  });

  it("an outflow beyond the balance is STOCK_NEGATIVE", async () => {
    const s = await shop();
    const it1 = await s.item();
    await receive(s, [line(it1, "5", { cost: iqd("100") })]);
    expect(await writeOffStock({ variantId: it1.variantId, unitId: it1.piece, quantity: "6", reason: "DAMAGED" }, s.as("owner"))).toMatchObject({
      ok: false,
      code: "STOCK_NEGATIVE",
    });
    expect(
      await adjustStock({ variantId: it1.variantId, unitId: it1.carton, direction: "OUT", quantity: "1", reason: "LOST" }, s.as("owner")),
    ).toMatchObject({ ok: false, code: "STOCK_NEGATIVE" });

    // A batch has less than the variant: the batch's own balance counts.
    const milk = await s.item({ tracksExpiry: true });
    const rec = await receive(s, [
      line(milk, "2", { cost: iqd("100"), expiryDate: isoDay(5), batchCode: "A" }),
      line(milk, "10", { cost: iqd("100"), expiryDate: isoDay(9), batchCode: "B" }),
    ]);
    const a = rec.lines[0]!.batchId!;
    expect(
      await writeOffStock({ variantId: milk.variantId, unitId: milk.piece, batchId: a, quantity: "3", reason: "EXPIRED" }, s.as("owner")),
    ).toMatchObject({ ok: false, code: "STOCK_NEGATIVE" });

    // Nothing was written and no number was used.
    expect(await db.rtStockDocument.count({ where: { kind: { in: ["ADJUSTMENT", "WRITE_OFF"] } } })).toBe(0);
    expect(await s.balance(it1.variantId)).toEqual({ qty: 5n * U, valueMinor: 500n });
    expect(await counter(s)).toBe(3);
  });

  it("batch, unit and item rules apply to adjustments", async () => {
    const s = await shop();
    const plain = await s.item();
    const milk = await s.item({ tracksExpiry: true });
    const other = await s.item({ tracksExpiry: true });
    await receive(s, [line(plain, "5", { cost: iqd("100") })]);
    const rec = await receive(s, [
      line(milk, "5", { cost: iqd("100"), expiryDate: isoDay(5) }),
      line(other, "5", { cost: iqd("100"), expiryDate: isoDay(5) }),
    ]);
    const milkBatch = rec.lines[0]!.batchId!;
    const otherBatch = rec.lines[1]!.batchId!;
    const off = (input: Record<string, unknown>) =>
      writeOffStock({ unitId: milk.piece, quantity: "1", reason: "DAMAGED", ...input } as never, s.as("owner"));
    // A batch product needs its batch; a batch must be of that variant; a plain product takes none.
    expect(await off({ variantId: milk.variantId })).toMatchObject({ ok: false, code: "STOCK_RULE", details: { reason: "BATCH_REQUIRED" } });
    expect(await off({ variantId: milk.variantId, batchId: otherBatch })).toMatchObject({
      ok: false,
      code: "STOCK_RULE",
      details: { reason: "BATCH_NOT_OF_VARIANT" },
    });
    expect(await off({ variantId: milk.variantId, batchId: "no-such-batch" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await off({ variantId: plain.variantId, unitId: plain.piece, batchId: milkBatch })).toMatchObject({
      ok: false,
      code: "STOCK_RULE",
      details: { reason: "BATCH_NOT_TRACKED" },
    });
    // The unit must be the variant's.
    expect(await off({ variantId: plain.variantId, unitId: milk.piece })).toMatchObject({
      ok: false,
      code: "STOCK_RULE",
      details: { reason: "UNIT_NOT_OF_VARIANT" },
    });
    // Trial and SERIAL items are refused.
    const trial = await s.item({ isTestData: true });
    const serial = await s.item({ trackingMode: "SERIAL" });
    expect(await adjustStock({ variantId: trial.variantId, unitId: trial.piece, direction: "IN", quantity: "1", reason: "COUNT_FIX" }, s.as("owner"))).toMatchObject({
      ok: false,
      code: "TEST_ITEM",
    });
    expect(await adjustStock({ variantId: serial.variantId, unitId: serial.piece, direction: "IN", quantity: "1", reason: "COUNT_FIX" }, s.as("owner"))).toMatchObject({
      ok: false,
      code: "SERIAL_NOT_SUPPORTED",
    });
    // Another business's item is not found.
    const b = await shop();
    expect(await adjustStock({ variantId: plain.variantId, unitId: plain.piece, direction: "IN", quantity: "1", reason: "COUNT_FIX" }, b.as("owner"))).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    expect(await db.rtStockDocument.count({ where: { kind: { in: ["ADJUSTMENT", "WRITE_OFF"] } } })).toBe(0);

    // The valid batch write-off goes through.
    expect(await off({ variantId: milk.variantId, batchId: milkBatch })).toMatchObject({ ok: true });
    // An archived item can still be written off (OUT), but not adjusted IN.
    await db.rtProduct.update({ where: { id: plain.productId }, data: { archivedAt: new Date() } });
    expect(await writeOffStock({ variantId: plain.variantId, unitId: plain.piece, quantity: "1", reason: "DAMAGED" }, s.as("owner"))).toMatchObject({ ok: true });
    expect(await adjustStock({ variantId: plain.variantId, unitId: plain.piece, direction: "IN", quantity: "1", reason: "COUNT_FIX" }, s.as("owner"))).toMatchObject({
      ok: false,
      code: "STOCK_RULE",
      details: { reason: "ARCHIVED" },
    });
  });

  it("reversing a receipt posts the exact negation and links to it", async () => {
    const s = await shop();
    const it1 = await s.item();
    const milk = await s.item({ tracksExpiry: true });
    const first = await receive(s, [line(it1, "10", { cost: iqd("100") })]);
    // The second receipt is dearer, in USD, and on a batch.
    const second = await receive(s, [
      line(it1, "10", { cost: { amount: "2.37", currency: "USD" }, rate: "1311.37" }),
      line(milk, "4", { cost: iqd("250"), expiryDate: isoDay(9), batchCode: "L1" }),
    ]);
    expect(first.number).toBe(1);
    expect(await s.balance(it1.variantId)).toEqual({ qty: 20n * U, valueMinor: 1_000n + 31_079n });

    const r = await reverse(s, second.documentId);
    expect(r).toMatchObject({ ok: true, value: { kind: "REVERSAL", reversesDocumentId: second.documentId, number: 3 } });
    const rev = r.ok ? r.value : null!;
    // Lines mirror the original: same quantities, batches, costs and values.
    expect(rev.lines.map((l) => [l.lineNo, l.variantId, l.quantity, l.batchId, l.valueMinor, l.currency, l.unitCostMinor, l.rateMicro])).toEqual(
      second.lines.map((l) => [l.lineNo, l.variantId, l.quantity, l.batchId, l.valueMinor, l.currency, l.unitCostMinor, l.rateMicro]),
    );
    // Movements are the exact negation (the original values, not the current average).
    const orig = await movements(second.documentId);
    const back = await movements(rev.documentId);
    expect(back.map((m) => [m.batchId, m.qtyDelta, m.valueDeltaMinor]).sort()).toEqual(
      orig.map((m) => [m.batchId, -m.qtyDelta, -m.valueDeltaMinor]).sort(),
    );
    expect(await s.balance(it1.variantId)).toEqual({ qty: 10n * U, valueMinor: 1_000n });
    expect(await s.balance(milk.variantId)).toEqual({ qty: 0n, valueMinor: 0n });
    const doc = await db.rtStockDocument.findFirstOrThrow({ where: { id: rev.documentId } });
    expect(doc).toMatchObject({ kind: "REVERSAL", status: "POSTED", reversesDocumentId: second.documentId, locationId: s.locations.Main, direction: null });
    expect(await getStockDocument({ documentId: rev.documentId }, s.as("owner"))).toMatchObject({
      ok: true,
      value: { kind: "REVERSAL", reversesDocumentId: second.documentId, lines: [{ valueMinor: 31_079n }, { valueMinor: 1_000n }] },
    });

    // A write-off and an adjustment reverse the same way: the value comes back exactly.
    const off = await writeOffStock({ variantId: it1.variantId, unitId: it1.piece, quantity: "3", reason: "DAMAGED" }, s.as("owner"));
    const offId = off.ok ? off.value.documentId : "";
    await receive(s, [line(it1, "1", { cost: iqd("5000") })]);
    const back2 = await reverse(s, offId);
    expect(back2).toMatchObject({ ok: true });
    expect(await movements(back2.ok ? back2.value.documentId : "")).toMatchObject([{ qtyDelta: 3n * U, valueDeltaMinor: 300n }]);
    expect(await s.balance(it1.variantId)).toEqual({ qty: 11n * U, valueMinor: 6_000n });
    const doc2 = await db.rtStockDocument.findFirstOrThrow({ where: { id: back2.ok ? back2.value.documentId : "" } });
    expect(doc2).toMatchObject({ reason: "DAMAGED", reversesDocumentId: offId });

    // An OPENING reverses too.
    const fresh = await s.item();
    const opening = await receive(s, [line(fresh, "2", { cost: iqd("10") })], "OPENING");
    expect(await reverse(s, opening.documentId)).toMatchObject({ ok: true });
    expect(await s.balance(fresh.variantId)).toEqual({ qty: 0n, valueMinor: 0n });
  });

  it("a document is reversed once and a reversal cannot be reversed", async () => {
    const s = await shop();
    const it1 = await s.item();
    const rec = await receive(s, [line(it1, "10", { cost: iqd("100") })]);
    const r = await reverse(s, rec.documentId);
    expect(r).toMatchObject({ ok: true });
    expect(await reverse(s, rec.documentId)).toMatchObject({ ok: false, code: "STOCK_RULE", details: { reason: "ALREADY_REVERSED" } });
    expect(await reverse(s, r.ok ? r.value.documentId : "")).toMatchObject({ ok: false, code: "STOCK_RULE", details: { reason: "REVERSAL" } });

    // A draft is not reversed; a stale version is a conflict.
    const d = await saveStockDraft({ kind: "RECEIPT", lines: [line(it1, "1", { cost: iqd("100") })] }, s.as("owner"));
    expect(await reverse(s, d.ok ? d.value.documentId : "")).toMatchObject({ ok: false, code: "STOCK_RULE", details: { reason: "NOT_POSTED" } });
    const rec2 = await receive(s, [line(it1, "10", { cost: iqd("100") })]);
    expect(await reverseStockDocument({ documentId: rec2.documentId, expectedVersion: 99 }, s.as("owner"))).toMatchObject({
      ok: false,
      code: "VERSION_CONFLICT",
    });

    // Two reversals at once (two keys): exactly one goes through.
    const version = await versionOf(rec2.documentId);
    const both = await Promise.all([
      reverseStockDocument({ documentId: rec2.documentId, expectedVersion: version }, s.as("owner")),
      reverseStockDocument({ documentId: rec2.documentId, expectedVersion: version }, s.as("manager")),
    ]);
    expect(both.filter((x) => x.ok)).toHaveLength(1);
    expect(both.find((x) => !x.ok)).toMatchObject({ ok: false, code: "STOCK_RULE", details: { reason: "ALREADY_REVERSED" } });
    expect(await db.rtStockDocument.count({ where: { kind: "REVERSAL" } })).toBe(2);
    expect(await s.balance(it1.variantId)).toEqual({ qty: 0n, valueMinor: 0n });

    // Another business, and a branch-limited officer of another branch, do not find it.
    const b = await shop();
    expect(await reverseStockDocument({ documentId: rec.documentId, expectedVersion: 1 }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    const second = await db.rtStockDocument.create({
      data: { businessId: s.businessId, branchId: s.branches.Second!.id, locationId: s.locations.Second!, kind: "RECEIPT" },
    });
    expect(await reverseStockDocument({ documentId: second.id, expectedVersion: 1 }, s.as("stock"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("a reversal is refused when the stock was already used", async () => {
    const s = await shop();
    const it1 = await s.item();
    const rec = await receive(s, [line(it1, "10", { cost: iqd("100") })]);
    await writeOffStock({ variantId: it1.variantId, unitId: it1.piece, quantity: "4", reason: "DAMAGED" }, s.as("owner"));
    const before = await db.rtStockMovement.count();
    const next = await counter(s);
    expect(await reverse(s, rec.documentId)).toMatchObject({ ok: false, code: "STOCK_NEGATIVE" });

    // Enough quantity, but the value left is below the original value: refused too (the total
    // value would go below zero). 10 at 100 + 10 at 300, then 10 out at the average 200.
    const it2 = await s.item();
    await receive(s, [line(it2, "10", { cost: iqd("100") })]);
    const dear = await receive(s, [line(it2, "10", { cost: iqd("300") })]);
    await writeOffStock({ variantId: it2.variantId, unitId: it2.piece, quantity: "10", reason: "DAMAGED" }, s.as("owner"));
    const mid = await db.rtStockMovement.count();
    expect(await s.balance(it2.variantId)).toEqual({ qty: 10n * U, valueMinor: 2_000n });
    expect(await reverse(s, dear.documentId)).toMatchObject({ ok: false, code: "STOCK_NEGATIVE" });

    expect(await db.rtStockMovement.count()).toBe(mid);
    expect(mid - before).toBe(3);
    expect(await db.rtStockDocument.count({ where: { kind: "REVERSAL" } })).toBe(0);
    expect(await counter(s)).toBe(next + 3);
    expect(await s.balance(it1.variantId)).toEqual({ qty: 6n * U, valueMinor: 600n });
  });

  it("a cashier cannot adjust, a manager and a stock officer can", async () => {
    const s = await shop();
    const it1 = await s.item();
    const rec = await receive(s, [line(it1, "10", { cost: iqd("100") })]);
    const adj = { variantId: it1.variantId, unitId: it1.piece, direction: "OUT" as const, quantity: "1", reason: "LOST" as const };
    const off = { variantId: it1.variantId, unitId: it1.piece, quantity: "1", reason: "DAMAGED" as const };
    for (const who of ["cashier", "purchasing"]) {
      expect(await adjustStock(adj, s.as(who))).toMatchObject({ ok: false, code: "FORBIDDEN" });
      expect(await writeOffStock(off, s.as(who))).toMatchObject({ ok: false, code: "FORBIDDEN" });
      expect(await reverse(s, rec.documentId, who)).toMatchObject({ ok: false, code: "FORBIDDEN" });
    }
    expect(await db.rtStockDocument.count()).toBe(1);

    for (const who of ["manager", "stock", "owner"]) {
      expect(await adjustStock(adj, s.as(who))).toMatchObject({ ok: true });
      expect(await writeOffStock(off, s.as(who))).toMatchObject({ ok: true });
    }
    expect(await s.balance(it1.variantId)).toEqual({ qty: 4n * U, valueMinor: 400n });
    const m = await adjustStock({ ...adj, direction: "IN" }, s.as("manager"));
    expect(await reverse(s, m.ok ? m.value.documentId : "", "stock")).toMatchObject({ ok: true });
    expect(await s.balance(it1.variantId)).toEqual({ qty: 4n * U, valueMinor: 400n });
  });

  it("the same key does not adjust twice", async () => {
    const s = await shop();
    const it1 = await s.item();
    const rec = await receive(s, [line(it1, "10", { cost: iqd("100") })]);
    const k = key();
    const input = { variantId: it1.variantId, unitId: it1.piece, direction: "OUT" as const, quantity: "2", reason: "COUNT_FIX" as const };
    const [a, b] = await Promise.all([adjustStock(input, s.as("stock", k)), adjustStock(input, s.as("stock", k))]);
    expect(a).toMatchObject({ ok: true });
    expect(b).toEqual(a);
    expect(await adjustStock(input, s.as("stock", k))).toEqual(a);
    const k2 = key();
    const off = { variantId: it1.variantId, unitId: it1.piece, quantity: "1", reason: "DAMAGED" as const };
    expect(await writeOffStock(off, s.as("stock", k2))).toEqual(await writeOffStock(off, s.as("stock", k2)));
    expect(await s.balance(it1.variantId)).toEqual({ qty: 7n * U, valueMinor: 700n });
    // The same key replays a reversal too (the adjustment's 2 come back once).
    const k3 = key();
    const adjustment = a.ok ? a.value.documentId : "";
    const r1 = await reverse(s, adjustment, "stock", k3);
    expect(r1).toMatchObject({ ok: true });
    expect(await reverse(s, adjustment, "stock", k3)).toEqual(r1);

    expect(await db.rtStockDocument.count({ where: { kind: "ADJUSTMENT" } })).toBe(1);
    expect(await db.rtStockDocument.count({ where: { kind: "WRITE_OFF" } })).toBe(1);
    expect(await db.rtStockDocument.count({ where: { kind: "REVERSAL" } })).toBe(1);
    expect(await s.balance(it1.variantId)).toEqual({ qty: 9n * U, valueMinor: 900n });
    expect(rec.number).toBe(1);
  });
});
