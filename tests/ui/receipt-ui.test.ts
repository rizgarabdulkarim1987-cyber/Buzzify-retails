import { randomUUID } from "node:crypto";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ar } from "@/messages/ar";
import { ckb } from "@/messages/ckb";
import { en } from "@/messages/en";
import { saveStockDraft } from "@/server/stock/documents";
import { loadReceiptDraft, loadReceiptItem } from "../../src/app/retail/stock/_lib/receipt-load";
import {
  addScanned,
  blockedReason,
  draftPayload,
  firstUnpostable,
  firstUnsavable,
  hasHiddenCosts,
  lineIssues,
  newLine,
  nextAttempt,
  rateText,
  receiptFailureMessage,
  restoreLines,
  showsRate,
  SingleFlight,
  withCurrency,
  type ItemInfo,
  type ReceiptLine,
  type ReceiptSettings,
} from "../../src/app/retail/stock/_lib/receipt-rules";
import { HiddenCostNotice, LineFields, LinesEmpty, PostBar, ReceiptDone, SaveStatusText } from "../../src/app/retail/stock/_lib/receipt-views";
import { COST_FIELD, lockedMapping, mappingProblems, rowStatusText } from "../../src/app/retail/stock/_lib/opening-import";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createPlan } from "../helpers/fixtures";

const { db } = useTestDb();
const html = (el: ReactElement) => renderToStaticMarkup(el);
const DAY = 86_400_000;
let seq = 0;
const makeKey = () => `k${++seq}`;

const IQD_ONLY: ReceiptSettings = { defaultCurrency: "IQD", enabledCurrencies: ["IQD"], lastRate: "" };
const BOTH: ReceiptSettings = { defaultCurrency: "IQD", enabledCurrencies: ["IQD", "USD"], lastRate: "1310" };
const TODAY = "2026-10-30";

const unit = (id: string, name: string, factor: number, isBase = false, quantityScale = 0) => ({ id, name, factor, quantityScale, isBase });
const info = (over: Partial<ItemInfo> = {}): ItemInfo => ({
  productId: "p1",
  variantId: "v1",
  nameAr: "حليب",
  nameCkb: null,
  nameEn: "Milk",
  sku: "M-1",
  trackingMode: "NONE",
  tracksExpiry: false,
  isTestData: false,
  archived: false,
  units: [unit("u1", "حبة", 1, true), unit("u2", "كرتون", 24)],
  ...over,
});

function leafKeys(o: unknown, prefix = ""): string[] {
  if (typeof o !== "object" || o === null) return [prefix];
  return Object.entries(o as Record<string, unknown>)
    .flatMap(([k, v]) => leafKeys(v, prefix ? `${prefix}.${k}` : k))
    .sort();
}

