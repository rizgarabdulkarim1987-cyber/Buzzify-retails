import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signRequest, verifyRequest } from "@/server/core/signing";
import { signHandoffForTests, verifyHandoff, type HandoffClaims } from "@/server/core/handoff";
import { CoreConfigError, coreConfig } from "@/server/core/config";
import { coreRateLimit, CORE_RATE_LIMIT } from "@/server/core/rate-limit";
import { useTestDb } from "../helpers/db";

const { db } = useTestDb();

const NOW = new Date("2026-11-01T10:00:00Z");
const at = (s: number) => new Date(NOW.getTime() + s * 1000);
const ENV = ["CORE_SYNC_SECRET", "CORE_SYNC_SECRET_PREVIOUS", "CORE_OUT_SECRET", "CORE_HANDOFF_SECRET", "CORE_HANDOFF_SECRET_PREVIOUS", "CORE_BASE_URL"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.CORE_SYNC_SECRET = "sync-secret-current";
  process.env.CORE_HANDOFF_SECRET = "handoff-secret-current";
  process.env.CORE_OUT_SECRET = "out-secret-0123456789";
  process.env.CORE_BASE_URL = "https://studio.example";
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const BODY = JSON.stringify({ a: 1 });
function req(over: Partial<{ method: string; path: string; body: string }> = {}, h?: Record<string, string>, secret = "sync-secret-current", when = NOW) {
  const headers = new Headers(h ?? signRequest("POST", "/api/core/state", BODY, secret, when));
  return { method: "POST", path: "/api/core/state", body: BODY, headers, ...over };
}

describe("signed requests", () => {
  it("a correct signature passes", () => {
    expect(verifyRequest(req(), NOW)).toEqual({ ok: true });
  });
  it("a changed body, path or method fails", () => {
    expect(verifyRequest(req({ body: JSON.stringify({ a: 2 }) }), NOW)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(verifyRequest(req({ path: "/api/core/other" }), NOW)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(verifyRequest(req({ method: "PUT" }), NOW)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });
  it("missing headers fail as MISSING", () => {
    expect(verifyRequest(req({}, {}), NOW)).toEqual({ ok: false, reason: "MISSING" });
  });
  it("accepts 119 s of skew in both directions and rejects 121 s", () => {
    expect(verifyRequest(req(), at(119))).toEqual({ ok: true });
    expect(verifyRequest(req(), at(-119))).toEqual({ ok: true });
    expect(verifyRequest(req(), at(121))).toEqual({ ok: false, reason: "SKEW" });
    expect(verifyRequest(req(), at(-121))).toEqual({ ok: false, reason: "SKEW" });
  });
  it("the previous secret is accepted, an unknown one is not", () => {
    process.env.CORE_SYNC_SECRET = "sync-secret-new-0123";
    process.env.CORE_SYNC_SECRET_PREVIOUS = "sync-secret-current";
    expect(verifyRequest(req(), NOW)).toEqual({ ok: true });
    expect(verifyRequest(req({}, undefined, "stranger-secret-0123456"), NOW)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });
  it("a malformed signature (wrong length / non-hex) fails without throwing", () => {
    const h = { "x-bz-timestamp": String(Math.floor(NOW.getTime() / 1000)), "x-bz-signature": "zz" };
    expect(verifyRequest(req({}, h), NOW)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });
  it("a changed query string fails (the signed path includes it)", () => {
    const h = signRequest("GET", "/api/core/v1/state?coreBusinessId=x", "", "sync-secret-current", NOW);
    const r = (path: string) => ({ method: "GET", path, body: "", headers: new Headers(h) });
    expect(verifyRequest(r("/api/core/v1/state?coreBusinessId=x"), NOW)).toEqual({ ok: true });
    expect(verifyRequest(r("/api/core/v1/state?coreBusinessId=y"), NOW)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(verifyRequest(r("/api/core/v1/state"), NOW)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });
  it("an uppercase hex signature is refused", () => {
    const h = signRequest("POST", "/api/core/state", BODY, "sync-secret-current", NOW);
    const up = { ...h, "x-bz-signature": h["x-bz-signature"].toUpperCase() };
    expect(verifyRequest(req({}, up), NOW)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });
  it("the signature header is hex", () => {
    expect(signRequest("GET", "/x", "", "s", NOW)["x-bz-signature"]).toMatch(/^[0-9a-f]{64}$/);
  });
});

const IAT = Math.floor(NOW.getTime() / 1000);
const claims = (over: Partial<HandoffClaims> = {}): HandoffClaims => ({
  aud: "retail",
  iat: IAT,
  exp: IAT + 60,
  nonce: "n1",
  jti: "j1",
  coreUserId: "u1",
  email: "a@b.test",
  emailVerified: true,
  name: "A",
  coreBusinessId: "b1",
  ...over,
});
const HS = "handoff-secret-current";

describe("handoff tokens", () => {
  it("a valid token verifies and returns the claims", () => {
    expect(verifyHandoff(signHandoffForTests(claims(), HS), at(5))).toEqual({ ok: true, claims: claims() });
  });
  it("a 61 s old token is expired; 60 s still passes", () => {
    const t = signHandoffForTests(claims(), HS);
    expect(verifyHandoff(t, at(60)).ok).toBe(true);
    expect(verifyHandoff(t, at(61))).toEqual({ ok: false, reason: "EXPIRED" });
  });
  it("past exp is expired", () => {
    expect(verifyHandoff(signHandoffForTests(claims(), HS), at(61))).toEqual({ ok: false, reason: "EXPIRED" });
  });
  it("a lifetime over 60 s is refused", () => {
    expect(verifyHandoff(signHandoffForTests(claims({ exp: IAT + 61 }), HS), at(1))).toEqual({ ok: false, reason: "EXPIRED" });
  });
  it("an iat in the future is refused even with a 60 s lifetime", () => {
    const t = signHandoffForTests(claims({ iat: IAT + 3600, exp: IAT + 3660 }), HS);
    expect(verifyHandoff(t, NOW)).toEqual({ ok: false, reason: "EXPIRED" });
    expect(verifyHandoff(t, at(3601)).ok).toBe(true);
  });
  it("exp before or equal to iat is refused", () => {
    expect(verifyHandoff(signHandoffForTests(claims({ exp: IAT - 1 }), HS), NOW).ok).toBe(false);
    expect(verifyHandoff(signHandoffForTests(claims({ exp: IAT }), HS), NOW).ok).toBe(false);
  });
  it("an oversized token is refused as FORMAT", () => {
    expect(verifyHandoff("a".repeat(4097), NOW)).toEqual({ ok: false, reason: "FORMAT" });
  });
  it("the signature is checked before the payload is parsed", () => {
    const payload = Buffer.from("not json").toString("base64url");
    const sig = signHandoffForTests(claims(), "stranger-secret-0123456").split(".")[1];
    expect(verifyHandoff(`${payload}.${sig}`, NOW)).toEqual({ ok: false, reason: "SIGNATURE" });
  });
  it("wrong audience fails", () => {
    const t = signHandoffForTests(claims({ aud: "other" as "retail" }), HS);
    expect(verifyHandoff(t, at(1))).toEqual({ ok: false, reason: "AUDIENCE" });
  });
  it("a swapped signature or payload fails", () => {
    const good = signHandoffForTests(claims(), HS);
    const [p, s] = good.split(".");
    const other = signHandoffForTests(claims(), "stranger").split(".")[1];
    expect(verifyHandoff(`${p}.${other}`, at(1))).toEqual({ ok: false, reason: "SIGNATURE" });
    const forged = signHandoffForTests(claims({ email: "evil@x.test" }), HS).split(".")[0];
    expect(verifyHandoff(`${forged}.${s}`, at(1))).toEqual({ ok: false, reason: "SIGNATURE" });
  });
  it("garbage fails as FORMAT", () => {
    expect(verifyHandoff("nope", at(1))).toEqual({ ok: false, reason: "FORMAT" });
    expect(verifyHandoff("a.b.c", at(1))).toEqual({ ok: false, reason: "FORMAT" });
  });
  it("the previous handoff secret is accepted", () => {
    process.env.CORE_HANDOFF_SECRET = "handoff-new-0123456789";
    process.env.CORE_HANDOFF_SECRET_PREVIOUS = HS;
    expect(verifyHandoff(signHandoffForTests(claims(), HS), at(1)).ok).toBe(true);
  });
});

describe("coreConfig", () => {
  it("reads env lazily and names the missing variable, never a value", () => {
    delete process.env.CORE_OUT_SECRET;
    expect(() => coreConfig().outSecret).toThrow(CoreConfigError);
    expect(() => coreConfig().outSecret).toThrow(/CORE_OUT_SECRET/);
    process.env.CORE_OUT_SECRET = "late-secret-0123456789";
    expect(coreConfig().outSecret).toBe("late-secret-0123456789");
    expect(coreConfig().baseUrl).toBe("https://studio.example");
  });
  it("rejects a secret shorter than 16 characters and trims whitespace", () => {
    process.env.CORE_OUT_SECRET = "short";
    expect(() => coreConfig().outSecret).toThrow(/CORE_OUT_SECRET/);
    process.env.CORE_OUT_SECRET = "  padded-secret-0123456  ";
    expect(coreConfig().outSecret).toBe("padded-secret-0123456");
    process.env.CORE_SYNC_SECRET_PREVIOUS = "tiny";
    expect(() => coreConfig().syncSecrets).toThrow(/CORE_SYNC_SECRET_PREVIOUS/);
  });
  it("lists current then previous secrets, skipping an unset previous", () => {
    expect(coreConfig().syncSecrets).toEqual(["sync-secret-current"]);
    process.env.CORE_SYNC_SECRET_PREVIOUS = "old-secret-0123456789";
    expect(coreConfig().syncSecrets).toEqual(["sync-secret-current", "old-secret-0123456789"]);
  });
});

describe("coreRateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows 120 per minute per key, then refuses; other keys unaffected", async () => {
    for (let i = 0; i < CORE_RATE_LIMIT; i++) expect(await coreRateLimit("198.51.100.1")).toEqual({ ok: true });
    expect(await coreRateLimit("198.51.100.1")).toEqual({ ok: false });
    expect(await coreRateLimit("198.51.100.2")).toEqual({ ok: true });
  });
  it("frees up after the minute passes, and stores only a hash", async () => {
    for (let i = 0; i < CORE_RATE_LIMIT; i++) await coreRateLimit("198.51.100.1");
    vi.setSystemTime(new Date(NOW.getTime() + 61_000));
    expect(await coreRateLimit("198.51.100.1")).toEqual({ ok: true });
    const rows = await db.rtLoginAttempt.findMany({ take: 3 });
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.key))).toBe(true);
  });
});
