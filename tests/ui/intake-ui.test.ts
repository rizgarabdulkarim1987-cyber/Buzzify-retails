import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ar } from "@/messages/ar";
import { ckb } from "@/messages/ckb";
import { en } from "@/messages/en";
import { INTAKE_MAX_BYTES, INTAKE_MAX_IMAGES } from "@/server/domain/intake";
import { CONSENT_VERSION } from "@/server/intake/consent";
import type { IntakeView } from "@/server/intake/receipts";
import {
  DECODE_OPTIONS,
  JPEG_QUALITIES,
  MAX_PAGES,
  MAX_PAGE_BYTES,
  MAX_SIDE,
  PAGE_TARGET_BYTES,
  UPLOAD_BUDGET_BYTES,
  fitWithin,
  nextQuality,
  pageKind,
  pagesFingerprint,
  roomFor,
  uploadProblem,
} from "../../src/app/retail/stock/receive/photo/_lib/image";
import {
  LINE_REASONS,
  draftGate,
  focusAfter,
  intakeDto,
  intakeFailureMessage,
  isOpen,
  lineBadge,
  localDigits,
  lineChoices,
  newItemLines,
  photoAccess,
  photoLink,
  pollDelay,
  readGate,
  readingPlan,
  shownLines,
  type IntakeDto,
  type IntakeLineDto,
} from "../../src/app/retail/stock/receive/photo/_lib/rules";
import { DraftBar, LineBadge, ReasonList, TotalBar } from "../../src/app/retail/stock/receive/photo/_lib/views";

const html = (el: ReactElement) => renderToStaticMarkup(el);

// ---------------------------------------------------------------------------------------------
// Downscale and upload rules

describe("photo downscale rules", () => {
  it("shares the server's limits", () => {
    expect(MAX_PAGES).toBe(INTAKE_MAX_IMAGES);
    expect(MAX_PAGE_BYTES).toBe(INTAKE_MAX_BYTES);
    expect(MAX_SIDE).toBe(1800);
    // All pages together, base64-encoded, stay inside the 8 MB Server Action body (next.config.ts).
    expect(Math.ceil(UPLOAD_BUDGET_BYTES / 3) * 4).toBeLessThan(8 * 1024 * 1024 - 64 * 1024);
    expect(PAGE_TARGET_BYTES * MAX_PAGES).toBeLessThanOrEqual(UPLOAD_BUDGET_BYTES);
  });

  it("keeps the longest side at or under 1800px, never enlarges, keeps the aspect", () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 1800, height: 1350 });
    expect(fitWithin(3000, 8000)).toEqual({ width: 675, height: 1800 });
    expect(fitWithin(1800, 1200)).toEqual({ width: 1800, height: 1200 });
    expect(fitWithin(1000, 500)).toEqual({ width: 1000, height: 500 });
    expect(fitWithin(9000, 3)).toEqual({ width: 1800, height: 1 });
    expect(fitWithin(0, 0)).toEqual({ width: 1, height: 1 });
  });

  it("reads EXIF orientation when decoding (a portrait phone photo stays upright)", () => {
    expect(DECODE_OPTIONS.imageOrientation).toBe("from-image");
  });

  it("lowers the JPEG quality step by step until the page fits its share", () => {
    expect(JPEG_QUALITIES[0]).toBeGreaterThan(JPEG_QUALITIES[JPEG_QUALITIES.length - 1]!);
    expect(nextQuality(JPEG_QUALITIES[0]!, PAGE_TARGET_BYTES)).toBeNull();
    expect(nextQuality(JPEG_QUALITIES[0]!, PAGE_TARGET_BYTES + 1)).toBe(JPEG_QUALITIES[1]);
    expect(nextQuality(JPEG_QUALITIES[JPEG_QUALITIES.length - 1]!, PAGE_TARGET_BYTES * 3)).toBeNull();
  });

  it("knows what it can send", () => {
    expect(pageKind("image/jpeg", "a.jpg")).toBe("image");
    expect(pageKind("image/heic", "a.heic")).toBe("image");
    expect(pageKind("application/pdf", "a.pdf")).toBe("pdf");
    expect(pageKind("", "scan.PDF")).toBe("pdf");
    expect(pageKind("text/plain", "a.txt")).toBeNull();
    expect(pageKind("image/gif", "a.gif")).toBeNull();
  });

  it("caps the pages at six and the bytes at the budget", () => {
    expect(roomFor(0, 3)).toEqual({ take: 3, dropped: 0 });
    expect(roomFor(4, 5)).toEqual({ take: 2, dropped: 3 });
    expect(roomFor(6, 1)).toEqual({ take: 0, dropped: 1 });
    expect(uploadProblem([])).toBe("NO_PAGES");
    expect(uploadProblem([{ size: 1000 }])).toBeNull();
    expect(uploadProblem(Array.from({ length: 7 }, () => ({ size: 10 })))).toBe("TOO_MANY");
    expect(uploadProblem([{ size: UPLOAD_BUDGET_BYTES }, { size: 1 }])).toBe("TOO_LARGE");
    expect(uploadProblem([{ size: 0 }])).toBe("TOO_LARGE");
  });

  it("ties the idempotency payload to the pages: same pages, same key; any change, a new one", () => {
    const a = pagesFingerprint([{ id: "p1" }, { id: "p2" }]);
    expect(pagesFingerprint([{ id: "p1" }, { id: "p2" }])).toBe(a);
    expect(pagesFingerprint([{ id: "p2" }, { id: "p1" }])).not.toBe(a);
    expect(pagesFingerprint([{ id: "p1" }])).not.toBe(a);
  });
});

