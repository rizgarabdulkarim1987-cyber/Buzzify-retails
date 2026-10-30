// Pure rules for AI receipt / barcode intake. No framework, database or I/O imports.
// Money is BigInt minor units; quantities are exact decimal text. Never Number for money.
import { createHash } from "node:crypto";
import type { Currency } from "@/generated/prisma/enums";
import { normalizeSearchText, parseMoneyText, toAsciiDigits } from "./catalog";

export const INTAKE_MAX_IMAGES = 6;
export const INTAKE_MAX_LINES = 100;
/** One JPEG/PNG/WebP page or barcode photo: the provider's per-image limit (the browser sends <= 1800 px JPEGs). */
export const INTAKE_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** One PDF page set: it is sent as it is, so it may use the whole upload budget (5.5 MB of bytes). */
export const INTAKE_MAX_PDF_BYTES = 5_500_000;
/** The largest file of any allowed type (the per-type limits above are what is enforced). */
export const INTAKE_MAX_BYTES = Math.max(INTAKE_MAX_IMAGE_BYTES, INTAKE_MAX_PDF_BYTES);

/** The byte limit of one stored page of this (sniffed) type. */
export function intakeMaxBytesOf(contentType: string): number {
  return contentType === "application/pdf" ? INTAKE_MAX_PDF_BYTES : INTAKE_MAX_IMAGE_BYTES;
}

/** Arabic-Indic and Persian/Kurdish digits to ASCII; Arabic thousands and decimal separators to "," and ".". */
export function normalizeDigits(s: string): string {
  return toAsciiDigits(s).replace(/٬/g, ",").replace(/٫/g, ".");
}

/** EAN-13, EAN-8 and UPC-A share one rule: weights 3,1,3,1... from the digit left of the check digit; UPC-E is checked through its UPC-A. */
const CHECKED_LENGTHS = new Set([8, 12, 13]);

/** The check digit of an EAN/UPC code is right (weights 3,1,3,1... from the digit left of it). */
function checkDigitOk(v: string): boolean {
  let sum = 0;
  for (let i = 0; i < v.length - 1; i++) {
    const fromRight = v.length - 1 - i; // 1 = digit next to the check digit
    sum += Number(v[i]) * (fromRight % 2 === 1 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === Number(v[v.length - 1]);
}

/**
 * An 8-digit UPC-E (number system 0 or 1, six data digits, check digit) expanded to its 12-digit
 * UPC-A by the standard rules (the last data digit says where the zeros go); null when not UPC-E.
 */
function upcEToUpcA(v: string): string | null {
  if (v.length !== 8 || (v[0] !== "0" && v[0] !== "1")) return null;
  const [d1, d2, d3, d4, d5, d6] = v.slice(1, 7);
  let body: string;
  if (d6 === "0" || d6 === "1" || d6 === "2") body = `${d1}${d2}${d6}0000${d3}${d4}${d5}`;
  else if (d6 === "3") body = `${d1}${d2}${d3}00000${d4}${d5}`;
  else if (d6 === "4") body = `${d1}${d2}${d3}${d4}00000${d5}`;
  else body = `${d1}${d2}${d3}${d4}${d5}0000${d6}`;
  return `${v[0]}${body}${v[7]}`;
}

export function barcodeCheck(code: string): { ok: boolean; checked: boolean } {
  const v = toAsciiDigits(code).trim();
  // Only all-digit codes of a retail length are checked; anything else is not a retail barcode.
  if (!CHECKED_LENGTHS.has(v.length) || !/^\d+$/.test(v)) return { ok: true, checked: false };
  if (checkDigitOk(v)) return { ok: true, checked: true };
  // Eight digits are EAN-8 or UPC-E: a code passing either is valid.
  const upcA = v.length === 8 ? upcEToUpcA(v) : null;
  return { ok: upcA !== null && checkDigitOk(upcA), checked: true };
}

/** True only for a code whose checksum was actually verified and is correct. */
export function isValidBarcodeChecksum(code: string): boolean {
  const r = barcodeCheck(code);
  return r.checked && r.ok;
}

// Unit synonym groups (Arabic, Kurdish Sorani, English), already in normalizeSearchText form.
// TODO: native Kurdish review of the ckb spellings below.
const UNIT_GROUPS: string[][] = [
  ["كرتون", "كارتون", "كرتونه", "carton", "ctn", "cartons", "كارتۆن"],
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
  const byConcept = names.filter((u) => u.names.some((n) => conceptOf(n) === concept));
  return byConcept.length === 1 ? byConcept[0].id : null;
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

const MAX_TEXT_LENGTH = 32;

/** Positive decimal; a comma is accepted only as a well-formed thousands separator ("2,5" is unreadable). */
function parseQuantity(text: string): { int: bigint; den: bigint } | null {
  if (text.length > MAX_TEXT_LENGTH) return null;
  const m = /^((?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.(\d+))?$/.exec(normalizeDigits(text).trim());
  if (!m) return null;
  const frac = m[2] ?? "";
  const int = BigInt(m[1].replace(/,/g, "") + frac);
  if (int <= 0n) return null;
  return { int, den: 10n ** BigInt(frac.length) };
}

function parseMoney(text: string, currency: Currency): bigint | null {
  if (text.length > MAX_TEXT_LENGTH) return null;
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
): { ok: boolean; reason?: "TOTAL_MISMATCH" | "UNREADABLE" } {
  const exact = exactLine(line, currency);
  if (!exact) return { ok: false, reason: "UNREADABLE" };
  if (line.lineTotal === undefined) return { ok: true };
  const total = parseMoney(line.lineTotal, currency);
  if (total === null) return { ok: false, reason: "UNREADABLE" };
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

/** sha256 (hex) over the per-part sha256 digests in the order given (no boundary collisions). */
export function intakeFileHash(parts: Buffer[]): string {
  const outer = createHash("sha256");
  for (const p of parts) outer.update(createHash("sha256").update(p).digest());
  return outer.digest("hex");
}
