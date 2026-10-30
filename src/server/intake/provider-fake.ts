// Deterministic intake provider for unit and e2e tests. Its scenario comes from globalThis.__intakeFake;
// whatever the scenario returns goes through the same strict schema as the real provider's output.
import {
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

async function resolve(req: IntakeFakeRequest, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) throw new AiUnavailableError("aborted");
  const s = globalThis.__intakeFake;
  const value = typeof s === "function" ? await s(req) : s;
  if (value instanceof Error) throw value;
  return value;
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
      const v = await resolve({ kind: "receipt", images }, signal);
      if (v === undefined) return parseExtractedReceipt(FAKE_DEFAULT_RECEIPT);
      // A fixed barcode scenario serves barcode calls; receipt calls then use the default receipt.
      if (globalThis.__intakeFake === v && isObject(v) && "digits" in v) return parseExtractedReceipt(FAKE_DEFAULT_RECEIPT);
      if (!isObject(v) || "digits" in v) wrongShape("receipt", v);
      // Extra fields or too many lines are AiBadOutputError, as from the real provider.
      return parseExtractedReceipt(v);
    },
    async readBarcode(image, { signal }) {
      const v = await resolve({ kind: "barcode", image }, signal);
      if (v === undefined) return parseBarcodeResult({ digits: FAKE_DEFAULT_BARCODE });
      // A fixed receipt scenario serves receipt calls; barcode calls then use the default digits.
      if (globalThis.__intakeFake === v && isObject(v) && "lines" in v) return parseBarcodeResult({ digits: FAKE_DEFAULT_BARCODE });
      if (!isObject(v) || !("digits" in v)) wrongShape("barcode", v);
      return parseBarcodeResult(v);
    },
  };
}