// ---------------------------------------------------------------------------------------------
// Review rules

const line = (over: Partial<IntakeLineDto> = {}): IntakeLineDto => ({
  lineNo: 1,
  description: "شاي",
  quantity: "٣",
  status: "SUGGESTED",
  candidates: [],
  reasons: [],
  confirmed: false,
  resolved: false,
  discarded: false,
  ...over,
});

const dto = (over: Partial<IntakeDto> = {}): IntakeDto => ({
  id: "i1",
  status: "READ",
  version: 3,
  pageCount: 1,
  duplicateOf: null,
  stockDocumentId: null,
  failureCode: null,
  createdAt: "2026-10-30T10:00:00.000Z",
  seesCost: true,
  receiptCurrency: "IQD",
  totalOk: true,
  totalAcknowledged: false,
  lines: [],
  ...over,
});

const view = (lines: IntakeView["result"] extends infer R ? (R extends { lines: infer L } ? L : never) : never): IntakeView => ({
  id: "i1",
  status: "READ",
  createdAt: new Date("2026-10-30T10:00:00Z"),
  createdById: "u1",
  failureCode: null,
  version: 2,
  readingStartedAt: null,
  pageCount: 2,
  duplicateOf: null,
  stockDocumentId: null,
  result: {
    supplier: "النور",
    total: "987654",
    currency: "IQD",
    receiptCurrency: "IQD",
    totalCheck: { ok: false },
    totalAcknowledged: false,
    lines,
  },
});

const gate = { hydrated: true, readOnly: false, busy: false };

