// AI intake provider port: the extracted-receipt schema, the provider interface, its errors and
// the selector. The model only proposes; this output is data and is checked again by the server.
import { z } from "zod";
import { INTAKE_MAX_LINES } from "@/server/domain/intake";
import { createFakeIntakeProvider } from "./provider-fake";
import { createClaudeIntakeProvider } from "./provider-claude";

const MAX_FIELD = 300; // generous bound for any one printed field
const optionalText = z.string().max(MAX_FIELD).optional();

/** One printed line, copied as written: digits and amounts are NOT normalised here. */
export const extractedLineSchema = z.strictObject({
  description: z.string().min(1).max(MAX_FIELD).describe("Item description exactly as printed"),
  barcode: optionalText.describe("Barcode digits exactly as printed, if a barcode is printed on the line"),
  quantity: z.string().min(1).max(MAX_FIELD).describe("Quantity exactly as printed"),
  unitText: optionalText.describe("Unit exactly as written (e.g. كرتون, pcs), if written"),
  unitPrice: optionalText.describe("Unit price exactly as printed, if printed"),
  lineTotal: optionalText.describe("Line total exactly as printed, if printed"),
  confidence: z.number().min(0).max(1).describe("Your confidence 0..1 that this line was read correctly"),
});

export const extractedReceiptSchema = z.strictObject({
  supplier: optionalText.describe("Supplier name as printed"),
  date: optionalText.describe("Receipt date as printed"),
  currency: optionalText.describe("Currency as printed (symbol, code or word)"),
  receiptNo: optionalText.describe("Receipt / invoice number as printed"),
  total: optionalText.describe("Receipt grand total as printed"),
  lines: z.array(extractedLineSchema).max(INTAKE_MAX_LINES).describe("Every item line, in printed order"),
});

/** Barcode digits as printed in ASCII, Arabic-Indic or Persian digits (what toAsciiDigits normalises); null when unreadable. */
export const barcodeResultSchema = z.strictObject({
  digits: z
    .string()
    .regex(/^[0-9٠-٩۰-۹]{1,32}$/)
    .nullable()
    .describe("Only the barcode digits as printed, or null if they cannot be read with certainty"),
});

export type ExtractedReceipt = z.infer<typeof extractedReceiptSchema>;
export type ExtractedLine = z.infer<typeof extractedLineSchema>;
export type BarcodeResult = z.infer<typeof barcodeResultSchema>;

export type IntakeImage = { contentType: string; bytes: Uint8Array };
export type IntakeCallOptions = { signal: AbortSignal };

export interface IntakeProvider {
  readReceipt(images: IntakeImage[], opts: IntakeCallOptions): Promise<ExtractedReceipt>;
  readBarcode(image: IntakeImage, opts: IntakeCallOptions): Promise<BarcodeResult>;
}

/** Provider could not be reached or refused (network, timeout, abort, HTTP error, no key). Maps to AI_UNAVAILABLE. */
/**
 * Why a call's signal ended it: a timeout (AbortSignal.timeout, whoever created it) or an abort.
 * The caller's own timeout signal reports TimeoutError, so it is logged as the timeout it is.
 */
export function abortReason(signal: AbortSignal): "timeout" | "aborted" {
  const r: unknown = signal.reason;
  return r instanceof Error && r.name === "TimeoutError" ? "timeout" : "aborted";
}

export class AiUnavailableError extends Error {
  readonly code = "AI_UNAVAILABLE" as const;
  constructor(
    readonly reason: "network" | "timeout" | "aborted" | "http" | "config" | "unsupported",
    readonly status?: number,
  ) {
    super(`AI provider unavailable (${reason}${status ? ` ${status}` : ""})`);
    this.name = "AiUnavailableError";
  }
}

/** Provider answered with output outside the schema. Maps to AI_BAD_OUTPUT. Never carries the output itself. */
export class AiBadOutputError extends Error {
  readonly code = "AI_BAD_OUTPUT" as const;
  constructor(readonly reason: "no-tool-use" | "schema" | "truncated" | "malformed" | "refusal") {
    super(`AI provider output rejected (${reason})`);
    this.name = "AiBadOutputError";
  }
}

/**
 * Logs a provider failure as `[intake.provider] <reason> <httpStatus|->`: the error class's reason and
 * the HTTP status only, never a body, key, image or model output.
 */
export function logProviderFailure(err: AiUnavailableError | AiBadOutputError): void {
  const status = err instanceof AiUnavailableError && err.status !== undefined ? String(err.status) : "-";
  console.error(`[intake.provider] ${err.reason} ${status}`);
}

export function parseExtractedReceipt(raw: unknown): ExtractedReceipt {
  const r = extractedReceiptSchema.safeParse(raw);
  if (!r.success) throw new AiBadOutputError("schema");
  return r.data;
}

export function parseBarcodeResult(raw: unknown): BarcodeResult {
  const r = barcodeResultSchema.safeParse(raw);
  if (!r.success) throw new AiBadOutputError("schema");
  return r.data;
}

/** Every call fails with AI_UNAVAILABLE (config): used when production is misconfigured to the fake. */
function misconfiguredProvider(): IntakeProvider {
  return {
    async readReceipt() {
      throw new AiUnavailableError("config");
    },
    async readBarcode() {
      throw new AiUnavailableError("config");
    },
  };
}

/**
 * Fake under tests, or INTAKE_PROVIDER=fake outside production (e2e on `next dev`), else Claude.
 * Production never selects the fake: there INTAKE_PROVIDER=fake fails closed per call.
 * Never throws: a missing key or bad configuration fails per call.
 */
export function getIntakeProvider(): IntakeProvider {
  const env = process.env.NODE_ENV;
  if (env === "test") return createFakeIntakeProvider();
  if (process.env.INTAKE_PROVIDER === "fake") {
    return env === "production" ? misconfiguredProvider() : createFakeIntakeProvider();
  }
  return createClaudeIntakeProvider();
}
