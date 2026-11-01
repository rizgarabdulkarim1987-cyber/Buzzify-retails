import { describe, expect, it, vi } from "vitest";

/* The scan screen's Server Actions refuse malformed input before any service call. */

const readBarcodeFromImage = vi.hoisted(() => vi.fn());
vi.mock("@/server/intake/barcode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/intake/barcode")>()),
  readBarcodeFromImage,
}));

const { scanReadImageAction } = await import("../../src/app/retail/catalog/actions");

describe("scanReadImageAction", () => {
  it.each([null, undefined, "x", 42])("refuses a %s input with INVALID_INPUT (no throw, no service call)", async (input) => {
    expect(await scanReadImageAction("k", input as never)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(readBarcodeFromImage).not.toHaveBeenCalled();
  });
});
