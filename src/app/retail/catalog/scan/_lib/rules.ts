import type { RtRole } from "@/generated/prisma/enums";
import type { Locale, Messages } from "@/messages";
import { normalizeBarcode } from "@/server/domain/catalog";
import { can } from "@/server/domain/permissions";
import type { BarcodeRead } from "@/server/intake/barcode";
import type { AiStatus } from "@/server/intake/quota";
import { nextAttempt } from "../../../stock/_lib/receipt-rules";
import { intakeFailureMessage } from "../../../stock/receive/photo/_lib/rules";
import { failureMessage, ownerOfBarcode } from "../../_lib/failures";
import type { UiFailure } from "../../_lib/types";

/*
 * The barcode scan screen's and the AI settings page's rules, kept out of the components so they
 * can be tested: what a typed or scanned code becomes, how a USB scanner's keys are told apart
 * from a person typing, what a lookup answer shows, who sees which control, and how the month's
 * use reads. The server decides all of it again (lookupBarcode, readBarcodeFromImage, addBarcode,
 * grant/revokeAiConsent).
 */

// ---------------------------------------------------------------------------------------------
// Codes and the keyboard-wedge scanner

/** A typed or scanned code as R1 stores it (Arabic-Indic / Persian digits to ASCII, trimmed), or null when it cannot be one. */
export function normalizeScan(text: string): string | null {
  try {
    return normalizeBarcode(text);
  } catch {
    return null;
  }
}

/** A USB scanner types a whole code within a few ms per key; a person is slower. */
export const WEDGE_GAP_MS = 60;
/** Shorter bursts are not taken as a scan (a stray key and Enter). */
export const WEDGE_MIN_LENGTH = 4;

export type WedgeState = { buffer: string; last: number };
export const emptyWedge = (): WedgeState => ({ buffer: "", last: 0 });

const MODIFIERS = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta", "CapsLock"]);

/**
 * One key pressed while no field has the focus (`at` in ms). Fast printable keys build a burst; a
 * pause starts a new one; Enter ends it and returns the code when the burst was long enough. Any
 * other key drops the burst; a modifier leaves it as it is.
 */
export function wedgeKey(state: WedgeState, key: string, at: number): { state: WedgeState; code: string | null } {
  if (MODIFIERS.has(key)) return { state, code: null };
  if (key === "Enter") {
    const code = state.buffer.length >= WEDGE_MIN_LENGTH ? normalizeScan(state.buffer) : null;
    return { state: emptyWedge(), code };
  }
  if ([...key].length !== 1) return { state: emptyWedge(), code: null };
  const continues = state.buffer !== "" && at - state.last <= WEDGE_GAP_MS;
  return { state: { buffer: (continues ? state.buffer : "") + key, last: at }, code: null };
}

// ---------------------------------------------------------------------------------------------
// Roles

export type ScanRole = {
  /** May look a code up (stock.view or catalog.manage). */
  canLookup: boolean;
  /** catalog.manage: link a code, make a new item, read with AI. */
  canManage: boolean;
  canUseAi: boolean;
  /** ai.consent: the owner. */
  isOwner: boolean;
  /** Runs the business with the owner (staff.manage): sees the AI settings. */
  isManager: boolean;
};

export function scanRole(role: RtRole): ScanRole {
  return {
    canLookup: can(role, "stock.view") || can(role, "catalog.manage"),
    canManage: can(role, "catalog.manage"),
    canUseAi: can(role, "ai.use"),
    isOwner: can(role, "ai.consent"),
    isManager: can(role, "staff.manage"),
  };
}

/** The AI status as a page loaded it; UNAVAILABLE when it could not be read (or was not loaded for this role). */
export type ScanStatus = Pick<AiStatus, "enabled" | "consent" | "consentCurrent" | "monthlyLimit" | "limitHalfUnits" | "usedHalfUnits" | "warn">;
export type LoadedScanStatus = ScanStatus | "UNAVAILABLE";

/** The scan link (home card, catalog page): the catalog roles, whatever the AI switch says (the camera decodes locally). */
export function scanEntry(role: ScanRole): "SHOW" | "HIDE" {
  return role.canManage ? "SHOW" : "HIDE";
}

export const AI_FALLBACK_STATES = ["SHOW", "HIDE", "CONSENT_OWNER", "CONSENT_ASK", "QUOTA_OUT", "READ_ONLY"] as const;
export type AiFallback = (typeof AI_FALLBACK_STATES)[number];

/**
 * "Read with AI" when the camera could not decode: ai.use + catalog.manage and the switch on, else
 * nothing at all (no button, no hint). Then consent (the owner is sent to the settings, others are
 * told to ask the owner), the quota (half a read), and a read-only business.
 */
export function aiFallback(role: ScanRole, status: LoadedScanStatus, readOnly: boolean): AiFallback {
  if (!role.canUseAi || !role.canManage) return "HIDE";
  if (status === "UNAVAILABLE" || !status.enabled) return "HIDE";
  if (!status.consentCurrent) return role.isOwner ? "CONSENT_OWNER" : "CONSENT_ASK";
  if (status.monthlyLimit <= 0 || status.usedHalfUnits + 1 > status.limitHalfUnits) return "QUOTA_OUT";
  if (readOnly) return "READ_ONLY";
  return "SHOW";
}

/**
 * The AI settings link: owner and manager while the switch is on. With it off the page matters only
 * to an owner who consented earlier (withdrawing is always allowed); a status not read is not shown.
 */
