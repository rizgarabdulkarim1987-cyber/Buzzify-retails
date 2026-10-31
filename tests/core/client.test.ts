import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreClientError, createHttpCoreClient, getCoreClient, resetCoreKeyCache, resolveAnthropicKey } from "@/server/core/client";
import { createFakeCoreClient, setCoreClientFake } from "@/server/core/client-fake";
import { verifyRequest } from "@/server/core/signing";

const KEY = "sk-ant-studio-key-SECRET-123";
const ENV = ["CORE_BASE_URL", "CORE_OUT_SECRET", "CORE_SYNC_SECRET", "ANTHROPIC_API_KEY", "INTAKE_MODEL"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.CORE_BASE_URL = "https://studio.example/";
  process.env.CORE_OUT_SECRET = "out-secret-0123456789";
  process.env.CORE_SYNC_SECRET = "out-secret-0123456789";
  resetCoreKeyCache();
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setCoreClientFake(undefined);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const failing = (kind: "network" | "timeout" = "network") => async () => {
  throw new CoreClientError(kind);
};

describe("http core client", () => {
  it("signs GET ai-config over method, path and body (verifyRequest accepts it)", async () => {
    const fetchMock = vi.fn(async () => json({ apiKey: KEY, model: "m-1" }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await createHttpCoreClient().getAiConfig();
    expect(out).toEqual({ apiKey: KEY, model: "m-1" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://studio.example/api/retail/v1/ai-config");
    expect(init.method).toBe("GET");
    const headers = new Headers(init.headers);
    expect(verifyRequest({ method: "GET", path: "/api/retail/v1/ai-config", body: "", headers })).toEqual({ ok: true });
  });

  it("signs POST identities over the raw body", async () => {
    const fetchMock = vi.fn(async () => json({ coreUserId: "cu_1", created: true, emailVerified: true }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await createHttpCoreClient().ensureIdentity("a@b.co", "Ann");
    expect(out).toEqual({ coreUserId: "cu_1", created: true, emailVerified: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://studio.example/api/retail/v1/identities");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ email: "a@b.co", name: "Ann" });
    const headers = new Headers(init.headers);
    expect(verifyRequest({ method: "POST", path: "/api/retail/v1/identities", body: init.body as string, headers })).toEqual({ ok: true });
    // A tampered body no longer verifies.
    expect(verifyRequest({ method: "POST", path: "/api/retail/v1/identities", body: "{}", headers }).ok).toBe(false);
  });

  it("times out after 5 s with a typed error", async () => {
    // AbortSignal.timeout is not driven by fake timers: capture it and fire it by hand.
    const ctrl = new AbortController();
    const seen: number[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      seen.push(ms);
      return ctrl.signal;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_u: string, init: RequestInit) =>
          new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason))),
      ),
    );
    const p = createHttpCoreClient().getAiConfig().catch((e: unknown) => e);
    ctrl.abort(new DOMException("timed out", "TimeoutError"));
    const err = await p;
    expect(seen).toEqual([5_000]);
    expect(err).toBeInstanceOf(CoreClientError);
    expect((err as CoreClientError).kind).toBe("timeout");
  });

  it("rejects malformed Studio replies (zod) and non-2xx, carrying class and status only", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ apiKey: 5 })));
    const bad = await createHttpCoreClient().getAiConfig().catch((e: unknown) => e);
    expect((bad as CoreClientError).kind).toBe("schema");

    vi.stubGlobal("fetch", vi.fn(async () => json({ coreUserId: "", created: true, emailVerified: true })));
    expect(((await createHttpCoreClient().ensureIdentity("a@b.co").catch((e: unknown) => e)) as CoreClientError).kind).toBe("schema");

    vi.stubGlobal("fetch", vi.fn(async () => new Response(`leaked ${KEY}`, { status: 503 })));
    const http = (await createHttpCoreClient().getAiConfig().catch((e: unknown) => e)) as CoreClientError;
    expect(http.kind).toBe("http");
    expect(http.status).toBe(503);
    expect(JSON.stringify(http)).not.toContain(KEY);
    expect(http.message).not.toContain(KEY);
    expect(http.message).not.toContain("studio.example");
  });

  it("an identity reply without emailVerified is malformed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ coreUserId: "cu_1", created: true })));
    expect(((await createHttpCoreClient().ensureIdentity("a@b.co").catch((e: unknown) => e)) as CoreClientError).kind).toBe("schema");
  });

  it("does not follow redirects", async () => {
    const fetchMock = vi.fn(async () => json({ apiKey: KEY, model: null }));
    vi.stubGlobal("fetch", fetchMock);
    await createHttpCoreClient().getAiConfig();
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe("error");
  });

  it("HTTP 404 and apiKey null are the definitive no-key reply", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    expect(await createHttpCoreClient().getAiConfig()).toEqual({ apiKey: null, model: null });
    vi.stubGlobal("fetch", vi.fn(async () => json({ apiKey: null, model: null })));
    expect(await createHttpCoreClient().getAiConfig()).toEqual({ apiKey: null, model: null });
  });

  it("requires https for CORE_BASE_URL in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.CORE_BASE_URL = "http://studio.example";
    const fetchMock = vi.fn(async () => json({ apiKey: KEY, model: null }));
    vi.stubGlobal("fetch", fetchMock);
    const err = (await createHttpCoreClient().getAiConfig().catch((e: unknown) => e)) as CoreClientError;
    expect(err.kind).toBe("config");
    expect(fetchMock).not.toHaveBeenCalled();
    process.env.CORE_BASE_URL = "https://studio.example";
    expect((await createHttpCoreClient().getAiConfig()).apiKey).toBe(KEY);
  });

  it("network failure is typed and does not leak the URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed https://studio.example/api/retail/v1/ai-config?x=1");
      }),
    );
    const err = (await createHttpCoreClient().getAiConfig().catch((e: unknown) => e)) as CoreClientError;
    expect(err.kind).toBe("network");
    expect(err.message).not.toContain("studio.example");
  });
});

