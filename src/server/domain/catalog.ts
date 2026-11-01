// Pure catalog rules. No framework or database imports.
import type { Currency } from "./money";
import { minorUnitDigits } from "./money";

export const MAX_BARCODE_LENGTH = 64;
export const MAX_UNIT_FACTOR = 100_000;
/** The characters a SKU may use (createProduct and the import share it). */
export const SKU_PATTERN = /^[A-Za-z0-9._/-]+$/;

const ARABIC_INDIC_ZERO = 0x0660;
const PERSIAN_ZERO = 0x06f0;

/** Arabic-Indic (U+0660..0669) and Persian (U+06F0..06F9) digits to ASCII. */
export function toAsciiDigits(s: string): string {
  return s.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (ch) => {
    const c = ch.charCodeAt(0);
    return String(c >= PERSIAN_ZERO ? c - PERSIAN_ZERO : c - ARABIC_INDIC_ZERO);
  });
}

export function normalizeSearchText(input: string): string {
  return toAsciiDigits(input)
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "") // tashkeel and Quranic marks
    .replace(/\u0640/g, "") // tatweel
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/[ىی]/g, "ي")
    .replace(/ک/g, "ك")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeBarcode(input: string): string {
  const v = toAsciiDigits(input).trim();
  if (v.length === 0) throw new Error("Barcode is empty");
  if (v.length > MAX_BARCODE_LENGTH) throw new Error(`Barcode exceeds ${MAX_BARCODE_LENGTH} characters`);
  if (!/^[A-Za-z0-9\-./_]+$/.test(v)) throw new Error("Barcode contains invalid characters");
  return v;
}

/** The check digit of an all-digit EAN/UPC/GTIN code is right (weights 3,1,3,1... from the digit left of it). */
export function gtinCheckDigitOk(v: string): boolean {
  if (v.length < 2 || !/^\d+$/.test(v)) return false;
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
 * Only where the symbology is known to be UPC-E (the camera decoder): the same 8 digits may be an
 * EAN-8, so the server never expands an 8-digit code on its own.
 */
export function upcEToUpcA(v: string): string | null {
  if (v.length !== 8 || !/^[01]\d{7}$/.test(v)) return null;
  const [d1, d2, d3, d4, d5, d6] = v.slice(1, 7);
  let body: string;
  if (d6 === "0" || d6 === "1" || d6 === "2") body = `${d1}${d2}${d6}0000${d3}${d4}${d5}`;
  else if (d6 === "3") body = `${d1}${d2}${d3}00000${d4}${d5}`;
  else if (d6 === "4") body = `${d1}${d2}${d3}${d4}00000${d5}`;
  else body = `${d1}${d2}${d3}${d4}${d5}0000${d6}`;
  return `${v[0]}${body}${v[7]}`;
}

/**
 * The stored (canonical) form of a code: normalizeBarcode, then a 12-digit UPC-A with a valid check
 * digit becomes its 13-digit GTIN-13 ("0" + code). Every other code (13 digits, 8 digits, a bad
 * check digit, shop labels) stays as normalizeBarcode left it. Throws as normalizeBarcode does.
 */
export function canonicalBarcode(input: string): string {
  const v = normalizeBarcode(input);
  return v.length === 12 && gtinCheckDigitOk(v) ? `0${v}` : v;
}

/**
 * Every stored form equal to a code, for look-ups and uniqueness: the code itself, its canonical
 * form, and the 12-digit form of a 13-digit code that starts with "0" (a row stored before
 * canonicalization). Throws as normalizeBarcode does.
 */
export function barcodeVariants(input: string): string[] {
  const v = normalizeBarcode(input);
  const out = new Set([v, canonicalBarcode(v)]);
  for (const c of [...out]) if (c.length === 13 && c.startsWith("0") && gtinCheckDigitOk(c.slice(1))) out.add(c.slice(1));
  return [...out];
}

const MAX_MONEY_INT_DIGITS = 15;

export function parseMoneyText(text: string, currency: Currency): bigint {
  const t = toAsciiDigits(text)
    .trim()
    .replace(/٬/g, ",") // Arabic thousands separator
    .replace(/٫/g, "."); // Arabic decimal separator
  const m = /^((?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.(\d+))?$/.exec(t);
  if (!m) throw new Error("Invalid money amount");
  const intPart = m[1].replace(/,/g, "");
  const frac = m[2] ?? "";
  if (intPart.length > MAX_MONEY_INT_DIGITS) throw new Error("Money amount too large");
  const digits = minorUnitDigits(currency);
  if (digits === 0) {
    if (/[^0]/.test(frac)) throw new Error(`Fractions are not allowed for ${currency}`);
    return BigInt(intPart);
  }
  if (frac.length > digits) throw new Error(`Too many decimals for ${currency}`);
  return BigInt(intPart + frac.padEnd(digits, "0"));
}

export function assertUnitFactor(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > MAX_UNIT_FACTOR) {
    throw new Error(`Unit factor must be an integer between 1 and ${MAX_UNIT_FACTOR}`);
  }
}

export function suggestUnitPrice(baseMinor: bigint, factor: number): bigint {
  assertUnitFactor(factor);
  return baseMinor * BigInt(factor);
}
