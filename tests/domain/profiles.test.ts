import { describe, expect, it } from "vitest";
import {
  ACTIVITY_TYPES,
  CAPABILITIES,
  defaultCapabilities,
  validateCapabilities,
  type ActivityType,
} from "@/server/domain/profiles";

describe("activity profiles", () => {
  it("MARKET defaults include BATCH and WEIGHT, CLOTHING includes VARIANTS", () => {
    expect(defaultCapabilities("MARKET")).toEqual(expect.arrayContaining(["BATCH", "WEIGHT"]));
    expect(defaultCapabilities("CLOTHING")).toContain("VARIANTS");
  });

  it("every activity type has the documented defaults and each default set is valid", () => {
    const expected: Record<ActivityType, string[]> = {
      MARKET: ["BATCH", "WEIGHT", "MULTI_UNIT", "HOLDS"],
      CLOTHING: ["VARIANTS", "HOLDS"],
      ELECTRONICS: ["SERIAL", "WARRANTY"],
      BEAUTY: ["BATCH", "VARIANTS"],
      STATIONERY: ["MULTI_UNIT"],
      MIXED: ["VARIANTS", "MULTI_UNIT", "BATCH"],
    };
    expect([...ACTIVITY_TYPES].sort()).toEqual(Object.keys(expected).sort());
    for (const a of ACTIVITY_TYPES) {
      expect([...defaultCapabilities(a)].sort(), a).toEqual([...expected[a]].sort());
      expect(validateCapabilities(defaultCapabilities(a)), a).toEqual({ ok: true });
    }
  });

  it("returns a fresh array: a caller cannot change the table", () => {
    const list = defaultCapabilities("MARKET");
    list.push("SERIAL");
    expect(defaultCapabilities("MARKET")).not.toContain("SERIAL");
  });

  it("SERIAL and BATCH together are refused", () => {
    expect(validateCapabilities(["SERIAL", "BATCH"])).toEqual({ ok: false, reason: "SERIAL_BATCH_CONFLICT" });
    expect(validateCapabilities([...defaultCapabilities("MIXED"), "SERIAL"])).toEqual({
      ok: false,
      reason: "SERIAL_BATCH_CONFLICT",
    });
    expect(validateCapabilities(["SERIAL", "WARRANTY"])).toEqual({ ok: true });
    expect(validateCapabilities([])).toEqual({ ok: true });
    expect(validateCapabilities([...CAPABILITIES].filter((c) => c !== "BATCH"))).toEqual({ ok: true });
  });
});
