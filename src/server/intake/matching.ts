import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import type { Currency, RtTrackingMode } from "@/generated/prisma/enums";
import { searchInTx } from "@/server/catalog/search";
import { normalizeBarcode, normalizeSearchText, parseMoneyText } from "@/server/domain/catalog";
import {
  MIN_CONFIDENCE,
  barcodeCheck,
  checkLineArithmetic,
  checkReceiptTotal,
  classifyLine,
  matchUnitText,
  normalizeDigits,
  type IntakeLineClass,
} from "@/server/domain/intake";
import { minorUnitDigits } from "@/server/domain/money";
import { toBaseQty } from "@/server/domain/stock";
import type { ExtractedLine, ExtractedReceipt } from "./provider";

type Tx = Prisma.TransactionClient;

/*
 * Server-side matching of an extracted receipt against the catalog (spec 3.2-3.4, 3.15, 3ب.1-3).
 * The model never chooses ids: the server looks a line up by its printed barcode (exact code of
 * this business), then by its description (searchInTx), and checks unit, quantity and arithmetic.
 *
 * - A barcode string is used only when it is 1..32 ASCII / Arabic-Indic / Persian digits
 *   (BARCODE_IGNORED otherwise) and, for a retail length, its checksum is right (BARCODE_CHECKSUM).
 * - A barcode owned by a trial item, a SERIAL item or an archived one is not a match: the line is
 *   DOUBTFUL with that reason and has no item until the reviewer picks one.
 * - A name search with exactly one usable hit (not trial, not SERIAL) is SUGGESTED; several hits
 *   make the line UNKNOWN with up to 5 candidates; none UNKNOWN.
 * - The unit is the barcode's unit when no unit is written, else the item's unit the written text
 *   names (matchUnitText); otherwise the line is DOUBTFUL (never a silent base unit).
 * - The quantity must fit the unit's decimals; price x quantity must match the printed line total
 *   (checkLineArithmetic) in the receipt currency, which must be enabled for the business.
 * - Every printed value is kept as printed (the reviewer compares it with the image); normalised
 *   digits are used only for checks and for the draft.
 *
 * A line is `resolved` (may go to the draft) when it is discarded or MATCHED. MATCHED needs an
 * exact barcode hit or the reviewer's confirmation (a pick), a unit, sound arithmetic and enough
 * confidence. Lines are re-evaluated on every change and again before the draft, against the
 * catalog as it is then.
 */

export const MAX_CANDIDATES = 5;
const SEARCH_LIMIT = MAX_CANDIDATES + 1;
const BARCODE_GATE = /^[0-9٠-٩۰-۹]{1,32}$/;

export type LineReason =
  | "BARCODE_IGNORED"
  | "BARCODE_CHECKSUM"
  | "ARCHIVED"
  | "TEST_ITEM"
  | "SERIAL_NOT_SUPPORTED"
  | "ITEM_GONE"
  | "UNIT_UNMATCHED"
  | "UNIT_MISSING"
  | "QTY_INVALID"
  | "CURRENCY_UNKNOWN"
  | "PRICE_MISSING"
  | "TOTAL_MISMATCH"
  | "UNREADABLE"
  | "LOW_CONFIDENCE"
  | "AMBIGUOUS";

/** Reasons the item found by barcode cannot be used (the line has no item then). */
const BLOCKING: readonly LineReason[] = ["ARCHIVED", "TEST_ITEM", "SERIAL_NOT_SUPPORTED"];

export type Candidate = { variantId: string; nameAr: string; sku: string };

export type IntakeLine = {
  lineNo: number;
  description: string;
  /** As printed. */
  barcode?: string;
  /** As printed. */
  quantity: string;
  unitText?: string;
  /** The price in use: as printed, or derived from the total on the reviewer's explicit choice. */
  unitPrice?: string;
  /** The printed price when unitPrice was derived from the total. */
  printedUnitPrice?: string;
  priceFromTotal?: boolean;
  lineTotal?: string;
  confidence: number;
  status: IntakeLineClass;
  candidates?: Candidate[];
  variantId?: string;
  unitId?: string;
  /** How the item was found. */
  source?: "BARCODE" | "NAME" | "REVIEWER";
  /** Facts from the reading that stay with the line (barcode problems, a blocked item). */
  notes: LineReason[];
  /** notes + the current checks' findings. */
  reasons: LineReason[];
  /** The reviewer picked or confirmed the item or unit of this line. */
  confirmed: boolean;
  resolved: boolean;
  discarded: boolean;
};

