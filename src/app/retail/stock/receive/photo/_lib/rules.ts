import { formatNumber, type Locale, type Messages } from "@/messages";
import type { AiStatus } from "@/server/intake/quota";
import type { IntakeView } from "@/server/intake/receipts";
import { fill } from "../../../../../_lib/format";
import { receiptFailureMessage } from "../../../_lib/receipt-rules";
import type { Currency, StockFailure } from "../../../_lib/types";
import { MAX_PAGES, uploadProblem } from "./image";

/*
 * The receipt-photo screens' rules, kept out of the components so they can be tested: what the
 * browser receives of an intake (no price for a caller without cost.view), what each line may do,
 * why "create the draft" is not available yet, where focus goes after a decision, what the reading
 * screen does next, and how a refusal reads. The server decides all of it again.
 */

export type IntakeStatus = IntakeView["status"];
export type LineStatus = "MATCHED" | "SUGGESTED" | "UNKNOWN" | "DOUBTFUL";

/** Every reason a line can carry (src/server/intake/matching.ts LineReason). */
export const LINE_REASONS = [
  "BARCODE_IGNORED",
  "BARCODE_CHECKSUM",
  "ARCHIVED",
  "TEST_ITEM",
  "SERIAL_NOT_SUPPORTED",
  "ITEM_GONE",
  "UNIT_UNMATCHED",
  "UNIT_MISSING",
  "QTY_INVALID",
  "CURRENCY_UNKNOWN",
  "PRICE_MISSING",
  "TOTAL_MISMATCH",
  "UNREADABLE",
  "LOW_CONFIDENCE",
  "AMBIGUOUS",
] as const;
export type LineReason = (typeof LINE_REASONS)[number];

export type CandidateDto = { variantId: string; nameAr: string; sku: string };

/** One read line as the browser receives it. Printed values stay as printed. */
export type IntakeLineDto = {
  lineNo: number;
  description: string;
  barcode?: string;
  quantity: string;
  unitText?: string;
  unitPrice?: string;
  printedUnitPrice?: string;
  priceFromTotal?: boolean;
  lineTotal?: string;
  status: LineStatus;
  candidates: CandidateDto[];
  variantId?: string;
  unitId?: string;
  source?: "BARCODE" | "NAME" | "REVIEWER";
  reasons: string[];
  confirmed: boolean;
  resolved: boolean;
  discarded: boolean;
};

export type IntakeDto = {
  id: string;
  status: IntakeStatus;
  version: number;
  pageCount: number;
  duplicateOf: string | null;
  stockDocumentId: string | null;
  failureCode: string | null;
  createdAt: string;
  /** Prices below were kept (cost.view). */
  seesCost: boolean;
  supplier?: string;
  date?: string;
  currencyPrinted?: string;
  receiptNo?: string;
  total?: string;
  receiptCurrency: Currency | null;
  totalOk: boolean;
  totalAcknowledged: boolean;
  lines: IntakeLineDto[];
};

const opt = <K extends string, V>(key: K, value: V | undefined | null): { [P in K]?: V } =>
  (value === undefined || value === null ? {} : { [key]: value }) as { [P in K]?: V };