describe("intake review rules", () => {
  it("turns the server view into a plain DTO, with no price for a caller without cost.view", () => {
    const v = view([
      {
        lineNo: 1,
        description: "شاي",
        quantity: "3",
        unitPrice: "123457",
        printedUnitPrice: "223457",
        priceFromTotal: true,
        lineTotal: "370371",
        confidence: 0.9,
        status: "MATCHED",
        variantId: "v1",
        unitId: "u1",
        source: "BARCODE",
        notes: [],
        reasons: [],
        confirmed: false,
        resolved: true,
        discarded: false,
      },
    ]);
    const full = intakeDto(v, true);
    expect(full.createdAt).toBe("2026-10-30T10:00:00.000Z");
    expect(full.lines[0]).toMatchObject({ unitPrice: "123457", lineTotal: "370371", printedUnitPrice: "223457", candidates: [] });
    expect(full.total).toBe("987654");
    const blind = intakeDto(v, false);
    const text = JSON.stringify(blind);
    for (const price of ["123457", "223457", "370371", "987654"]) expect(text).not.toContain(price);
    expect(blind.seesCost).toBe(false);
    // A view with no result yet (UPLOADED / READING / FAILED) still has a shape.
    expect(intakeDto({ ...v, status: "READING", result: null }, true)).toMatchObject({ status: "READING", lines: [], receiptCurrency: null });
  });

  it("names each line's state in words, never by colour alone", () => {
    expect(lineBadge(line({ status: "MATCHED", resolved: true }))).toEqual({ kind: "MATCHED", tone: "accent" });
    expect(lineBadge(line({ status: "SUGGESTED" }))).toEqual({ kind: "SUGGESTED", tone: "warn" });
    expect(lineBadge(line({ status: "UNKNOWN" }))).toEqual({ kind: "UNKNOWN", tone: "warn" });
    expect(lineBadge(line({ status: "DOUBTFUL" }))).toEqual({ kind: "DOUBTFUL", tone: "danger" });
    expect(lineBadge(line({ status: "DOUBTFUL", discarded: true, resolved: true }))).toEqual({ kind: "DISCARDED", tone: null });
    for (const t of [ar, ckb, en]) for (const k of ["MATCHED", "SUGGESTED", "UNKNOWN", "DOUBTFUL", "DISCARDED"] as const) {
      expect(html(createElement(LineBadge, { t, line: line(k === "DISCARDED" ? { discarded: true } : { status: k }) }))).toContain(t.stock.intake.badge[k]);
    }
  });

  it("filters to the lines still waiting for a decision", () => {
    const lines = [
      line({ lineNo: 1, status: "MATCHED", resolved: true }),
      line({ lineNo: 2, status: "DOUBTFUL" }),
      line({ lineNo: 3, discarded: true, resolved: true }),
      line({ lineNo: 4, status: "UNKNOWN" }),
    ];
    expect(lines.filter(isOpen).map((l) => l.lineNo)).toEqual([2, 4]);
    expect(shownLines(lines, true).map((l) => l.lineNo)).toEqual([2, 4]);
    expect(shownLines(lines, false).map((l) => l.lineNo)).toEqual([1, 2, 3, 4]);
  });

  it("disables “create the draft” with the first reason, in the server's order", () => {
    const open = line({ lineNo: 2, status: "DOUBTFUL" });
    const done = line({ lineNo: 1, status: "MATCHED", resolved: true });
    expect(draftGate({ ...gate, hydrated: false }, dto({ lines: [done] }))).toEqual({ ok: false, reason: "LOADING" });
    expect(draftGate(gate, dto({ status: "DRAFTED", stockDocumentId: "d1", lines: [done] }))).toEqual({ ok: false, reason: "DONE" });
    expect(draftGate({ ...gate, readOnly: true }, dto({ lines: [done] }))).toEqual({ ok: false, reason: "READ_ONLY" });
    expect(draftGate({ ...gate, busy: true }, dto({ lines: [done] }))).toEqual({ ok: false, reason: "BUSY" });
    expect(draftGate(gate, dto({ receiptCurrency: null, lines: [open] }))).toEqual({ ok: false, reason: "CURRENCY" });
    expect(draftGate(gate, dto({ lines: [done, open, line({ lineNo: 5 })] }))).toEqual({ ok: false, reason: "UNRESOLVED", count: 2, lineNo: 2 });
    expect(draftGate(gate, dto({ totalOk: false, lines: [done] }))).toEqual({ ok: false, reason: "TOTAL" });
    expect(draftGate(gate, dto({ totalOk: false, totalAcknowledged: true, lines: [done] }))).toEqual({ ok: true });
    expect(draftGate(gate, dto({ lines: [line({ discarded: true, resolved: true })] }))).toEqual({ ok: false, reason: "EMPTY" });
    expect(draftGate(gate, dto({ status: "FAILED", lines: [] }))).toEqual({ ok: false, reason: "EMPTY" });
    expect(draftGate(gate, dto({ lines: [done] }))).toEqual({ ok: true });
  });

  it("after a decision, focus goes to the next open line, else to a safe summary (null)", () => {
    const lines = [line({ lineNo: 1 }), line({ lineNo: 2, status: "MATCHED", resolved: true }), line({ lineNo: 3 }), line({ lineNo: 4 })];
    expect(focusAfter(lines, 1)).toBe(3);
    expect(focusAfter(lines, 3)).toBe(4);
    expect(focusAfter(lines, 4)).toBe(1);
    expect(focusAfter([line({ lineNo: 1, resolved: true, status: "MATCHED" })], 1)).toBeNull();
    expect(focusAfter([], 1)).toBeNull();
  });

  it("offers only the decisions that fit the line", () => {
    const opts = { canCreateItems: true, hasCurrency: true };
    // An item and unit found: accept them (the unit picker beside the suggested item); never a new item.
    expect(lineChoices(line({ variantId: "v1", unitId: "u1" }), opts)).toMatchObject({ accept: true, createItem: false, useTotal: false, discard: true });
    // No item: candidates to pick from, or a new item for whoever may create one.
    expect(lineChoices(line({ status: "UNKNOWN", candidates: [{ variantId: "v2", nameAr: "شاي", sku: "S-1" }] }), opts)).toMatchObject({ accept: false, candidates: true, createItem: true });
    expect(lineChoices(line({ status: "UNKNOWN" }), { ...opts, canCreateItems: false }).createItem).toBe(false);
    // The total ÷ quantity price only with a readable total, a chosen currency and a price problem.
    expect(lineChoices(line({ lineTotal: "4500", reasons: ["PRICE_MISSING"] }), opts).useTotal).toBe(true);
    expect(lineChoices(line({ lineTotal: "4500", unitPrice: "1400", reasons: ["TOTAL_MISMATCH"] }), opts).useTotal).toBe(true);
    expect(lineChoices(line({ lineTotal: "4500", unitPrice: "1500", reasons: [] }), opts).useTotal).toBe(false);
    expect(lineChoices(line({ lineTotal: "4500", reasons: ["PRICE_MISSING"] }), { ...opts, hasCurrency: false }).useTotal).toBe(false);
    expect(lineChoices(line({ lineTotal: "4500", reasons: ["TOTAL_MISMATCH"], priceFromTotal: true }), opts).useTotal).toBe(false);
    // A discarded line is final: nothing more to do on it.
    expect(lineChoices(line({ discarded: true, resolved: true, variantId: "v1", unitId: "u1" }), opts)).toEqual({ accept: false, candidates: false, search: false, useTotal: false, createItem: false, discard: false });
  });

  it("collects the lines a new item can be made for (kept, no item), at most 50", () => {
    const lines = [
      line({ lineNo: 1, status: "UNKNOWN" }),
      line({ lineNo: 2, variantId: "v1" }),
      line({ lineNo: 3, status: "UNKNOWN", discarded: true, resolved: true }),
      ...Array.from({ length: 60 }, (_, i) => line({ lineNo: 10 + i, status: "UNKNOWN" })),
    ];
    const got = newItemLines(lines);
    expect(got[0]).toBe(1);
    expect(got).not.toContain(2);
    expect(got).not.toContain(3);
    expect(got).toHaveLength(50);
  });

  it("decides what the reading screen does and how often it asks", () => {
    expect(readingPlan("UPLOADED")).toBe("RUN");
    expect(readingPlan("READING")).toBe("POLL");
    expect(readingPlan("READ")).toBe("REVIEW");
    expect(readingPlan("DRAFTED")).toBe("REVIEW");
    expect(readingPlan("DISCARDED")).toBe("REVIEW");
    expect(readingPlan("FAILED")).toBe("FAILED");
    expect(pollDelay(0)).toBe(2000);
    expect(pollDelay(3)).toBeGreaterThan(pollDelay(0));
    expect(pollDelay(50)).toBe(5000);
  });

  it("shows a worked-out price in the interface digits", () => {
    expect(localDigits("ar", "1125")).toBe("١١٢٥");
    expect(localDigits("ckb", "12.50")).toBe("١٢٫٥٠");
    expect(localDigits("en", "12.50")).toBe("12.50");
  });

  it("gates the read button with a stated reason", () => {
    const base = { hydrated: true, processing: false, sending: false, pages: [{ size: 1000 }] };
    expect(readGate(base)).toEqual({ ok: true });
    expect(readGate({ ...base, hydrated: false })).toEqual({ ok: false, reason: "LOADING" });
    expect(readGate({ ...base, sending: true })).toEqual({ ok: false, reason: "SENDING" });
    expect(readGate({ ...base, processing: true })).toEqual({ ok: false, reason: "PROCESSING" });
    expect(readGate({ ...base, pages: [] })).toEqual({ ok: false, reason: "NO_PAGES" });
    expect(readGate({ ...base, pages: [{ size: UPLOAD_BUDGET_BYTES + 1 }] })).toEqual({ ok: false, reason: "TOO_LARGE" });
  });
});

