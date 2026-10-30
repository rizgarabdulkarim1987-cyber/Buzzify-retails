import { describe, expect, it, vi } from "vitest";

/*
 * The status route when the intake service throws (a database failure, a bug): a safe JSON failure,
 * never cached, instead of an unhandled 500. Nothing of the error reaches the answer.
 */

const metaFault = vi.hoisted(() => ({ on: false }));
vi.mock("@/app/retail/catalog/_lib/call", () => ({
  metaFor: async () => {
    if (metaFault.on) throw new Error("session store down: secret-host");
    return { userId: "u", businessId: "b", idempotencyKey: "" };
  },
}));
vi.mock("@/server/intake/receipts", () => ({
  getIntake: async () => {
    throw new Error("connection refused: secret-host:5432");
  },
}));

const { GET } = await import("../../src/app/retail/stock/receive/photo/[intakeId]/status/route");

describe("the status route when the service throws", () => {
  it("answers a JSON INTERNAL failure (private, no-store) and logs the class name only", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const intakeId = "7f1d1c6e-6a3c-4a51-9a39-3c6b8f0b2a11";
      const res = await GET(new Request(`http://x/retail/stock/receive/photo/${intakeId}/status`), { params: Promise.resolve({ intakeId }) });
      expect(res.status).toBe(503);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ ok: false, code: "INTERNAL" });
      expect(text).not.toContain("secret-host");
      expect(spy).toHaveBeenCalledWith("[intake.status] unexpected failure: Error");
    } finally {
      spy.mockRestore();
    }
  });

  it("a failure while resolving the session is the same JSON INTERNAL answer", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    metaFault.on = true;
    try {
      const intakeId = "7f1d1c6e-6a3c-4a51-9a39-3c6b8f0b2a11";
      const res = await GET(new Request(`http://x/retail/stock/receive/photo/${intakeId}/status`), { params: Promise.resolve({ intakeId }) });
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ ok: false, code: "INTERNAL" });
      expect(text).not.toContain("secret-host");
    } finally {
      metaFault.on = false;
      spy.mockRestore();
    }
  });
});
