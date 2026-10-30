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

/** Barcode digits in any script (ASCII, Arabic-Indic, Persian), as printed; null when unreadable. */
export const barcodeResultSchema = z.strictObject({
  digits: z
    .string()
    .regex(/^\p{Nd}{1,32}$/u)
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
  constructor(readonly reason: "no-tool-use" | "schema" | "truncated" | "malformed") {
    super(`AI provider output rejected (${reason})`);
    this.name = "AiBadOutputError";
  }
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

/** Fake under tests or INTAKE_PROVIDER=fake (e2e), else Claude. Never throws: a missing key fails per call. */
export function getIntakeProvider(): IntakeProvider {
  if (process.env.NODE_ENV === "test" || process.env.INTAKE_PROVIDER === "fake") return createFakeIntakeProvider();
  return createClaudeIntakeProvider();
}