describe("receiving rules", () => {
  it("scanning the same barcode twice raises the line quantity", () => {
    const milk = info();
    let s = addScanned([], milk, "u1", IQD_ONLY, "a");
    expect(s.bumped).toBe(false);
    s = addScanned(s.lines, milk, "u1", IQD_ONLY, "b");
    expect(s.bumped).toBe(true);
    expect(s.key).toBe("a");
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]!.quantity).toBe("2");

    // Another unit of the same item is its own line; a third scan of the piece raises the first line again.
    s = addScanned(s.lines, milk, "u2", IQD_ONLY, "c");
    expect(s.lines.map((l) => [l.unitId, l.quantity])).toEqual([
      ["u1", "2"],
      ["u2", "1"],
    ]);
    s = addScanned(s.lines, milk, "u1", IQD_ONLY, "d");
    expect(s.lines[0]!.quantity).toBe("3");

    // A typed fraction or Arabic digits are raised by one whole unit; text that is not a number starts a new line.
    const typed = s.lines.map((l, i) => (i === 0 ? { ...l, quantity: "١٫٥" } : l));
    expect(addScanned(typed, milk, "u1", IQD_ONLY, "e").lines[0]!.quantity).toBe("2.5");
    const broken = s.lines.map((l, i) => (i === 0 ? { ...l, quantity: "abc" } : l));
    expect(addScanned(broken, milk, "u1", IQD_ONLY, "f").lines).toHaveLength(3);

    // Items the server would refuse never become lines.
    expect(blockedReason(info({ isTestData: true }))).toBe("TEST_ITEM");
    expect(blockedReason(info({ trackingMode: "SERIAL" }))).toBe("SERIAL_NOT_SUPPORTED");
    expect(blockedReason(info({ archived: true }))).toBe("ARCHIVED");
    expect(blockedReason(info({ units: [] }))).toBe("NO_UNITS");
    expect(blockedReason(milk)).toBeNull();
  });

  it("the post button is disabled while a post is in flight", async () => {
    const idle = html(createElement(PostBar, { t: ar, posting: false, blocked: false, canDiscard: true, onPost: () => {}, onDiscard: () => {} }));
    expect(idle).not.toMatch(/data-testid="receipt-post"[^>]*aria-disabled="true"|aria-disabled="true"[^>]*data-testid="receipt-post"/);
    expect(idle).toContain(ar.stock.receive.post);

    const busy = html(createElement(PostBar, { t: ar, posting: true, blocked: false, canDiscard: true, onPost: () => {}, onDiscard: () => {} }));
    // aria-disabled (not disabled) keeps focus on the button while the answer is awaited.
    expect(busy).toMatch(/<button[^>]*aria-disabled="true"[^>]*aria-busy="true"[^>]*data-testid="receipt-post"/);
    expect(busy).toContain(ar.stock.receive.posting);
    expect(busy).toMatch(/<button[^>]*disabled=""[^>]*data-testid="receipt-discard"/);

    // A double click starts one post only: the second call is refused before anything awaits.
    const flight = new SingleFlight();
    let posts = 0;
    let release!: () => void;
    const task = () =>
      new Promise<string>((done) => {
        posts += 1;
        release = () => done("posted");
      });
    const first = flight.run(task);
    expect(flight.busy).toBe(true);
    expect(await flight.run(task)).toBeNull();
    release();
    expect(await first).toBe("posted");
    expect(posts).toBe(1);
    expect(flight.busy).toBe(false);

    // A retry of the same document version keeps its idempotency key; a new version gets a new one.
    const a = nextAttempt(null, "doc:1", makeKey);
    expect(nextAttempt(a, "doc:1", makeKey)).toBe(a);
    expect(nextAttempt(a, "doc:2", makeKey).key).not.toBe(a.key);
  });

  it("the rate field appears only for a foreign currency and defaults to the last rate", () => {
    const milk = info();
    const iqd = newLine(milk, "u1", BOTH, "a", []);
    expect(iqd.currency).toBe("IQD");
    expect(iqd.rate).toBe("");
    expect(showsRate(iqd, BOTH)).toBe(false);

    const usd = withCurrency(iqd, "USD", [], BOTH);
    expect(usd.rate).toBe("1310");
    expect(showsRate(usd, BOTH)).toBe(true);
    // The rate typed last in this form wins over the last posted one; a new line keeps the currency before it.
    const typed = { ...usd, rate: "1320" };
    const next = newLine(milk, "u2", BOTH, "b", [typed]);
    expect(next.currency).toBe("USD");
    expect(next.rate).toBe("1320");
    // Back to dinar: no rate is kept or sent.
    expect(withCurrency(typed, "IQD", [], BOTH).rate).toBe("");
    expect(rateText("1310000000")).toBe("1310");
    expect(rateText(1310500000n)).toBe("1310.5");

    const props = { locale: "en" as const, t: en, index: 0, kind: "RECEIPT" as const, settings: BOTH, problems: [], warnings: [], disabled: false, onChange: () => {}, onRemove: () => {} };
    const withCost = { ...typed, cost: "2.5" };
    const foreign = html(createElement(LineFields, { ...props, line: withCost }));
    expect(foreign).toContain('data-testid="line-rate"');
    expect(foreign).toContain('value="1320"');
    expect(foreign).toContain(en.stock.receive.rate);
    expect(html(createElement(LineFields, { ...props, line: { ...withCost, currency: "IQD", rate: "" } }))).not.toContain('data-testid="line-rate"');
    // A business with one currency gets no currency choice at all.
    expect(html(createElement(LineFields, { ...props, settings: IQD_ONLY, line: iqd }))).not.toContain('data-testid="line-currency"');
    // Batch and expiry only for an item tracked by batch.
    expect(foreign).not.toContain('data-testid="line-expiry"');
    const batch = html(createElement(LineFields, { ...props, line: { ...withCost, item: info({ trackingMode: "BATCH", tracksExpiry: true }) } }));
    expect(batch).toContain('data-testid="line-batch"');
    expect(batch).toContain('data-testid="line-expiry"');

    // A foreign cost needs its rate; a draft can still be saved without it, a receipt cannot be posted.
    const noRate = { ...withCost, rate: "" };
    expect(lineIssues(noRate, "RECEIPT", BOTH, TODAY).problems).toEqual(["RATE_REQUIRED"]);
    expect(firstUnsavable([noRate], "RECEIPT", BOTH, TODAY)).toBeNull();
    expect(firstUnpostable([noRate], "RECEIPT", BOTH, TODAY)).toBe(1);
    expect(draftPayload("RECEIPT", "", "", [withCost], BOTH).lines[0]).toEqual({
      variantId: "v1",
      unitId: "u1",
      quantity: "1",
      cost: { amount: "2.5", currency: "USD" },
      rate: "1320",
    });
  });
});

