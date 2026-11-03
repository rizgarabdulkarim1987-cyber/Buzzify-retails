import { formatNumber, type Locale, type Messages } from "@/messages";
import { parseMoneyText, toAsciiDigits } from "@/server/domain/catalog";
import { parseRate, toBaseQty } from "@/server/domain/stock";
import { fill, minorToInput } from "../../../_lib/format";
import { stockFailureMessage } from "./adjust-rules";
import type { Currency, StockFailure } from "./types";

/*
 * The receiving screen's rules, kept out of the component so they can be tested: how a scan turns
 * into a line (the same item scanned again raises its line), what each line still lacks, what a
 * draft sends to the server and how a saved draft comes back after a reload. The server checks
 * all of it again (it is the authority); these rules only say it sooner, in the line it concerns.
 */

export type ReceiptKind = "RECEIPT" | "OPENING";
export const RECEIPT_KINDS: readonly ReceiptKind[] = ["RECEIPT", "OPENING"];
/** The server's limit of lines in one document (MAX_DOCUMENT_LINES). */
export const MAX_LINES = 500;
export const MAX_BATCH_CODE = 64;
const MAX_COST_MINOR = 10n ** 18n;

export type ItemUnit = { id: string; name: string; factor: number; quantityScale: number; isBase: boolean };

/** What the form needs to know about one variant (read from the catalog when it is scanned). */
export type ItemInfo = {
  productId: string;
  variantId: string;
  nameAr: string;
  nameCkb: string | null;
  nameEn: string | null;
  sku: string;
  trackingMode: "NONE" | "BATCH" | "SERIAL";
  tracksExpiry: boolean;
  isTestData: boolean;
  /** The product or the variant is archived. */
  archived: boolean;
  /** Active units only, the base unit first. */
  units: ItemUnit[];
};

/** One line as typed. Every field is text as the user typed it (Arabic digits are fine). */
export type ReceiptLine = {
  /** A key for React and focus, never sent. */
  key: string;
  item: ItemInfo;
  unitId: string;
  quantity: string;
  cost: string;
  currency: Currency;
  rate: string;
  batchCode: string;
  /** YYYY-MM-DD, or "" for none. */
  expiryDate: string;
  /**
   * The line came back from a saved draft with a cost this user cannot see (no cost.view): the
   * server holds it, the screen does not, so the draft must not be saved again from here (a save
   * replaces every line and would erase it).
   */
  costHidden: boolean;
};

export type ReceiptSettings = {
  defaultCurrency: Currency;
  enabledCurrencies: Currency[];
  /** The last exchange rate entered in a posted document, as text ("1310"), or "" when there is none. */
  lastRate: string;
};

// ---------------------------------------------------------------------------------------------
// Adding lines

export type BlockedReason = "TEST_ITEM" | "SERIAL_NOT_SUPPORTED" | "ARCHIVED" | "NO_UNITS";

/** Why an item cannot be received at all (the server would refuse it), or null. */
export function blockedReason(item: ItemInfo): BlockedReason | null {
  if (item.isTestData) return "TEST_ITEM";
  if (item.trackingMode === "SERIAL") return "SERIAL_NOT_SUPPORTED";
  if (item.archived) return "ARCHIVED";
  if (item.units.length === 0) return "NO_UNITS";
  return null;
}

/** The unit a scan adds: the one whose barcode was scanned when it is active, else the base unit. */
export function scanUnit(item: ItemInfo, unitId: string | undefined): string {
  if (unitId && item.units.some((u) => u.id === unitId)) return unitId;
  return (item.units.find((u) => u.isBase) ?? item.units[0])?.id ?? "";
}

/** A typed quantity plus one ("2" -> "3", "1.5" -> "2.5", Arabic digits read); null when it is not a plain number. */
export function bumpQuantity(text: string): string | null {
  const m = /^(\d+)(\.\d+)?$/.exec(toAsciiDigits(text).trim().replace(/٫/g, "."));
  if (!m) return null;
  return `${BigInt(m[1]!) + 1n}${m[2] ?? ""}`;
}

/** The rate a new foreign-currency line starts with: the last one typed in this form, else the last posted one. */
export function rateDefault(lines: readonly ReceiptLine[], settings: ReceiptSettings): string {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const l = lines[i]!;
    if (l.currency !== settings.defaultCurrency && l.rate.trim() !== "") return l.rate.trim();
  }
  return settings.lastRate;
}

/** The rate field is drawn only for a cost in another currency than the business's. */
export function showsRate(line: Pick<ReceiptLine, "currency">, settings: Pick<ReceiptSettings, "defaultCurrency">): boolean {
  return line.currency !== settings.defaultCurrency;
}

