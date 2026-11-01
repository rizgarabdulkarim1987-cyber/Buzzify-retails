import { describe, expect, it } from "vitest";
import { addBaghdadDays, startOfBaghdadDay } from "@/server/domain/baghdad-time";

const at = (iso: string) => new Date(iso);

describe("startOfBaghdadDay", () => {
  it("returns 00:00 Baghdad (21:00Z the day before) for any instant of that Baghdad day", () => {
    const expected = at("2026-03-09T21:00:00.000Z"); // 2026-03-10 00:00 +03:00
    expect(startOfBaghdadDay(at("2026-03-10T00:00:00+03:00"))).toEqual(expected);
    expect(startOfBaghdadDay(at("2026-03-10T12:30:00+03:00"))).toEqual(expected);
    expect(startOfBaghdadDay(at("2026-03-10T23:59:59.999+03:00"))).toEqual(expected);
  });

  it("an instant one millisecond before Baghdad midnight belongs to the previous day", () => {
    expect(startOfBaghdadDay(at("2026-03-09T23:59:59.999Z"))).toEqual(at("2026-03-09T21:00:00.000Z"));
    expect(startOfBaghdadDay(at("2026-03-09T20:59:59.999Z"))).toEqual(at("2026-03-08T21:00:00.000Z"));
  });

  it("crosses month and year ends", () => {
    expect(startOfBaghdadDay(at("2026-12-31T22:00:00Z"))).toEqual(at("2026-12-31T21:00:00Z"));
    expect(startOfBaghdadDay(at("2026-12-31T21:00:00Z"))).toEqual(at("2026-12-31T21:00:00Z"));
  });
});

describe("addBaghdadDays", () => {
  it("adds calendar days and lands on Baghdad midnight", () => {
    expect(addBaghdadDays(at("2026-03-10T23:59:59+03:00"), 8)).toEqual(at("2026-03-18T00:00:00+03:00"));
    expect(addBaghdadDays(at("2026-03-10T00:00:00+03:00"), 0)).toEqual(at("2026-03-10T00:00:00+03:00"));
    expect(addBaghdadDays(at("2026-02-27T10:00:00+03:00"), 2)).toEqual(at("2026-03-01T00:00:00+03:00"));
    expect(addBaghdadDays(at("2026-12-30T10:00:00+03:00"), 3)).toEqual(at("2027-01-02T00:00:00+03:00"));
  });
});
