import { describe, expect, it } from "vitest";
import { pageOf, pageSlots, pageWindow } from "@/app/retail/sell/_lib/pager";

describe("till pager", () => {
  it("fits whole rows into the height, at least one", () => {
    expect(pageSlots(368, 46)).toBe(8);
    expect(pageSlots(10, 46)).toBe(1);
    expect(pageSlots(0, 46)).toBe(1);
  });
  it("puts the selected row on its page", () => {
    expect(pageOf(7, 8)).toBe(0);
    expect(pageOf(8, 8)).toBe(1);
    expect(pageOf(0, 8)).toBe(0);
  });
  it("returns one page of items and clamps past the end", () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    expect(pageWindow(items, 2, 8)).toEqual([16, 17, 18, 19]);
    expect(pageWindow(items, 9, 8)).toEqual([16, 17, 18, 19]);
    expect(pageWindow([], 0, 8)).toEqual([]);
  });
});