export type IntakeResult = {
  supplier?: string;
  date?: string;
  /** As printed. */
  currency?: string;
  receiptNo?: string;
  total?: string;
  /** An enabled currency of the business, or null until the reviewer picks one. */
  receiptCurrency: Currency | null;
  totalCheck: { ok: boolean };
  /**
   * The reviewer accepted a receipt total that does not match (ruling R1b-F): the fingerprint of the
   * totals accepted (totalsFingerprint). Any later change to what the total check reads voids it.
   */
  totalAck?: string;
  /** totalAck still matches the current totals. */
  totalAcknowledged: boolean;
  lines: IntakeLine[];
};

export type VariantInfo = {
  id: string;
  nameAr: string;
  sku: string;
  archived: boolean;
  isTestData: boolean;
  trackingMode: RtTrackingMode;
  /** Active units only. */
  units: { id: string; name: string; factor: number; quantityScale: number }[];
};

export type BusinessCurrencies = { defaultCurrency: Currency; enabledCurrencies: Currency[] };

// ---------------------------------------------------------------------------------------------
// Small pure helpers

/** Printed quantity to plain ASCII ("١٬٢٠٠" -> "1200", "٣٫٥" -> "3.5"); thousands commas dropped. */
export function plainQuantity(text: string): string {
  const t = normalizeDigits(text).trim();
  return /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(t) ? t.replace(/,/g, "") : t;
}

/** Printed money to ASCII digits (separators kept: parseMoneyText reads them). */
export const plainMoney = (text: string): string => normalizeDigits(text).trim();

/** The printed currency mapped to IQD / USD, or null when unknown or ambiguous. */
export function mapCurrency(printed: string): Currency | null {
  const t = normalizeSearchText(printed).replace(/[\s.]/g, "");
  const iqd = t === "دع" || t === "عد" || t === "id" || t.includes("iqd") || t.includes("دينار") || t.includes("dinar") || t.includes("دینار");
  const usd = t.includes("usd") || t.includes("$") || t.includes("دولار") || t.includes("dollar") || t.includes("دۆلار");
  if (iqd === usd) return null;
  return iqd ? "IQD" : "USD";
}

/** The receipt currency: the printed one when enabled; nothing printed and one enabled currency: that one; else null. */
export function receiptCurrencyOf(printed: string | undefined, biz: BusinessCurrencies): Currency | null {
  if (printed === undefined || normalizeSearchText(printed) === "") {
    return biz.enabledCurrencies.length === 1 ? biz.enabledCurrencies[0]! : null;
  }
  const c = mapCurrency(printed);
  return c !== null && biz.enabledCurrencies.includes(c) ? c : null;
}

function parseQuantityFraction(text: string): { int: bigint; den: bigint } | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(plainQuantity(text));
  if (!m || text.length > 32) return null;
  const frac = m[2] ?? "";
  const int = BigInt(m[1] + frac);
  return int > 0n ? { int, den: 10n ** BigInt(frac.length) } : null;
}

function formatMinor(minor: bigint, currency: Currency): string {
  const digits = minorUnitDigits(currency);
  if (digits === 0) return minor.toString();
  const s = minor.toString().padStart(digits + 1, "0");
  return `${s.slice(0, -digits)}.${s.slice(-digits)}`;
}

