import { describe, expect, it } from "vitest";
import { canSwitchBranch } from "@/server/domain/branch-switch";

describe("branch switch", () => {
  it("switching is refused with open drafts or an open shift", () => {
    expect(canSwitchBranch({ openDrafts: 1, openShift: false })).toEqual({ allowed: false, reason: "OPEN_DRAFTS" });
    expect(canSwitchBranch({ openDrafts: 3, openShift: false })).toEqual({ allowed: false, reason: "OPEN_DRAFTS" });
    expect(canSwitchBranch({ openDrafts: 0, openShift: true })).toEqual({ allowed: false, reason: "OPEN_SHIFT" });
  });

  it("an open shift is reported before open drafts (closing the shift is the bigger step)", () => {
    expect(canSwitchBranch({ openDrafts: 2, openShift: true })).toEqual({ allowed: false, reason: "OPEN_SHIFT" });
  });

  it("switching is allowed with no drafts and no open shift", () => {
    expect(canSwitchBranch({ openDrafts: 0, openShift: false })).toEqual({ allowed: true });
  });

  it("a malformed draft count is refused, never treated as zero", () => {
    for (const openDrafts of [Number.NaN, -1, 0.5, Number.POSITIVE_INFINITY]) {
      expect(canSwitchBranch({ openDrafts, openShift: false })).toEqual({ allowed: false, reason: "OPEN_DRAFTS" });
    }
  });
});
