import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClaudeIntakeProvider } from "@/server/intake/provider-claude";
import { AiUnavailableError } from "@/server/intake/provider";
import { createFakeCoreClient, setCoreClientFake } from "@/server/core/client-fake";
import { resetCoreKeyCache } from "@/server/core/client";

const IMAGE = { contentType: "image/png", bytes: new Uint8Array([1, 2, 3]) };
const ENV = ["CORE_BASE_URL", "ANTHROPIC_API_KEY", "INTAKE_MODEL"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  resetCoreKeyCache();
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setCoreClientFake(undefined);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function mockFetch() {
  const m = vi.fn(
    async () => new Response(JSON.stringify({ content: [{ type: "tool_use", name: "record_barcode", input: { digits: "4006381333931" } }], stop_reason: "tool_use" }), { status: 200 }),
  );
  vi.stubGlobal("fetch", m);
  return m;
}
const read = () => createClaudeIntakeProvider().readBarcode(IMAGE, { signal: new AbortController().signal }).catch((e: unknown) => e);

describe("provider key from Studio", () => {
  it("sends Studio's key and model", async () => {
    process.env.CORE_BASE_URL = "https://studio.example";
    process.env.INTAKE_MODEL = "m-env";
    setCoreClientFake({ ...createFakeCoreClient(), getAiConfig: async () => ({ apiKey: "studio-key", model: "m-studio" }) });
    const f = mockFetch();
    await read();
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("studio-key");
    expect(JSON.parse(init.body as string).model).toBe("m-studio");
  });

  it("uses INTAKE_MODEL when Studio gives no model", async () => {
    process.env.CORE_BASE_URL = "https://studio.example";
    process.env.INTAKE_MODEL = "m-env";
    setCoreClientFake({ ...createFakeCoreClient(), getAiConfig: async () => ({ apiKey: "studio-key", model: null }) });
    const f = mockFetch();
    await read();
    expect(JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).model).toBe("m-env");
  });

  it("production with no Studio value throws AiUnavailableError(config) and calls no provider", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.CORE_BASE_URL = "https://studio.example";
    process.env.ANTHROPIC_API_KEY = "env-key";
    const f = vi.fn(async () => new Response("x", { status: 500 }));
    vi.stubGlobal("fetch", f);
    const err = await read();
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect((err as AiUnavailableError).reason).toBe("config");
    expect(f.mock.calls.every((c) => !String((c as unknown as [string])[0]).includes("anthropic"))).toBe(true);
  });
});
