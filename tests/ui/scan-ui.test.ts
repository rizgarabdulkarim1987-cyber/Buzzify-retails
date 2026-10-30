import { describe, expect, it } from "vitest";
import type { RtRole } from "@/generated/prisma/enums";
import { ar } from "@/messages/ar";
import { ckb } from "@/messages/ckb";
import { en } from "@/messages/en";
import { CONSENT_VERSION } from "@/server/intake/consent";
import {
  AI_FALLBACK_STATES,
  DECODE_FORMATS,
  SCAN_IMAGE_SIDE,
  WEDGE_GAP_MS,
  WEDGE_MIN_LENGTH,
  aiFallback,
  aiSettingsLink,
  consentState,
  emptyWedge,
  itemHref,
  newItemHref,
  normalizeScan,
  decodedCode,
  quotaWarning,
  readAttempt,
  scanEntry,
  scanFailure,
  scanOutcome,
  scanRole,
  settingsView,
  usageView,
  wedgeKey,
  type ScanStatus,
} from "../../src/app/retail/catalog/scan/_lib/rules";

const ROLES: RtRole[] = ["OWNER", "MANAGER", "CASHIER", "STOCK", "PURCHASING", "ACCOUNTANT", "AUDITOR"];

const status: ScanStatus = { enabled: true, consent: true, consentCurrent: true, monthlyLimit: 10, limitHalfUnits: 20, usedHalfUnits: 0, warn: false };

// ---------------------------------------------------------------------------------------------
// Digits and the keyboard-wedge scanner

describe("normalizeScan", () => {
  it("turns Arabic-Indic and Persian digits into ASCII and keeps leading zeros", () => {
    expect(normalizeScan("٠٠١٢٣٤٥٦٧٨٩٠٥")).toBe("0012345678905");
    expect(normalizeScan("۰۱۲۳۴۵۶۷۸۹")).toBe("0123456789");
    expect(normalizeScan("  6291041500213 ")).toBe("6291041500213");
  });

  it("refuses empty text, spaces inside, other characters and over-long codes", () => {
    expect(normalizeScan("")).toBeNull();
    expect(normalizeScan("   ")).toBeNull();
    expect(normalizeScan("629 104")).toBeNull();
    expect(normalizeScan("abc;drop")).toBeNull();
    expect(normalizeScan("1".repeat(65))).toBeNull();
    expect(normalizeScan("AB-12/3_4.5")).toBe("AB-12/3_4.5");
  });
});

describe("quotaWarning (spec 3ب.4: the 80% warning for the owner and the manager)", () => {
  const warn = { ...status, usedHalfUnits: 16, warn: true };
  it("shows to the owner and the manager when the month's use is at 80%", () => {
    expect(quotaWarning(scanRole("OWNER"), warn)).toBe(true);
    expect(quotaWarning(scanRole("MANAGER"), warn)).toBe(true);
  });
  it("not to other roles, not below 80%, not with the switch off or the status unread", () => {
    for (const r of ["STOCK", "PURCHASING", "CASHIER", "ACCOUNTANT", "AUDITOR"] as const) expect(quotaWarning(scanRole(r), warn), r).toBe(false);
    expect(quotaWarning(scanRole("OWNER"), status)).toBe(false);
    expect(quotaWarning(scanRole("OWNER"), { ...warn, enabled: false })).toBe(false);
    expect(quotaWarning(scanRole("OWNER"), "UNAVAILABLE")).toBe(false);
  });
});

describe("scanned codes in the canonical GTIN-13 form", () => {
  it("a typed or wedge-scanned UPC-A becomes its 13-digit form; 8-digit codes stay", () => {
    expect(normalizeScan("036000291452")).toBe("0036000291452");
    expect(normalizeScan("036000291453")).toBe("036000291453");
    expect(normalizeScan("73513537")).toBe("73513537");
  });

  it("a camera UPC-E (symbology known) is expanded to its 13-digit form; the same digits as EAN-8 are not", () => {
    expect(decodedCode({ text: "01234565", format: "upc_e" })).toBe("0012345000065");
    expect(decodedCode({ text: "04252614", format: "UPC-E" })).toBe("0042100005264");
    expect(decodedCode({ text: "73513537", format: "ean_8" })).toBe("73513537");
    expect(decodedCode({ text: "036000291452", format: "upc_a" })).toBe("0036000291452");
    expect(decodedCode({ text: "6291041500213", format: "EAN-13" })).toBe("6291041500213");
    expect(decodedCode({ text: "AB 1", format: "code_128" })).toBeNull();
  });
});

