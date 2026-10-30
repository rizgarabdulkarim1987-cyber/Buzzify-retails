// Pure rules for AI receipt / barcode intake. No framework, database or I/O imports.
// Money is BigInt minor units; quantities are exact decimal text. Never Number for money.
import { createHash } from "node:crypto";
import type { Currency } from "@/generated/prisma/enums";
import { normalizeSearchText, parseMoneyText, toAsciiDigits } from "./catalog";

export const INTAKE_MAX_IMAGES = 6;
export const INTAKE_MAX_LINES = 100;
export const INTAKE_MAX_BYTES = 8 * 1024 * 1024;

/** Arabic-Indic and Persian/Kurdish digits to ASCII; Arabic thousands and decimal separators to "," and ".". */
export function normalizeDigits(s: string): string {
  return toAsciiDigits(s).replace(/٬/g, ",").replace(/٫/g, ".");
}

/** EAN-13, EAN-8 and UPC-A share one rule: weights 3,1,3,1... from the digit left of the check digit. */
const CHECKED_LENGTHS = new Set([8, 12, 13]);

export function barcodeCheck(code: string): { ok: boolean; checked: boolean } {
  const v = toAsciiDigits(code).trim();
  if (!CHECKED_LENGTHS.has(v.length)) return { ok: true, checked: false };
  if (!/^\d+$/.test(v)) return { ok: false, checked: true };
  let sum = 0;
  for (let i = 0; i < v.length - 1; i++) {
    const fromRight = v.length - 1 - i; // 1 = digit next to the check digit
    sum += Number(v[i]) * (fromRight % 2 === 1 ? 3 : 1);
  }
  return { ok: (10 - (sum % 10)) % 10 === Number(v[v.length - 1]), checked: true };
}

/** True only for a code whose checksum was actually verified and is correct. */
export function isValidBarcodeChecksum(code: string): boolean {
  const r = barcodeCheck(code);
  return r.checked && r.ok;
}

// Unit synonym groups (Arabic, Kurdish Sorani, English), already in normalizeSearchText form.
const UNIT_GROUPS: string[][] = [
  ["كرتون", "كارتون", "كرتونه", "carton", "ctn", "cartons", "كارتۆن", "كارتون"],
  ["علبه", "علبة", "box", "boxes", "قوتو", "قوتوو"],
  ["قطعه", "حبه", "pcs", "pc", "piece", "pieces", "دانه", "دانە", "عدد"],
  ["دزينه", "دزينة", "دستة", "dozen", "doz", "dz", "دوزينه", "دوزینە", "دەرزەن"],
].map((g) => g.map(normalizeSearchText));

function conceptOf(text: string): number {
  return UNIT_GROUPS.findIndex((g) => g.includes(text));
}

/** The unit id that text names (by name, alias or synonym), or null when none or more than one fits. */
export function matchUnitText(
  text: string,
  units: { id: string; name: string; aliases?: string[] }[],
): string | null {
  const t = normalizeSearchText(text);
  if (t === "") return null;
  const names = units.map((u) => ({ id: u.id, names: [u.name, ...(u.aliases ?? [])].map(normalizeSearchText) }));
  const exact = names.filter((u) => u.names.includes(t));
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1) return null;
  const concept = conceptOf(t);
  if (concept < 0) return null;
  const byConcept = names.filter((u) => u.names.some((n) => n === t || conceptOf(n) === concept));
  return byConcept.length === 1 ? byConcept[0].id : null;
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

function parseQuantity(text: string): { int: bigint; den: bigint } | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(normalizeDigits(text).trim().replace(/,/g, ""));
  if (!m) return null;
  const frac = m[2] ?? "";
  return { int: BigInt(m[1] + frac), den: 10n ** BigInt(frac.length) };
}

function parseMoney(text: string, currency: Currency): bigint | null {
  try {
    return parseMoneyText(text, currency);
  } catch {
    return null;
  }
}

/** diff and den are an exact fraction diff/den of a minor unit; count = how many lines' tolerance to allow. */
function withinTolerance(diff: bigint, den: bigint, currency: Currency, count = 1n): boolean {
  // IQD: at most 1 dinar (a whole minor unit). Others: half the smallest unit.
  return currency === "IQD" ? diff <= den * count : diff * 2n <= den * count;
}

/** Exact value of quantity x unit price as a fraction num/den of minor units, or null if unreadable. */
function exactLine(line: { quantity: string; unitPrice: string }, currency: Currency) {
  const qty = parseQuantity(line.quantity);
  const price = parseMoney(line.unitPrice, currency);
  if (!qty || price === null) return null;
  return { num: price * qty.int, den: qty.den };
}

export function checkLineArithmetic(
  line: { quantity: string; unitPrice: string; lineTotal?: string },
  currency: Currency,
): { ok: boolean; reason?: "TOTAL_MISMATCH" } {
  if (line.lineTotal === undefined) return { ok: true };
  const exact = exactLine(line, currency);
  const total = parseMoney(line.lineTotal, currency);
  if (!exact || total === null) return { ok: false, reason: "TOTAL_MISMATCH" };
  const diff = abs(total * exact.den - exact.num);
  return withinTolerance(diff, exact.den, currency) ? { ok: true } : { ok: false, reason: "TOTAL_MISMATCH" };
}

/**
 * Sum of the lines (stated line total, else quantity x price rounded half up) against the receipt
 * total, allowing the single-line tolerance once per line. No receipt total: nothing to check.
 */
export function checkReceiptTotal(
  lines: { quantity: string; unitPrice: string; lineTotal?: string }[],
  receiptTotal: string | undefined,
  currency: Currency,
): { ok: boolean } {
  if (receiptTotal === undefined) return { ok: true };
  const expected = parseMoney(receiptTotal, currency);
  if (expected === null) return { ok: false };
  let sum = 0n;
  for (const line of lines) {
    if (line.lineTotal !== undefined) {
      const t = parseMoney(line.lineTotal, currency);
      if (t === null) return { ok: false };
      sum += t;
    } else {
      const exact = exactLine(line, currency);
      if (!exact) return { ok: false };
      sum += (exact.num * 2n + exact.den) / (exact.den * 2n);
    }
  }
  return { ok: withinTolerance(abs(sum - expected), 1n, currency, BigInt(Math.max(lines.length, 1))) };
}

export type IntakeLineClass = "MATCHED" | "SUGGESTED" | "UNKNOWN" | "DOUBTFUL";

export const MIN_CONFIDENCE = 0.6;

export function classifyLine(input: {
  match: "barcode-exact" | "name-suggested" | "none";
  unitMatched: boolean;
  arithmeticOk: boolean;
  confidence: number;
}): IntakeLineClass {
  if (input.match === "none") return "UNKNOWN";
  if (!input.unitMatched || !input.arithmeticOk || !(input.confidence >= MIN_CONFIDENCE)) return "DOUBTFUL";
  return input.match === "barcode-exact" ? "MATCHED" : "SUGGESTED";
}

/** sha256 (hex) over the parts concatenated in the order given. */
export function intakeFileHash(parts: Buffer[]): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest("hex");
}
