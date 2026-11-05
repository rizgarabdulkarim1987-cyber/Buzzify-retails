import { readFileSync } from "node:fs";
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
  microToRateText,
  quickUsdAmounts,
  rateToMicro,
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
import { ACCENT, CARD, DIM, PALETTE, accentFor, contrast } from "../../src/app/retail/sell/_lib/category-accent";
import { hasGlyph } from "../../src/app/retail/sell/_lib/category-icons";
import { STANDARD_CATEGORY_KEYS, categoryKind } from "../../src/app/retail/sell/_lib/category-kind";
import { CategoryTile } from "../../src/app/retail/sell/_lib/category-tile";
import { ExpensePanel, ExpenseSection } from "../../src/app/retail/sell/expense-panel";
import { EXPENSE_CATEGORIES, activeTotal, expenseState, type ExpenseDto } from "../../src/app/retail/sell/_lib/expenses";
import { ExpenseList, Numpad, PayMethods, PaySummary, Receipt, ShiftSummaryView, TicketPad, TicketRow, Tile, UsdDue, differenceText, entryText } from "../../src/app/retail/sell/_lib/views";
import { offenders } from "../helpers/own-words";
import { TillNav } from "../../src/app/retail/sell/till-nav";
import { categoryTone, keyFromKeyboard, minorToEntry, moneyDecimals, numpadKeys, numpadPress, tileInitial, textLength, CATEGORY_TONES, type NumpadKey } from "../../src/app/retail/sell/_lib/till";

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