describe("wedgeKey (USB scanner typing into the page)", () => {
  const type = (text: string, start = 1000, gap = 10) => {
    let s = emptyWedge();
    let at = start;
    for (const ch of text) {
      s = wedgeKey(s, ch, at).state;
      at += gap;
    }
    return { s, at };
  };

  it("emits the code on Enter after fast keys, normalising Arabic-Indic digits", () => {
    const { s, at } = type("٦٢٩١٠٤١٥٠٠٢١٣");
    const r = wedgeKey(s, "Enter", at);
    expect(r.code).toBe("6291041500213");
    expect(r.state).toEqual(emptyWedge());
  });

  it("ignores slow human typing, short bursts and other keys", () => {
    const slow = type("6291041500213", 1000, WEDGE_GAP_MS + 50);
    expect(wedgeKey(slow.s, "Enter", slow.at).code).toBeNull();
    const short = type("12".slice(0, WEDGE_MIN_LENGTH - 1));
    expect(wedgeKey(short.s, "Enter", short.at).code).toBeNull();
    const { s, at } = type("629104");
    const shifted = wedgeKey(s, "Shift", at);
    expect(shifted.code).toBeNull();
    expect(shifted.state).toEqual(s); // a modifier does not break the burst
    const reset = wedgeKey(s, "ArrowLeft", at);
    expect(reset.state).toEqual(emptyWedge());
  });

  it("a pause starts a new burst", () => {
    const first = type("999");
    let s = wedgeKey(first.s, "6", first.at + WEDGE_GAP_MS + 100).state;
    let at = first.at + WEDGE_GAP_MS + 110;
    for (const ch of "291041500213") {
      s = wedgeKey(s, ch, at).state;
      at += 10;
    }
    expect(wedgeKey(s, "Enter", at).code).toBe("6291041500213");
  });
});

// ---------------------------------------------------------------------------------------------
// Result states

describe("scanOutcome", () => {
  const known = {
    status: "KNOWN" as const,
    code: "6291041500213",
    productId: "p1",
    variantId: "v1",
    unitId: "u1",
    unitName: "Piece",
    nameAr: "حليب",
    sku: "SKU-1",
    archived: false,
    isTestData: false,
  };
  const manager = scanRole("MANAGER");
  const cashier = scanRole("CASHIER");

  it("a known code without flags opens the item at once", () => {
    expect(scanOutcome(known, manager)).toEqual({ kind: "OPEN", productId: "p1" });
    expect(scanOutcome(known, cashier)).toEqual({ kind: "OPEN", productId: "p1" });
  });

  it("an archived or trial item is shown first with its flags", () => {
    expect(scanOutcome({ ...known, archived: true }, manager)).toMatchObject({ kind: "KNOWN", archived: true, trial: false, item: { productId: "p1" } });
    expect(scanOutcome({ ...known, isTestData: true }, manager)).toMatchObject({ kind: "KNOWN", archived: false, trial: true });
  });

  it("an unknown code offers link and new item to catalog managers only, and says when it was not verified", () => {
    expect(scanOutcome({ status: "UNKNOWN", code: "6291041500213", checked: true }, manager)).toEqual({
      kind: "UNKNOWN",
      code: "6291041500213",
      verified: true,
      canLink: true,
      canCreate: true,
    });
    expect(scanOutcome({ status: "UNKNOWN", code: "ABC-1", checked: false }, manager)).toMatchObject({ kind: "UNKNOWN", verified: false });
    expect(scanOutcome({ status: "UNKNOWN", code: "ABC-1", checked: false }, cashier)).toMatchObject({ canLink: false, canCreate: false });
  });

  it("maps a wrong check digit and an unreadable photo", () => {
    expect(scanOutcome({ status: "INVALID_CHECKSUM" }, manager)).toEqual({ kind: "INVALID_CHECKSUM" });
    expect(scanOutcome({ status: "NOT_READABLE" }, manager)).toEqual({ kind: "NOT_READABLE" });
  });

  it("builds the links with encoded values", () => {
    expect(itemHref("p 1")).toBe("/retail/catalog/p%201");
    expect(newItemHref("0012/3")).toBe("/retail/catalog/new?barcode=0012%2F3&from=scan");
  });
});

// ---------------------------------------------------------------------------------------------
// Permission matrix in the interface

