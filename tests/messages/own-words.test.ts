import { describe, expect, it } from "vitest";
import { ar } from "@/messages/ar";
import { ckb } from "@/messages/ckb";
import { en } from "@/messages/en";
import { ERROR_MESSAGES, INTERNAL_ERROR_MESSAGE } from "@/server/framework/errors";
import { offenders } from "../helpers/own-words";

/*
 * The guard's words live in tests/helpers/own-words.ts (shared with the rendered sign-in page
 * checks). Only message VALUES are checked: keys (adminCore, CORE_MANAGED), enum names (CASHIER)
 * and code identifiers are never shown, so they are allowed by construction.
 */

describe("messages use Retails' own words", () => {
  for (const [name, tree] of [["ar", ar], ["ckb", ckb], ["en", en]] as const) {
    it(`${name} names no other product and no internal service`, () => {
      expect(offenders(tree)).toEqual([]);
    });
  }

  it("the framework's error texts do too", () => {
    expect(offenders({ ...ERROR_MESSAGES, internal: INTERNAL_ERROR_MESSAGE })).toEqual([]);
  });

  it("the guard itself catches each forbidden word (and leaves keys alone)", () => {
    expect(offenders({ a: "Sign in with Studio" })).toHaveLength(1);
    expect(offenders({ a: "مرتبط بـStudio" })).toHaveLength(1);
    expect(offenders({ a: "Linked to Core" })).toHaveLength(1);
    expect(offenders({ a: "Open the restaurant" })).toHaveLength(1);
    expect(offenders({ a: "Your menus" })).toHaveLength(1);
    expect(offenders({ a: "Menu" })).toHaveLength(1);
    expect(offenders({ a: "القوائم" })).toHaveLength(1);
    expect(offenders({ a: "مینیوەکان" })).toHaveLength(1);
    expect(offenders({ a: "Sign in with Buzzify Core" })).toHaveLength(1);
    expect(offenders({ a: "Pharmacy stock" })).toHaveLength(1);
    expect(offenders({ a: "كاشير" })).toHaveLength(1);
    expect(offenders({ a: "صيدلية" })).toHaveLength(1);
    expect(offenders({ a: "مطعم" })).toHaveLength(1);
    expect(offenders({ a: "ستوديو" })).toHaveLength(1);
    expect(offenders({ a: "ستۆدیۆ" })).toHaveLength(1);
    expect(offenders({ a: "چێشتخانە" })).toHaveLength(1);
    expect(offenders({ a: "دەرمانخانە" })).toHaveLength(1);
    expect(offenders({ adminCore: { CASHIER: "Till operator" }, CORE_MANAGED: "Managed by Buzzify" })).toEqual([]);
    expect(offenders({ a: "A score of 3" })).toEqual([]);
    expect(offenders({ a: "Numerous items" })).toEqual([]);
  });
});
