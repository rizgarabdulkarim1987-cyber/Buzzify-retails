import { describe, expect, it } from "vitest";
import { ar } from "@/messages/ar";
import { ckb } from "@/messages/ckb";
import { en } from "@/messages/en";
import { ERROR_MESSAGES, INTERNAL_ERROR_MESSAGE } from "@/server/framework/errors";

/*
 * Retails speaks only its own words: a shop user never reads the name of another Buzzify product
 * (the Studio, the restaurant product, the Cashier product, the Pharmacy product) or of the
 * internal "Core" service. Only message VALUES are checked: keys (adminCore, CORE_MANAGED), enum
 * names (CASHIER) and code identifiers are never shown, so they are allowed by construction.
 */
const FORBIDDEN: { word: string; pattern: RegExp }[] = [
  { word: "Studio", pattern: /studio/i },
  { word: "Core", pattern: /\bcore\b/i },
  { word: "restaurant", pattern: /restaurant/i },
  { word: "pharmacy", pattern: /pharmac/i },
  { word: "prescription", pattern: /prescription/i },
  { word: "Cashier", pattern: /cashier/i },
  // Arabic
  { word: "ستوديو", pattern: /ستوديو|ستوديـو|ستديو/ },
  { word: "مطعم", pattern: /مطعم|مطاعم/ },
  { word: "صيدلية", pattern: /صيدلي/ },
  { word: "كاشير", pattern: /كاشير/ },
  { word: "وصفة طبية", pattern: /وصفة طبية|وصفات طبية/ },
  // Central Kurdish
  { word: "ستۆدیۆ", pattern: /ستۆدیۆ|ستودیو/ },
  { word: "چێشتخانە", pattern: /چێشتخانە/ },
  { word: "دەرمانخانە", pattern: /دەرمانخانە/ },
  { word: "کاشێر", pattern: /کاشێر|کاشیر/ },
];

/** Every leaf of a message tree as [path, value]. */
function entries(tree: unknown, prefix = ""): [string, string][] {
  if (typeof tree === "string") return [[prefix, tree]];
  if (typeof tree !== "object" || tree === null) return [];
  return Object.entries(tree).flatMap(([k, v]) => entries(v, prefix ? `${prefix}.${k}` : k));
}

function offenders(tree: unknown): string[] {
  const found: string[] = [];
  for (const [path, value] of entries(tree)) {
    for (const { word, pattern } of FORBIDDEN) if (pattern.test(value)) found.push(`${path}: "${word}" in ${JSON.stringify(value)}`);
  }
  return found;
}

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
    expect(offenders({ a: "Open the restaurant menu" })).toHaveLength(1);
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
  });
});