describe("receiving drafts", () => {
  it("a draft survives a reload", async () => {
    if ((await db.rtPlan.count()) === 0) await createPlan(db, { maxBranches: 3 });
    const w = await createBusinessWithStaff(db, {
      branches: ["Main"],
      staff: [
        { key: "owner", role: "OWNER" },
        { key: "stock", role: "STOCK", branches: ["Main"] },
      ],
    });
    const businessId = w.business.id;
    await db.rtBusiness.update({ where: { id: businessId }, data: { status: "ACTIVE", enabledCurrencies: ["IQD", "USD"], defaultCurrency: "IQD" } });
    await db.rtSubscription.create({
      data: { businessId, planCode: "basic", status: "ACTIVE", currentPeriodStart: new Date(Date.now() - DAY), currentPeriodEnd: new Date(Date.now() + 30 * DAY) },
    });
    await db.rtLocation.create({ data: { businessId, branchId: w.branches.Main!.id, name: "المخزن" } });
    const as = (who: string) => ({ userId: w.staff[who]!.user.id, businessId, idempotencyKey: randomUUID() });

    async function product(tracksExpiry: boolean, sku: string) {
      const p = await db.rtProduct.create({ data: { businessId, nameAr: "جبن", trackingMode: tracksExpiry ? "BATCH" : "NONE", tracksExpiry } });
      const v = await db.rtVariant.create({ data: { businessId, productId: p.id, sku } });
      const piece = await db.rtUnit.create({ data: { businessId, variantId: v.id, name: "حبة", factor: 1, isBase: true } });
      const carton = await db.rtUnit.create({ data: { businessId, variantId: v.id, name: "كرتون", factor: 24 } });
      const item = await loadReceiptItem(p.id, v.id, as("owner"));
      if (!item.ok) throw new Error(item.code);
      return { item: item.value, piece: piece.id, carton: carton.id };
    }
    const milk = await product(false, "R-1");
    const cheese = await product(true, "R-2");
    expect(milk.item.units[0]!.isBase).toBe(true);

    let lines: ReceiptLine[] = addScanned([], milk.item, milk.carton, BOTH, makeKey()).lines;
    lines = [{ ...withCurrency(lines[0]!, "USD", [], BOTH), quantity: "2", cost: "2.50" }];
    lines = addScanned(lines, cheese.item, cheese.piece, BOTH, makeKey()).lines;
    lines[1] = { ...withCurrency(lines[1]!, "IQD", lines, BOTH), quantity: "10", cost: "1500", batchCode: "B-7", expiryDate: "2099-01-31" };
    expect(firstUnpostable(lines, "RECEIPT", BOTH, TODAY)).toBeNull();

    const payload = draftPayload("RECEIPT", "مورد ١", "", lines, BOTH);
    const saved = await saveStockDraft(payload, as("owner"));
    if (!saved.ok) throw new Error(saved.code);

    // The owner reloads: the same lines come back, and saving them again sends exactly what was saved.
    const back = await loadReceiptDraft(saved.value.documentId, as("owner"));
    if (!back.ok) throw new Error(back.code);
    expect(back.value.doc.version).toBe(saved.value.version);
    expect(back.value.doc.status).toBe("DRAFT");
    const restored = restoreLines(back.value.doc, back.value.items, BOTH, makeKey);
    expect(restored).not.toBeNull();
    expect(hasHiddenCosts(restored!)).toBe(false);
    expect(draftPayload("RECEIPT", back.value.doc.supplierRef ?? "", back.value.doc.note ?? "", restored!, BOTH)).toEqual(payload);

    // A stock keeper (no cost.view) gets no cost at all, sees the lines as holding a hidden cost, and
    // the form refuses to save them (a save replaces every line and would erase the costs).
    const keeper = await loadReceiptDraft(saved.value.documentId, as("stock"));
    if (!keeper.ok) throw new Error(keeper.code);
    expect(JSON.stringify(keeper.value)).not.toMatch(/unitCostMinor|valueMinor|rateMicro|"currency"/);
    const hidden = restoreLines(keeper.value.doc, keeper.value.items, BOTH, makeKey)!;
    expect(hidden.every((l) => l.costHidden && l.cost === "")).toBe(true);
    expect(hasHiddenCosts(hidden)).toBe(true);
    // No cost is required of a hidden-cost line (the server holds one), and a scan never raises it.
    expect(lineIssues(hidden[0]!, "RECEIPT", BOTH, TODAY).problems).toEqual([]);
    expect(addScanned(hidden, milk.item, milk.carton, BOTH, "new").lines).toHaveLength(3);
    const notice = html(createElement(HiddenCostNotice, { t: ar }));
    expect(notice).toContain('data-testid="receipt-hidden-costs"');
    expect(notice).toContain(ar.stock.receive.hiddenTitle);

    // An opening draft without costs stays editable for the stock keeper.
    const opening = await saveStockDraft(draftPayload("OPENING", "", "", [{ ...lines[0]!, cost: "", currency: "IQD", rate: "" }], BOTH), as("stock"));
    if (!opening.ok) throw new Error(opening.code);
    const open = await loadReceiptDraft(opening.value.documentId, as("stock"));
    if (!open.ok) throw new Error(open.code);
    expect(hasHiddenCosts(restoreLines(open.value.doc, open.value.items, BOTH, makeKey)!)).toBe(false);

    // A link to a draft that does not exist is NOT_FOUND, not an error page.
    const missing = await loadReceiptDraft("no-such-draft", as("owner"));
    expect(missing.ok ? null : missing.code).toBe("NOT_FOUND");
  });
});