/** lineTotal / quantity rounded half up to the currency's minor unit, as text; null when unreadable. */
export function priceFromTotal(line: { quantity: string; lineTotal?: string }, currency: Currency): string | null {
  if (line.lineTotal === undefined) return null;
  const qty = parseQuantityFraction(line.quantity);
  let total: bigint;
  try {
    total = parseMoneyText(plainMoney(line.lineTotal), currency);
  } catch {
    return null;
  }
  if (!qty) return null;
  const num = total * qty.den;
  const minor = (num * 2n + qty.int) / (qty.int * 2n);
  return formatMinor(minor, currency);
}

/** The printed barcode as a usable code, or the note explaining why it is not used. */
export function usableBarcode(printed: string | undefined): { code: string } | { note: LineReason } | null {
  if (printed === undefined || printed.trim() === "") return null;
  const raw = printed.trim();
  if (!BARCODE_GATE.test(raw)) return { note: "BARCODE_IGNORED" };
  const code = normalizeDigits(raw);
  const check = barcodeCheck(code);
  if (check.checked && !check.ok) return { note: "BARCODE_CHECKSUM" };
  return { code: normalizeBarcode(code) };
}

// ---------------------------------------------------------------------------------------------
// Evaluation (pure)

/** Re-checks a line against its item (fresh catalog info) and the receipt currency. */
export function evaluateLine(line: IntakeLine, info: VariantInfo | undefined, currency: Currency | null): IntakeLine {
  const notes = line.variantId ? line.notes.filter((n) => !BLOCKING.includes(n)) : line.notes;
  const reasons: LineReason[] = [...notes];
  if (line.discarded) return { ...line, notes, reasons, resolved: true };

  let variantId = line.variantId;
  let unitId = line.unitId;
  if (variantId) {
    const blocked: LineReason | null = !info
      ? "ITEM_GONE"
      : info.isTestData
        ? "TEST_ITEM"
        : info.trackingMode === "SERIAL"
          ? "SERIAL_NOT_SUPPORTED"
          : info.archived
            ? "ARCHIVED"
            : null;
    if (blocked) {
      reasons.push(blocked);
      variantId = undefined;
      unitId = undefined;
    }
  }
  if (!variantId || !info) {
    const status: IntakeLineClass = reasons.some((r) => BLOCKING.includes(r) || r === "ITEM_GONE") ? "DOUBTFUL" : "UNKNOWN";
    return { ...line, variantId: undefined, unitId: undefined, notes, reasons, status, resolved: false };
  }

  let unit = unitId ? info.units.find((u) => u.id === unitId) : undefined;
  if (!unit && line.unitText !== undefined) {
    const id = matchUnitText(line.unitText, info.units);
    unit = id ? info.units.find((u) => u.id === id) : undefined;
  }
  if (!unit) reasons.push(line.unitText !== undefined ? "UNIT_UNMATCHED" : "UNIT_MISSING");

  let arithmeticOk = true;
  if (unit) {
    try {
      toBaseQty(plainQuantity(line.quantity), unit);
    } catch {
      reasons.push("QTY_INVALID");
      arithmeticOk = false;
    }
  }
  if (currency === null) {
    reasons.push("CURRENCY_UNKNOWN");
    arithmeticOk = false;
  } else if (line.unitPrice === undefined) {
    reasons.push("PRICE_MISSING");
    // Nothing printed to check: the reviewer's confirmation lets it go to the draft without a cost
    // (the receipt screen asks for it before posting). A printed total must be used explicitly.
    if (line.lineTotal !== undefined || !line.confirmed) arithmeticOk = false;
  } else if (line.priceFromTotal) {
    try {
      parseMoneyText(plainMoney(line.unitPrice), currency);
    } catch {
      reasons.push("UNREADABLE");
      arithmeticOk = false;
    }
  } else {
    const r = checkLineArithmetic({ quantity: line.quantity, unitPrice: line.unitPrice, lineTotal: line.lineTotal }, currency);
    if (!r.ok) {
      reasons.push(r.reason ?? "UNREADABLE");
      arithmeticOk = false;
    }
  }

  const confidence = line.confirmed ? 1 : line.confidence;
  if (!(confidence >= MIN_CONFIDENCE)) reasons.push("LOW_CONFIDENCE");
  const status = classifyLine({
    match: line.confirmed || line.source === "BARCODE" ? "barcode-exact" : "name-suggested",
    unitMatched: unit !== undefined,
    arithmeticOk,
    confidence,
  });
  return { ...line, variantId, unitId: unit?.id, notes, reasons, status, resolved: status === "MATCHED" };
}

