import { describe, expect, it } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ar } from "@/messages/ar";
import { ckb } from "@/messages/ckb";
import { en } from "@/messages/en";
import { lineValueMinor } from "@/server/domain/stock";
import {
  addCash,
  addItem,
  cardRest,
  cartCount,
  cartTotal,
  exactCash,
  holdCart,
  lineTotal,
  parseAmount,
  parseHeld,
  payState,
  paymentsOf,
  quickAmounts,
  removeLine,
  repriceLines,
  resumeCart,
  setQuantity,
  stepLine,
  MAX_HELD,
  type CartLine,
  type ReceiptDto,
  type SellItemDto,
  type ShiftDto,
} from "../../src/app/retail/sell/_lib/cart";
import { CartLineRow, Numpad, PaySummary, Receipt, ShiftSummaryView, Tile, differenceText, entryText } from "../../src/app/retail/sell/_lib/views";
import { categoryTone, keyFromKeyboard, minorToEntry, moneyDecimals, numpadKeys, numpadPress, tileInitial, CATEGORY_TONES, type NumpadKey } from "../../src/app/retail/sell/_lib/till";

const html = (el: ReactElement) => renderToStaticMarkup(el);

const item = (over: Partial<SellItemDto> = {}): SellItemDto => ({
  variantId: "v1",
  unitId: "u1",
  nameAr: "سكر",
  nameCkb: "شەکر",
  nameEn: "Sugar",
  unitName: "قطعة",
  quantityScale: 0,
  factor: 1,
  soldByWeight: false,
  priceMinor: "1500",
  currency: "IQD",
  onHand: "10000",
  matchedBarcode: null,
  categoryId: null,
  ...over,
});
const cheese = item({ variantId: "v2", unitId: "u2", nameAr: "جبن", nameEn: "Cheese", unitName: "كغم", quantityScale: 3, soldByWeight: true, priceMinor: "1500" });

describe("the cart", () => {
  it("a tap adds one, a second tap merges, - removes the line at zero", () => {
    let lines = addItem([], item());
    lines = addItem(lines, item());
    expect(lines).toHaveLength(1);
    expect(lines[0]!.quantity).toBe("2");
    expect(cartTotal(lines)).toBe(3000n);
    lines = stepLine(lines, lines[0]!.key, -1);
    expect(lines[0]!.quantity).toBe("1");
    lines = stepLine(lines, lines[0]!.key, -1);
    expect(lines).toEqual([]);
  });

  it("an item without a price is never added", () => {
    expect(addItem([], item({ priceMinor: null }))).toEqual([]);
  });

  it("the line total matches the server's half-up rule for weights, Arabic digits included", () => {
    let lines = addItem([], cheese);
    lines = setQuantity(lines, lines[0]!.key, "0.333")!;
    expect(lineTotal(lines[0]!)).toBe(500n); // 1500 x 0.333 = 499.5 -> 500
    expect(lineTotal(lines[0]!)).toBe(lineValueMinor(1500n, "0.333", { factor: 1, quantityScale: 3 }));
    lines = setQuantity(lines, lines[0]!.key, "٠٫٢٥١")!;
    expect(lines[0]!.quantity).toBe("0.251");
    expect(lineTotal(lines[0]!)).toBe(377n);
    // More decimals than the unit holds, zero and text are refused.
    expect(setQuantity(lines, lines[0]!.key, "0.2505")).toBeNull();
    expect(setQuantity(lines, lines[0]!.key, "0")).toBeNull();
    expect(setQuantity(lines, lines[0]!.key, "abc")).toBeNull();
    // A piece unit takes whole numbers only.
    const pieces = addItem([], item());
    expect(setQuantity(pieces, pieces[0]!.key, "1.5")).toBeNull();
  });

  it("a weighed line counts once in the piece count; removing a line drops it", () => {
    const lines = addItem(addItem(addItem([], item()), item()), cheese);
    expect(cartCount(lines)).toBe(3);
    expect(removeLine(lines, lines[0]!.key)).toHaveLength(1);
  });

  it("new prices after PRICE_CHANGED replace the old ones, a unit without price drops out", () => {
    const lines = addItem(addItem([], item()), cheese);
    const next = repriceLines(lines, { u1: "1750", u2: null });
    expect(next).toHaveLength(1);
    expect(next[0]!.priceMinor).toBe(1750n);
  });
});