/** A line in another currency: the rate field appears, filled with the default rate when empty. */
export function withCurrency(line: ReceiptLine, currency: Currency, lines: readonly ReceiptLine[], settings: ReceiptSettings): ReceiptLine {
  if (currency === settings.defaultCurrency) return { ...line, currency, rate: "" };
  return { ...line, currency, rate: line.rate.trim() !== "" ? line.rate : rateDefault(lines, settings) };
}

/** A new line of `item`: quantity 1, the currency of the line before it (or the business's). */
export function newLine(item: ItemInfo, unitId: string, settings: ReceiptSettings, key: string, lines: readonly ReceiptLine[]): ReceiptLine {
  const before = lines[lines.length - 1];
  const currency = before && settings.enabledCurrencies.includes(before.currency) ? before.currency : settings.defaultCurrency;
  const blank: ReceiptLine = { key, item, unitId, quantity: "1", cost: "", currency: settings.defaultCurrency, rate: "", batchCode: "", expiryDate: "", costHidden: false };
  return withCurrency(blank, currency, lines, settings);
}

export type Scanned = { lines: ReceiptLine[]; key: string; bumped: boolean };

/**
 * A scanned (or picked) item: when a line of the same item in the same unit exists, the last such
 * line's quantity goes up by one; otherwise a new line is added at the end.
 */
export function addScanned(lines: readonly ReceiptLine[], item: ItemInfo, unitId: string, settings: ReceiptSettings, key: string): Scanned {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const l = lines[i]!;
    if (l.item.variantId !== item.variantId || l.unitId !== unitId || l.costHidden) continue;
    const next = bumpQuantity(l.quantity);
    if (next === null) break;
    const out = [...lines];
    out[i] = { ...l, quantity: next };
    return { lines: out, key: l.key, bumped: true };
  }
  return { lines: [...lines, newLine(item, unitId, settings, key, lines)], key, bumped: false };
}

// ---------------------------------------------------------------------------------------------
// Checks

export type LineProblem =
  | "QUANTITY_REQUIRED"
  | "BAD_QUANTITY"
  | "BAD_COST"
  | "COST_REQUIRED"
  | "BAD_RATE"
  | "RATE_REQUIRED"
  | "BAD_BATCH"
  | "BAD_EXPIRY"
  | "EXPIRY_REQUIRED"
  | "EXPIRED";
export type LineWarning = "COST_MISSING" | "EXPIRED";

/** What the server refuses already when the draft is saved; the rest only matters at posting. */
const SAVE_BLOCKING: ReadonlySet<LineProblem> = new Set(["QUANTITY_REQUIRED", "BAD_QUANTITY", "BAD_COST", "BAD_RATE", "BAD_BATCH", "BAD_EXPIRY"]);

export const isSaveBlocking = (p: LineProblem) => SAVE_BLOCKING.has(p);

function isRealDay(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const d = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
}

export const unitOf = (line: Pick<ReceiptLine, "item" | "unitId">): ItemUnit | undefined => line.item.units.find((u) => u.id === line.unitId);
const hasCost = (line: ReceiptLine) => line.cost.trim() !== "";

/**
 * What a line lacks (problems, in the order its fields appear) and what posting it will note
 * (warnings). `today` is the business's day as YYYY-MM-DD: a past expiry is refused for a receipt
 * and only noted for opening stock.
 */
export function lineIssues(line: ReceiptLine, kind: ReceiptKind, settings: ReceiptSettings, today: string): { problems: LineProblem[]; warnings: LineWarning[] } {
  const problems: LineProblem[] = [];
  const warnings: LineWarning[] = [];
  const unit = unitOf(line);
  if (line.quantity.trim() === "") problems.push("QUANTITY_REQUIRED");
  else if (!unit || !fits(() => toBaseQty(line.quantity, unit))) problems.push("BAD_QUANTITY");

  if (!line.costHidden) {
    if (!hasCost(line)) {
      if (kind === "RECEIPT") problems.push("COST_REQUIRED");
      else warnings.push("COST_MISSING");
    } else if (!fits(() => parseMoneyText(line.cost.trim(), line.currency) <= MAX_COST_MINOR || bad())) {
      problems.push("BAD_COST");
    }
    if (showsRate(line, settings) && hasCost(line)) {
      if (line.rate.trim() === "") problems.push("RATE_REQUIRED");
      else if (!fits(() => parseRate(line.rate))) problems.push("BAD_RATE");
    }
  }

  if (line.item.trackingMode === "BATCH") {
    if (line.batchCode.trim().length > MAX_BATCH_CODE) problems.push("BAD_BATCH");
    const expiry = line.expiryDate.trim();
    if (expiry === "") {
      if (line.item.tracksExpiry) problems.push("EXPIRY_REQUIRED");
    } else if (!isRealDay(expiry)) {
      problems.push("BAD_EXPIRY");
    } else if (expiry < today) {
      if (kind === "RECEIPT") problems.push("EXPIRED");
      else warnings.push("EXPIRED");
    }
  }
  return { problems, warnings };
}