/** What the receipt total check reads: the printed total, the currency and each line's printed amounts. */
export function totalsFingerprint(result: Pick<IntakeResult, "lines" | "total" | "receiptCurrency">): string {
  const lines = result.lines.map((l) => [l.quantity, l.printedUnitPrice ?? (l.priceFromTotal ? null : (l.unitPrice ?? null)), l.lineTotal ?? null]);
  return createHash("sha256").update(JSON.stringify([result.total ?? null, result.receiptCurrency, lines])).digest("hex");
}

export function totalCheckOf(result: Pick<IntakeResult, "lines" | "total" | "receiptCurrency">): { ok: boolean } {
  if (result.total === undefined) return { ok: true };
  if (result.receiptCurrency === null) return { ok: false };
  const lines = result.lines.map((l) => ({
    quantity: l.quantity,
    unitPrice: l.printedUnitPrice ?? (l.priceFromTotal ? "" : (l.unitPrice ?? "")),
    ...(l.lineTotal !== undefined ? { lineTotal: l.lineTotal } : {}),
  }));
  return checkReceiptTotal(lines, result.total, result.receiptCurrency);
}

// ---------------------------------------------------------------------------------------------
// Catalog reads

/** Catalog facts of the given variants (this business only, through the scoped client). */
export async function loadVariantInfo(tx: Tx, variantIds: string[]): Promise<Map<string, VariantInfo>> {
  const ids = [...new Set(variantIds)];
  if (ids.length === 0) return new Map();
  const [variants, units] = await Promise.all([
    tx.rtVariant.findMany({
      where: { id: { in: ids } },
      select: { id: true, sku: true, archivedAt: true, product: { select: { nameAr: true, isTestData: true, trackingMode: true, archivedAt: true } } },
    }),
    tx.rtUnit.findMany({
      where: { variantId: { in: ids }, archivedAt: null },
      orderBy: [{ factor: "asc" }, { id: "asc" }],
      select: { id: true, variantId: true, name: true, factor: true, quantityScale: true },
    }),
  ]);
  return new Map(
    variants.map((v) => [
      v.id,
      {
        id: v.id,
        nameAr: v.product.nameAr,
        sku: v.sku,
        archived: v.archivedAt !== null || v.product.archivedAt !== null,
        isTestData: v.product.isTestData,
        trackingMode: v.product.trackingMode,
        units: units.filter((u) => u.variantId === v.id).map(({ id, name, factor, quantityScale }) => ({ id, name, factor, quantityScale })),
      },
    ]),
  );
}

type Found = Pick<IntakeLine, "variantId" | "unitId" | "source" | "candidates"> & { notes: LineReason[] };

async function findByBarcode(tx: Tx, code: string): Promise<Found | null> {
  const hit = await tx.rtBarcode.findFirst({
    where: { code },
    select: {
      archivedAt: true,
      unit: {
        select: {
          id: true,
          archivedAt: true,
          variantId: true,
          variant: { select: { archivedAt: true, product: { select: { isTestData: true, trackingMode: true, archivedAt: true } } } },
        },
      },
    },
  });
  if (!hit) return null;
  const p = hit.unit.variant.product;
  if (p.isTestData) return { notes: ["TEST_ITEM"] };
  if (p.trackingMode === "SERIAL") return { notes: ["SERIAL_NOT_SUPPORTED"] };
  if (hit.archivedAt || hit.unit.archivedAt || hit.unit.variant.archivedAt || p.archivedAt) return { notes: ["ARCHIVED"] };
  return { variantId: hit.unit.variantId, unitId: hit.unit.id, source: "BARCODE", notes: [] };
}

