import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as callbackGET } from "@/app/api/core/v1/handoff/callback/route";
import { GET as startGET } from "@/app/api/core/v1/handoff/start/route";
import { auth } from "@/server/auth/auth";
import { signHandoffForTests, type HandoffClaims } from "@/server/core/handoff";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createUser } from "../helpers/fixtures";

const { db } = useTestDb();

const SECRET = "handoff-secret-current";
const STUDIO = "https://studio.example";
const APP = "http://localhost:3000"; // APP_URL from vitest.config.ts
const ENV = ["CORE_HANDOFF_SECRET", "CORE_HANDOFF_SECRET_PREVIOUS", "CORE_BASE_URL"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.CORE_HANDOFF_SECRET = SECRET;
  process.env.CORE_BASE_URL = STUDIO;
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const HOUR = 3_600_000;
const nowS = () => Math.floor(Date.now() / 1000);

function claims(over: Partial<HandoffClaims> = {}): HandoffClaims {
  const iat = nowS();
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

/** A business linked to Studio, owned in Studio by core-user-1. */
async function linkedBusiness(opts: Parameters<typeof createBusinessWithStaff>[1] = {}) {
  const w = await createBusinessWithStaff(db, opts);
  await db.rtBusiness.update({
    where: { id: w.business.id },
    data: { coreBusinessId: "core-biz-1", coreOwnerUserId: "core-user-1", status: "ACTIVE" },
  });
  return w;
}

function setCookies(res: Response): string[] {
  return res.headers.getSetCookie();
}

/** Runs /start and returns the state, the browser's Cookie header and the start response. */
async function start(returnTo = "/retail/catalog") {
  const res = await startGET(new Request(`${APP}/api/core/v1/handoff/start?returnTo=${encodeURIComponent(returnTo)}`));
  const location = new URL(res.headers.get("location")!);
  const state = location.searchParams.get("state")!;
  const cookie = setCookies(res)
    .map((c) => c.split(";")[0]!)
    .join("; ");
  return { res, location, state, cookie };
}

async function callback(token: string, state: string, cookie: string | null) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  return callbackGET(
    new Request(`${APP}/api/core/v1/handoff/callback?token=${encodeURIComponent(token)}&state=${encodeURIComponent(state)}`, { headers }),
  );
}

/** Full round trip: start, then callback with the start cookie and state. */
async function signIn(c: HandoffClaims, returnTo?: string) {
  const s = await start(returnTo);
  return callback(signHandoffForTests(c, SECRET), s.state, s.cookie);
}

const isLoginError = (res: Response) => res.headers.get("location") === "/login?error=core";
const sessionCookieOf = (res: Response) => setCookies(res).find((c) => /session_token=/.test(c));

describe("GET /api/core/v1/handoff/start", () => {
  it("sets a short-lived HttpOnly Lax state cookie and redirects to Studio with the callback and state", async () => {
    const { res, location, state } = await start("/retail/catalog");
    expect([302, 303, 307]).toContain(res.status);
    expect(location.origin + location.pathname).toBe(`${STUDIO}/api/retail/v1/handoff`);
    expect(location.searchParams.get("return")).toBe(`${APP}/api/core/v1/handoff/callback`);
    expect(state).toMatch(/^[A-Za-z0-9_-]{32,}$/);

    const cookies = setCookies(res);
    expect(cookies).toHaveLength(1);
    const c = cookies[0]!;
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/SameSite=Lax/i);
    expect(c).toMatch(/Path=\/api\/core\/v1\/handoff/);
    const maxAge = Number(/Max-Age=(\d+)/i.exec(c)?.[1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(600);
    expect(c).not.toMatch(/Secure/i); // not production
  });

  it("each start gets a fresh state", async () => {
    expect((await start()).state).not.toBe((await start()).state);
  });
});

describe("GET /api/core/v1/handoff/callback", () => {
  it("an owner token creates the user, links coreUserId, ensures RtStaff OWNER and opens a 12 h session", async () => {
    const { business } = await linkedBusiness();
    const res = await signIn(claims(), "/retail/catalog");
    expect(res.headers.get("location")).toBe("/retail/catalog");

    const user = await db.user.findUniqueOrThrow({ where: { coreUserId: "core-user-1" } });
    expect(user).toMatchObject({ email: "owner@example.test", emailVerified: true, name: "Owner" });
    expect(await db.account.count({ where: { userId: user.id } })).toBe(0); // no password row

    const staff = await db.rtStaff.findUniqueOrThrow({ where: { businessId_userId: { businessId: business.id, userId: user.id } } });
    expect(staff).toMatchObject({ role: "OWNER", deactivatedAt: null });

    const sessions = await db.session.findMany({ where: { userId: user.id } });
    expect(sessions).toHaveLength(1);
    const left = sessions[0]!.expiresAt.getTime() - Date.now();
    expect(left).toBeGreaterThan(12 * HOUR - 60_000);
    expect(left).toBeLessThanOrEqual(12 * HOUR + 1_000);

    // The cookie is one Better Auth itself accepts.
    const cookie = sessionCookieOf(res);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const got = await auth.api.getSession({ headers: new Headers({ cookie: cookie!.split(";")[0]! }) });
    expect(got?.user.id).toBe(user.id);

    // The state cookie is cleared.
    expect(setCookies(res).some((c) => /^rt_core_handoff=;/.test(c) && /Max-Age=0/i.test(c))).toBe(true);
  });

  it("a second owner sign-in is idempotent: same user, one OWNER row, a deactivated OWNER is reactivated", async () => {
    const { business } = await linkedBusiness();
    expect(isLoginError(await signIn(claims()))).toBe(false);
    const user = await db.user.findUniqueOrThrow({ where: { coreUserId: "core-user-1" } });
    await db.rtStaff.update({ where: { businessId_userId: { businessId: business.id, userId: user.id } }, data: { deactivatedAt: new Date() } });

    expect(isLoginError(await signIn(claims()))).toBe(false);
    expect(await db.user.count()).toBe(1);
    const rows = await db.rtStaff.findMany({ where: { businessId: business.id, userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: "OWNER", deactivatedAt: null });
  });

  it("the same token twice: the second is rejected (jti)", async () => {
    await linkedBusiness();
    const token = signHandoffForTests(claims(), SECRET);
    const a = await start();
    expect(isLoginError(await callback(token, a.state, a.cookie))).toBe(false);
    const b = await start();
    const second = await callback(token, b.state, b.cookie);
    expect(isLoginError(second)).toBe(true);
    expect(sessionCookieOf(second)).toBeUndefined();
    expect(await db.session.count()).toBe(1);
  });

  it("state mismatch or a missing state cookie is rejected with no session and no nonce spent", async () => {
    await linkedBusiness();
    const c = claims();
    const token = signHandoffForTests(c, SECRET);
    const s = await start();

    const mismatch = await callback(token, `${s.state}x`, s.cookie);
    expect(isLoginError(mismatch)).toBe(true);
    expect(sessionCookieOf(mismatch)).toBeUndefined();

    const noCookie = await callback(token, s.state, null);
    expect(isLoginError(noCookie)).toBe(true);

    const otherCookie = await callback(token, s.state, (await start()).cookie);
    expect(isLoginError(otherCookie)).toBe(true);

    expect(await db.session.count()).toBe(0);
    expect(await db.user.count()).toBe(0);
    expect(await db.rtCoreNonce.count()).toBe(0);
  });

  it("expired, wrong-audience, badly signed and garbage tokens are rejected", async () => {
    await linkedBusiness();
    const iat = nowS() - 120;
    const bad = [
      signHandoffForTests(claims({ iat, exp: iat + 60 }), SECRET),
      signHandoffForTests({ ...claims(), aud: "menu" as "retail" }, SECRET),
      signHandoffForTests(claims(), "another-secret-0123456789"),
      "not-a-token",
    ];
    for (const token of bad) {
      const s = await start();
      expect(isLoginError(await callback(token, s.state, s.cookie)), token).toBe(true);
    }
    expect(await db.session.count()).toBe(0);
    expect(await db.user.count()).toBe(0);
  });

  it("unverified email + an existing local user with that email: no link, no session", async () => {
    await linkedBusiness();
    const local = await createUser(db, { email: "owner@example.test" });
    const res = await signIn(claims({ emailVerified: false }));
    expect(isLoginError(res)).toBe(true);
    expect(sessionCookieOf(res)).toBeUndefined();
    expect((await db.user.findUniqueOrThrow({ where: { id: local.id } })).coreUserId).toBeNull();
    expect(await db.user.count()).toBe(1);
    expect(await db.session.count()).toBe(0);
    expect(await db.rtStaff.count({ where: { userId: local.id } })).toBe(0);
  });

  it("verified email + an existing local user (any case): linked, no second user", async () => {
    const { business } = await linkedBusiness();
    const local = await createUser(db, { email: "owner@example.test" });
    const res = await signIn(claims({ email: "Owner@Example.test" }));
    expect(isLoginError(res)).toBe(false);
    expect((await db.user.findUniqueOrThrow({ where: { id: local.id } })).coreUserId).toBe("core-user-1");
    expect(await db.user.count()).toBe(1);
    expect(await db.rtStaff.count({ where: { businessId: business.id, userId: local.id, role: "OWNER" } })).toBe(1);
  });

  it("verified email whose local user is linked to another coreUserId: rejected, never relinked", async () => {
    await linkedBusiness();
    const local = await createUser(db, { email: "owner@example.test", coreUserId: "core-user-OTHER" });
    const res = await signIn(claims());
    expect(isLoginError(res)).toBe(true);
    expect((await db.user.findUniqueOrThrow({ where: { id: local.id } })).coreUserId).toBe("core-user-OTHER");
    expect(await db.user.count()).toBe(1);
    expect(await db.session.count()).toBe(0);
  });

  it("an unverified email with no local user creates the user unverified", async () => {
    await linkedBusiness();
    expect(isLoginError(await signIn(claims({ emailVerified: false })))).toBe(false);
    expect((await db.user.findUniqueOrThrow({ where: { coreUserId: "core-user-1" } })).emailVerified).toBe(false);
  });

  it("a coreUserId already linked under a different email resolves to the same user", async () => {
    await linkedBusiness();
    const local = await createUser(db, { email: "old@example.test", coreUserId: "core-user-1" });
    const res = await signIn(claims({ email: "new@example.test", emailVerified: false }));
    expect(isLoginError(res)).toBe(false);
    expect(await db.user.count()).toBe(1);
    const sessions = await db.session.findMany();
    expect(sessions.map((s) => s.userId)).toEqual([local.id]);
  });

  it("a non-owner signs in but gets no staff row", async () => {
    const { business } = await linkedBusiness();
    const res = await signIn(claims({ coreUserId: "core-user-2", email: "member@example.test" }));
    expect(isLoginError(res)).toBe(false);
    const user = await db.user.findUniqueOrThrow({ where: { coreUserId: "core-user-2" } });
    expect(await db.rtStaff.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.rtStaff.count({ where: { businessId: business.id } })).toBe(0);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
  });

  it("a non-owner who is already staff keeps their own role", async () => {
    const { business, staff } = await linkedBusiness({ staff: [{ key: "cashier", role: "CASHIER" }] });
    await db.user.update({ where: { id: staff.cashier!.user.id }, data: { coreUserId: "core-user-3" } });
    expect(isLoginError(await signIn(claims({ coreUserId: "core-user-3", email: "x@example.test" })))).toBe(false);
    const rows = await db.rtStaff.findMany({ where: { businessId: business.id } });
    expect(rows.map((r) => r.role)).toEqual(["CASHIER"]);
  });

  it("an unknown coreBusinessId is rejected, nothing created", async () => {
    await linkedBusiness();
    const res = await signIn(claims({ coreBusinessId: "core-biz-unknown" }));
    expect(isLoginError(res)).toBe(true);
    expect(await db.user.count()).toBe(0);
    expect(await db.session.count()).toBe(0);
  });

  it.each(["//evil.com", "https://evil.com", "/\\evil", "\\\\evil", "evil", "/%2F%2Fevil.com", "", "/ok\nx"])(
    "returnTo %j falls back to /retail/home",
    async (returnTo) => {
      await linkedBusiness();
      const res = await signIn(claims(), returnTo);
      expect(res.headers.get("location")).toBe("/retail/home");
    },
  );

  it("expired nonces are deleted on every call, live ones kept", async () => {
    await db.rtCoreNonce.createMany({
      data: [
        { jti: "old-1", expiresAt: new Date(Date.now() - 1000) },
        { jti: "old-2", expiresAt: new Date(Date.now() - HOUR) },
        { jti: "live", expiresAt: new Date(Date.now() + 60_000) },
      ],
    });
    const s = await start();
    expect(isLoginError(await callback("not-a-token", s.state, s.cookie))).toBe(true);
    expect((await db.rtCoreNonce.findMany()).map((n) => n.jti)).toEqual(["live"]);
  });

  it("a spent jti is kept about two minutes", async () => {
    await linkedBusiness();
    const c = claims();
    await signIn(c);
    const n = await db.rtCoreNonce.findUniqueOrThrow({ where: { jti: c.jti } });
    const left = n.expiresAt.getTime() - Date.now();
    expect(left).toBeGreaterThan(100_000);
    expect(left).toBeLessThanOrEqual(121_000);
  });

  it("without core configuration both endpoints send the user to /login?error=core", async () => {
    delete process.env.CORE_BASE_URL;
    const res = await startGET(new Request(`${APP}/api/core/v1/handoff/start`));
    expect(res.headers.get("location")).toBe("/login?error=core");
    delete process.env.CORE_HANDOFF_SECRET;
    expect(isLoginError(await callback("a.b", "s", "rt_core_handoff=s.x"))).toBe(true);
  });
});

describe("session lifetime", () => {
  it("Better Auth sessions last 12 hours at most (no sliding refresh past the cap)", async () => {
    const ctx = await auth.$context;
    expect(ctx.sessionConfig.expiresIn).toBe(12 * 60 * 60);
    expect(ctx.options.session?.disableSessionRefresh).toBe(true);
  });
});
