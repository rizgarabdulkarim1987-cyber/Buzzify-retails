import { describe, expect, it } from "vitest";
import { ar } from "@/messages/ar";
import { ckb } from "@/messages/ckb";
import { en } from "@/messages/en";
import { allPackWords } from "@/packs";
import { SHELL_WORDS } from "@/packs/shell-words";
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

/*
 * Packs: Buzzify Supermarket, Buzzify Electronics and Buzzify Clothing are separate products. Each
 * pack's words name only that product: never another pack's name or its own words, and never the
 * words forbidden above. The shared messages (every product shows them) name no product at all;
 * `activity` is the platform-admin list of activity types (a Buzzify staff screen), so it is exempt.
 */
const PACK_TERMS: Record<string, RegExp[]> = {
  supermarket: [/supermarket/i, /grocer/i, /سوبر ?ماركت|ماركت/, /سوپەر ?مارکێت|مارکێت/],
  electronics: [/electronic/i, /devices?/i, /phones?/i, /إلكترونيات|الكترونيات|موبايل|الأجهزة|أجهزة/, /ئەلیکترۆنیات|ئەلکترۆنی|مۆبایل|ئامێرەکان/],
  clothing: [/clothing|clothes/i, /fashion/i, /ملابس|أزياء|الأصناف/, /جلوبەرگ|جل و بەرگ|کاڵاکان/],
};

function packOffenders(tree: unknown, others: string[]): string[] {
  const found: string[] = [];
  for (const [path, value] of entries(tree)) {
    for (const other of others) for (const p of PACK_TERMS[other]!) if (p.test(value)) found.push(`${path}: ${other} word in ${JSON.stringify(value)}`);
  }
  return found;
}

describe("each product speaks only its own words", () => {
  const sets = allPackWords();

  it("every pack has a guard entry", () => {
    expect(Object.keys(sets).sort()).toEqual(Object.keys(PACK_TERMS).sort());
  });

  for (const [key, set] of Object.entries(sets)) {
    for (const [locale, words] of Object.entries(set)) {
      it(`${key} (${locale}) names no other pack, no other product and no internal service`, () => {
        expect(packOffenders(words, Object.keys(PACK_TERMS).filter((k) => k !== key))).toEqual([]);
        expect(offenders(words)).toEqual([]);
      });
      it(`${key} (${locale}) names itself`, () => {
        expect(PACK_TERMS[key]!.some((p) => p.test(words.productName))).toBe(true);
      });
    }
  }

  it("the neutral pack shell words name no pack and no other product", () => {
    for (const words of Object.values(SHELL_WORDS)) {
      expect(packOffenders(words, Object.keys(PACK_TERMS))).toEqual([]);
      expect(offenders(words)).toEqual([]);
    }
  });

  for (const [name, tree] of [["ar", ar], ["ckb", ckb], ["en", en]] as const) {
    it(`the shared ${name} messages name no pack (activity list for platform staff exempt)`, () => {
      const shared = Object.fromEntries(Object.entries(tree).filter(([k]) => k !== "activity"));
      const names = [/supermarket/i, /electronics/i, /clothing/i, /سوبرماركت/, /إلكترونيات/, /ملابس/, /سوپەرمارکێت/, /ئەلیکترۆنیات/, /جلوبەرگ/];
      const hits = entries(shared).filter(([, v]) => names.some((p) => p.test(v)));
      expect(hits).toEqual([]);
    });
  }

  it("the pack guard catches each pack's words", () => {
    expect(packOffenders({ a: "Buzzify Electronics" }, ["electronics"])).toHaveLength(1);
    expect(packOffenders({ a: "الأجهزة" }, ["electronics"])).toHaveLength(1);
    expect(packOffenders({ a: "Buzzify ملابس" }, ["clothing"])).toHaveLength(1);
    expect(packOffenders({ a: "سوبرماركت" }, ["supermarket"])).toHaveLength(1);
    expect(packOffenders({ a: "Buzzify سوپەرمارکێت" }, ["supermarket"])).toHaveLength(1);
    // The Arabic word for e-mail shares a root with "electronics" and is not a pack word.
    expect(packOffenders({ a: "البريد الإلكتروني" }, ["electronics"])).toEqual([]);
  });
});