async function findByName(tx: Tx, description: string): Promise<Found> {
  const query = description.slice(0, 100);
  if (normalizeSearchText(query) === "") return { notes: [] };
  const { items } = await searchInTx(tx, { query, includeArchived: false, limit: SEARCH_LIMIT });
  const usable = items.filter((h) => !h.isTestData && !h.archived);
  const info = await loadVariantInfo(tx, usable.map((h) => h.variantId));
  const hits = usable.filter((h) => info.get(h.variantId)?.trackingMode !== "SERIAL");
  if (hits.length === 1) return { variantId: hits[0]!.variantId, source: "NAME", notes: [] };
  if (hits.length === 0) return { notes: [] };
  return {
    notes: ["AMBIGUOUS"],
    candidates: hits.slice(0, MAX_CANDIDATES).map((h) => ({ variantId: h.variantId, nameAr: h.nameAr, sku: h.sku })),
  };
}

/** One extracted line looked up in the catalog (before evaluation). */
async function lookupLine(tx: Tx, line: ExtractedLine, lineNo: number): Promise<IntakeLine> {
  const notes: LineReason[] = [];
  let found: Found | null = null;
  const barcode = usableBarcode(line.barcode);
  if (barcode && "note" in barcode) notes.push(barcode.note);
  if (barcode && "code" in barcode) {
    found = await findByBarcode(tx, barcode.code);
    // The barcode's unit counts only when no unit is written (else the written unit must match).
    if (found?.unitId && line.unitText !== undefined) found = { ...found, unitId: undefined };
  }
  if (!found) found = await findByName(tx, line.description);
  return {
    lineNo,
    description: line.description,
    ...(line.barcode !== undefined ? { barcode: line.barcode } : {}),
    quantity: line.quantity,
    ...(line.unitText !== undefined ? { unitText: line.unitText } : {}),
    ...(line.unitPrice !== undefined ? { unitPrice: line.unitPrice } : {}),
    ...(line.lineTotal !== undefined ? { lineTotal: line.lineTotal } : {}),
    confidence: line.confidence,
    status: "UNKNOWN",
    ...(found.candidates ? { candidates: found.candidates } : {}),
    ...(found.variantId ? { variantId: found.variantId } : {}),
    ...(found.unitId ? { unitId: found.unitId } : {}),
    ...(found.source ? { source: found.source } : {}),
    notes: [...notes, ...found.notes],
    reasons: [],
    confirmed: false,
    resolved: false,
    discarded: false,
  };
}

/** Re-evaluates every line against the current catalog and recomputes the receipt total check. */
export async function reevaluate(tx: Tx, result: IntakeResult): Promise<IntakeResult> {
  const info = await loadVariantInfo(
    tx,
    result.lines.flatMap((l) => (l.variantId ? [l.variantId] : [])),
  );
  const lines = result.lines.map((l) => evaluateLine(l, l.variantId ? info.get(l.variantId) : undefined, result.receiptCurrency));
  const next = { ...result, lines };
  return { ...next, totalCheck: totalCheckOf(next), totalAcknowledged: result.totalAck !== undefined && result.totalAck === totalsFingerprint(next) };
}

/** The stored result of a fresh reading: lookups, checks and statuses of every line. */
export async function matchReceipt(tx: Tx, extracted: ExtractedReceipt, biz: BusinessCurrencies): Promise<IntakeResult> {
  const lines: IntakeLine[] = [];
  for (const [i, line] of extracted.lines.entries()) lines.push(await lookupLine(tx, line, i + 1));
  const base: IntakeResult = {
    ...(extracted.supplier !== undefined ? { supplier: extracted.supplier } : {}),
    ...(extracted.date !== undefined ? { date: extracted.date } : {}),
    ...(extracted.currency !== undefined ? { currency: extracted.currency } : {}),
    ...(extracted.receiptNo !== undefined ? { receiptNo: extracted.receiptNo } : {}),
    ...(extracted.total !== undefined ? { total: extracted.total } : {}),
    receiptCurrency: receiptCurrencyOf(extracted.currency, biz),
    totalCheck: { ok: true },
    totalAcknowledged: false,
    lines,
  };
  return reevaluate(tx, base);
}
