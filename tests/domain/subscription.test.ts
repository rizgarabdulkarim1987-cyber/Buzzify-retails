import { describe, expect, it } from "vitest";
import { gateFor, type GateMode } from "@/server/domain/subscription";

const at = (iso: string) => new Date(iso);
const DAY = 86_400_000;
const ms = (d: Date, delta: number) => new Date(d.getTime() + delta);

const base = {
  status: "ACTIVE" as const,
  currentPeriodEnd: at("2026-03-10T23:59:59+03:00"),
  graceDays: 7,
};
// graceEnd = start of the Baghdad day containing the period end + (7 + 1) days = 2026-03-18 00:00 +03:00.
const graceEnd = at("2026-03-18T00:00:00+03:00");
const retentionEnd = ms(graceEnd, 90 * DAY);

describe("gateFor", () => {
  it("no subscription -> CLOSED", () => {
    expect(gateFor(null, at("2026-03-01T00:00:00Z"))).toBe("CLOSED");
  });

  it("TRIAL before trialEndsAt -> FULL", () => {
    const sub = { ...base, status: "TRIAL" as const, trialEndsAt: at("2026-03-05T12:00:00+03:00") };
    expect(gateFor(sub, at("2026-03-05T11:59:59+03:00"))).toBe("FULL");
  });

  it("TRIAL with null trialEndsAt falls back to currentPeriodEnd", () => {
    const sub = { ...base, status: "TRIAL" as const, trialEndsAt: null };
    expect(gateFor(sub, at("2026-03-10T23:00:00+03:00"))).toBe("FULL");
    expect(gateFor(sub, ms(graceEnd, 0))).toBe("READ_ONLY");
  });

  it("TRIAL uses trialEndsAt (not currentPeriodEnd) as its period end", () => {
    const sub = { ...base, status: "TRIAL" as const, trialEndsAt: at("2026-02-01T12:00:00+03:00") };
    // trial grace ends 2026-02-09 00:00 +03:00
    expect(gateFor(sub, at("2026-02-08T23:59:59+03:00"))).toBe("FULL");
    expect(gateFor(sub, at("2026-02-09T00:00:00+03:00"))).toBe("READ_ONLY");
  });

  it("ACTIVE one day after the period end, within grace -> FULL", () => {
    expect(gateFor(base, at("2026-03-11T23:59:59+03:00"))).toBe("FULL");
  });

  it("ACTIVE inside the period -> FULL", () => {
    expect(gateFor(base, at("2026-03-01T00:00:00+03:00"))).toBe("FULL");
  });

  it("after grace -> READ_ONLY", () => {
    expect(gateFor(base, at("2026-03-19T00:00:00+03:00"))).toBe("READ_ONLY");
  });

  it("exact transition instants: grace end and retention end", () => {
    const mode = (d: Date): GateMode => gateFor(base, d);
    expect(mode(ms(graceEnd, -1))).toBe("FULL");
    expect(mode(graceEnd)).toBe("READ_ONLY");
    expect(mode(ms(retentionEnd, -1))).toBe("READ_ONLY");
    expect(mode(retentionEnd)).toBe("CLOSED");
    expect(mode(ms(retentionEnd, 1))).toBe("CLOSED");
  });

  it("90 days after grace end -> CLOSED", () => {
    expect(gateFor(base, ms(graceEnd, 90 * DAY + 1))).toBe("CLOSED");
  });

  it("retentionDays is a parameter", () => {
    expect(gateFor(base, ms(graceEnd, 31 * DAY), 30)).toBe("CLOSED");
    expect(gateFor(base, ms(graceEnd, 29 * DAY), 30)).toBe("READ_ONLY");
  });

  it("period end at the exact instant: FULL strictly before, grace starts at it", () => {
    expect(gateFor(base, ms(base.currentPeriodEnd, -1))).toBe("FULL");
    expect(gateFor(base, base.currentPeriodEnd)).toBe("FULL"); // grace is still FULL
  });

  it("boundary: period end 23:59:59 Baghdad vs 00:00:00 of the next Baghdad day", () => {
    const late = { ...base, currentPeriodEnd: at("2026-03-10T23:59:59+03:00") };
    const next = { ...base, currentPeriodEnd: at("2026-03-11T00:00:00+03:00") };
    const lateGraceEnd = at("2026-03-18T00:00:00+03:00");
    const nextGraceEnd = at("2026-03-19T00:00:00+03:00");
    // Same instant (one second apart) but different Baghdad days: grace ends a full day apart.
    expect(gateFor(late, ms(lateGraceEnd, -1))).toBe("FULL");
    expect(gateFor(late, lateGraceEnd)).toBe("READ_ONLY");
    expect(gateFor(next, ms(lateGraceEnd, 0))).toBe("FULL");
    expect(gateFor(next, ms(nextGraceEnd, -1))).toBe("FULL");
    expect(gateFor(next, nextGraceEnd)).toBe("READ_ONLY");
    // retention follows each graceEnd
    expect(gateFor(late, ms(lateGraceEnd, 90 * DAY))).toBe("CLOSED");
    expect(gateFor(next, ms(nextGraceEnd, 90 * DAY - 1))).toBe("READ_ONLY");
    expect(gateFor(next, ms(nextGraceEnd, 90 * DAY))).toBe("CLOSED");
  });

  it("graceDays 0: FULL until the start of the next Baghdad day", () => {
    const sub = { ...base, graceDays: 0 };
    expect(gateFor(sub, at("2026-03-10T23:59:59.500+03:00"))).toBe("FULL");
    expect(gateFor(sub, at("2026-03-11T00:00:00+03:00"))).toBe("READ_ONLY");
  });

  it("CANCELLED is READ_ONLY from cancelledAt until 90 days later, then CLOSED, never FULL", () => {
    const cancelledAt = at("2026-03-02T10:00:00+03:00");
    const sub = { ...base, status: "CANCELLED" as const, cancelledAt };
    // period is still running, but a cancelled subscription is never FULL
    expect(gateFor(sub, at("2026-03-03T00:00:00+03:00"))).toBe("READ_ONLY");
    expect(gateFor(sub, ms(cancelledAt, 90 * DAY - 1))).toBe("READ_ONLY");
    expect(gateFor(sub, ms(cancelledAt, 90 * DAY))).toBe("CLOSED");
  });

  it("stored status that disagrees with the dates: dates win (except CANCELLED)", () => {
    const farFuture = at("2026-03-20T00:00:00+03:00"); // inside READ_ONLY window
    expect(gateFor({ ...base, status: "ACTIVE" }, farFuture)).toBe("READ_ONLY");
    expect(gateFor({ ...base, status: "EXPIRED" }, at("2026-03-01T00:00:00+03:00"))).toBe("FULL");
    expect(gateFor({ ...base, status: "GRACE" }, at("2026-03-01T00:00:00+03:00"))).toBe("FULL");
    expect(gateFor({ ...base, status: "EXPIRED" }, ms(retentionEnd, 1))).toBe("CLOSED");
  });
});