describe("till v3: compact tiles and the shop frame", () => {
  const ctx = { locale: "ar" as const, t: ar };

  it("textLength counts characters, not UTF-16 units (the total's font size divides by it)", () => {
    expect(textLength("٩٬٩٩٩٬٩٩٩٬٩٩٩ د.ع")).toBe(17);
    expect(textLength("😀a")).toBe(2);
  });

  it("a tile is text first and one neutral style: name, price, the cart count; no colour, no picture area, no big letter", () => {
    const out = html(createElement(Tile, { ...ctx, item: item({ nameAr: "بسكويت ماري" }), qty: 3 }));
    expect(out).not.toContain("data-tone");
    expect(out).toContain('data-incart="true"');
    expect(out).toContain('data-testid="tile-qty"');
    expect(out).toContain("till-tile-name");
    expect(out).not.toContain("till-tile-media");
    expect(out).not.toContain("till-tile-initial");
    expect(out).not.toContain("<svg");
    const plain = html(createElement(Tile, { ...ctx, item: item() }));
    expect(plain).not.toContain("tile-qty");
    expect(plain).not.toContain("data-incart");
  });

  it("a very large price keeps its whole text and tells the box its length", () => {
    const out = html(createElement(Tile, { ...ctx, item: item({ priceMinor: "9999999999" }) }));
    expect(out).toContain("٩٬٩٩٩٬٩٩٩٬٩٩٩");
    expect(out).toMatch(/--len:\d+/);
  });

  it("the shop frame links the screens that exist and shows the rest as soon, without links", () => {
    const out = html(createElement(TillNav, { t: ar, variant: "rail" }));
    for (const href of ["/retail/sell", "/retail/sell/close", "/retail/stock", "/retail/catalog", "/retail/setup"]) expect(out).toContain(`href="${href}"`);
    expect(out).toContain('aria-current="page"');
    for (const k of ["expenses", "suppliers", "customers", "reports"] as const) {
      expect(out).toContain(ar.till.nav[k]);
      expect(out).toMatch(new RegExp(`aria-disabled="true"[^>]*data-testid="nav-${k}"`));
    }
    expect((out.match(/<a /g) ?? []).length).toBe(5);
    expect((out.match(/aria-disabled="true"/g) ?? []).length).toBe(4);
  });

  it("the new till strings exist in the three languages and keep the words guard", () => {
    for (const t of [ar, ckb, en]) {
      for (const k of ["offline", "quickQty", "cartActions", "colItem", "colQty", "colPrice", "ticket", "fnVoid", "fnClear", "fnCustomer", "fnNote", "productsTab", "backToTicket", "padShow", "padHide", "methods", "scanPlaceholder", "scanLabel", "scanNotFound", "allCategories"] as const) expect(t.till[k].length).toBeGreaterThan(1);
      for (const v of Object.values(t.till.nav)) expect(v.length).toBeGreaterThan(1);
      expect(offenders(t.till)).toEqual([]);
    }
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

  it("a category's picture is chosen from the words of its name (ar, ckb, en), with a neutral fallback", () => {
    const cases: [string, string][] = [
      ["ألبان", "dairy"], ["ألبان وأجبان", "dairy"], ["Dairy & Eggs", "dairy"], ["مخبوزات", "bakery"], ["خضار وفواكه", "fruit_veg"],
      ["لحوم ودجاج", "meat_poultry"], ["أسماك ومأكولات بحرية", "fish"], ["مجمدات", "frozen"], ["مواد غذائية أساسية", "staples"],
      ["معلبات", "canned"], ["بهارات وتوابل", "spices"], ["إفطار وحبوب", "breakfast"], ["وجبات خفيفة", "snacks"], ["حلويات وسكاكر", "sweets"],
      ["حلويات ووجبات", "sweets"], ["شاي وقهوة", "tea_coffee"], ["مشروبات", "beverages"], ["منظفات", "cleaning"], ["عناية شخصية", "personal_care"],
      ["أطفال", "baby"], ["مستلزمات الحيوانات الأليفة", "pet"], ["أدوات منزلية", "household"], ["قرطاسية وألعاب", "stationery"], ["ورقيات", "stationery"],
      ["صحة وفيتامينات", "health"], ["تبغ وكبريت", "tobacco"], ["Bakery", "bakery"], ["Frozen food", "frozen"], ["أشياء متفرقة", "other"], ["", "other"],
    ];
    for (const [name, kind] of cases) expect(categoryKind(name), name).toBe(kind);
    expect(categoryKind(null, undefined, "Fresh fish")).toBe("fish");
  });

  it("every standard department key has a glyph and a fixed accent (23 keys); All is white", () => {
    expect(STANDARD_CATEGORY_KEYS).toHaveLength(23);
    for (const key of STANDARD_CATEGORY_KEYS) {
      expect(hasGlyph(key), key).toBe(true);
      if (key !== "other") expect(ACCENT[key], key).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(hasGlyph("all")).toBe(true);
    expect(ACCENT.all).toBe("#ffffff");
    expect(ACCENT.dairy).toBe(PALETTE.sky);
    expect(accentFor("dairy", "any seed")).toBe(accentFor("dairy", "another seed"));
  });

  it("every accent reads on the near-black card at AA (4.5:1) and the dim ink does too", () => {
    for (const [name, hex] of Object.entries({ ...PALETTE, all: ACCENT.all })) expect(contrast(hex, CARD), name).toBeGreaterThanOrEqual(4.5);
    // The dim ink is white at 62%: blend it over the card before measuring.
    const a = Number(/([\d.]+)\)$/.exec(DIM)![1]);
    const blend = [1, 3, 5].map((i) => Math.round(255 * a + parseInt(CARD.slice(i, i + 2), 16) * (1 - a)).toString(16).padStart(2, "0")).join("");
    expect(contrast(`#${blend}`, CARD)).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#ffffff", CARD)).toBeGreaterThanOrEqual(15);
  });

  it("an owner-made category gets a stable accent from the palette (same name, same colour)", () => {
    const palette = new Set<string>(Object.values(PALETTE));
    const seeds = ["قسم جديد", "My shelf", "بەشی نوێ", "x", "", "Cat 7"];
    for (const seed of seeds) {
      expect(palette.has(accentFor("other", seed)), seed).toBe(true);
      expect(accentFor("other", seed)).toBe(accentFor("other", seed));
    }
    expect(new Set(seeds.map((x) => accentFor("other", x))).size).toBeGreaterThan(2);
  });

  it("a category tile is a dark card: glyph, index, name, item count and an Open label; no picture, no price", () => {
    const out = html(createElement(CategoryTile, { name: "ألبان", kind: "dairy", accent: ACCENT.dairy, index: "01", meta: "24 مادة", action: "فتح" }));
    expect(out).toContain("--accent-night:#60a5fa");
    expect(out).toContain("--accent-day:#1d4ed8");
    expect(out).toContain("till-cattile-glyph");
    expect(out).toMatch(/till-cattile-index[^>]*>01</);
    expect(out).toContain("ألبان");
    expect(out).toContain("24 مادة");
    expect(out).toContain("till-cattile-action");
    expect(out.indexOf("till-cattile-name")).toBeLessThan(out.indexOf("till-cattile-meta"));
    expect(out.indexOf("till-cattile-meta")).toBeLessThan(out.indexOf("till-cattile-action"));
    expect(out).not.toContain("<img");
    expect(out).not.toContain("till-tile-price");
  });

  it("a ticket line is one selectable row: name, quantity, unit price and total", () => {
    const out = html(createElement(TicketRow, { ...ctx, line: line(), currency: "IQD", selected: true }));
    expect(out).toMatch(/<button[^>]*aria-pressed="true"[^>]*aria-label="تغيير كمية سكر"[^>]*data-testid="cart-select"/);
    expect(out).toContain('data-selected="true"');
    expect(out).toContain('data-testid="cart-qty"');
    expect(out).toContain("till-row-price");
    expect(out).toContain("till-row-total");
    expect(html(createElement(TicketRow, { ...ctx, line: line(), currency: "IQD" }))).toContain('aria-pressed="false"');
    const weighed = html(createElement(TicketRow, { ...ctx, line: addItem([], cheese)[0]!, currency: "IQD" }));
    expect(weighed).toContain(`<small>${addItem([], cheese)[0]!.unitName}</small>`);
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

  it("the ticket keypad edits the selected line: Qty mode, + and -, backspace and C; no dead keys", () => {
    const out = html(createElement(TicketPad, { ...ctx, decimals: 0, name: "سكر", onPress: () => {}, onStep: () => {} }));
    expect(out).toContain('dir="ltr"');
    for (const id of ["key-mode-qty", "key-plus", "key-minus", "key-back", "key-clear", "key-0", "key-7"]) expect(out).toContain(`data-testid="${id}"`);
    expect(out).not.toContain('data-testid="key-dot"');
    expect(out).not.toContain('data-testid="key-000"');
    expect(out).toContain("زيادة سكر");
    expect(out).toContain("إنقاص سكر");
    const weighed = html(createElement(TicketPad, { locale: "en", t: en, decimals: 3, name: "Cheese", onPress: () => {}, onStep: () => {} }));
    expect(weighed).toContain('data-testid="key-dot"');
    expect(weighed).toContain("Add one Cheese");
    expect(html(createElement(TicketPad, { ...ctx, decimals: 0, name: "", disabled: true, onPress: () => {}, onStep: () => {} }))).toContain("disabled");
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
      expensesMinor: "0",
      usdRateMicro: null,
      openingUsdMinor: "0",
      usdTenderedMinor: "0",
      usdDinarMinor: "0",
      expectedUsdMinor: null,
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

describe("dollars at the till", () => {
  const ctx = { locale: "ar" as const, t: ar };
  const RATE = "1450000000";

  it("quick dollar chips: the exact amount first, then 20, 50 and 100 without repeats", () => {
    expect(quickUsdAmounts(2018n)).toEqual([2018n, 2000n, 5000n, 10000n]);
    expect(quickUsdAmounts(5000n)).toEqual([5000n, 2000n, 10000n]);
    expect(quickUsdAmounts(0n)).toEqual([]);
  });

  it("a typed rate becomes micro-dinars per dollar, and only a believable rate is accepted", () => {
    expect(rateToMicro("1450")).toBe(1450_000000n);
    expect(rateToMicro("١٤٥٠٫٥")).toBe(1450_500000n);
    expect(rateToMicro("")).toBeNull();
    expect(rateToMicro("0")).toBeNull();
    expect(rateToMicro("99")).toBeNull();
    expect(rateToMicro("20000")).toBeNull();
    expect(microToRateText(1450_000000n)).toBe("1450");
    expect(microToRateText(1450_500000n)).toBe("1450.5");
  });

  it("dollars cover the due in dinars at the rate: exact dollars need no extra, one cent less is short", () => {
    const covered = { cashMinor: 0n, cardMinor: 0n, usdMinor: 2018n, usdDinarMinor: 29_261n };
    expect(payState(29_250n, covered)).toMatchObject({ ready: true, remaining: 0n, change: 11n });
    const short = { cashMinor: 0n, cardMinor: 0n, usdMinor: 2017n, usdDinarMinor: 29_246n };
    expect(payState(29_250n, short)).toMatchObject({ ready: false, remaining: 4n });
  });

  it("dollars first, the rest in dinars or by card; dinars that would all be change are not ready", () => {
    const mixed = { cashMinor: 15_000n, cardMinor: 0n, usdMinor: 1000n, usdDinarMinor: 14_500n };
    expect(payState(29_250n, mixed)).toMatchObject({ ready: true, change: 250n });
    expect(exactCash(29_250n, { cashMinor: 0n, cardMinor: 0n, usdMinor: 1000n, usdDinarMinor: 14_500n }).cashMinor).toBe(14_750n);
    const wasted = { cashMinor: 10_000n, cardMinor: 0n, usdMinor: 5000n, usdDinarMinor: 72_500n };
    expect(payState(29_250n, wasted).ready).toBe(false);
    const withCard = cardRest(29_250n, { cashMinor: 0n, cardMinor: 0n, usdMinor: 1000n, usdDinarMinor: 14_500n });
    expect(withCard).toMatchObject({ cardMinor: 14_750n, usdMinor: 1000n });
    expect(payState(29_250n, withCard).ready).toBe(true);
  });

  it("the sale action gets the dinars, the dollars with their dinar value, and the card", () => {
    expect(paymentsOf({ cashMinor: 15_000n, cardMinor: 0n, usdMinor: 1000n, usdDinarMinor: 14_500n })).toEqual([
      { method: "CASH", amountMinor: "15000" },
      { method: "CASH", currency: "USD", usdMinor: "1000", amountMinor: "14500" },
    ]);
    expect(paymentsOf({ cashMinor: 0n, cardMinor: 14_750n, usdMinor: 1000n, usdDinarMinor: 14_500n })).toEqual([
      { method: "CASH", currency: "USD", usdMinor: "1000", amountMinor: "14500" },
      { method: "CARD", amountMinor: "14750" },
    ]);
  });

  it("the keypad types dollars with two decimals", () => {
    expect(["1", "2", ".", "5"].reduce((x, k) => numpadPress(x, k as NumpadKey, moneyDecimals("USD")), "")).toBe("12.5");
    expect(parseAmount("12.5", "USD")).toBe(1250n);
    expect(numpadKeys(moneyDecimals("USD"))).toContain(".");
  });

  it("the method row hides dollars without a rate; with one it shows Cash IQD, Cash USD and Card", () => {
    const base = { ...ctx, target: "IQD" as const, onTarget: () => {}, onCard: () => {}, cardLabel: ar.till.payCard, cardDisabled: false, disabled: false };
    const plain = html(createElement(PayMethods, { ...base, usd: false }));
    expect(plain).toContain('data-testid="pay-method-iqd"');
    expect(plain).toContain('data-testid="pay-card"');
    expect(plain).not.toContain('data-testid="pay-method-usd"');
    expect(plain).not.toContain(ar.till.cashUsd);
    const withUsd = html(createElement(PayMethods, { ...base, usd: true, target: "USD" }));
    expect(withUsd).toContain(ar.till.cashIqd);
    expect(withUsd).toContain(ar.till.cashUsd);
    expect(withUsd).toMatch(/data-testid="pay-method-usd"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-testid="pay-method-usd"/);
  });

  it("the dollar line shows the due in dollars and the rate, in Arabic and in English digits", () => {
    const line = html(createElement(UsdDue, { ...ctx, dueCents: 2018n, rateMicro: RATE }));
    expect(line).toContain('data-testid="pay-usd-due"');
    expect(line).toContain("٢٠٫١٨");
    expect(line).toContain("١٬٤٥٠");
    const eng = html(createElement(UsdDue, { locale: "en", t: en, dueCents: 2018n, rateMicro: RATE }));
    expect(eng).toContain("20.18");
    expect(eng).toContain("1,450");
  });

  const receiptOf = (over: Partial<ReceiptDto>): ReceiptDto => ({
    saleId: "s1",
    number: 8,
    saleKey: "k",
    currency: "IQD",
    totalMinor: "29250",
    paidMinor: "72500",
    changeMinor: "43250",
    postedAt: "2026-11-05T08:00:00Z",
    lines: [{ lineNo: 1, nameAr: "حليب", nameCkb: null, nameEn: "Milk", unitName: "حبة", quantity: "1", unitPriceMinor: "29250", lineTotalMinor: "29250" }],
    payments: [{ method: "CASH", amountMinor: "29250", tenderedMinor: "72500", usdMinor: "5000", rateMicro: RATE }],
    ...over,
  });

  it("the receipt shows the dollars taken, the rate and the change in dinars", () => {
    const r = html(createElement(Receipt, { ...ctx, receipt: receiptOf({}), business: "دكان", branch: "المركز", cashier: "علي" }));
    expect(r).toContain('data-testid="receipt-usd"');
    expect(r).toContain("٥٠٫٠٠");
    expect(r).toContain("١٬٤٥٠");
    expect(r).toContain(ar.till.changeDinars);
    expect(r).toContain("٤٣٬٢٥٠");
  });

  it("a dinar-only receipt shows nothing about dollars", () => {
    const r = html(
      createElement(Receipt, {
        ...ctx,
        receipt: receiptOf({ paidMinor: "30000", changeMinor: "750", payments: [{ method: "CASH", amountMinor: "29250", tenderedMinor: "30000" }] }),
        business: "دكان",
        branch: "المركز",
        cashier: "علي",
      }),
    );
    expect(r).not.toContain('data-testid="receipt-usd"');
    expect(r).not.toContain(ar.till.changeDinars);
  });

  const shiftOf = (over: Partial<ShiftDto>): ShiftDto => ({
    id: "sh",
    version: 1,
    openedAt: "2026-11-05T05:00:00Z",
    currency: "IQD",
    openingCashMinor: "50000",
    salesCount: 3,
    totalMinor: "87750",
    cashMinor: "750",
    cardMinor: "0",
    expectedCashMinor: "50750",
    expensesMinor: "0",
    usdRateMicro: null,
    openingUsdMinor: "0",
    usdTenderedMinor: "0",
    usdDinarMinor: "0",
    expectedUsdMinor: null,
    ...over,
  });

  it("the shift summary shows the dollar drawer only when the shift has a rate", () => {
    const plain = html(createElement(ShiftSummaryView, { ...ctx, shift: shiftOf({}) }));
    expect(plain).not.toContain(ar.till.dollarsInDrawer);
    const withUsd = html(
      createElement(ShiftSummaryView, {
        ...ctx,
        shift: shiftOf({ usdRateMicro: RATE, openingUsdMinor: "10000", usdTenderedMinor: "6000", usdDinarMinor: "87000", expectedUsdMinor: "16000" }),
      }),
    );
    expect(withUsd).toContain(ar.till.dollarsInDrawer);
    expect(withUsd).toContain('data-testid="summary-expected-usd"');
    expect(withUsd).toContain("١٦٠٫٠٠");
  });

  it("the new words exist in ar, ckb and en", () => {
    for (const t of [ar, ckb, en]) {
      for (const k of ["cashIqd", "cashUsd", "rate", "dollarsReceived", "changeDinars", "openingDollars", "dollarsInDrawer", "countedDollars"] as const) {
        expect(t.till[k].length).toBeGreaterThan(1);
      }
    }
  });
});

describe("drawer expenses at the till", () => {
  const exp = (over: Partial<ExpenseDto> = {}): ExpenseDto => ({
    id: "e1",
    categoryKey: "TRANSPORT",
    amountMinor: "5000",
    note: "سائق التوصيل",
    createdAt: "2026-11-05T09:30:00Z",
    voidedAt: null,
    voidReason: null,
    ...over,
  });
  const panel = (locale: "ar" | "ckb" | "en", props: Record<string, unknown> = {}) => {
    const t = { ar, ckb, en }[locale];
    return html(createElement(ExpensePanel, { locale, t, currency: "IQD", shiftId: "sh", canVoid: false, who: "علي", onClose: () => {}, initialList: [], ...props }));
  };

  it("Save is ready with an amount above zero and a category; Other also needs a note", () => {
    const ok = (amountText: string, category: (typeof EXPENSE_CATEGORIES)[number] | null, note = "") => expenseState({ amountText, category, note }, "IQD");
    expect(ok("", "SUPPLIES").ready).toBe(false);
    expect(ok("0", "SUPPLIES").ready).toBe(false);
    expect(ok("5000", null).ready).toBe(false);
    expect(ok("5000", "SUPPLIES")).toMatchObject({ amount: 5000n, ready: true, needsNote: false });
    expect(ok("5000", "OTHER")).toMatchObject({ ready: false, needsNote: true });
    expect(ok("5000", "OTHER", "   ").ready).toBe(false);
    expect(ok("5000", "OTHER", "ice").ready).toBe(true);
  });

  it("the eight categories are the plan's, and every one has a name in ar, ckb and en", () => {
    expect([...EXPENSE_CATEGORIES]).toEqual(["SUPPLIES", "TRANSPORT", "UTILITIES", "CLEANING", "MAINTENANCE", "WAGES", "MEALS", "OTHER"]);
    for (const t of [ar, ckb, en]) for (const c of EXPENSE_CATEGORIES) expect(t.expense.categories[c].length).toBeGreaterThan(1);
  });

  it("the empty panel: amount at zero, eight category cards, a note field, Save disabled, an empty list", () => {
    const h = panel("ar");
    expect(h).toContain('data-testid="expense-panel"');
    expect(h).toContain('role="dialog"');
    expect(h).toContain(ar.expense.title);
    for (const c of EXPENSE_CATEGORIES) expect(h).toContain(`data-testid="expense-cat-${c}"`);
    expect(h).toContain('data-testid="numpad"');
    expect(h).toContain('data-testid="expense-note"');
    expect(h).toMatch(/data-testid="expense-save"[^>]*disabled|disabled=""[^>]*data-testid="expense-save"/);
    expect(h).toContain('data-testid="expense-empty"');
    expect(h).toContain(ar.expense.today);
    expect(h).not.toContain('data-testid="expense-void"');
  });

  it("while the list loads the panel says so", () => {
    expect(panel("en", { initialList: null })).toContain(en.expense.loading);
  });

  it("the list shows time, category, note and amount, a voided row struck with its reason, a void button only for managers", () => {
    const list = [exp(), exp({ id: "e2", categoryKey: "OTHER", note: "ice", amountMinor: "1000", voidedAt: "2026-11-05T10:00:00Z", voidReason: "typo" })];
    const staff = html(createElement(ExpenseList, { locale: "en", t: en, currency: "IQD", list, who: "Ali" }));
    expect(staff).toContain(en.expense.categories.TRANSPORT);
    expect(staff).toContain("5,000");
    expect(staff).toContain("سائق التوصيل");
    expect(staff).toContain(en.expense.voided);
    expect(staff).toContain("typo");
    expect(staff).toContain("Ali");
    expect(staff).toContain('data-voided="true"');
    expect(staff).not.toContain('data-testid="expense-void"');
    const manager = html(createElement(ExpenseList, { locale: "en", t: en, currency: "IQD", list, who: "Ali", onVoid: () => {} }));
    // One live row: one void button; the voided row has none.
    expect(manager.match(/data-testid="expense-void"/g)).toHaveLength(1);
    const open = html(createElement(ExpenseList, { locale: "en", t: en, currency: "IQD", list, who: "Ali", onVoid: () => {}, draft: { id: "e1", reason: "" } }));
    expect(open).toContain('data-testid="expense-void-form"');
    expect(open).toMatch(/data-testid="expense-void-confirm"[^>]*disabled|disabled=""[^>]*data-testid="expense-void-confirm"/);
  });

  it("a manager's panel lists the void buttons, a cashier's does not", () => {
    const list = [exp()];
    expect(panel("ar", { initialList: list, canVoid: true })).toContain('data-testid="expense-void"');
    expect(panel("ar", { initialList: list, canVoid: false })).not.toContain('data-testid="expense-void"');
  });

  it("the total counts only the expenses not voided", () => {
    const list = [exp(), exp({ id: "e2", amountMinor: "1000" }), exp({ id: "e3", amountMinor: "9000", voidedAt: "2026-11-05T10:00:00Z", voidReason: "x" })];
    expect(activeTotal(list)).toBe(6000n);
  });

  it("the close summary shows an Expenses line only when there are expenses, and the expected cash is the shift's", () => {
    const shift: ShiftDto = {
      id: "sh", version: 1, openedAt: "2026-11-05T05:00:00Z", currency: "IQD", openingCashMinor: "50000", salesCount: 1, totalMinor: "29250", cashMinor: "29250",
      cardMinor: "0", expectedCashMinor: "64250", expensesMinor: "15000", usdRateMicro: null, openingUsdMinor: "0", usdTenderedMinor: "0", usdDinarMinor: "0", expectedUsdMinor: null,
    };
    const withExp = html(createElement(ShiftSummaryView, { locale: "en", t: en, shift }));
    expect(withExp).toContain('data-testid="summary-expenses"');
    expect(withExp).toContain("15,000 IQD");
    expect(withExp).toContain("64,250 IQD");
    const without = html(createElement(ShiftSummaryView, { locale: "en", t: en, shift: { ...shift, expensesMinor: "0", expectedCashMinor: "79250" } }));
    expect(without).not.toContain('data-testid="summary-expenses"');
  });

  it("the close list is one collapsed line with the count and total; none without expenses", () => {
    const list = Array.from({ length: 40 }, (_, i) => exp({ id: `e${i}`, amountMinor: "1000" }));
    const h = html(createElement(ExpenseSection, { locale: "ar", t: ar, currency: "IQD", initial: list, canVoid: false, who: "علي" }));
    expect(h).toContain("<details");
    expect(h).not.toContain("<details open");
    expect(h).toContain("٤٠ مصروفات");
    expect(h).toContain("٤٠٬٠٠٠");
    expect(h.match(/data-testid="expense-row"/g)).toHaveLength(40);
    expect(html(createElement(ExpenseSection, { locale: "ar", t: ar, currency: "IQD", initial: [], canVoid: false, who: "" }))).toBe("");
  });

  it("the words exist in ar, ckb and en, with no empty string and a placeholder where the text takes one", () => {
    const keys = Object.keys(ar.expense) as (keyof typeof ar.expense)[];
    for (const t of [ar, ckb, en]) {
      expect(Object.keys(t.expense).sort()).toEqual([...keys].sort());
      for (const k of keys) if (typeof t.expense[k] === "string") expect((t.expense[k] as string).length).toBeGreaterThan(1);
      expect(t.expense.count).toContain("{n}");
      expect(t.expense.by).toContain("{name}");
      expect(t.expense.voidedReason).toContain("{reason}");
      expect(t.errors.EXPENSE_EXCEEDS_DRAWER.length).toBeGreaterThan(5);
      expect(t.errors.EXPENSE_VOIDED.length).toBeGreaterThan(5);
      expect(offenders(t.expense)).toEqual([]);
    }
  });

  it("the Expense function key is on the till for anyone who can sell, not hidden behind a role", () => {
    const src = readFileSync("src/app/retail/sell/sell-screen.tsx", "utf8");
    expect(src).toContain('data-testid="fn-expense"');
    expect(src).not.toMatch(/fn-expense[\s\S]{0,40}canVoid/);
  });

  it("Arabic renders the panel right-to-left: the panel adds no fixed left or right", () => {
    const css = readFileSync("src/app/retail/sell/sell.css", "utf8");
    const block = css.slice(css.indexOf("/* Expenses"));
    expect(block.length).toBeGreaterThan(200);
    expect(block).not.toMatch(/\b(margin|padding)-(left|right)\b|\b(left|right)\s*:/);
  });
});
