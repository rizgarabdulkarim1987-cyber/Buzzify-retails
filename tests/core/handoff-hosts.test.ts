import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as callbackGET } from "@/app/api/core/v1/handoff/callback/route";
import { GET as startGET } from "@/app/api/core/v1/handoff/start/route";
import { auth } from "@/server/auth/auth";
import { signHandoffForTests, type HandoffClaims } from "@/server/core/handoff";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff } from "../helpers/fixtures";

/*
 * The Studio handoff on the product addresses (PACK_HOSTS). Test values only. The callback URL is
 * built on the address the browser is on when it is a configured one, so the state cookie set by
 * /start comes back with the browser; a spoofed Host or X-Forwarded-Host never moves it.
 */

const { db } = useTestDb();

const SECRET = "handoff-secret-current";
const STUDIO = "https://studio.example";
const APP = "http://localhost:3000"; // APP_URL from vitest.config.ts
const PACK_HOSTS = "supermarket.localhost=SUPERMARKET,electronics.localhost=ELECTRONICS,clothing.localhost=CLOTHING";
const ENV = ["CORE_HANDOFF_SECRET", "CORE_HANDOFF_SECRET_PREVIOUS", "CORE_BASE_URL", "PACK_HOSTS"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.CORE_HANDOFF_SECRET = SECRET;
  process.env.CORE_BASE_URL = STUDIO;
  process.env.PACK_HOSTS = PACK_HOSTS;
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const nonceFor = (state: string) => createHash("sha256").update(state, "utf8").digest("base64url");

function claims(over: Partial<HandoffClaims> = {}): HandoffClaims {
  const iat = Math.floor(Date.now() / 1000);
  return {
    aud: "retail",
    iat,
    exp: iat + 60,
    nonce: randomUUID(),
    jti: randomUUID(),
    coreUserId: "core-user-1",
    email: "owner@example.test",
    emailVerified: true,
    name: "Owner",
    coreBusinessId: "core-biz-1",
    ...over,
  };
}

async function linkedBusiness(activityType: "MARKET" | "ELECTRONICS" | "CLOTHING") {
  const w = await createBusinessWithStaff(db);
  await db.rtBusiness.update({
    where: { id: w.business.id },
    data: { activityType, coreBusinessId: "core-biz-1", coreOwnerUserId: "core-user-1", status: "ACTIVE" },
  });
  return w;
}

/** /start as the browser sends it: Host (and optionally X-Forwarded-Host) headers on a request to that address. */
async function start(host: string | null, extra: Record<string, string> = {}) {
  const headers = new Headers(extra);
  if (host) headers.set("host", host);
  const res = await startGET(new Request(`http://${host ?? "localhost:3000"}/api/core/v1/handoff/start?returnTo=%2Fretail%2Fcatalog`, { headers }));
  const location = new URL(res.headers.get("location")!);
  const state = location.searchParams.get("state")!;
  const cookies = res.headers.getSetCookie();
  return { res, location, state, cookies, cookie: cookies.map((c) => c.split(";")[0]!).join("; ") };
}

async function callback(host: string, token: string, state: string, cookie: string) {
  const headers = new Headers({ host, cookie });
  return callbackGET(
    new Request(`http://${host}/api/core/v1/handoff/callback?token=${encodeURIComponent(token)}&state=${encodeURIComponent(state)}`, { headers }),
  );
}

const returnOf = (s: { location: URL }) => s.location.searchParams.get("return");

describe("handoff /start on the product addresses", () => {
  it("on a product address the callback is on that address (APP_URL's scheme and port)", async () => {
    expect(returnOf(await start("electronics.localhost:3000"))).toBe("http://electronics.localhost:3000/api/core/v1/handoff/callback");
    expect(returnOf(await start("supermarket.localhost:3000"))).toBe("http://supermarket.localhost:3000/api/core/v1/handoff/callback");
  });

  it("on the shared address, and with no Host at all, the callback stays on APP_URL (the old single-host flow)", async () => {
    expect(returnOf(await start("localhost:3000"))).toBe(`${APP}/api/core/v1/handoff/callback`);
    expect(returnOf(await start(null))).toBe(`${APP}/api/core/v1/handoff/callback`);
    delete process.env.PACK_HOSTS;
    expect(returnOf(await start("electronics.localhost:3000"))).toBe(`${APP}/api/core/v1/handoff/callback`);
  });

  it("a spoofed Host never becomes the callback host", async () => {
    for (const host of ["evil.example", "electronics.localhost.evil.example", "evil.example:3000"]) {
      const s = await start(host);
      expect(returnOf(s)).toBe(`${APP}/api/core/v1/handoff/callback`);
      expect(s.location.origin).toBe(STUDIO);
    }
  });

  it("X-Forwarded-Host is ignored, whether it names an unknown host or another product", async () => {
    expect(returnOf(await start("localhost:3000", { "x-forwarded-host": "evil.example" }))).toBe(`${APP}/api/core/v1/handoff/callback`);
    expect(returnOf(await start("supermarket.localhost:3000", { "x-forwarded-host": "clothing.localhost" }))).toBe(
      "http://supermarket.localhost:3000/api/core/v1/handoff/callback",
    );
    expect(returnOf(await start("evil.example", { "x-forwarded-host": "electronics.localhost:3000" }))).toBe(`${APP}/api/core/v1/handoff/callback`);
  });

  it("the state cookie is host-only (no Domain), so each address keeps its own", async () => {
    const s = await start("clothing.localhost:3000");
    expect(s.cookies).toHaveLength(1);
    expect(s.cookies[0]).not.toMatch(/Domain=/i);
    expect(s.cookies[0]).toMatch(/Path=\/api\/core\/v1\/handoff/);
  });

  it("a malformed PACK_HOSTS refuses the start instead of guessing a host", async () => {
    process.env.PACK_HOSTS = "https://electronics.localhost=ELECTRONICS";
    const headers = new Headers({ host: "electronics.localhost:3000" });
    const res = await startGET(new Request("http://electronics.localhost:3000/api/core/v1/handoff/start", { headers }));
    expect(res.headers.get("location")).toBe("/login?error=core");
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

describe("handoff /callback landing on a product address", () => {
  it("state and nonce survive the round trip; the session cookie is host-only and the redirect stays on this address", async () => {
    await linkedBusiness("ELECTRONICS");
    const s = await start("electronics.localhost:3000");
    const token = signHandoffForTests(claims({ nonce: nonceFor(s.state) }), SECRET);
    const res = await callback("electronics.localhost:3000", token, s.state, s.cookie);
    expect(res.headers.get("location")).toBe("/retail/catalog");
    const session = res.headers.getSetCookie().find((c) => /session_token=/.test(c));
    expect(session).toBeDefined();
    expect(session).not.toMatch(/Domain=/i);
    const got = await auth.api.getSession({ headers: new Headers({ cookie: session!.split(";")[0]!, host: "electronics.localhost:3000" }) });
    expect(got?.user.email).toBe("owner@example.test");
  });

  it("a state cookie from one address does not complete a handoff started on another (a different browser state)", async () => {
    await linkedBusiness("CLOTHING");
    const onClothing = await start("clothing.localhost:3000");
    const onMarket = await start("supermarket.localhost:3000");
    const token = signHandoffForTests(claims({ nonce: nonceFor(onClothing.state) }), SECRET);
    const res = await callback("clothing.localhost:3000", token, onClothing.state, onMarket.cookie);
    expect(res.headers.get("location")).toBe("/login?error=core");
    expect(await db.session.count()).toBe(0);
  });

  it("the old single-host flow still works with PACK_HOSTS set", async () => {
    await linkedBusiness("MARKET");
    const s = await start("localhost:3000");
    const token = signHandoffForTests(claims({ nonce: nonceFor(s.state) }), SECRET);
    const res = await callback("localhost:3000", token, s.state, s.cookie);
    expect(res.headers.get("location")).toBe("/retail/catalog");
    expect(await db.session.count()).toBe(1);
  });
});