describe("permission matrix", () => {
  it("scanning (local lookup) follows the catalog roles, never the AI switch", () => {
    const shown = ROLES.filter((r) => scanEntry(scanRole(r)) === "SHOW");
    expect(shown.sort()).toEqual(["MANAGER", "OWNER", "STOCK"]);
  });

  it("the AI fallback needs ai.use + catalog.manage, the switch, consent and quota", () => {
    const can = ROLES.filter((r) => aiFallback(scanRole(r), status, false) === "SHOW");
    expect(can.sort()).toEqual(["MANAGER", "OWNER"]);
    for (const r of ["STOCK", "PURCHASING", "CASHIER", "ACCOUNTANT", "AUDITOR"] as const) {
      expect(aiFallback(scanRole(r), status, false), r).toBe("HIDE");
    }
    const owner = scanRole("OWNER");
    const manager = scanRole("MANAGER");
    expect(aiFallback(owner, { ...status, enabled: false }, false)).toBe("HIDE");
    expect(aiFallback(owner, "UNAVAILABLE", false)).toBe("HIDE");
    expect(aiFallback(owner, { ...status, consentCurrent: false }, false)).toBe("CONSENT_OWNER");
    expect(aiFallback(manager, { ...status, consentCurrent: false }, false)).toBe("CONSENT_ASK");
    expect(aiFallback(owner, { ...status, monthlyLimit: 0, limitHalfUnits: 0 }, false)).toBe("QUOTA_OUT");
    // One barcode read is half a unit: 19 of 20 used still leaves one.
    expect(aiFallback(owner, { ...status, usedHalfUnits: 19 }, false)).toBe("SHOW");
    expect(aiFallback(owner, { ...status, usedHalfUnits: 20 }, false)).toBe("QUOTA_OUT");
    expect(aiFallback(owner, status, true)).toBe("READ_ONLY");
  });

  it("every fallback state has its words in every language", () => {
    for (const t of [ar, ckb, en]) {
      for (const s of AI_FALLBACK_STATES) {
        if (s === "SHOW" || s === "HIDE") continue;
        expect(typeof t.catalog.scan.ai[s]).toBe("string");
      }
    }
  });

  it("the AI settings link: owner and manager while the switch is on; with it off only an owner with consent (to withdraw it)", () => {
    const shown = ROLES.filter((r) => aiSettingsLink(scanRole(r), status) === "SHOW");
    expect(shown.sort()).toEqual(["MANAGER", "OWNER"]);
    const off = { ...status, enabled: false };
    expect(aiSettingsLink(scanRole("OWNER"), off)).toBe("SHOW");
    expect(aiSettingsLink(scanRole("OWNER"), { ...off, consent: false, consentCurrent: false })).toBe("HIDE");
    expect(aiSettingsLink(scanRole("MANAGER"), off)).toBe("HIDE");
    expect(aiSettingsLink(scanRole("OWNER"), "UNAVAILABLE")).toBe("HIDE");
  });

  it("the settings page: owner grants and withdraws (withdraw also with the switch off or read-only), manager only views", () => {
    const owner = scanRole("OWNER");
    const manager = scanRole("MANAGER");
    expect(settingsView(owner, { ...status, consent: false, consentCurrent: false }, false)).toMatchObject({ access: "OK", grant: "SHOW", revoke: "HIDE" });
    expect(settingsView(owner, status, false)).toMatchObject({ access: "OK", grant: "HIDE", revoke: "SHOW" });
    expect(settingsView(owner, { ...status, enabled: false }, false)).toMatchObject({ grant: "HIDE", revoke: "SHOW" });
    expect(settingsView(owner, { ...status, enabled: false }, true)).toMatchObject({ revoke: "SHOW" });
    expect(settingsView(owner, { ...status, consentCurrent: false }, false)).toMatchObject({ grant: "SHOW", revoke: "SHOW" });
    expect(settingsView(owner, { ...status, consent: false, consentCurrent: false }, true)).toMatchObject({ grant: "READ_ONLY" });
    expect(settingsView(owner, { ...status, enabled: false, consent: false, consentCurrent: false }, false)).toMatchObject({ grant: "HIDE" });
    expect(settingsView(manager, { ...status, consent: false, consentCurrent: false }, false)).toMatchObject({ access: "OK", grant: "HIDE", revoke: "HIDE" });
    for (const r of ["STOCK", "PURCHASING", "CASHIER", "ACCOUNTANT", "AUDITOR"] as const) {
      expect(settingsView(scanRole(r), status, false).access, r).toBe("NO_PERMISSION");
    }
    expect(settingsView(owner, "UNAVAILABLE", false).access).toBe("STATUS_FAILED");
  });

  it("consent state: current, given to an earlier text, or none", () => {
    expect(consentState(status)).toBe("CURRENT");
    expect(consentState({ ...status, consentCurrent: false })).toBe("OUTDATED");
    expect(consentState({ ...status, consent: false, consentCurrent: false })).toBe("NONE");
    expect(CONSENT_VERSION).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Usage

describe("usageView", () => {
  it("shows half units as reads, with what is left and the 80% warning", () => {
    expect(usageView({ ...status, usedHalfUnits: 15 })).toEqual({ used: 7.5, limit: 10, remaining: 2.5, percent: 75, warn: false, closed: false });
    expect(usageView({ ...status, usedHalfUnits: 16 })).toMatchObject({ used: 8, percent: 80, warn: true });
    expect(usageView({ ...status, usedHalfUnits: 25 })).toMatchObject({ remaining: 0, percent: 100, warn: true });
    expect(usageView({ ...status, monthlyLimit: 0, limitHalfUnits: 0 })).toMatchObject({ closed: true, warn: false, percent: 0 });
  });
});

// ---------------------------------------------------------------------------------------------
// The AI read's idempotency key

describe("readAttempt", () => {
  it("keeps the key for the same photo after no answer, a new key for a new photo", () => {
    let n = 0;
    const make = () => `k${++n}`;
    const a = readAttempt(null, "still-1", make);
    expect(readAttempt(a, "still-1", make)).toBe(a);
    expect(readAttempt(a, "still-2", make).key).not.toBe(a.key);
  });
});

// ---------------------------------------------------------------------------------------------
// Decoding constants

describe("decoding", () => {
  it("reads the retail formats and keeps the photo small", () => {
    for (const f of ["ean_13", "ean_8", "upc_a", "upc_e"]) expect(DECODE_FORMATS.detector).toContain(f);
    for (const f of ["EAN-13", "EAN-8", "UPC-A", "UPC-E"]) expect(DECODE_FORMATS.zxing).toContain(f);
    expect(SCAN_IMAGE_SIDE).toBeLessThanOrEqual(1800);
  });
});

// ---------------------------------------------------------------------------------------------
// Messages

function leafKeys(tree: unknown, prefix = ""): string[] {
  if (typeof tree !== "object" || tree === null) return [prefix];
  return Object.entries(tree)
    .flatMap(([k, v]) => leafKeys(v, prefix ? `${prefix}.${k}` : k))
    .sort();
}

function expectParity(pick: (t: typeof ar) => unknown, min: number) {
  const keys = leafKeys(pick(ar));
  expect(keys.length).toBeGreaterThan(min);
  expect(leafKeys(pick(ckb as typeof ar))).toEqual(keys);
  expect(leafKeys(pick(en as typeof ar))).toEqual(keys);
  for (const t of [ar, ckb, en]) {
    for (const leaf of keys) {
      const value = leaf.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], pick(t as typeof ar));
      expect(typeof value, leaf).toBe("string");
      expect((value as string).trim(), leaf).not.toBe("");
    }
  }
}

describe("scan and AI settings messages", () => {
  it("have the same keys in ar, ckb and en, every leaf a non-empty string", () => {
    expectParity((t) => t.catalog.scan, 40);
    expectParity((t) => t.aiSettings, 20);
    expect(en.catalog.scan.title).not.toBe(ar.catalog.scan.title);
    expect(ckb.catalog.scan.title).not.toBe(ar.catalog.scan.title);
  });

  it("every refusal the scan screen can meet reads in words, never as a code", () => {
    for (const t of [ar, ckb, en]) {
      for (const code of Object.keys(t.errors) as (keyof typeof t.errors)[]) {
        const { text } = scanFailure(t, { code }, "ar");
        expect(text, code).not.toContain(code);
        expect(text.trim()).not.toBe("");
      }
      expect(scanFailure(t, { code: "BAD_BARCODE" }, "ar").text).toBe(t.catalog.entry.badBarcode);
      // An unknown code reads as the generic error.
      expect(scanFailure(t, { code: "SOMETHING_NEW" as never }, "ar").text).toBe(t.internalError);
    }
  });

  it("a taken code names its owner with a link", () => {
    const r = scanFailure(en, { code: "BARCODE_TAKEN", details: { productId: "p9", productName: "شاي", productNameEn: "Tea" } }, "en");
    expect(r.text).toBe(en.errors.BARCODE_TAKEN);
    expect(r.owner).toEqual({ productId: "p9", name: "Tea" });
  });
});
