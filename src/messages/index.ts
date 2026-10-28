import { ar } from "./ar";
import { ckb } from "./ckb";
import { en } from "./en";
import type { Messages } from "./types";

export type { Messages } from "./types";

export const LOCALES = ["ar", "ckb", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "ar";
/** The cookie that remembers the UI language. */
export const LOCALE_COOKIE = "rt_locale";

const MESSAGES: Readonly<Record<Locale, Messages>> = Object.freeze({ ar, ckb, en });

/** BCP 47 tags used for Intl formatting: Arabic-Indic digits for ar and ckb, Latin for en. */
const INTL_TAGS: Readonly<Record<Locale, string>> = Object.freeze({
  ar: "ar-IQ-u-nu-arab",
  ckb: "ckb-IQ-u-nu-arab",
  en: "en-US",
});

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** The cookie's locale, or Arabic when it is missing or unknown. */
export function parseLocale(value: string | undefined | null): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

export function messagesFor(locale: Locale): Messages {
  return MESSAGES[locale];
}

export function dirOf(locale: Locale): "rtl" | "ltr" {
  return locale === "en" ? "ltr" : "rtl";
}

export function formatNumber(locale: Locale, value: number | bigint): string {
  return new Intl.NumberFormat(INTL_TAGS[locale]).format(value);
}

/** A calendar date in Baghdad time, in the UI locale's digits. */
export function formatDate(locale: Locale, value: Date): string {
  return new Intl.DateTimeFormat(INTL_TAGS[locale], {
    timeZone: "Asia/Baghdad",
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(value);
}
