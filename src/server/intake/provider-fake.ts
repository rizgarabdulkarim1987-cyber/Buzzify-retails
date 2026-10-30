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

export function createFakeIntakeProvider(): IntakeProvider {
  return {
    async readReceipt(images, { signal }) {
      const v = await resolve({ kind: "receipt", images }, signal);
      return parseExtractedReceipt(v && typeof v === "object" && !("digits" in v) ? v : FAKE_DEFAULT_RECEIPT);
    },
    async readBarcode(image, { signal }) {
      const v = await resolve({ kind: "barcode", image }, signal);
      return parseBarcodeResult(v && typeof v === "object" && "digits" in v ? v : { digits: FAKE_DEFAULT_BARCODE });
    },
  };
}
