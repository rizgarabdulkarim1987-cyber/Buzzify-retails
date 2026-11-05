import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CARD, CARD_DAY, PALETTE, PALETTE_DAY, WASH_DAY, accentFor, contrast, dayAccent } from "../../src/app/retail/sell/_lib/category-accent";
import { hasGlyph } from "../../src/app/retail/sell/_lib/category-icons";
import { CLOTHING_CATEGORY_KEYS, ELECTRONICS_CATEGORY_KEYS, STANDARD_CATEGORY_KEYS, categoryKind, categoryKindFor, type CategoryKind } from "../../src/app/retail/sell/_lib/category-kind";
import { clothingDepartments } from "../../src/packs/clothing/departments";
import type { DepartmentTree } from "../../src/packs/departments";
import { electronicsDepartments } from "../../src/packs/electronics/departments";
import { allPackWords, packById, packWords } from "../../src/packs";
import { entries, offenders } from "../helpers/own-words";

const LOCALES = ["ar", "ckb", "en"] as const;
const PACKS: [string, "ELECTRONICS" | "CLOTHING", DepartmentTree, readonly CategoryKind[]][] = [
  ["Electronics", "ELECTRONICS", electronicsDepartments, ELECTRONICS_CATEGORY_KEYS],
  ["Clothing", "CLOTHING", clothingDepartments, CLOTHING_CATEGORY_KEYS],
];

describe.each(PACKS)("%s standard departments", (_name, pack, tree, keys) => {
  it("every department has a key and a name in ar, ckb and en, children included, and no name repeats", () => {
    const seen = new Set<string>();
    for (const d of tree) {
      for (const l of LOCALES) expect(d[l].trim().length, `${d.key} ${l}`).toBeGreaterThan(0);
      expect(seen.has(d.key), d.key).toBe(false);
      seen.add(d.key);
      const childAr = new Set<string>();
      for (const c of d.children ?? []) {
        for (const l of LOCALES) expect(c[l].trim().length, `${d.key} child ${l}`).toBeGreaterThan(0);
        expect(childAr.has(c.ar), `${d.key}: ${c.ar}`).toBe(false);
        childAr.add(c.ar);
      }
    }
    expect(new Set(tree.map((d) => d.ar)).size).toBe(tree.length);
  });

  it("the tree is the key list the till knows, in order, ending with other", () => {
    expect(tree.map((d) => d.key)).toEqual([...keys, "other"]);
  });

  it("no name carries a forbidden word (another product, an internal service)", () => {
    expect(offenders(tree)).toEqual([]);
    expect(entries(tree).length).toBeGreaterThan(40);
  });

  it("every key has a glyph and a fixed accent that reads in Night (on the card) and Day (on the washed card)", () => {
    for (const key of keys) {
      expect(hasGlyph(key), key).toBe(true);
      const accent = accentFor(key, "any seed");
      expect(accentFor(key, "another seed")).toBe(accent);
      expect(Object.values(PALETTE), key).toContain(accent);
      expect(contrast(accent, CARD), `${key} night`).toBeGreaterThanOrEqual(4.5);
      const day = dayAccent(accent);
      expect(Object.values(PALETTE_DAY), key).toContain(day);
      // 9% wash of the accent over the white card, as the CSS paints it
      const mix = (c: number, a: number) => Math.round(c * WASH_DAY + a * (1 - WASH_DAY));
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(day.slice(i, i + 2), 16));
      const white = parseInt(CARD_DAY.slice(1, 3), 16);
      const washed = `#${[mix(r!, white), mix(g!, white), mix(b!, white)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
      expect(contrast(day, washed), `${key} day`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("a department's own names choose its key, in every language", () => {
    for (const d of tree) {
      if (d.key === "other") continue;
      for (const l of LOCALES) expect(categoryKindFor(pack, d[l]), `${d.key} ${l}: ${d[l]}`).toBe(d.key);
      expect(categoryKindFor(pack, d.ar, d.ckb, d.en), d.key).toBe(d.key);
    }
  });

  it("an owner-made name that matches nothing is other (hashed accent, stable)", () => {
    expect(categoryKindFor(pack, "قسم خاص بي")).toBe("other");
    expect(categoryKindFor(pack, null, undefined, "")).toBe("other");
    expect(accentFor("other", "x")).toBe(accentFor("other", "x"));
  });
});

describe("a product never reaches another product's departments", () => {
  const sm: string[] = [...STANDARD_CATEGORY_KEYS];
  const el: string[] = [...ELECTRONICS_CATEGORY_KEYS];
  const cl: string[] = [...CLOTHING_CATEGORY_KEYS];

  it("keys are disjoint across the three products (only other is shared)", () => {
    const all = [...sm.filter((k) => k !== "other"), ...el, ...cl];
    expect(new Set(all).size).toBe(all.length);
  });

  it("electronics names give electronics keys or other, clothing names clothing keys or other, supermarket names supermarket kinds", () => {
    const names = (t: DepartmentTree) => t.flatMap((d) => [d, ...(d.children ?? [])]).flatMap((d) => [d.ar, d.ckb, d.en]);
    for (const n of [...names(clothingDepartments), "ألبان", "Dairy", "Fresh fish", "خضار"]) expect([...el, "other"], `electronics: ${n}`).toContain(categoryKindFor("ELECTRONICS", n));
    for (const n of [...names(electronicsDepartments), "ألبان", "Dairy", "Fresh fish", "خضار"]) expect([...cl, "other"], `clothing: ${n}`).toContain(categoryKindFor("CLOTHING", n));
    for (const n of [...names(electronicsDepartments), ...names(clothingDepartments)]) expect([...sm, "all"], `supermarket: ${n}`).toContain(categoryKindFor("SUPERMARKET", n));
  });

  it("the supermarket matcher is unchanged and the pack-less call is the supermarket's", () => {
    expect(categoryKindFor("SUPERMARKET", "ألبان")).toBe(categoryKind("ألبان"));
    expect(categoryKindFor("SUPERMARKET", "Fresh fish")).toBe("fish");
  });
});

describe("the till's department words come from the pack", () => {
  const sets = allPackWords();
  it("every pack has the three department words in ar, ckb and en, with {n} where a count goes", () => {
    for (const [key, set] of Object.entries(sets)) {
      for (const l of LOCALES) {
        const t = set[l].till;
        expect(t.departments, `${key} ${l}`).toContain("{n}");
        expect(t.categoryItems, `${key} ${l}`).toContain("{n}");
        expect(t.open.trim().length, `${key} ${l}`).toBeGreaterThan(0);
      }
    }
  });

  it("electronics, clothing and the supermarket do not share a count word (the words are the product's own)", () => {
    for (const l of LOCALES) {
      const words = ["SUPERMARKET", "ELECTRONICS", "CLOTHING"].map((id) => packWords(packById(id as "SUPERMARKET"), l).till.categoryItems);
      expect(new Set(words).size, l).toBe(3);
    }
  });

  it("the sell page passes the pack and its words, and the cards use them", () => {
    const page = readFileSync(join(process.cwd(), "src/app/retail/sell/page.tsx"), "utf8");
    expect(page).toContain("pack={pack}");
    expect(page).toContain("departmentWords={departmentWords}");
    const screen = readFileSync(join(process.cwd(), "src/app/retail/sell/sell-screen.tsx"), "utf8");
    expect(screen).toContain("categoryKindFor(pack,");
    expect(screen).toContain("departmentWords.open");
    expect(screen).toContain("departmentWords.categoryItems");
    expect(screen).not.toContain("tl.openCategory");
  });
});
