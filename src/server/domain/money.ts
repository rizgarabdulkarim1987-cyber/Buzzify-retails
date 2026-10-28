import { Currency } from "@/generated/prisma/enums";

// Single source of truth: the Prisma `Currency` enum.
export { Currency };

export const CURRENCIES = Object.values(Currency);

/** Digits after the decimal point in the minor unit (IQD has none, USD has cents). */
export function minorUnitDigits(c: Currency): 0 | 2 {
  return c === Currency.IQD ? 0 : 2;
}

export function assertCurrency(v: string): Currency {
  if ((CURRENCIES as string[]).includes(v)) return v as Currency;
  throw new Error(`Unsupported currency: ${v}`);
}
