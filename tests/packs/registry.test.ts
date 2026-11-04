import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LOCALES } from "@/messages";
import { FALLBACK_PACK, PACK_IDS, allPackWords, allPacks, getPack, packById, packWords, visibleNav } from "@/packs";
import { placeMemberships, shownPack } from "@/packs/placement";
import { can } from "@/server/domain/permissions";
import { ACTIVITY_TYPES, defaultCapabilities } from "@/server/domain/profiles";
import type { RtRole } from "@/generated/prisma/client";

const pageFile = (route: string) => fileURLToPath(new URL(`../../src/app${route}/page.tsx`, import.meta.url));

/** Every leaf path of a tree, sorted. */
function leafKeys(tree: unknown, prefix = ""): string[] {
  if (typeof tree !== "object" || tree === null) return [prefix];
  return Object.entries(tree)
    .flatMap(([k, v]) => leafKeys(v, prefix ? `${prefix}.${k}` : k))
    .sort();
}

describe("pack registry", () => {
  it("has the three products, each serving its own activity type", () => {
    expect(PACK_IDS).toEqual(["SUPERMARKET", "ELECTRONICS", "CLOTHING"]);
    expect(packById("SUPERMARKET").activityType).toBe("MARKET");
    expect(packById("ELECTRONICS").activityType).toBe("ELECTRONICS");
    expect(packById("CLOTHING").activityType).toBe("CLOTHING");
    expect(new Set(allPacks().map((p) => p.hostKey)).size).toBe(3);
    expect(new Set(allPacks().map((p) => p.wordSet)).size).toBe(3);
  });

  it("getPack maps each activity type; MIXED, the types without a pack and unknown values get the supermarket", () => {
    expect(getPack("MARKET").id).toBe("SUPERMARKET");
    expect(getPack("ELECTRONICS").id).toBe("ELECTRONICS");
    expect(getPack("CLOTHING").id).toBe("CLOTHING");
    for (const a of ["MIXED", "BEAUTY", "STATIONERY", "BAKERY", "", "__proto__", null, undefined]) {
      expect(getPack(a).id).toBe(FALLBACK_PACK);
    }
    expect(FALLBACK_PACK).toBe("SUPERMARKET");
  });

  it("default capabilities: SERIAL for electronics, VARIANTS for clothing, BATCH and WEIGHT for the supermarket, and the same set provisioning uses", () => {
    expect(packById("ELECTRONICS").capabilities).toContain("SERIAL");
    expect(packById("CLOTHING").capabilities).toContain("VARIANTS");
    expect(packById("SUPERMARKET").capabilities).toEqual(expect.arrayContaining(["BATCH", "WEIGHT"]));
    for (const p of allPacks()) expect([...p.capabilities].sort()).toEqual(defaultCapabilities(p.activityType).sort());
    for (const a of ACTIVITY_TYPES) expect(getPack(a)).toBeDefined();
  });

  it("every section and home is an existing screen", () => {
    for (const p of allPacks()) {
      expect(existsSync(pageFile(p.home)), p.home).toBe(true);
      expect(p.nav.map((s) => s.id)).toEqual(["sell", "catalog", "stock", "scan", "setup"]);
      for (const s of p.nav) expect(existsSync(pageFile(s.route)), s.route).toBe(true);
    }
  });

  it("sections follow the role: a till operator sees Sell (with a branch) and Stock, not Scan or Setup", () => {
    const pack = packById("SUPERMARKET");
    const ids = (role: RtRole, hasBranch: boolean, placement?: "bar" | "more") =>
      visibleNav(pack, { can: (p) => can(role, p), hasBranch }, placement).map((s) => s.id);
    expect(ids("CASHIER", true)).toEqual(["sell", "catalog", "stock"]);
    expect(ids("CASHIER", false)).toEqual(["catalog", "stock"]);
    expect(ids("OWNER", true)).toEqual(["sell", "catalog", "stock", "scan", "setup"]);
    expect(ids("OWNER", true, "bar")).toEqual(["sell", "catalog", "stock"]);
    expect(ids("OWNER", true, "more")).toEqual(["scan", "setup"]);
    expect(ids("STOCK", true)).toEqual(["catalog", "stock", "scan"]);
  });

  it("every pack has the same word keys in every locale, all non-empty, and names itself", () => {
    const sets = Object.values(allPackWords());
    const keys = leafKeys(sets[0]!.en);
    expect(keys).toContain("productName");
    for (const set of sets) {
      for (const l of LOCALES) {
        expect(leafKeys(set[l])).toEqual(keys);
        for (const v of Object.values(set[l]).flatMap((x) => (typeof x === "string" ? [x] : Object.values(x)))) expect(v.trim()).not.toBe("");
      }
    }
    expect(packWords(packById("SUPERMARKET"), "en").productName).toBe("Buzzify Supermarket");
    expect(packWords(packById("ELECTRONICS"), "en").productName).toBe("Buzzify Electronics");
    expect(packWords(packById("CLOTHING"), "en").productName).toBe("Buzzify Clothing");
    for (const p of allPacks()) for (const l of LOCALES) expect(packWords(p, l).productName).toContain(packWords(p, l).productWord);
  });
});

describe("which businesses an address shows", () => {
  const market = { businessId: "m", activityType: "MARKET" };
  const phones = { businessId: "e", activityType: "ELECTRONICS" };
  const mixed = { businessId: "x", activityType: "MIXED" };
  const origins = (p: string) => (p === "ELECTRONICS" ? "https://electronics.example.test" : null);

  it("the shared address shows every business", () => {
    expect(placeMemberships(null, [market, phones], origins)).toEqual({ memberships: [market, phones], misplaced: null });
  });

  it("a product address shows only that product's businesses (MIXED counts as supermarket)", () => {
    expect(placeMemberships("SUPERMARKET", [market, phones, mixed], origins)).toEqual({ memberships: [market, mixed], misplaced: null });
    expect(placeMemberships("ELECTRONICS", [market, phones], origins).memberships).toEqual([phones]);
  });

  it("a user with only another product's businesses is sent to that product's address, or to the not-available page", () => {
    expect(placeMemberships("SUPERMARKET", [phones], origins).misplaced).toEqual({ redirectTo: "https://electronics.example.test/retail/home" });
    expect(placeMemberships("ELECTRONICS", [market], origins).misplaced).toEqual({ redirectTo: null });
  });

  it("a user with no business at all is not misplaced", () => {
    expect(placeMemberships("CLOTHING", [], origins)).toEqual({ memberships: [], misplaced: null });
  });

  it("the shown product: the address's own, else the business's, else none", () => {
    expect(shownPack("CLOTHING", "MARKET")?.id).toBe("CLOTHING");
    expect(shownPack(null, "ELECTRONICS")?.id).toBe("ELECTRONICS");
    expect(shownPack(null, "MIXED")?.id).toBe("SUPERMARKET");
    expect(shownPack(null, undefined)).toBeNull();
  });
});