describe("who sees the photo intake", () => {
  const all = { canUseAi: true, canReceive: true, seesCost: true, isOwner: true };
  const status = { enabled: true, consentCurrent: true, monthlyLimit: 50, limitHalfUnits: 100, usedHalfUnits: 10, warn: false };

  it("decides the photo page's state: permission, then the master switch, then consent, then quota", () => {
    expect(photoAccess({ ...all, seesCost: false }, status)).toBe("NO_PERMISSION");
    expect(photoAccess({ ...all, canReceive: false }, status)).toBe("NO_PERMISSION");
    expect(photoAccess({ ...all, canUseAi: false }, status)).toBe("NO_PERMISSION");
    expect(photoAccess(all, null)).toBe("DISABLED");
    expect(photoAccess(all, { ...status, enabled: false, consentCurrent: false })).toBe("DISABLED");
    expect(photoAccess(all, { ...status, consentCurrent: false })).toBe("CONSENT_OWNER");
    expect(photoAccess({ ...all, isOwner: false }, { ...status, consentCurrent: false })).toBe("CONSENT_ASK_OWNER");
    expect(photoAccess(all, { ...status, monthlyLimit: 0, limitHalfUnits: 0, usedHalfUnits: 0 })).toBe("QUOTA_CLOSED");
    expect(photoAccess(all, { ...status, usedHalfUnits: 99 })).toBe("QUOTA_OUT");
    expect(photoAccess(all, status)).toBe("OK");
  });

  it("shows the “from a receipt photo” button only when it can work; the owner learns why it is missing", () => {
    expect(photoLink(all, status)).toBe("SHOW");
    expect(photoLink(all, { ...status, consentCurrent: false })).toBe("SHOW");
    expect(photoLink(all, { ...status, enabled: false })).toBe("OWNER_HINT");
    expect(photoLink(all, null)).toBe("OWNER_HINT");
    expect(photoLink({ ...all, isOwner: false }, { ...status, enabled: false })).toBe("HIDE");
    expect(photoLink({ ...all, seesCost: false }, status)).toBe("HIDE");
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

const NEW_CODES = ["AI_DISABLED", "AI_CONSENT_REQUIRED", "AI_QUOTA_EXCEEDED", "AI_UNAVAILABLE", "AI_BAD_OUTPUT", "INTAKE_NOT_READABLE", "INTAKE_UNRESOLVED", "DUPLICATE_RECEIPT"] as const;

describe("intake messages", () => {
  it("has the same keys in ar, ckb and en, every leaf a non-empty string", () => {
    const keys = leafKeys(ar.stock.intake);
    expect(keys.length).toBeGreaterThan(80);
    expect(leafKeys(ckb.stock.intake)).toEqual(keys);
    expect(leafKeys(en.stock.intake)).toEqual(keys);
    for (const t of [ar, ckb, en]) {
      for (const leaf of keys) {
        const value = leaf.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], t.stock.intake);
        expect(typeof value).toBe("string");
        expect((value as string).trim()).not.toBe("");
      }
    }
    expect(en.stock.intake.title).not.toBe(ar.stock.intake.title);
    expect(ckb.stock.intake.title).not.toBe(ar.stock.intake.title);
  });

  it("has the consent text of the current version", () => {
    for (const t of [ar, ckb, en]) {
      const text = (t.stock.intake.consent as Record<string, string>)[`v${CONSENT_VERSION}`];
      expect(text && text.length).toBeGreaterThan(80);
    }
  });

  it("names every line reason in words", () => {
    for (const t of [ar, ckb, en]) {
      expect(Object.keys(t.stock.intake.reasons).sort()).toEqual([...LINE_REASONS].sort());
      const out = html(createElement(ReasonList, { t, reasons: [...LINE_REASONS] })).replaceAll("&#x27;", "'");
      for (const r of LINE_REASONS) {
        expect(out).not.toContain(r);
        expect(out).toContain(t.stock.intake.reasons[r]);
      }
    }
  });

  it("every new refusal and reason reads in the interface language, never as a code", () => {
    for (const t of [ar, ckb, en]) {
      for (const code of NEW_CODES) {
        const text = intakeFailureMessage(t, { code });
        expect(text).toBe(t.errors[code]);
        expect(text).not.toContain(code);
      }
      const cases = [
        { code: "INTAKE_UNRESOLVED", details: { reason: "TOTAL" } },
        { code: "INTAKE_UNRESOLVED", details: { reason: "CURRENCY" } },
        { code: "INTAKE_UNRESOLVED", details: { lineNo: "4" } },
        { code: "INVALID_INPUT", details: { reason: "STORAGE" } },
        { code: "INVALID_INPUT", details: { reason: "EMPTY" } },
        { code: "STOCK_RULE", details: { reason: "UNIT_NOT_OF_VARIANT" } },
        { code: "INVALID_INPUT", details: { lineNo: "2" } },
      ] as const;
      for (const f of cases) {
        const text = intakeFailureMessage(t, f, "en");
        for (const raw of ["TOTAL", "CURRENCY", "STORAGE", "EMPTY", "UNIT_NOT_OF_VARIANT", "INTAKE_UNRESOLVED", "INVALID_INPUT"]) expect(text).not.toContain(raw);
        expect(text.trim()).not.toBe("");
      }
      expect(intakeFailureMessage(t, { code: "INTAKE_UNRESOLVED", details: { reason: "TOTAL" } })).toBe(t.stock.intake.unresolved.TOTAL);
      expect(intakeFailureMessage(t, { code: "INVALID_INPUT", details: { reason: "STORAGE" } })).toBe(t.stock.intake.storageFull);
      expect(intakeFailureMessage(t, { code: "INTAKE_UNRESOLVED", details: { lineNo: "4" } }, "en")).toContain("4");
      // A stored failure code (a FAILED intake) that is not a known code still reads as words.
      expect(intakeFailureMessage(t, { code: "SOMETHING_ELSE" as never })).toBe(t.internalError);
      expect(intakeFailureMessage(t, { code: "INTERNAL" })).toBe(t.internalError);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Views and styles

describe("intake views", () => {
  it("the draft button is aria-disabled (never disabled) with its reason beside it", () => {
    for (const t of [ar, ckb, en]) {
      const blocked = html(createElement(DraftBar, { t, locale: "ar", gate: { ok: false, reason: "UNRESOLVED", count: 2, lineNo: 3 }, busy: false, onDraft: () => {} }));
      expect(blocked).toContain('aria-disabled="true"');
      expect(blocked).not.toMatch(/\sdisabled=""/);
      expect(blocked).toMatch(/aria-describedby="intake-draft-reason"/);
      expect(blocked).toContain('id="intake-draft-reason"');
      const ready = html(createElement(DraftBar, { t, locale: "ar", gate: { ok: true }, busy: false, onDraft: () => {} }));
      expect(ready).not.toContain("aria-disabled");
      expect(ready).toContain(t.stock.intake.review.draft);
    }
  });

  it("the total bar shows the printed total and offers to accept a difference", () => {
    const mismatch = html(createElement(TotalBar, { t: ar, intake: dto({ total: "٧٠٠٠", totalOk: false }), canAct: true, busy: false, onAccept: () => {} }));
    expect(mismatch).toContain("٧٠٠٠");
    expect(mismatch).toContain(ar.stock.intake.review.totalAccept);
    const accepted = html(createElement(TotalBar, { t: ar, intake: dto({ total: "٧٠٠٠", totalOk: false, totalAcknowledged: true }), canAct: true, busy: false, onAccept: () => {} }));
    expect(accepted).toContain(ar.stock.intake.review.totalAccepted);
    expect(accepted).not.toContain(ar.stock.intake.review.totalAccept + "<");
    expect(html(createElement(TotalBar, { t: ar, intake: dto({ totalOk: true }), canAct: true, busy: false, onAccept: () => {} }))).toContain(ar.stock.intake.review.totalNone);
  });

  it("uses no coloured side stripes (full quiet borders only)", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    const start = css.indexOf("/* Receipt photo intake");
    expect(start).toBeGreaterThan(0);
    const block = css.slice(start);
    expect(block).not.toMatch(/border-(inline-start|inline-end|left|right)\s*:/);
    expect(block).not.toMatch(/border-(inline-start|inline-end|left|right)-color/);
    for (const file of ["_lib/views.tsx", "photo-capture.tsx", "intake-review.tsx"]) {
      const src = readFileSync(`src/app/retail/stock/receive/photo/${file}`, "utf8");
      expect(src).not.toMatch(/border(Inline(Start|End)|Left|Right)/);
      // Every action button in these screens is aria-disabled, never the native disabled flag.
      expect(src).not.toMatch(/<button[^>]*\sdisabled=/);
    }
  });
});