function bad(): never {
  throw new Error("bad");
}

function fits(check: () => unknown): boolean {
  try {
    check();
    return true;
  } catch {
    return false;
  }
}

/** The first line (1-based) that keeps the draft from being saved, or null when it can be saved. */
export function firstUnsavable(lines: readonly ReceiptLine[], kind: ReceiptKind, settings: ReceiptSettings, today: string): number | null {
  const i = lines.findIndex((l) => lineIssues(l, kind, settings, today).problems.some(isSaveBlocking));
  return i < 0 ? null : i + 1;
}

/** The first line (1-based) that keeps the document from being posted, or null. */
export function firstUnpostable(lines: readonly ReceiptLine[], kind: ReceiptKind, settings: ReceiptSettings, today: string): number | null {
  const i = lines.findIndex((l) => lineIssues(l, kind, settings, today).problems.length > 0);
  return i < 0 ? null : i + 1;
}

/** Some line holds a cost this user cannot see: the draft is shown read-only (it can be posted or deleted). */
export const hasHiddenCosts = (lines: readonly ReceiptLine[]) => lines.some((l) => l.costHidden);

// ---------------------------------------------------------------------------------------------
// What a draft sends, and what comes back

export type DraftLinePayload = {
  variantId: string;
  unitId: string;
  quantity: string;
  cost?: { amount: string; currency: Currency };
  rate?: string;
  batchCode?: string;
  expiryDate?: string;
};
export type DraftPayload = { kind: ReceiptKind; supplierRef: string | null; note: string | null; lines: DraftLinePayload[] };

/** One line as saveStockDraft takes it: only what was typed, a rate only for a foreign cost, a batch only for a batch item. */
export function draftLine(line: ReceiptLine, settings: Pick<ReceiptSettings, "defaultCurrency">): DraftLinePayload {
  const out: DraftLinePayload = { variantId: line.item.variantId, unitId: line.unitId, quantity: line.quantity.trim() };
  if (hasCost(line)) {
    out.cost = { amount: line.cost.trim(), currency: line.currency };
    if (showsRate(line, settings) && line.rate.trim() !== "") out.rate = line.rate.trim();
  }
  if (line.item.trackingMode === "BATCH") {
    if (line.batchCode.trim() !== "") out.batchCode = line.batchCode.trim();
    if (line.expiryDate.trim() !== "") out.expiryDate = line.expiryDate.trim();
  }
  return out;
}

/** The whole draft. A supplier belongs to a receipt only; blank texts are sent as null. */
export function draftPayload(kind: ReceiptKind, supplierRef: string, note: string, lines: readonly ReceiptLine[], settings: Pick<ReceiptSettings, "defaultCurrency">): DraftPayload {
  const text = (v: string) => (v.trim() === "" ? null : v.trim());
  return { kind, supplierRef: kind === "RECEIPT" ? text(supplierRef) : null, note: text(note), lines: lines.map((l) => draftLine(l, settings)) };
}

/** A saved line as the browser receives it (getStockDocument; cost keys only for cost.view, as digit strings). */
export type DocLineDto = {
  lineNo: number;
  variantId: string;
  unitId: string;
  quantity: string;
  enteredQuantity: string;
  batchCode: string | null;
  expiryDate: string | null;
  costMissing: boolean;
  currency?: Currency | null;
  unitCostMinor?: string | null;
  rateMicro?: string | null;
  valueMinor?: string | null;
};
export type DocumentDto = {
  id: string;
  kind: "OPENING" | "RECEIPT" | "ADJUSTMENT" | "WRITE_OFF" | "REVERSAL" | "SALE";
  status: "DRAFT" | "POSTED";
  number: number | null;
  supplierRef: string | null;
  note: string | null;
  version: number;
  createdAt: string;
  lines: DocLineDto[];
};