export function aiSettingsLink(role: ScanRole, status: LoadedScanStatus): "SHOW" | "HIDE" {
  if (!role.isOwner && !(role.isManager && role.canUseAi)) return "HIDE";
  if (status === "UNAVAILABLE") return "HIDE";
  if (status.enabled) return "SHOW";
  return role.isOwner && status.consent ? "SHOW" : "HIDE";
}

export type ConsentState = "CURRENT" | "OUTDATED" | "NONE";

export function consentState(s: Pick<ScanStatus, "consent" | "consentCurrent">): ConsentState {
  if (s.consentCurrent) return "CURRENT";
  return s.consent ? "OUTDATED" : "NONE";
}

export type SettingsView =
  | { access: "NO_PERMISSION" | "STATUS_FAILED" }
  | { access: "OK"; grant: "SHOW" | "HIDE" | "READ_ONLY"; revoke: "SHOW" | "HIDE" };

/**
 * The AI settings page: the owner and the manager see it; only the owner grants (switch on, consent
 * not current) and withdraws (any consent, also with the switch off or read-only, ruling R1b-C).
 */
export function settingsView(role: ScanRole, status: LoadedScanStatus, readOnly: boolean): SettingsView {
  if (!role.isOwner && !(role.isManager && role.canUseAi)) return { access: "NO_PERMISSION" };
  if (status === "UNAVAILABLE") return { access: "STATUS_FAILED" };
  const grant = !role.isOwner || !status.enabled || status.consentCurrent ? "HIDE" : readOnly ? "READ_ONLY" : "SHOW";
  const revoke = role.isOwner && status.consent ? "SHOW" : "HIDE";
  return { access: "OK", grant, revoke };
}

export type UsageView = { used: number; limit: number; remaining: number; percent: number; warn: boolean; closed: boolean };

/** This month's use in reads (a receipt is one, an AI barcode read half), what is left, and the 80% warning. */
export function usageView(s: ScanStatus): UsageView {
  const limit = s.monthlyLimit;
  const used = s.usedHalfUnits / 2;
  const closed = s.limitHalfUnits <= 0;
  return {
    used,
    limit,
    remaining: Math.max(0, s.limitHalfUnits - s.usedHalfUnits) / 2,
    percent: closed ? 0 : Math.min(100, Math.round((s.usedHalfUnits / s.limitHalfUnits) * 100)),
    // The server's rule (getAiStatus.warn), worked out from the same numbers.
    warn: !closed && s.usedHalfUnits * 5 >= s.limitHalfUnits * 4,
    closed,
  };
}

// ---------------------------------------------------------------------------------------------
// Results

type Known = Extract<BarcodeRead, { status: "KNOWN" }>;

export type ScanOutcome =
  | { kind: "OPEN"; productId: string }
  | { kind: "KNOWN"; item: Known; archived: boolean; trial: boolean }
  | { kind: "UNKNOWN"; code: string; verified: boolean; canLink: boolean; canCreate: boolean }
  | { kind: "INVALID_CHECKSUM" }
  | { kind: "NOT_READABLE" };

/**
 * What a lookup or AI answer shows. A known item opens at once, unless it is archived or a trial
 * item: then it is shown with those flags first. An unknown code offers "link" and "new item" to
 * catalog managers, and says so when its check digit could not be verified.
 */
export function scanOutcome(r: BarcodeRead, role: ScanRole): ScanOutcome {
  switch (r.status) {
    case "KNOWN":
      return r.archived || r.isTestData ? { kind: "KNOWN", item: r, archived: r.archived, trial: r.isTestData } : { kind: "OPEN", productId: r.productId };
    case "UNKNOWN":
      return { kind: "UNKNOWN", code: r.code, verified: r.checked, canLink: role.canManage, canCreate: role.canManage };
    case "INVALID_CHECKSUM":
      return { kind: "INVALID_CHECKSUM" };
    case "NOT_READABLE":
      return { kind: "NOT_READABLE" };
  }
}

export const itemHref = (productId: string): string => `/retail/catalog/${encodeURIComponent(productId)}`;
/** The quick entry (R1) with the code filled in. */
export const newItemHref = (code: string): string => `/retail/catalog/new?barcode=${encodeURIComponent(code)}&from=scan`;

/**
 * The AI read's idempotency key: kept while the same photo is sent again after no answer (the
 * server answers that retry from the first attempt, without a second charge), new for a new photo.
 */
export function readAttempt(prev: { payload: string; key: string } | null, stillId: string, makeKey: () => string): { payload: string; key: string } {
  return nextAttempt(prev, `barcode-ai:${stillId}`, makeKey);
}

/** A refusal in words (the intake screens' mapping), and the owning item of a taken code. */
export function scanFailure(t: Messages, f: UiFailure, locale: Locale): { text: string; owner: { productId: string; name: string } | null } {
  // The catalog's own refusals (a code it could not take) keep the catalog's words.
  const text = String(f.code).startsWith("BAD_") ? failureMessage(t, f) : intakeFailureMessage(t, f, locale);
  return { text, owner: ownerOfBarcode(f, locale) };
}

// ---------------------------------------------------------------------------------------------
// Decoding

/** The formats asked of the decoders: the retail ones first, then what shops print on their own labels. */
export const DECODE_FORMATS = {
  detector: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf"],
  zxing: ["EAN-13", "EAN-8", "UPC-A", "UPC-E", "Code128", "Code39", "ITF"],
} as const;

/** The longest side of a barcode photo sent to the AI (the same shrink as receipt pages). */
export const SCAN_IMAGE_SIDE = 1600;
