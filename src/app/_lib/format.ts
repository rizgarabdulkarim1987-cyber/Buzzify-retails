import { formatNumber, type Locale } from "@/messages";

/** Replaces {name} placeholders in a message. Unknown placeholders are left as they are. */
export function fill(template: string, vars: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (Object.hasOwn(vars, key) ? String(vars[key]) : whole));
}

export type MoneyCurrency = "IQD" | "USD";

const DECIMAL_MARK: Record<Locale, string> = { ar: "٫", ckb: "٫", en: "." };

/** Every digit of a plain digit string in the UI locale's digits (ASCII for en, Arabic-Indic for ar and ckb). */
function localDigits(locale: Locale, digits: string): string {
  return [...digits].map((d) => formatNumber(locale, Number(d))).join("");
}

/**
 * An amount in minor units as text for the UI, in the interface's digits, with the currency after
 * it. Exact: BigInt arithmetic only (dinar has no minor digits, dollar has two), never a float.
 */
export function formatMoney(locale: Locale, currency: MoneyCurrency, amountMinor: bigint | string, label: string): string {
  const minor = typeof amountMinor === "bigint" ? amountMinor : BigInt(amountMinor);
  if (currency === "IQD") return `${formatNumber(locale, minor)} ${label}`;
  const whole = minor / 100n;
  const cents = String(minor % 100n).padStart(2, "0");
  return `${formatNumber(locale, whole)}${DECIMAL_MARK[locale]}${localDigits(locale, cents)} ${label}`;
}

/** The name to show in the interface language, falling back to Arabic (the required name). */
export function pickName(locale: Locale, names: { nameAr: string; nameCkb?: string | null; nameEn?: string | null }): string {
  if (locale === "ckb" && names.nameCkb) return names.nameCkb;
  if (locale === "en" && names.nameEn) return names.nameEn;
  return names.nameAr;
}

/** Minor units as plain editable text in ASCII digits ("1250" for dinar, "12.50" for dollar): what a price box is filled with. */
export function minorToInput(currency: MoneyCurrency, amountMinor: bigint | string): string {
  const minor = typeof amountMinor === "bigint" ? amountMinor : BigInt(amountMinor);
  if (currency === "IQD") return minor.toString();
  return `${minor / 100n}.${String(minor % 100n).padStart(2, "0")}`;
}
