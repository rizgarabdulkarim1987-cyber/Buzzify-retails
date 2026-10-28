import { describe, expect, it } from "vitest";
import { ar } from "@/messages/ar";
import { ckb } from "@/messages/ckb";
import { en } from "@/messages/en";
import { LOCALES, dirOf, formatNumber, messagesFor, parseLocale } from "@/messages";
import { ERROR_MESSAGES } from "@/server/framework/errors";

/** Every leaf path of a message tree ("shell.header.business"), sorted. */
function leafKeys(tree: unknown, prefix = ""): string[] {
  if (typeof tree !== "object" || tree === null) return [prefix];
  return Object.entries(tree)
    .flatMap(([k, v]) => leafKeys(v, prefix ? `${prefix}.${k}` : k))
    .sort();
}

function leaves(tree: unknown): unknown[] {
  if (typeof tree !== "object" || tree === null) return [tree];
  return Object.values(tree).flatMap(leaves);
}

describe("messages", () => {
  it("ar, ckb and en have exactly the same keys", () => {
    const keys = leafKeys(ar);
    expect(keys.length).toBeGreaterThan(20);
    expect(leafKeys(ckb)).toEqual(keys);
    expect(leafKeys(en)).toEqual(keys);
  });

  it("every message is a non-empty string", () => {
    for (const tree of [ar, ckb, en]) {
      for (const value of leaves(tree)) {
        expect(typeof value).toBe("string");
        expect((value as string).trim()).not.toBe("");
      }
    }
  });

  it("every ErrorCode has a message in every locale, and the Arabic ones are the framework's", () => {
    const codes = Object.keys(ERROR_MESSAGES).sort();
    for (const tree of [ar, ckb, en]) expect(Object.keys(tree.errors).sort()).toEqual(codes);
    expect(ar.errors).toEqual(ERROR_MESSAGES);
  });

  it("ar and ckb are right-to-left, en is left-to-right", () => {
    expect(LOCALES).toEqual(["ar", "ckb", "en"]);
    expect(dirOf("ar")).toBe("rtl");
    expect(dirOf("ckb")).toBe("rtl");
    expect(dirOf("en")).toBe("ltr");
    expect(messagesFor("ckb")).toBe(ckb);
  });

  it("the locale cookie falls back to Arabic for a missing or unknown value", () => {
    expect(parseLocale(undefined)).toBe("ar");
    expect(parseLocale("")).toBe("ar");
    expect(parseLocale("fr")).toBe("ar");
    expect(parseLocale("__proto__")).toBe("ar");
    expect(parseLocale("ckb")).toBe("ckb");
    expect(parseLocale("en")).toBe("en");
  });

  it("numbers follow the UI locale's digits", () => {
    expect(formatNumber("ar", 1234567)).toBe("١٬٢٣٤٬٥٦٧");
    expect(formatNumber("ckb", 1234567)).toBe("١٬٢٣٤٬٥٦٧");
    expect(formatNumber("en", 1234567)).toBe("1,234,567");
  });
});
