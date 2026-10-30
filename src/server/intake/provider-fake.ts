// Deterministic intake provider for unit and e2e tests. Its scenario comes from globalThis.__intakeFake
// (same process), else from the JSON file named by INTAKE_FAKE_FILE, read on every call (a separate
// `next dev` process, as in e2e, cannot see globalThis; a test switches scenarios by rewriting the
// file). The file is never read in production (getIntakeProvider never selects the fake there
// either). Whatever the scenario returns goes through the same strict schema as the real
// provider's output.
import { readFileSync } from "node:fs";
import {
  AiBadOutputError,
  AiUnavailableError,
  parseBarcodeResult,
  parseExtractedReceipt,
  type BarcodeResult,
  type ExtractedReceipt,
  type IntakeImage,
  type IntakeProvider,
} from "./provider";

export type IntakeFakeRequest = { kind: "receipt"; images: IntakeImage[] } | { kind: "barcode"; image: IntakeImage };
type FakeValue = ExtractedReceipt | BarcodeResult | Error;
export type IntakeFakeScenario = FakeValue | ((req: IntakeFakeRequest) => FakeValue | Promise<FakeValue>);

declare global {
  var __intakeFake: IntakeFakeScenario | undefined;
}

/** A valid EAN-13. */
export const FAKE_DEFAULT_BARCODE = "4006381333931";

export const FAKE_DEFAULT_RECEIPT: ExtractedReceipt = {
  supplier: "شركة النور للتجارة",
  date: "2026-10-30",
  currency: "IQD",
  receiptNo: "1001",
  total: "7000",
  lines: [
    {
      description: "شاي 500 غرام",
      barcode: FAKE_DEFAULT_BARCODE,
      quantity: "3",
      unitText: "كرتون",
      unitPrice: "1500",
      lineTotal: "4500",
      confidence: 0.95,
    },
    { description: "سكر 1 كغم", quantity: "2", unitText: "قطعة", unitPrice: "1250", lineTotal: "2500", confidence: 0.9 },
  ],
};

/** Waits `ms`; an abort ends the wait at once with AiUnavailableError("aborted"). */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new AiUnavailableError("aborted"));
      },
      { once: true },
    );
  });
}

/**
 * The scenario file (INTAKE_FAKE_FILE), outside production only. Its JSON is a receipt, a barcode
 * result ({"digits": ...}), {"error": "unavailable" | "bad-output"}, or any of these wrapped as
 * {"delayMs": n, "receipt" | "barcode": ...} for a slow read. No file: the defaults.
 */
async function fileScenario(signal: AbortSignal): Promise<FakeValue | undefined> {
  const path = process.env.INTAKE_FAKE_FILE;
  if (!path || process.env.NODE_ENV === "production") return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  let v = JSON.parse(text) as Record<string, unknown>;
  if (isObject(v) && typeof v.delayMs === "number") {
    await wait(Math.min(Math.max(0, v.delayMs), 120_000), signal);
    v = (v.receipt ?? v.barcode) as Record<string, unknown>;
  }
  if (isObject(v) && "error" in v) {
    if (v.error === "unavailable") return new AiUnavailableError("network");
    if (v.error === "bad-output") return new AiBadOutputError("schema");
    throw new TypeError(`INTAKE_FAKE_FILE: unknown error scenario ${JSON.stringify(v.error)}`);
  }
  return v as unknown as FakeValue;
}

/** The scenario value for this call and whether it is a fixed one (not a function's answer). */
async function resolve(req: IntakeFakeRequest, signal: AbortSignal): Promise<{ value: unknown; fixed: boolean }> {
  if (signal.aborted) throw new AiUnavailableError("aborted");
  const s = globalThis.__intakeFake;
  const value = typeof s === "function" ? await s(req) : s !== undefined ? s : await fileScenario(signal);
  if (value instanceof Error) throw value;
  return { value, fixed: typeof s !== "function" };
}

/** A wrong-shaped scenario is a test bug: fail loudly instead of quietly returning the default. */
function wrongShape(kind: "receipt" | "barcode", v: unknown): never {
  const shape = v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? `{${Object.keys(v as object).join(",")}}` : typeof v;
  throw new TypeError(`__intakeFake: ${kind} call got a wrong-shaped scenario (${shape})`);
}

const isObject = (v: unknown): v is object => typeof v === "object" && v !== null && !Array.isArray(v);

export function createFakeIntakeProvider(): IntakeProvider {
  return {
    async readReceipt(images, { signal }) {
      const { value: v, fixed } = await resolve({ kind: "receipt", images }, signal);
      if (v === undefined) return parseExtractedReceipt(FAKE_DEFAULT_RECEIPT);
      // A fixed barcode scenario serves barcode calls; receipt calls then use the default receipt.
      if (fixed && isObject(v) && "digits" in v) return parseExtractedReceipt(FAKE_DEFAULT_RECEIPT);
      if (!isObject(v) || "digits" in v) wrongShape("receipt", v);
      // Extra fields or too many lines are AiBadOutputError, as from the real provider.
      return parseExtractedReceipt(v);
    },
    async readBarcode(image, { signal }) {
      const { value: v, fixed } = await resolve({ kind: "barcode", image }, signal);
      if (v === undefined) return parseBarcodeResult({ digits: FAKE_DEFAULT_BARCODE });
      // A fixed receipt scenario serves receipt calls; barcode calls then use the default digits.
      if (fixed && isObject(v) && "lines" in v) return parseBarcodeResult({ digits: FAKE_DEFAULT_BARCODE });
      if (!isObject(v) || !("digits" in v)) wrongShape("barcode", v);
      return parseBarcodeResult(v);
    },
  };
}