describe("getCoreClient", () => {
  it("is null in standalone mode and the fake is never used in production", () => {
    delete process.env.CORE_BASE_URL;
    expect(getCoreClient()).toBeNull();
    const fake = createFakeCoreClient();
    setCoreClientFake(fake);
    expect(getCoreClient()).toBe(fake);
    vi.stubEnv("NODE_ENV", "production");
    expect(getCoreClient()).toBeNull();
    process.env.CORE_BASE_URL = "https://studio.example";
    expect(getCoreClient()).not.toBe(fake);
    expect(getCoreClient()).not.toBeNull();
  });
});

describe("resolveAnthropicKey", () => {
  it("standalone (no CORE_BASE_URL) uses the env key as today, even in production", async () => {
    delete process.env.CORE_BASE_URL;
    process.env.ANTHROPIC_API_KEY = "env-key";
    process.env.INTAKE_MODEL = "m-env";
    expect(await resolveAnthropicKey()).toEqual({ apiKey: "env-key", model: "m-env" });
    vi.stubEnv("NODE_ENV", "production");
    expect(await resolveAnthropicKey()).toEqual({ apiKey: "env-key", model: "m-env" });
    delete process.env.ANTHROPIC_API_KEY;
    expect(await resolveAnthropicKey()).toBeNull();
  });

  it("caches for 60 s (one call for two requests), then re-fetches", async () => {
    vi.useFakeTimers();
    const getAiConfig = vi.fn(async () => ({ apiKey: KEY, model: null }));
    setCoreClientFake({ ...createFakeCoreClient(), getAiConfig });
    expect(await resolveAnthropicKey()).toEqual({ apiKey: KEY, model: null });
    expect(await resolveAnthropicKey()).toEqual({ apiKey: KEY, model: null });
    expect(getAiConfig).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_000);
    await resolveAnthropicKey();
    expect(getAiConfig).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await resolveAnthropicKey();
    expect(getAiConfig).toHaveBeenCalledTimes(2);
  });

  it("concurrent requests share one Studio call", async () => {
    const getAiConfig = vi.fn(async () => ({ apiKey: KEY, model: "m" }));
    setCoreClientFake({ ...createFakeCoreClient(), getAiConfig });
    await Promise.all([resolveAnthropicKey(), resolveAnthropicKey(), resolveAnthropicKey()]);
    expect(getAiConfig).toHaveBeenCalledTimes(1);
  });

  it("serves the last value, even stale, when Studio fails", async () => {
    vi.useFakeTimers();
    let fail = false;
    setCoreClientFake({
      ...createFakeCoreClient(),
      getAiConfig: async () => {
        if (fail) throw new CoreClientError("network");
        return { apiKey: KEY, model: "m" };
      },
    });
    await resolveAnthropicKey();
    fail = true;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(await resolveAnthropicKey()).toEqual({ apiKey: KEY, model: "m" });
  });

  it("outside production, with no cached value, falls back to the env key", async () => {
    process.env.ANTHROPIC_API_KEY = "env-key";
    setCoreClientFake({ ...createFakeCoreClient(), getAiConfig: failing("timeout") });
    expect(await resolveAnthropicKey()).toEqual({ apiKey: "env-key", model: null });
  });

  it("in production with no Studio value returns null, never the env key", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.ANTHROPIC_API_KEY = "env-key";
    process.env.CORE_BASE_URL = "https://studio.example";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 500 })));
    expect(await resolveAnthropicKey()).toBeNull();
  });

  it("never writes the key to the console or into an error message", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    vi.stubGlobal("fetch", vi.fn(async () => json({ apiKey: KEY, model: null })));
    await resolveAnthropicKey();
    vi.stubGlobal("fetch", vi.fn(async () => json({ apiKey: KEY, extra: 1, model: 7 })));
    resetCoreKeyCache();
    process.env.ANTHROPIC_API_KEY = "";
    await resolveAnthropicKey();
    const err = (await createHttpCoreClient().getAiConfig().catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(KEY);
    expect(JSON.stringify(err)).not.toContain(KEY);
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(KEY);
  });
  it("negative cache: after a failure Studio is skipped for 15 s and the stale value served", async () => {
    vi.useFakeTimers();
    let fail = false;
    const getAiConfig = vi.fn(async () => {
      if (fail) throw new CoreClientError("network");
      return { apiKey: KEY, model: "m" };
    });
    setCoreClientFake({ ...createFakeCoreClient(), getAiConfig });
    await resolveAnthropicKey();
    await vi.advanceTimersByTimeAsync(61_000);
    fail = true;
    expect((await resolveAnthropicKey())?.apiKey).toBe(KEY);
    expect(getAiConfig).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(14_000);
    await resolveAnthropicKey();
    expect(getAiConfig).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    await resolveAnthropicKey();
    expect(getAiConfig).toHaveBeenCalledTimes(3);
  });

  it("negative cache with no value: null in production for 15 s, env key outside it", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response("", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("NODE_ENV", "production"); // the real client: the fake is ignored in production
    expect(await resolveAnthropicKey()).toBeNull();
    expect(await resolveAnthropicKey()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(await resolveAnthropicKey()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("staleness is capped at 1 h: older than that is null in production, env outside", async () => {
    vi.useFakeTimers();
    let fail = false;
    setCoreClientFake({
      ...createFakeCoreClient(),
      getAiConfig: async () => {
        if (fail) throw new CoreClientError("network");
        return { apiKey: KEY, model: "m" };
      },
    });
    await resolveAnthropicKey();
    fail = true;
    await vi.advanceTimersByTimeAsync(59 * 60_000);
    expect((await resolveAnthropicKey())?.apiKey).toBe(KEY);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    process.env.ANTHROPIC_API_KEY = "env-key";
    expect((await resolveAnthropicKey())?.apiKey).toBe("env-key");
    vi.stubEnv("NODE_ENV", "production");
    expect(await resolveAnthropicKey()).toBeNull();
  });

  it("a definitive no-key reply clears the cache and returns null", async () => {
    vi.useFakeTimers();
    let none = false;
    setCoreClientFake({
      ...createFakeCoreClient(),
      getAiConfig: async () => (none ? { apiKey: null, model: null } : { apiKey: KEY, model: "m" }),
    });
    process.env.ANTHROPIC_API_KEY = "env-key";
    await resolveAnthropicKey();
    none = true;
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await resolveAnthropicKey()).toBeNull();
    // and it stays cleared: a later Studio failure does not resurrect the old key
    none = false;
    setCoreClientFake({ ...createFakeCoreClient(), getAiConfig: failing("network") });
    await vi.advanceTimersByTimeAsync(61_000);
    expect((await resolveAnthropicKey())?.apiKey).toBe("env-key");
  });

  it("a client that throws synchronously does not wedge the in-flight slot", async () => {
    let calls = 0;
    setCoreClientFake({
      ...createFakeCoreClient(),
      getAiConfig: (() => {
        calls++;
        if (calls === 1) throw new Error("sync boom");
        return Promise.resolve({ apiKey: KEY, model: null });
      }) as never,
    });
    process.env.ANTHROPIC_API_KEY = "env-key";
    expect((await resolveAnthropicKey())?.apiKey).toBe("env-key");
    vi.useFakeTimers({ now: Date.now() + 16_000 });
    expect((await resolveAnthropicKey())?.apiKey).toBe(KEY);
  });
});
