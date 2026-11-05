import { toAsciiDigits } from "@/server/domain/catalog";
import type { CategoryDto, Currency } from "./cart";

/*
 * The touch till's pure helpers (no React): the numpad's text editing, the category colours and
 * the typographic tile initial. The numpad edits plain ASCII text ("12500", "0.75"); money and
 * quantities are parsed from it with the cart's own rules, so nothing here does arithmetic on money.
 */

/** How many category colours the till cycles through (tokens --till-hue-0 .. --till-hue-7 in sell.css). */
export const CATEGORY_TONES = 8;

/** The colour slot of a top-level category: its place in the till's category list, cycled; null when unknown. */
export function categoryTone(categories: readonly Pick<CategoryDto, "id">[], categoryId: string | null): number | null {
  if (!categoryId) return null;
  const i = categories.findIndex((c) => c.id === categoryId);
  return i < 0 ? null : i % CATEGORY_TONES;
}

/**
 * The letter a tile without a photo shows: the first letter of the name, skipping the Arabic
 * article "ال" (so "الرز" shows "ر", not a column of alifs), upper-cased for Latin names. A name
 * that starts with a digit or a symbol falls back to its first character.
 */
export function tileInitial(name: string): string {
  const trimmed = name.trim();
  const body = /^ال\p{L}{2,}/u.test(trimmed) ? trimmed.slice(2) : trimmed;
  const first = [...body][0] ?? "";
  return first.toLocaleUpperCase();
}

/** "12" for twelve digits, a CSS custom property the total's font size divides the box width by. */
export const textLength = (text: string) => [...text].length;

export type NumpadKey = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "000" | "." | "back" | "clear";

/** The keys a numpad shows: "000" for dinar amounts (no fractions), "." where the value may have decimals. */
export function numpadKeys(decimals: number): NumpadKey[] {
  return ["7", "8", "9", "4", "5", "6", "1", "2", "3", decimals > 0 ? "." : "000", "0", "back"];
}

/** How many decimals a money entry may have: none for dinar, two for dollar. */
export const moneyDecimals = (currency: Currency) => (currency === "IQD" ? 0 : 2);

const MAX_WHOLE_DIGITS = 12;

/**
 * One key press on the numpad's text. Never produces a value the field cannot hold: no leading
 * zeros, at most one decimal mark and `decimals` digits after it, at most 12 whole digits. A
 * physical keyboard's Arabic-Indic digits arrive here already as the same keys.
 */
export function numpadPress(text: string, key: NumpadKey, decimals: number): string {
  if (key === "clear") return "";
  if (key === "back") return text.slice(0, -1);
  if (key === ".") {
    if (decimals === 0 || text.includes(".")) return text;
    return text === "" ? "0." : `${text}.`;
  }
  const digits = key === "000" ? "000" : key;
  if (text === "" && /^0+$/.test(digits)) return digits === "000" ? "" : "0";
  const [whole, frac] = text.split(".") as [string, string | undefined];
  if (frac !== undefined) {
    const room = decimals - frac.length;
    return room <= 0 ? text : `${text}${digits.slice(0, room)}`;
  }
  const next = whole === "0" ? digits.replace(/^0+(?=\d)/, "") : whole + digits;
  return next.length > MAX_WHOLE_DIGITS ? text : next;
}

/** A key typed on a physical keyboard as a numpad key (Arabic-Indic digits and the Arabic decimal mark included), or null. */
export function keyFromKeyboard(key: string): NumpadKey | null {
  if (key === "Backspace") return "back";
  if (key === "Delete" || key === "Escape") return null;
  const k = toAsciiDigits(key);
  if (/^\d$/.test(k)) return k as NumpadKey;
  if (k === "." || k === "," || key === "٫") return ".";
  return null;
}

/** Minor units as numpad text in ASCII ("12500" for dinar, "12.5" for dollar): what a numpad starts from. */
export function minorToEntry(currency: Currency, minor: bigint): string {
  if (minor <= 0n) return "";
  if (currency === "IQD") return minor.toString();
  const cents = (minor % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return cents ? `${minor / 100n}.${cents}` : `${minor / 100n}`;
}