/** Micro-units of a rate back to text: "1310000000" -> "1310", "1310500000" -> "1310.5". */
export function rateText(micro: string | bigint): string {
  const v = typeof micro === "bigint" ? micro : BigInt(micro);
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/**
 * A saved draft back into lines (after a reload). Null when a line's item could not be read. A
 * caller without cost.view gets no cost keys: a line with a cost (costMissing false) comes back
 * costHidden, so the screen shows the draft read-only instead of saving it without its costs.
 */
export function restoreLines(doc: Pick<DocumentDto, "lines">, items: Readonly<Record<string, ItemInfo>>, settings: ReceiptSettings, makeKey: () => string): ReceiptLine[] | null {
  const out: ReceiptLine[] = [];
  for (const l of doc.lines) {
    const item = items[l.variantId];
    if (!item) return null;
    const base: ReceiptLine = {
      key: makeKey(),
      item,
      unitId: l.unitId,
      quantity: l.enteredQuantity,
      cost: "",
      currency: settings.defaultCurrency,
      rate: "",
      batchCode: l.batchCode ?? "",
      expiryDate: l.expiryDate ?? "",
      costHidden: false,
    };
    if (l.unitCostMinor === undefined) {
      out.push({ ...base, costHidden: !l.costMissing });
      continue;
    }
    const currency = l.currency ?? settings.defaultCurrency;
    out.push({
      ...base,
      currency,
      cost: l.unitCostMinor === null ? "" : minorToInput(currency, l.unitCostMinor),
      rate: currency !== settings.defaultCurrency && l.rateMicro ? rateText(l.rateMicro) : "",
    });
  }
  return out;
}

/**
 * The receiving screen's link: a draft by id, else a new document of `kind`; `extra` is kept
 * query text such as "from=setup".
 */
export function receiveHref(target: { draft: string } | { kind: ReceiptKind }, extra = ""): string {
  const params = new URLSearchParams();
  if ("draft" in target) params.set("draft", target.draft);
  else if (target.kind === "OPENING") params.set("kind", "opening");
  for (const [k, v] of new URLSearchParams(extra)) params.set(k, v);
  const q = params.toString();
  return `/retail/stock/receive${q ? `?${q}` : ""}`;
}

// ---------------------------------------------------------------------------------------------
// What the form allows now

export type FormState = { hydrated: boolean; readOnly: boolean; hiddenCosts: boolean; conflict: boolean; done: boolean; posting: boolean };

/**
 * What the form accepts in its state: nothing is edited, scanned or saved while a post is on its
 * way (a line added then would not be in the posted document, and a save would race the post), and
 * nothing at all after a conflict, after posting, in a read-only business, or for a draft whose
 * costs this role cannot see (posting and deleting it stay possible).
 */
export function formGate(s: FormState): { canEdit: boolean; canScan: boolean; canAutosave: boolean; canPost: boolean } {
  const closed = !s.hydrated || s.readOnly || s.conflict || s.done;
  const editable = !closed && !s.hiddenCosts && !s.posting;
  return { canEdit: editable, canScan: editable, canAutosave: !s.readOnly && !s.conflict && !s.done && !s.hiddenCosts && !s.posting, canPost: !closed && !s.posting };
}

// ---------------------------------------------------------------------------------------------
// Sending once

/**
 * The idempotency key of a write: kept while the same payload is sent again (a retry after a lost
 * answer replays instead of writing twice), new for a new payload. Decided before the await.
 */
export function nextAttempt(prev: { payload: string; key: string } | null, payload: string, makeKey: () => string): { payload: string; key: string } {
  return prev && prev.payload === payload ? prev : { payload, key: makeKey() };
}

/**
 * One task at a time: a second call while the first is on its way returns `null` at once and
 * never starts (a double click posts once). The flag is set before anything awaits.
 */
export class SingleFlight {
  private running = false;
  get busy(): boolean {
    return this.running;
  }
  async run<T>(task: () => Promise<T>): Promise<T | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await task();
    } finally {
      this.running = false;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Messages

/** The line (1-based) a refusal names, or null. */
export function failedLine(f: StockFailure): number | null {
  const n = Number(f.details?.lineNo);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/** A refusal in the interface language; with "Line n:" (in the interface digits) in front when the server named the line. */
export function receiptFailureMessage(t: Messages, f: StockFailure, locale: Locale = "en"): string {
  // The server names only the line of an INVALID_INPUT (a quantity, cost, rate or value it could not take).
  const text = f.code === "INVALID_INPUT" && failedLine(f) !== null ? t.stock.receive.lineInvalid : stockFailureMessage(t, f);
  const n = failedLine(f);
  return n === null ? text : fill(t.stock.receive.doneWarning, { n: formatNumber(locale, n), text });
}