describe("receiving and import messages", () => {
  it("message parity and states", () => {
    for (const pick of [(t: typeof ar) => t.stock.receive, (t: typeof ar) => t.stock.openingImport, (t: typeof ar) => t.setup.openingStep]) {
      const keys = leafKeys(pick(ar));
      expect(keys.length).toBeGreaterThan(5);
      expect(leafKeys(pick(ckb))).toEqual(keys);
      expect(leafKeys(pick(en))).toEqual(keys);
      for (const t of [ar, ckb, en]) {
        for (const leaf of keys) {
          const value = leaf.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], pick(t));
          expect(typeof value).toBe("string");
          expect((value as string).trim()).not.toBe("");
        }
      }
    }
    expect(en.stock.receive.titleRECEIPT).not.toBe(ar.stock.receive.titleRECEIPT);
    expect(ckb.stock.openingImport.title).not.toBe(ar.stock.openingImport.title);

    // Every reason a refusal can carry reads in the interface language, never as a code.
    for (const t of [ar, ckb, en]) {
      for (const reason of ["COST_REQUIRED", "RATE_REQUIRED", "EXPIRY_REQUIRED", "EXPIRED", "OPENING_AFTER_MOVEMENT", "CURRENCY_NOT_ENABLED", "KIND", "EMPTY"]) {
        const text = receiptFailureMessage(t, { code: "STOCK_RULE", details: { lineNo: "2", reason } });
        expect(text).not.toContain(reason);
        expect(text).toContain(t === en ? "Line 2" : t.stock.receive.doneWarning.split("{")[0]!.trim());
      }
      expect(receiptFailureMessage(t, { code: "VERSION_CONFLICT" })).toBe(t.errors.VERSION_CONFLICT);
      expect(receiptFailureMessage(t, { code: "TEST_ITEM", details: { lineNo: "1" } })).not.toContain("TEST_ITEM");
    }

    // States: no lines yet, every save state, the success summary (with the total only when sent).
    expect(html(createElement(LinesEmpty, { t: ckb }))).toContain(ckb.stock.receive.emptyTitle);
    for (const state of [{ kind: "idle" }, { kind: "saving" }, { kind: "saved" }, { kind: "pending" }, { kind: "offline" }] as const) {
      expect(html(createElement(SaveStatusText, { locale: "en", t: en, state }))).toContain(en.stock.receive.saveState[state.kind]);
    }
    expect(html(createElement(SaveStatusText, { locale: "en", t: en, state: { kind: "blocked", line: 3 } }))).toContain("line 3");
    expect(html(createElement(SaveStatusText, { locale: "en", t: en, state: { kind: "failed", failure: { code: "VERSION_CONFLICT" } } }))).not.toContain("VERSION_CONFLICT");

    const done = { documentId: "d1", number: 42, kind: "RECEIPT" as const, lineCount: 2, totalMinor: "125000", warnings: [{ lineNo: 2, code: "EXPIRED" as const }] };
    const shown = html(createElement(ReceiptDone, { locale: "ar", t: ar, currency: "IQD", done }));
    expect(shown).toContain('data-testid="receipt-done"');
    expect(shown).toContain("٤٢");
    expect(shown).toContain("١٢٥٬٠٠٠");
    expect(shown).toContain(ar.stock.receive.warnings.EXPIRED);
    const noCost = html(createElement(ReceiptDone, { locale: "en", t: en, currency: "IQD", done: { ...done, totalMinor: undefined, warnings: [] } }));
    expect(noCost).not.toContain("Total value");
    expect(noCost).toContain(en.stock.receive.newDocument);

    // The import wizard: the cost column is locked for a role without cost.view (it keeps its column
    // and that column is offered to no other field), and row statuses read as words.
    const mapping = { barcode: 0, sku: null, quantity: 1, unit: null, cost: 2, currency: null, rate: null, batch: null, expiry: null };
    expect(COST_FIELD).toBe("cost");
    expect(lockedMapping({ ...mapping, cost: null, quantity: 2 }, mapping, false)).toEqual(mapping);
    expect(lockedMapping({ ...mapping, quantity: 3 }, mapping, true)).toEqual({ ...mapping, quantity: 3 });
    expect(mappingProblems({ ...mapping, barcode: null })).toContain("MISSING_IDENTIFIER");
    expect(mappingProblems({ ...mapping, quantity: null })).toContain("MISSING_QUANTITY");
    expect(mappingProblems({ ...mapping, sku: 0 })).toContain("DUPLICATE_COLUMN");
    expect(mappingProblems(mapping)).toEqual([]);
    expect(rowStatusText(en, { status: "REJECTED", reason: "UNKNOWN_ITEM" })).toContain(en.stock.openingImport.reasons.UNKNOWN_ITEM);
    expect(rowStatusText(ar, { status: "OK", reason: null })).toBe(ar.stock.openingImport.rowStatus.OK);
    expect(rowStatusText(en, { status: "REJECTED", reason: "SOMETHING_NEW" })).not.toContain("SOMETHING_NEW");
  });
});
