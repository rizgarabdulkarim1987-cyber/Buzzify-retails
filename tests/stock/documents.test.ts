import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Currency, RtTrackingMode } from "@/generated/prisma/client";
import { businessToday, expiryStatus } from "@/server/domain/stock";
import {
  discardStockDraft,
  getStockDocument,
  listStockDocuments,
  postStockDocument,
  saveStockDraft,
  type DraftLineInput,
} from "@/server/stock/documents";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createPlan } from "../helpers/fixtures";

const { db } = useTestDb();

const DAY = 86_400_000;
const key = () => randomUUID();
const U = 1000n; // one base unit (quantities are base x 1000)
let skuSeq = 0;

type ItemOpts = { trackingMode?: RtTrackingMode; tracksExpiry?: boolean; isTestData?: boolean; quantityScale?: number };

/**
 * An active business (subscription) with branches Main and Second, one location each, and staff:
 * owner (cost.view), stock officer and cashier limited to Main.
 */
async function shop(opts: { currencies?: Currency[] } = {}) {
  if ((await db.rtPlan.count()) === 0) await createPlan(db, { maxBranches: 3 });
  const w = await createBusinessWithStaff(db, {
    branches: ["Main", "Second"],
    staff: [
      { key: "owner", role: "OWNER" },
      { key: "stock", role: "STOCK", branches: ["Main"] },
      { key: "cashier", role: "CASHIER", branches: ["Main"] },
      { key: "purchasing", role: "PURCHASING", branches: ["Main"] },
    ],
  });
  const businessId = w.business.id;
  await db.rtBusiness.update({
    where: { id: businessId },
    data: { status: "ACTIVE", enabledCurrencies: opts.currencies ?? ["IQD", "USD"], defaultCurrency: "IQD" },
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
    const product = await db.rtProduct.create({
      data: {
        businessId,
        nameAr: "حليب",
        trackingMode: o.trackingMode ?? (o.tracksExpiry ? "BATCH" : "NONE"),
        tracksExpiry: o.tracksExpiry ?? false,
        isTestData: o.isTestData ?? false,
      },
    });
    const variant = await db.rtVariant.create({ data: { businessId, productId: product.id, sku: `T-${++skuSeq}` } });
    const piece = await db.rtUnit.create({
      data: { businessId, variantId: variant.id, name: "حبة", factor: 1, isBase: true, quantityScale: o.quantityScale ?? 0 },
    });
    const carton = await db.rtUnit.create({ data: { businessId, variantId: variant.id, name: "كرتون", factor: 24 } });
    return { productId: product.id, variantId: variant.id, piece: piece.id, carton: carton.id };
  }

  const balance = async (variantId: string, where: "Main" | "Second" = "Main") => {
    const s = await db.rtStockBalance.aggregate({
      where: { businessId, locationId: locations[where], variantId },
      _sum: { qty: true, valueMinor: true },
    });
    return { qty: s._sum.qty ?? 0n, valueMinor: s._sum.valueMinor ?? 0n };
  };

  return { ...w, businessId, locations, as, item, balance };
}

type Shop = Awaited<ReturnType<typeof shop>>;
type Item = Awaited<ReturnType<Shop["item"]>>;

const line = (it: Item, quantity: string, extra: Partial<DraftLineInput> = {}): DraftLineInput => ({
  variantId: it.variantId,
  unitId: it.piece,
  quantity,
  ...extra,
});
const iqd = (amount: string) => ({ amount, currency: "IQD" as const });

/** Saves a new draft and returns its id and version (fails the test on refusal). */
async function draft(s: Shop, kind: "OPENING" | "RECEIPT", lines: DraftLineInput[], who = "owner") {
  const r = await saveStockDraft({ kind, lines }, s.as(who));
  if (!r.ok) throw new Error(`draft refused: ${r.code} ${JSON.stringify(r.details ?? {})}`);
  return r.value;
}

/** Saves and posts; resolves to the post result. */
async function receive(s: Shop, kind: "OPENING" | "RECEIPT", lines: DraftLineInput[], who = "owner") {
  const d = await draft(s, kind, lines, who);
  return postStockDocument({ documentId: d.documentId, expectedVersion: d.version }, s.as(who));
}

async function receiveOk(s: Shop, kind: "OPENING" | "RECEIPT", lines: DraftLineInput[], who = "owner") {
  const r = await receive(s, kind, lines, who);
  if (!r.ok) throw new Error(`post refused: ${r.code} ${JSON.stringify(r.details ?? {})}`);
  return r.value;
}

const isoDay = (offsetDays: number) => new Date(businessToday(new Date(), "Asia/Baghdad").getTime() + offsetDays * DAY).toISOString().slice(0, 10);

describe("stock receipts and opening balances", () => {
  it("a receipt of 2 cartons and 5 pieces adds 53 base pieces and a weighted-average cost", async () => {
    const s = await shop();
    const it1 = await s.item();
    const posted = await receiveOk(s, "RECEIPT", [
      line(it1, "2", { unitId: it1.carton, cost: iqd("24,000") }),
      line(it1, "5", { cost: iqd("1000") }),
    ]);
    expect(posted.number).toBe(1);
    expect(posted.lines).toHaveLength(2);
    expect(posted.lines.map((l) => [l.quantity, l.valueMinor])).toEqual([
      [48n * U, 48_000n],
      [5n * U, 5_000n],
    ]);
    expect(await s.balance(it1.variantId)).toEqual({ qty: 53n * U, valueMinor: 53_000n });
    // Movements go to the default location of the actor's branch.
    const doc = await db.rtStockDocument.findFirstOrThrow({ where: { id: posted.documentId } });
    expect(doc).toMatchObject({ status: "POSTED", number: 1, locationId: s.locations.Main, branchId: s.branches.Main!.id });
    expect(await db.rtStockMovement.count({ where: { documentId: posted.documentId } })).toBe(2);

    // Two lines of the same (variant, unit, batch) and price are merged into one at posting.
    const merged = await receiveOk(s, "RECEIPT", [line(it1, "3", { cost: iqd("1000") }), line(it1, "4", { cost: iqd("1000") })]);
    expect(merged.lines).toHaveLength(1);
    expect(merged.lines[0]).toMatchObject({ quantity: 7n * U, enteredQuantity: "7", valueMinor: 7_000n });
    expect(await db.rtStockLine.count({ where: { documentId: merged.documentId } })).toBe(1);
    expect(await db.rtStockMovement.count({ where: { documentId: merged.documentId } })).toBe(1);
    expect(await s.balance(it1.variantId)).toEqual({ qty: 60n * U, valueMinor: 60_000n });
  });

  it("a second receipt at another price moves the average", async () => {
    const s = await shop();
    const it1 = await s.item();
    await receiveOk(s, "RECEIPT", [line(it1, "2", { unitId: it1.carton, cost: iqd("24000") }), line(it1, "5", { cost: iqd("1000") })]);
    await receiveOk(s, "RECEIPT", [line(it1, "10", { cost: iqd("1530") })]);
    const b = await s.balance(it1.variantId);
    expect(b).toEqual({ qty: 63n * U, valueMinor: 68_300n });
    // average per piece: 68300 / 63 = 1084.1...
    expect((b.valueMinor * U) / b.qty).toBe(1084n);
  });

  it("a USD receipt with a rate stores original, rate and converted value", async () => {
    const s = await shop();
    const it1 = await s.item();
    const posted = await receiveOk(s, "RECEIPT", [line(it1, "10", { cost: { amount: "2.37", currency: "USD" }, rate: "1311.37" })]);
    // 10 x $2.37 = $23.70 x 1311.37 = 31,079.469 -> 31,079 IQD (half up)
    expect(posted.lines[0]).toMatchObject({ currency: "USD", unitCostMinor: 237n, rateMicro: 1_311_370_000n, valueMinor: 31_079n });
    const stored = await db.rtStockLine.findFirstOrThrow({ where: { documentId: posted.documentId } });
    expect(stored).toMatchObject({ currency: "USD", unitCostMinor: 237n, rateMicro: 1_311_370_000n, valueMinor: 31_079n, quantity: 10n * U });
    expect(await s.balance(it1.variantId)).toEqual({ qty: 10n * U, valueMinor: 31_079n });

    // A foreign currency without a rate is refused at posting.
    const noRate = await receive(s, "RECEIPT", [line(it1, "1", { cost: { amount: "1", currency: "USD" } })]);
    expect(noRate).toMatchObject({ ok: false, code: "STOCK_RULE", details: { lineNo: "1", reason: "RATE_REQUIRED" } });
    // A receipt line needs a cost.
    const noCost = await receive(s, "RECEIPT", [line(it1, "1")]);
    expect(noCost).toMatchObject({ ok: false, code: "STOCK_RULE", details: { lineNo: "1", reason: "COST_REQUIRED" } });
    expect(await s.balance(it1.variantId)).toEqual({ qty: 10n * U, valueMinor: 31_079n });
  });

  it("a currency the business does not use is refused", async () => {
    const s = await shop({ currencies: ["IQD"] });
    const it1 = await s.item();
    const r = await saveStockDraft({ kind: "RECEIPT", lines: [line(it1, "1", { cost: { amount: "2", currency: "USD" }, rate: "1300" })] }, s.as("owner"));
    expect(r).toMatchObject({ ok: false, code: "STOCK_RULE", details: { lineNo: "1", reason: "CURRENCY_NOT_ENABLED" } });

    // A draft saved while USD was enabled is refused at posting once it is not.
    await db.rtBusiness.update({ where: { id: s.businessId }, data: { enabledCurrencies: ["IQD", "USD"] } });
    const d = await draft(s, "RECEIPT", [line(it1, "1", { cost: { amount: "2", currency: "USD" }, rate: "1300" })]);
    await db.rtBusiness.update({ where: { id: s.businessId }, data: { enabledCurrencies: ["IQD"] } });
    const p = await postStockDocument({ documentId: d.documentId, expectedVersion: d.version }, s.as("owner"));
    expect(p).toMatchObject({ ok: false, code: "STOCK_RULE", details: { reason: "CURRENCY_NOT_ENABLED" } });
    expect(await db.rtStockMovement.count()).toBe(0);
  });

  it("a SERIAL product and a trial product are refused", async () => {
    const s = await shop();
    const serial = await s.item({ trackingMode: "SERIAL" });
    const trial = await s.item({ isTestData: true });
    const plain = await s.item();
    expect(await saveStockDraft({ kind: "RECEIPT", lines: [line(serial, "1", { cost: iqd("5") })] }, s.as("owner"))).toMatchObject({
      ok: false,
      code: "SERIAL_NOT_SUPPORTED",
    });
    expect(
      await saveStockDraft({ kind: "OPENING", lines: [line(plain, "1"), line(trial, "1", { cost: iqd("5") })] }, s.as("owner")),
    ).toMatchObject({ ok: false, code: "TEST_ITEM", details: { lineNo: "2" } });

    // A product that turns into a trial or SERIAL item after the draft was saved is refused at posting.
    const d = await draft(s, "RECEIPT", [line(plain, "1", { cost: iqd("5") })]);
    await db.rtProduct.update({ where: { id: plain.productId }, data: { trackingMode: "SERIAL" } });
    expect(await postStockDocument({ documentId: d.documentId, expectedVersion: d.version }, s.as("owner"))).toMatchObject({
      ok: false,
      code: "SERIAL_NOT_SUPPORTED",
    });
    await db.rtProduct.update({ where: { id: plain.productId }, data: { trackingMode: "NONE", isTestData: true } });
    expect(await postStockDocument({ documentId: d.documentId, expectedVersion: d.version }, s.as("owner"))).toMatchObject({
      ok: false,
      code: "TEST_ITEM",
    });
    expect(await db.rtStockMovement.count()).toBe(0);
    expect(await db.rtStockDocument.findFirstOrThrow({ where: { id: d.documentId } })).toMatchObject({ status: "DRAFT", number: null });
  });

  it("a tracksExpiry product without an expiry date is refused", async () => {
    const s = await shop();
    const milk = await s.item({ tracksExpiry: true });
    const r = await receive(s, "RECEIPT", [line(milk, "1", { cost: iqd("5"), batchCode: "L1" })]);
    expect(r).toMatchObject({ ok: false, code: "STOCK_RULE", details: { lineNo: "1", reason: "EXPIRY_REQUIRED" } });
    // A past date is refused for a receipt.
    const past = await receive(s, "RECEIPT", [line(milk, "1", { cost: iqd("5"), expiryDate: isoDay(-1) })]);
    expect(past).toMatchObject({ ok: false, code: "STOCK_RULE", details: { reason: "EXPIRED" } });
    // A batch or a date on a product that does not track batches is refused.
    const plain = await s.item();
    const batchOnPlain = await saveStockDraft({ kind: "RECEIPT", lines: [line(plain, "1", { cost: iqd("5"), batchCode: "X" })] }, s.as("owner"));
    expect(batchOnPlain).toMatchObject({ ok: false, code: "STOCK_RULE", details: { reason: "BATCH_NOT_TRACKED" } });
    // An impossible date is invalid input.
    expect(await saveStockDraft({ kind: "RECEIPT", lines: [line(milk, "1", { expiryDate: "2026-02-30" })] }, s.as("owner"))).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
    expect(await db.rtStockMovement.count()).toBe(0);

    // With a date (today counts as not expired) it posts into one batch per (code, date).
    const ok = await receiveOk(s, "RECEIPT", [
      line(milk, "1", { cost: iqd("5"), expiryDate: isoDay(0) }),
      line(milk, "2", { cost: iqd("5"), expiryDate: isoDay(30), batchCode: "L1" }),
    ]);
    expect(ok.lines.map((l) => l.expired)).toEqual([false, false]);
    expect(await db.rtBatch.count({ where: { variantId: milk.variantId } })).toBe(2);
    const again = await receiveOk(s, "RECEIPT", [line(milk, "1", { cost: iqd("5"), expiryDate: isoDay(30), batchCode: "L1" })]);
    expect(again.lines[0]!.batchId).toBe(ok.lines[1]!.batchId);
    expect(await db.rtBatch.count({ where: { variantId: milk.variantId } })).toBe(2);
  });

  it("an expired batch in OPENING posts with a warning and counts as unavailable", async () => {
    const s = await shop();
    const milk = await s.item({ tracksExpiry: true });
    const posted = await receiveOk(s, "OPENING", [line(milk, "4", { cost: iqd("250"), expiryDate: isoDay(-3), batchCode: "OLD" }), line(milk, "2", { expiryDate: isoDay(10) })]);
    expect(posted.warnings).toEqual([
      { lineNo: 1, code: "EXPIRED" },
      { lineNo: 2, code: "COST_MISSING" },
    ]);
    expect(posted.lines[0]).toMatchObject({ expired: true, costMissing: false, valueMinor: 1_000n });
    expect(posted.lines[1]).toMatchObject({ expired: false, costMissing: true, valueMinor: 0n });
    // The stock is recorded, on a batch that is expired for the business today.
    expect(await s.balance(milk.variantId)).toEqual({ qty: 6n * U, valueMinor: 1_000n });
    const batch = await db.rtBatch.findUniqueOrThrow({ where: { id: posted.lines[0]!.batchId! } });
    expect(expiryStatus(batch.expiryDate, businessToday(new Date(), "Asia/Baghdad"), 0)).toBe("EXPIRED");
  });

  it("a second OPENING adds, and OPENING is refused after any other movement of that item", async () => {
    const s = await shop();
    const it1 = await s.item();
    const other = await s.item();
    await receiveOk(s, "OPENING", [line(it1, "5", { cost: iqd("100") })]);
    await receiveOk(s, "OPENING", [line(it1, "3", { cost: iqd("100") })]);
    expect(await s.balance(it1.variantId)).toEqual({ qty: 8n * U, valueMinor: 800n });

    await receiveOk(s, "RECEIPT", [line(it1, "1", { cost: iqd("100") })]);
    const refused = await receive(s, "OPENING", [line(other, "1"), line(it1, "1", { cost: iqd("100") })]);
    expect(refused).toMatchObject({ ok: false, code: "STOCK_RULE", details: { lineNo: "2", reason: "OPENING_AFTER_MOVEMENT" } });
    expect(await s.balance(it1.variantId)).toEqual({ qty: 9n * U, valueMinor: 900n });
    expect(await s.balance(other.variantId)).toEqual({ qty: 0n, valueMinor: 0n });
    // Another item still takes an opening balance.
    await receiveOk(s, "OPENING", [line(other, "1")]);
  });

  it("posting twice with the same key or from two tabs creates one document and one set of movements", async () => {
    const s = await shop();
    const it1 = await s.item();
    // The stock officer posts: a replay returns the stored value, which never carries costs, so
    // for a caller without cost.view it equals the first result exactly.
    const d = await draft(s, "RECEIPT", [line(it1, "2", { cost: iqd("10") }), line(it1, "1", { unitId: it1.carton, cost: iqd("200") })], "stock");
    const k = key();
    const input = { documentId: d.documentId, expectedVersion: d.version };
    const results = await Promise.all([
      postStockDocument(input, s.as("stock", k)),
      postStockDocument(input, s.as("stock", k)),
      postStockDocument(input, s.as("stock")),
      postStockDocument(input, s.as("owner")),
    ]);
    const oks = results.filter((r) => r.ok);
    const refused = results.filter((r) => !r.ok);
    // The two same-key calls return the same document; one other tab may not get through.
    expect(oks.length).toBeGreaterThanOrEqual(1);
    for (const r of refused) expect(r).toMatchObject({ ok: false, code: "DOCUMENT_POSTED" });
    const numbers = new Set(oks.map((r) => (r.ok ? r.value.number : 0)));
    expect(numbers).toEqual(new Set([1]));
    expect(results[0]).toEqual(results[1]);
    expect(await db.rtStockMovement.count()).toBe(2);
    expect(await s.balance(it1.variantId)).toEqual({ qty: 26n * U, valueMinor: 220n });
    expect(await db.rtStockCounter.findFirstOrThrow({ where: { businessId: s.businessId } })).toMatchObject({ nextNumber: 2 });
    // A replay later still returns the first result.
    expect(await postStockDocument(input, s.as("stock", k))).toEqual(results[0]);
  });

  it("501 lines are refused at draft save", async () => {
    const s = await shop();
    const it1 = await s.item();
    const lines = Array.from({ length: 501 }, () => line(it1, "1"));
    expect(await saveStockDraft({ kind: "OPENING", lines }, s.as("owner"))).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await db.rtStockDocument.count()).toBe(0);
    const d = await draft(s, "OPENING", lines.slice(0, 500));
    expect(await db.rtStockLine.count({ where: { documentId: d.documentId } })).toBe(500);
    // Editing up to 501 is refused as well, and the draft stays as it was.
    expect(await saveStockDraft({ documentId: d.documentId, expectedVersion: d.version, kind: "OPENING", lines }, s.as("owner"))).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
    expect(await db.rtStockLine.count({ where: { documentId: d.documentId } })).toBe(500);
  });

  it("a posted document cannot be edited or discarded", async () => {
    const s = await shop();
    const it1 = await s.item();
    // A draft can be edited (version checked) and discarded.
    const d = await draft(s, "RECEIPT", [line(it1, "1", { cost: iqd("10") })]);
    const edited = await saveStockDraft(
      { documentId: d.documentId, expectedVersion: d.version, kind: "RECEIPT", supplierRef: "مورد", lines: [line(it1, "2", { cost: iqd("10") }), line(it1, "3", { cost: iqd("11") })] },
      s.as("owner"),
    );
    expect(edited).toMatchObject({ ok: true, value: { documentId: d.documentId, version: d.version + 1 } });
    expect(await saveStockDraft({ documentId: d.documentId, expectedVersion: d.version, kind: "RECEIPT", lines: [] }, s.as("owner"))).toMatchObject({
      ok: false,
      code: "VERSION_CONFLICT",
    });
    expect(await db.rtStockLine.count({ where: { documentId: d.documentId } })).toBe(2);
    const other = await draft(s, "RECEIPT", [line(it1, "1", { cost: iqd("10") })]);
    expect(await discardStockDraft({ documentId: other.documentId, expectedVersion: other.version }, s.as("owner"))).toMatchObject({ ok: true });
    expect(await db.rtStockDocument.count({ where: { id: other.documentId } })).toBe(0);

    const posted = await postStockDocument({ documentId: d.documentId, expectedVersion: d.version + 1 }, s.as("owner"));
    expect(posted).toMatchObject({ ok: true });
    const version = (await db.rtStockDocument.findFirstOrThrow({ where: { id: d.documentId } })).version;
    expect(await saveStockDraft({ documentId: d.documentId, expectedVersion: version, kind: "RECEIPT", lines: [] }, s.as("owner"))).toMatchObject({
      ok: false,
      code: "DOCUMENT_POSTED",
    });
    expect(await discardStockDraft({ documentId: d.documentId, expectedVersion: version }, s.as("owner"))).toMatchObject({
      ok: false,
      code: "DOCUMENT_POSTED",
    });
    expect(await postStockDocument({ documentId: d.documentId, expectedVersion: version }, s.as("owner"))).toMatchObject({
      ok: false,
      code: "DOCUMENT_POSTED",
    });
    expect(await db.rtStockLine.count({ where: { documentId: d.documentId } })).toBe(2);
    expect(await db.rtStockMovement.count({ where: { documentId: d.documentId } })).toBe(2);
  });

  it("a stock officer receives, a cashier cannot", async () => {
    const s = await shop();
    const it1 = await s.item();
    const posted = await receiveOk(s, "RECEIPT", [line(it1, "4", { cost: iqd("10") })], "stock");
    expect(posted.number).toBe(1);
    expect(await s.balance(it1.variantId)).toEqual({ qty: 4n * U, valueMinor: 40n });

    expect(await saveStockDraft({ kind: "RECEIPT", lines: [line(it1, "1", { cost: iqd("10") })] }, s.as("cashier"))).toMatchObject({
      ok: false,
      code: "FORBIDDEN",
    });
    const d = await draft(s, "RECEIPT", [line(it1, "1", { cost: iqd("10") })], "stock");
    expect(await postStockDocument({ documentId: d.documentId, expectedVersion: d.version }, s.as("cashier"))).toMatchObject({
      ok: false,
      code: "FORBIDDEN",
    });
    expect(await discardStockDraft({ documentId: d.documentId, expectedVersion: d.version }, s.as("cashier"))).toMatchObject({
      ok: false,
      code: "FORBIDDEN",
    });
    // The cashier may read (stock.view), without costs.
    const read = await getStockDocument({ documentId: posted.documentId }, s.as("cashier"));
    expect(read).toMatchObject({ ok: true, value: { number: 1, status: "POSTED", lines: [{ quantity: 4n * U }] } });
    const listed = await listStockDocuments({}, s.as("cashier"));
    expect(listed.ok && listed.value.rows.map((r) => r.id).sort()).toEqual([posted.documentId, d.documentId].sort());
  });

  it("READ_ONLY refuses save and post", async () => {
    const s = await shop();
    const it1 = await s.item();
    const d = await draft(s, "RECEIPT", [line(it1, "1", { cost: iqd("10") })]);
    await db.rtBusiness.update({ where: { id: s.businessId }, data: { status: "SUSPENDED" } });
    const results = [
      await saveStockDraft({ kind: "RECEIPT", lines: [line(it1, "1", { cost: iqd("10") })] }, s.as("owner")),
      await saveStockDraft({ documentId: d.documentId, expectedVersion: d.version, kind: "RECEIPT", lines: [] }, s.as("owner")),
      await postStockDocument({ documentId: d.documentId, expectedVersion: d.version }, s.as("owner")),
      await discardStockDraft({ documentId: d.documentId, expectedVersion: d.version }, s.as("owner")),
    ];
    for (const r of results) expect(r).toMatchObject({ ok: false, code: "READ_ONLY" });
    expect(await getStockDocument({ documentId: d.documentId }, s.as("owner"))).toMatchObject({ ok: true, value: { status: "DRAFT" } });
    expect(await db.rtStockMovement.count()).toBe(0);
  });

  it("no cost appears in the result or the stored idempotency value without cost.view", async () => {
    const s = await shop();
    const it1 = await s.item();
    const costFields = ["valueMinor", "unitCostMinor", "rateMicro", "currency"];
    const noCost = (v: unknown) => {
      const text = JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
      for (const f of costFields) expect(text).not.toContain(f);
      expect(text).not.toContain("31079");
    };

    // The stock officer (no cost.view): no cost in the result, the replay, the read or the list.
    const k = key();
    const d = await draft(s, "RECEIPT", [line(it1, "10", { cost: { amount: "2.37", currency: "USD" }, rate: "1311.37" })], "stock");
    const posted = await postStockDocument({ documentId: d.documentId, expectedVersion: d.version }, s.as("stock", k));
    expect(posted).toMatchObject({ ok: true, value: { lines: [{ quantity: 10n * U, costMissing: false }] } });
    noCost(posted);
    noCost(await postStockDocument({ documentId: d.documentId, expectedVersion: d.version }, s.as("stock", k)));
    noCost(await getStockDocument({ documentId: d.documentId }, s.as("stock")));
    noCost(await listStockDocuments({}, s.as("stock")));
    const stored = await db.rtIdempotency.findUniqueOrThrow({ where: { scope_key: { scope: s.businessId, key: k } } });
    noCost(stored.result);

    // The owner (cost.view) sees the values in the result and the read, but the stored value has none.
    const k2 = key();
    const d2 = await draft(s, "RECEIPT", [line(it1, "10", { cost: { amount: "2.37", currency: "USD" }, rate: "1311.37" })]);
    const own = await postStockDocument({ documentId: d2.documentId, expectedVersion: d2.version }, s.as("owner", k2));
    expect(own).toMatchObject({ ok: true, value: { lines: [{ valueMinor: 31_079n, unitCostMinor: 237n, currency: "USD" }] } });
    expect(await getStockDocument({ documentId: d2.documentId }, s.as("owner"))).toMatchObject({
      ok: true,
      value: { lines: [{ valueMinor: 31_079n, unitCostMinor: 237n, rateMicro: 1_311_370_000n }] },
    });
    noCost((await db.rtIdempotency.findUniqueOrThrow({ where: { scope_key: { scope: s.businessId, key: k2 } } })).result);
  });

  it("another business cannot read or post this document", async () => {
    const a = await shop();
    const b = await shop();
    const itemA = await a.item();
    const d = await draft(a, "RECEIPT", [line(itemA, "1", { cost: iqd("10") })]);
    const input = { documentId: d.documentId, expectedVersion: d.version };
    expect(await getStockDocument({ documentId: d.documentId }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await postStockDocument(input, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await discardStockDraft(input, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await saveStockDraft({ ...input, kind: "RECEIPT", lines: [] }, b.as("owner"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    const listed = await listStockDocuments({}, b.as("owner"));
    expect(listed).toMatchObject({ ok: true, value: { rows: [] } });
    // B cannot receive A's item either.
    expect(await saveStockDraft({ kind: "RECEIPT", lines: [line(itemA, "1", { cost: iqd("10") })] }, b.as("owner"))).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    // A branch-limited officer of A does not see a draft of A's other branch.
    const second = await db.rtStockDocument.create({
      data: { businessId: a.businessId, branchId: a.branches.Second!.id, locationId: a.locations.Second!, kind: "RECEIPT" },
    });
    expect(await getStockDocument({ documentId: second.id }, a.as("stock"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await postStockDocument({ documentId: second.id, expectedVersion: 1 }, a.as("stock"))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await db.rtStockMovement.count()).toBe(0);
    expect(await db.rtStockDocument.findFirstOrThrow({ where: { id: d.documentId } })).toMatchObject({ status: "DRAFT" });
  });

  it("documents are numbered gap-free per business under concurrency", async () => {
    const a = await shop();
    const b = await shop();
    const itemA = await a.item();
    const itemA2 = await a.item();
    const itemB = await b.item();
    const drafts = [];
    for (let i = 0; i < 6; i++) drafts.push(await draft(a, "RECEIPT", [line(i % 2 ? itemA : itemA2, "1", { cost: iqd("10") })]));
    const draftB = await draft(b, "RECEIPT", [line(itemB, "1", { cost: iqd("10") })]);
    // A refused post in between consumes no number.
    const bad = await draft(a, "RECEIPT", [line(itemA, "1")]);
    const results = await Promise.all([
      ...drafts.map((d) => postStockDocument({ documentId: d.documentId, expectedVersion: d.version }, a.as("owner"))),
      postStockDocument({ documentId: bad.documentId, expectedVersion: bad.version }, a.as("owner")),
      postStockDocument({ documentId: draftB.documentId, expectedVersion: draftB.version }, b.as("owner")),
    ]);
    const numbersA = results.slice(0, 6).map((r) => (r.ok ? r.value.number : -1));
    expect([...numbersA].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(results[6]).toMatchObject({ ok: false, code: "STOCK_RULE" });
    expect(results[7]).toMatchObject({ ok: true, value: { number: 1 } });
    const next = await receiveOk(a, "RECEIPT", [line(itemA, "1", { cost: iqd("10") })]);
    expect(next.number).toBe(7);
  });
  it("receipt actions refuse other kinds of document and imported ones", async () => {
    const s = await shop();
    const it1 = await s.item();
    const place = { businessId: s.businessId, branchId: s.branches.Main!.id, locationId: s.locations.Main! };
    const importBatch = await db.rtImportBatch.create({
      data: { businessId: s.businessId, kind: "OPENING_STOCK", fileName: "a.csv", fileHash: "h", columns: [], stats: {}, createdById: "u" },
    });
    // Drafts the receipt actions did not create: an adjustment, a write-off and an imported OPENING.
    const others = [
      await db.rtStockDocument.create({ data: { ...place, kind: "ADJUSTMENT", direction: "IN", reason: "COUNT_FIX" } }),
      await db.rtStockDocument.create({ data: { ...place, kind: "WRITE_OFF", direction: "OUT", reason: "DAMAGED" } }),
      await db.rtStockDocument.create({ data: { ...place, kind: "OPENING", importBatchId: importBatch.id } }),
    ];
    for (const doc of others) {
      await db.rtStockLine.create({
        data: { businessId: place.businessId, branchId: place.branchId, documentId: doc.id, lineNo: 1, variantId: it1.variantId, unitId: it1.piece, quantity: 1000n, enteredQuantity: "1" },
      });
      const input = { documentId: doc.id, expectedVersion: doc.version };
      for (const who of ["purchasing", "owner"]) {
        const kindRefusal = { ok: false, code: "STOCK_RULE", details: { reason: "KIND" } };
        expect(await postStockDocument(input, s.as(who))).toMatchObject(kindRefusal);
        expect(await discardStockDraft(input, s.as(who))).toMatchObject(kindRefusal);
        expect(await saveStockDraft({ ...input, kind: "RECEIPT", lines: [] }, s.as(who))).toMatchObject(kindRefusal);
      }
      expect(await db.rtStockDocument.findFirstOrThrow({ where: { id: doc.id } })).toMatchObject({ status: "DRAFT", kind: doc.kind, version: 1 });
      expect(await db.rtStockLine.count({ where: { documentId: doc.id } })).toBe(1);
    }
    expect(await db.rtStockMovement.count()).toBe(0);
    // The purchasing officer still receives.
    expect((await receiveOk(s, "RECEIPT", [line(it1, "1", { cost: iqd("10") })], "purchasing")).number).toBe(1);
  });
});