describe("paying", () => {
  it("quick amounts start with the exact amount, then likely notes, all at least the due", () => {
    expect(quickAmounts(7250n, "IQD")).toEqual([7250n, 8000n, 10000n, 25000n, 50000n, 100000n]);
    expect(quickAmounts(5000n, "IQD")).toEqual([5000n, 10000n, 25000n, 50000n, 100000n]);
    expect(quickAmounts(60000n, "IQD")).toEqual([60000n, 75000n, 100000n]);
    for (const v of quickAmounts(123456n, "IQD")) expect(v >= 123456n).toBe(true);
  });

  it("notes add up; the change is what the customer gets back", () => {
    let tn = addCash({ cashMinor: 0n, cardMinor: 0n }, 10000n);
    expect(payState(7250n, tn)).toMatchObject({ ready: true, change: 2750n, remaining: 0n });
    tn = addCash({ cashMinor: 0n, cardMinor: 0n }, 5000n);
    expect(payState(7250n, tn)).toMatchObject({ ready: false, remaining: 2250n });
    expect(payState(7250n, exactCash(7250n, tn))).toMatchObject({ ready: true, change: 0n });
  });

  it("mixed: cash given, the card takes the rest; the card never pays more than the total", () => {
    const tn = cardRest(7250n, { cashMinor: 5000n, cardMinor: 0n });
    expect(tn).toEqual({ cashMinor: 5000n, cardMinor: 2250n });
    expect(payState(7250n, tn).ready).toBe(true);
    expect(paymentsOf(tn)).toEqual([
      { method: "CASH", amountMinor: "5000" },
      { method: "CARD", amountMinor: "2250" },
    ]);
    // All by card, then a note on top: refused (the server says CASH_NOT_NEEDED).
    const all = cardRest(7250n, { cashMinor: 0n, cardMinor: 0n });
    expect(payState(7250n, addCash(all, 1000n)).ready).toBe(false);
  });

  it("typed amounts accept Arabic digits and separators", () => {
    expect(parseAmount("١٠٬٠٠٠", "IQD")).toBe(10000n);
    expect(parseAmount("12.50", "USD")).toBe(1250n);
    expect(parseAmount("abc", "IQD")).toBeNull();
  });
});

