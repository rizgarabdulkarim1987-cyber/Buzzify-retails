/*
 * Calendar-day arithmetic in Asia/Baghdad. The zone is UTC+3 with no DST since 2008, but the
 * offset is always read from Intl so a future rule change cannot silently break the day boundary.
 */

const ZONE = "Asia/Baghdad";

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

type Wall = { year: number; month: number; day: number };

function parts(date: Date): Wall & { hour: number; minute: number; second: number } {
  const out: Record<string, number> = {};
  for (const p of formatter.formatToParts(date)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out as ReturnType<typeof parts>;
}

/** Offset of Baghdad from UTC in ms at the given instant (positive east of UTC). */
function offsetMs(date: Date): number {
  const p = parts(date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant at which the given Baghdad calendar date starts (00:00:00.000 local). */
function midnightOf({ year, month, day }: Wall): Date {
  const wallAsUtc = Date.UTC(year, month - 1, day);
  // The offset may differ between the guess and the result around a rule change; settle in two steps.
  let guess = wallAsUtc - offsetMs(new Date(wallAsUtc));
  guess = wallAsUtc - offsetMs(new Date(guess));
  return new Date(guess);
}

/** Start (00:00:00.000 Baghdad) of the Baghdad calendar day that contains `date`. */
export function startOfBaghdadDay(date: Date): Date {
  return midnightOf(parts(date));
}

/** Start of the Baghdad calendar day `days` days after the day that contains `date`. */
export function addBaghdadDays(date: Date, days: number): Date {
  const { year, month, day } = parts(date);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return midnightOf({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  });
}
