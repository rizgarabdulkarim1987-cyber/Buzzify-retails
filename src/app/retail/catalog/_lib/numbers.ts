import { toAsciiDigits } from "@/server/domain/catalog";

/** A whole number typed in any digits (Arabic-Indic and Persian too), up to six digits; null when it is not one. */
export function wholeNumber(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const t = toAsciiDigits(text).trim();
  return /^\d{1,6}$/.test(t) ? Number(t) : null;
}

/** The Baghdad calendar date of an instant as YYYY-MM-DD. */
export function baghdadToday(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Baghdad", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export type StartDate = { kind: "now" } | { kind: "at"; at: Date } | { kind: "bad" };

/**
 * A price start date typed as a calendar day. Empty or today is "now"; a later day starts at its
 * Baghdad midnight; a past day or anything that is not a date is refused (history is never rewritten).
 */
export function resolveStartDate(text: unknown, now: Date): StartDate {
  const raw = typeof text === "string" ? toAsciiDigits(text).trim() : "";
  if (raw === "") return { kind: "now" };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return { kind: "bad" };
  const at = new Date(`${raw}T00:00:00+03:00`);
  // Noon Baghdad is 09:00Z the same day: a date that rolled over (30 February) does not round-trip.
  const noon = new Date(`${raw}T12:00:00+03:00`);
  if (Number.isNaN(noon.getTime()) || noon.toISOString().slice(0, 10) !== raw) return { kind: "bad" };
  const today = baghdadToday(now);
  if (raw < today) return { kind: "bad" };
  return raw === today ? { kind: "now" } : { kind: "at", at };
}