/** The server view as the browser receives it: dates as text, and no price for a caller without cost.view. */
export function intakeDto(v: IntakeView, seesCost: boolean): IntakeDto {
  const r = v.result;
  return {
    id: v.id,
    status: v.status,
    version: v.version,
    pageCount: v.pageCount,
    duplicateOf: v.duplicateOf,
    stockDocumentId: v.stockDocumentId,
    failureCode: v.failureCode,
    createdAt: v.createdAt.toISOString(),
    seesCost,
    ...opt("supplier", r?.supplier),
    ...opt("date", r?.date),
    ...opt("currencyPrinted", r?.currency),
    ...opt("receiptNo", r?.receiptNo),
    ...(seesCost ? opt("total", r?.total) : {}),
    receiptCurrency: r?.receiptCurrency ?? null,
    totalOk: r?.totalCheck.ok ?? true,
    totalAcknowledged: r?.totalAcknowledged ?? false,
    lines: (r?.lines ?? []).map(
      (l): IntakeLineDto => ({
        lineNo: l.lineNo,
        description: l.description,
        ...opt("barcode", l.barcode),
        quantity: l.quantity,
        ...opt("unitText", l.unitText),
        ...(seesCost
          ? { ...opt("unitPrice", l.unitPrice), ...opt("printedUnitPrice", l.printedUnitPrice), ...opt("lineTotal", l.lineTotal), ...opt("priceFromTotal", l.priceFromTotal) }
          : {}),
        status: l.status,
        candidates: (l.candidates ?? []).map((c) => ({ variantId: c.variantId, nameAr: c.nameAr, sku: c.sku })),
        ...opt("variantId", l.variantId),
        ...opt("unitId", l.unitId),
        ...opt("source", l.source),
        reasons: [...l.reasons],
        confirmed: l.confirmed,
        resolved: l.resolved,
        discarded: l.discarded,
      }),
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// Lines

export type BadgeKind = LineStatus | "DISCARDED";
export type BadgeTone = "accent" | "warn" | "danger" | null;

/** The line's state, said in words (the tone only repeats it). */
export function lineBadge(line: Pick<IntakeLineDto, "status" | "discarded">): { kind: BadgeKind; tone: BadgeTone } {
  if (line.discarded) return { kind: "DISCARDED", tone: null };
  switch (line.status) {
    case "MATCHED":
      return { kind: "MATCHED", tone: "accent" };
    case "DOUBTFUL":
      return { kind: "DOUBTFUL", tone: "danger" };
    default:
      return { kind: line.status, tone: "warn" };
  }
}

/** Still waiting for a decision (kept and not settled). */
export const isOpen = (line: Pick<IntakeLineDto, "discarded" | "resolved">): boolean => !line.discarded && !line.resolved;

/** "Doubtful only": the lines still waiting for a decision. */
export function shownLines<L extends Pick<IntakeLineDto, "discarded" | "resolved">>(lines: readonly L[], openOnly: boolean): L[] {
  return openOnly ? lines.filter(isOpen) : [...lines];
}

export type LineChoices = { accept: boolean; candidates: boolean; search: boolean; useTotal: boolean; createItem: boolean; discard: boolean };

/**
 * What the reviewer may do with a line. `accept` confirms the item found together with a unit
 * picked from its units (PICK_UNIT confirms the item too, so the item is shown beside the picker).
 * `useTotal` only with a readable total, a chosen currency and a price problem, and not twice.
 * A discarded line is final.
 */
export function lineChoices(
  line: Pick<IntakeLineDto, "discarded" | "variantId" | "candidates" | "lineTotal" | "reasons" | "priceFromTotal" | "unitPrice">,
  opts: { canCreateItems: boolean; hasCurrency: boolean },
): LineChoices {
  if (line.discarded) return { accept: false, candidates: false, search: false, useTotal: false, createItem: false, discard: false };
  const priceProblem = line.unitPrice === undefined || line.reasons.includes("TOTAL_MISMATCH");
  return {
    accept: line.variantId !== undefined,
    candidates: line.variantId === undefined && line.candidates.length > 0,
    search: true,
    useTotal: line.lineTotal !== undefined && opts.hasCurrency && line.priceFromTotal !== true && priceProblem,
    createItem: opts.canCreateItems && line.variantId === undefined,
    discard: true,
  };
}

/** At most this many new items in one "create the new items" (MAX_NEW_ITEMS on the server). */
export const MAX_NEW_ITEMS = 50;

/** The lines a new item can be made for: kept and without an item, the first 50. */
export function newItemLines(lines: readonly Pick<IntakeLineDto, "lineNo" | "discarded" | "variantId">[]): number[] {
  return lines
    .filter((l) => !l.discarded && l.variantId === undefined)
    .map((l) => l.lineNo)
    .slice(0, MAX_NEW_ITEMS);
}

/** After a decision on `lineNo`: the next open line (wrapping round), or null for the safe summary. */
export function focusAfter(lines: readonly Pick<IntakeLineDto, "lineNo" | "discarded" | "resolved">[], lineNo: number): number | null {
  const open = lines.filter(isOpen).map((l) => l.lineNo);
  if (open.length === 0) return null;
  return open.find((n) => n > lineNo) ?? open[0]!;
}

// ---------------------------------------------------------------------------------------------
// Gates

export type DraftBlock = "LOADING" | "DONE" | "READ_ONLY" | "BUSY" | "CURRENCY" | "UNRESOLVED" | "TOTAL" | "EMPTY";
export type DraftGate = { ok: true } | { ok: false; reason: Exclude<DraftBlock, "UNRESOLVED"> } | { ok: false; reason: "UNRESOLVED"; count: number; lineNo: number };

/** Whether "create the draft" may run, else its first reason (the server's order: currency, lines, total). */
export function draftGate(
  s: { hydrated: boolean; readOnly: boolean; busy: boolean },
  i: Pick<IntakeDto, "status" | "receiptCurrency" | "totalOk" | "totalAcknowledged" | "lines">,
): DraftGate {
  if (!s.hydrated) return { ok: false, reason: "LOADING" };
  if (i.status === "DRAFTED") return { ok: false, reason: "DONE" };
  if (s.readOnly) return { ok: false, reason: "READ_ONLY" };
  if (s.busy) return { ok: false, reason: "BUSY" };
  if (i.status !== "READ") return { ok: false, reason: "EMPTY" };
  if (i.receiptCurrency === null) return { ok: false, reason: "CURRENCY" };
  const open = i.lines.filter(isOpen);
  if (open.length > 0) return { ok: false, reason: "UNRESOLVED", count: open.length, lineNo: open[0]!.lineNo };
  if (!i.totalOk && !i.totalAcknowledged) return { ok: false, reason: "TOTAL" };
  if (!i.lines.some((l) => !l.discarded)) return { ok: false, reason: "EMPTY" };
  return { ok: true };
}

export type ReadBlock = "LOADING" | "SENDING" | "PROCESSING" | "NO_PAGES" | "TOO_MANY" | "TOO_LARGE";

/** Whether "read" may run, else why not (said beside the button). */
export function readGate(s: { hydrated: boolean; processing: boolean; sending: boolean; pages: readonly { size: number }[] }): { ok: true } | { ok: false; reason: ReadBlock } {
  if (!s.hydrated) return { ok: false, reason: "LOADING" };
  if (s.sending) return { ok: false, reason: "SENDING" };
  if (s.processing) return { ok: false, reason: "PROCESSING" };
  const problem = uploadProblem(s.pages);
  return problem ? { ok: false, reason: problem } : { ok: true };
}

export { MAX_PAGES };

// ---------------------------------------------------------------------------------------------
// Reading

/** What the screen of an intake does: start the read, wait for another attempt, show the review, or the failure. */
export function readingPlan(status: IntakeStatus): "RUN" | "POLL" | "REVIEW" | "FAILED" {
  switch (status) {
    case "UPLOADED":
      return "RUN";
    case "READING":
      return "POLL";
    case "FAILED":
      return "FAILED";
    default:
      return "REVIEW";
  }
}

/** The wait before the n-th status check (0-based): 2 s, growing to 5 s. */
export function pollDelay(n: number): number {
  return Math.min(5000, 2000 + Math.max(0, n) * 500);
}

// ---------------------------------------------------------------------------------------------
// Access

export type PhotoRole = { canUseAi: boolean; canReceive: boolean; seesCost: boolean; isOwner: boolean };
type Status = Pick<AiStatus, "enabled" | "consentCurrent" | "monthlyLimit" | "limitHalfUnits" | "usedHalfUnits">;

export type PhotoState = "NO_PERMISSION" | "DISABLED" | "CONSENT_OWNER" | "CONSENT_ASK_OWNER" | "QUOTA_CLOSED" | "QUOTA_OUT" | "OK";

/** The photo page's state: permission (ai.use + stock.receive + cost.view), the master switch, consent, then quota. */
export function photoAccess(role: PhotoRole, status: Status | null): PhotoState {
  if (!role.canUseAi || !role.canReceive || !role.seesCost) return "NO_PERMISSION";
  if (!status || !status.enabled) return "DISABLED";
  if (!status.consentCurrent) return role.isOwner ? "CONSENT_OWNER" : "CONSENT_ASK_OWNER";
  if (status.monthlyLimit <= 0) return "QUOTA_CLOSED";
  if (status.usedHalfUnits + 2 > status.limitHalfUnits) return "QUOTA_OUT";
  return "OK";
}

/**
 * The "from a receipt photo" button on the receiving screen: shown when the role may use it and
 * the switch is on (the photo page then explains consent or quota); with the switch off, the owner
 * sees one line saying it is not enabled for the shop, everyone else nothing.
 */
export function photoLink(role: PhotoRole, status: Status | null): "SHOW" | "OWNER_HINT" | "HIDE" {
  if (!role.canUseAi || !role.canReceive || !role.seesCost) return "HIDE";
  if (status?.enabled) return "SHOW";
  return role.isOwner ? "OWNER_HINT" : "HIDE";
}

/**
 * A value the server worked out (a price from total ÷ quantity is plain ASCII) in the interface
 * digits, like the printed values beside it; separators and the text otherwise unchanged.
 */
export function localDigits(locale: Locale, text: string): string {
  if (locale === "en") return text;
  return text.replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d))).replaceAll(".", "٫");
}

// ---------------------------------------------------------------------------------------------
// Messages

/** A refusal in the interface language (never a code), including the intake's own reasons. */
export function intakeFailureMessage(t: Messages, f: StockFailure, locale: Locale = "en"): string {
  const m = t.stock.intake;
  const reason = f.details?.reason;
  if (f.code === "INTAKE_UNRESOLVED") {
    if (reason === "TOTAL" || reason === "CURRENCY") return m.unresolved[reason];
    const n = Number(f.details?.lineNo);
    if (Number.isInteger(n) && n >= 1) return fill(m.unresolved.line, { n: formatNumber(locale, n) });
    return t.errors.INTAKE_UNRESOLVED;
  }
  if (f.code === "INVALID_INPUT" && reason === "STORAGE") return m.storageFull;
  if (f.code === "INVALID_INPUT" && reason === "EMPTY") return m.allDiscarded;
  if (f.code === "STOCK_RULE" && reason === "UNIT_NOT_OF_VARIANT") return m.unitNotOfItem;
  if (f.code !== "INTERNAL" && !Object.hasOwn(t.errors, f.code) && !String(f.code).startsWith("BAD_")) return t.internalError;
  return receiptFailureMessage(t, f, locale);
}
