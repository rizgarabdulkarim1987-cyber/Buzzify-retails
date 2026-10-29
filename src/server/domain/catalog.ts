// Pure catalog rules. No framework or database imports.
import type { Currency } from "./money";
import { minorUnitDigits } from "./money";

export const MAX_BARCODE_LENGTH = 64;
export const MAX_UNIT_FACTOR = 100_000;

const ARABIC_INDIC_ZERO = 0x0660;
const PERSIAN_ZERO = 0x06f0;

/** Arabic-Indic (U+0660..0669) and Persian (U+06F0..06F9) digits to ASCII. */
function toAsciiDigits(s: string): string {
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
    .replace(/ى/g, "ي")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeBarcode(input: string): string {
  const v = toAsciiDigits(input).trim();
  if (v.length === 0) throw new Error("Barcode is empty");
  if (v.length > MAX_BARCODE_LENGTH) throw new Error(`Barcode exceeds ${MAX_BARCODE_LENGTH} characters`);
  if (!/^[\p{L}\p{N}\-./_]+$/u.test(v)) throw new Error("Barcode contains invalid characters");
  return v;
}

export function parseMoneyText(text: string, currency: Currency): bigint {
  const t = toAsciiDigits(text)
    .trim()
    .replace(/\u066C/g, ",") // Arabic thousands separator
    .replace(/\u066B/g, "."); // Arabic decimal separator
  if (!/^[0-9][0-9,]*(\.[0-9]+)?$|^\.[0-9]+$/.test(t)) throw new Error("Invalid money amount");
  const [intRaw, frac = ""] = t.split(".");
  const intPart = intRaw.replace(/,/g, "");
  const digits = minorUnitDigits(currency);
  if (frac.length > digits) throw new Error(`Too many decimals for ${currency}`);
  const minor = (intPart === "" ? "0" : intPart) + frac.padEnd(digits, "0");
  return BigInt(minor);
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