describe("the numpad and the tiles", () => {
  const type = (keys: NumpadKey[], decimals: number) => keys.reduce((x, k) => numpadPress(x, k, decimals), "");

  it("types money without leading zeros, '000' multiplies, backspace and clear edit", () => {
    expect(type(["2", "5", "000"], 0)).toBe("25000");
    expect(type(["0", "0", "7"], 0)).toBe("7");
    expect(type(["000"], 0)).toBe("");
    expect(type(["1", "2", "back"], 0)).toBe("1");
    expect(type(["1", "2", "clear"], 0)).toBe("");
    // No decimal mark for dinar; one mark and at most two decimals for dollar.
    expect(type(["1", "."], 0)).toBe("1");
    expect(type([".", "5", ".", "0", "1"], 2)).toBe("0.50");
    expect(parseAmount(type(["1", "2", ".", "5"], 2), "USD")).toBe(1250n);
    // Twelve whole digits at most.
    expect(type(Array.from({ length: 15 }, () => "9" as NumpadKey), 0)).toHaveLength(12);
  });

  it("weights take the unit's decimals, and the typed text is what setQuantity accepts", () => {
    const w = type(["0", ".", "7", "5", "0", "1"], 3);
    expect(w).toBe("0.750");
    const lines = addItem([], cheese);
    expect(setQuantity(lines, lines[0]!.key, w)![0]!.quantity).toBe("0.75");
    expect(numpadKeys(3)).toContain(".");
    expect(numpadKeys(0)).toContain("000");
  });

  it("a physical keyboard (Arabic-Indic digits included) feeds the same keys", () => {
    expect(keyFromKeyboard("٥")).toBe("5");
    expect(keyFromKeyboard("7")).toBe("7");
    expect(keyFromKeyboard("Backspace")).toBe("back");
    expect(keyFromKeyboard("٫")).toBe(".");
    expect(keyFromKeyboard("a")).toBeNull();
  });

  it("amounts start the numpad in its own text; dinar has no decimals", () => {
    expect(minorToEntry("IQD", 25000n)).toBe("25000");
    expect(minorToEntry("USD", 1250n)).toBe("12.5");
    expect(minorToEntry("USD", 1200n)).toBe("12");
    expect(minorToEntry("IQD", 0n)).toBe("");
    expect(moneyDecimals("IQD")).toBe(0);
    expect(moneyDecimals("USD")).toBe(2);
  });

  it("category tones follow the category list and cycle; initials skip the Arabic article", () => {
    const cats = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}` }));
    expect(categoryTone(cats, "c2")).toBe(2);
    expect(categoryTone(cats, "c9")).toBe(9 % CATEGORY_TONES);
    expect(categoryTone(cats, "nope")).toBeNull();
    expect(categoryTone(cats, null)).toBeNull();
    expect(tileInitial("الرز")).toBe("ر");
    expect(tileInitial("ال")).toBe("ا");
    expect(tileInitial("sugar")).toBe("S");
    expect(tileInitial("شەکر")).toBe("ش");
    expect(tileInitial("")).toBe("");
  });
});

describe("held carts", () => {
  it("hold and resume round-trip; at most MAX_HELD are kept; storage junk is dropped", () => {
    const lines = addItem([], item());
    let held = holdCart([], lines, "h1", new Date("2026-11-03T08:00:00Z"));
    const raw = JSON.stringify(held);
    expect(parseHeld(raw)).toEqual(held);
    const r = resumeCart(parseHeld(raw), "h1")!;
    expect(r.lines).toEqual(lines);
    expect(r.held).toEqual([]);
    for (let i = 0; i < 15; i++) held = holdCart(held, lines, `h${i + 2}`, new Date());
    expect(held).toHaveLength(MAX_HELD);
    expect(parseHeld("not json")).toEqual([]);
    expect(parseHeld(JSON.stringify([{ id: 1 }, { id: "x", at: "y", lines: [{ unitId: "u", priceMinor: "-5", quantity: "1" }] }]))).toEqual([]);
    expect(holdCart([], [], "e", new Date())).toEqual([]);
  });
});

describe("views", () => {
  const ctx = { locale: "ar" as const, t: ar };
  const line = (): CartLine => addItem([], item())[0]!;

  it("a tile shows the name and price; without a price it is disabled", () => {
    const on = html(createElement(Tile, { ...ctx, item: item() }));
    expect(on).toContain("سكر");
    expect(on).toContain("١٬٥٠٠");
    expect(on).not.toContain("disabled");
    const off = html(createElement(Tile, { ...ctx, item: item({ priceMinor: null }) }));
    expect(off).toContain("disabled");
    expect(off).toContain(ar.sell.noPrice);
    expect(html(createElement(Tile, { ...ctx, item: item({ onHand: "0" }) }))).toContain(ar.sell.outOfStock);
  });

  it("a tile carries its category tone and the name's first letter in the photo slot (the Arabic article skipped)", () => {
    const out = html(createElement(Tile, { ...ctx, item: item({ nameAr: "الرز" }), tone: 3 }));
    expect(out).toContain('data-tone="3"');
    expect(out).toContain('till-tile-initial">ر<');
    expect(html(createElement(Tile, { ...ctx, item: item() }))).not.toContain("data-tone");
  });

  it("the quantity of a cart line is a button that opens the numpad", () => {
    const out = html(createElement(CartLineRow, { ...ctx, line: line(), currency: "IQD" }));
    expect(out).toMatch(/<button[^>]*aria-label="تغيير كمية سكر"[^>]*data-testid="cart-qty"/);
    const weighed = html(createElement(CartLineRow, { ...ctx, line: addItem([], cheese)[0]!, currency: "IQD" }));
    expect(weighed).not.toContain('data-testid="cart-inc"');
    expect(weighed).toContain('data-testid="cart-qty"');
  });

  it("the numpad keeps the calculator layout, shows local digits, '000' for dinar and the decimal mark for decimals", () => {
    const iqd = html(createElement(Numpad, { ...ctx, label: "x", decimals: 0, onPress: () => {} }));
    expect(iqd).toContain('dir="ltr"');
    expect(iqd).toContain('data-testid="key-000"');
    expect(iqd).not.toContain('data-testid="key-dot"');
    expect(iqd).toContain(">٧<");
    expect(iqd).toContain(`aria-label="${ar.till.backspace}"`);
    const usd = html(createElement(Numpad, { locale: "en", t: en, label: "x", decimals: 2, onPress: () => {} }));
    expect(usd).toContain('data-testid="key-dot"');
    expect(usd).toContain(">7<");
    expect(entryText("ar", "12.5")).toBe("١٢٫٥");
  });

  it("a cart line has big - and + with spoken labels, in the interface language", () => {
    const out = html(createElement(CartLineRow, { ...ctx, line: line(), currency: "IQD" }));
    expect(out).toContain('data-testid="cart-dec"');
    expect(out).toContain('data-testid="cart-inc"');
    expect(out).toContain("زيادة سكر");
    const enOut = html(createElement(CartLineRow, { locale: "en", t: en, line: line(), currency: "IQD" }));
    expect(enOut).toContain("Add one Sugar");
  });

  it("the pay summary shows the change when covered and the remaining otherwise", () => {
    const covered = html(createElement(PaySummary, { ...ctx, currency: "IQD", state: payState(7250n, { cashMinor: 10000n, cardMinor: 0n }) }));
    expect(covered).toContain('data-testid="pay-change"');
    expect(covered).toContain("٢٬٧٥٠");
    const short = html(createElement(PaySummary, { ...ctx, currency: "IQD", state: payState(7250n, { cashMinor: 5000n, cardMinor: 0n }) }));
    expect(short).toContain('data-testid="pay-remaining"');
  });

  it("the receipt lists lines, total, cash given and change; the shift summary and difference words", () => {
    const receipt: ReceiptDto = {
      saleId: "s1",
      number: 7,
      saleKey: "k",
      currency: "IQD",
      totalMinor: "7250",
      paidMinor: "7250",
      changeMinor: "2750",
      postedAt: "2026-11-03T08:00:00Z",
      lines: [{ lineNo: 1, nameAr: "سكر", nameCkb: null, nameEn: "Sugar", unitName: "قطعة", quantity: "2", unitPriceMinor: "1500", lineTotalMinor: "3000" }],
      payments: [{ method: "CASH", amountMinor: "7250", tenderedMinor: "10000" }],
    };
    const r = html(createElement(Receipt, { ...ctx, receipt, business: "دكان", branch: "المركز", cashier: "علي" }));
    expect(r).toContain("فاتورة رقم ٧");
    expect(r).toContain('data-testid="receipt-change"');
    expect(r).toContain("١٠٬٠٠٠");
    const shift: ShiftDto = {
      id: "sh",
      version: 1,
      openedAt: "2026-11-03T05:00:00Z",
      currency: "IQD",
      openingCashMinor: "50000",
      salesCount: 3,
      totalMinor: "20000",
      cashMinor: "15000",
      cardMinor: "5000",
      expectedCashMinor: "65000",
    };
    const sm = html(createElement(ShiftSummaryView, { ...ctx, shift }));
    expect(sm).toContain("٦٥٬٠٠٠");
    expect(sm).toContain(ar.sell.close.expected);
    expect(differenceText(ctx, "IQD", 0n)).toEqual({ tone: "good", text: ar.sell.close.matches });
    expect(differenceText(ctx, "IQD", -250n).tone).toBe("bad");
    expect(differenceText(ctx, "IQD", 500n).text).toContain(ar.sell.close.over);
  });

  it("every sell string exists in ckb and en", () => {
    const keys = (o: object, p = ""): string[] =>
      Object.entries(o).flatMap(([k, v]) => (typeof v === "object" && v !== null ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
    expect(keys(ckb.sell)).toEqual(keys(ar.sell));
    expect(keys(en.sell)).toEqual(keys(ar.sell));
    expect(keys(ckb.till)).toEqual(keys(ar.till));
    expect(keys(en.till)).toEqual(keys(ar.till));
  });

  it("the till words say nothing about later releases and name no other product", () => {
    for (const t of [ar, ckb, en]) {
      const text = JSON.stringify([t.sell, t.till]);
      expect(text).not.toMatch(/release|إصدار|وەشان|Studio|Core|restaurant|pharmacy|cashier/i);
    }
  });
});
