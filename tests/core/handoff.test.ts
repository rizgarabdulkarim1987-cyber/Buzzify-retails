import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as callbackGET } from "@/app/api/core/v1/handoff/callback/route";
import { GET as startGET } from "@/app/api/core/v1/handoff/start/route";
import { auth } from "@/server/auth/auth";
import { signHandoffForTests, verifyHandoff, type HandoffClaims } from "@/server/core/handoff";
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
/** What Studio must put in the token's nonce: base64url(sha256(state)). */
const nonceFor = (state: string) => createHash("sha256").update(state, "utf8").digest("base64url");
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

/** A token bound to this start's state (the nonce Studio echoes). */
const tokenFor = (s: { state: string }, over: Partial<HandoffClaims> = {}) =>
  signHandoffForTests(claims({ nonce: nonceFor(s.state), ...over }), SECRET);

/** Full round trip: start, then callback with the start cookie, state and a token bound to it. */
async function signIn(over: Partial<HandoffClaims> = {}, returnTo?: string) {
  const s = await start(returnTo);
  return callback(tokenFor(s, over), s.state, s.cookie);
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
    expect(location.searchParams.get("nonce")).toBe(nonceFor(state));

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
    const res = await signIn({}, "/retail/catalog");
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
    expect(isLoginError(await signIn())).toBe(false);
    const user = await db.user.findUniqueOrThrow({ where: { coreUserId: "core-user-1" } });
    await db.rtStaff.update({ where: { businessId_userId: { businessId: business.id, userId: user.id } }, data: { deactivatedAt: new Date() } });

    expect(isLoginError(await signIn())).toBe(false);
    expect(await db.user.count()).toBe(1);
    const rows = await db.rtStaff.findMany({ where: { businessId: business.id, userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: "OWNER", deactivatedAt: null });
  });

  it("the same token twice: the second is rejected (jti)", async () => {
    await linkedBusiness();
    const a = await start();
    const token = tokenFor(a);
    expect(isLoginError(await callback(token, a.state, a.cookie))).toBe(false);
    const second = await callback(token, a.state, a.cookie);
    expect(isLoginError(second)).toBe(true);
    expect(sessionCookieOf(second)).toBeUndefined();
    expect(await db.session.count()).toBe(1);
  });

  it("a valid token redeemed with another browser's state/cookie pair is refused (nonce binding)", async () => {
    await linkedBusiness();
    const victim = await start();
    const attacker = await start();
    const token = tokenFor(attacker); // issued for the attacker's state
    const res = await callback(token, victim.state, victim.cookie);
    expect(isLoginError(res)).toBe(true);
    expect(sessionCookieOf(res)).toBeUndefined();
    expect(await db.session.count()).toBe(0);
    expect(await db.user.count()).toBe(0);
    // A token with an unrelated nonce, or the hash of another state, is refused too.
    expect(isLoginError(await callback(signHandoffForTests(claims(), SECRET), victim.state, victim.cookie))).toBe(true);
    expect(isLoginError(await callback(tokenFor({ state: `${victim.state}x` }), victim.state, victim.cookie))).toBe(true);
    // The matching pair still works.
    expect(isLoginError(await callback(token, attacker.state, attacker.cookie))).toBe(false);
  });

  it("state mismatch or a missing state cookie is rejected with no session and no nonce spent", async () => {
    await linkedBusiness();
    const s = await start();
    const token = tokenFor(s);

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
      (n: string) => signHandoffForTests(claims({ nonce: n, iat, exp: iat + 60 }), SECRET),
      (n: string) => signHandoffForTests({ ...claims({ nonce: n }), aud: "menu" as "retail" }, SECRET),
      (n: string) => signHandoffForTests(claims({ nonce: n }), "another-secret-0123456789"),
      () => "not-a-token",
    ];
    for (const make of bad) {
      const s = await start();
      const token = make(nonceFor(s.state));
      expect(isLoginError(await callback(token, s.state, s.cookie)), token).toBe(true);
    }
    expect(await db.session.count()).toBe(0);
    expect(await db.user.count()).toBe(0);
  });

  it("unverified email + an existing local user with that email: no link, no session", async () => {
    await linkedBusiness();
    const local = await createUser(db, { email: "owner@example.test" });
    const res = await signIn({ emailVerified: false });
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
    const res = await signIn({ email: "Owner@Example.test" });
    expect(isLoginError(res)).toBe(false);
    expect((await db.user.findUniqueOrThrow({ where: { id: local.id } })).coreUserId).toBe("core-user-1");
    expect(await db.user.count()).toBe(1);
    expect(await db.rtStaff.count({ where: { businessId: business.id, userId: local.id, role: "OWNER" } })).toBe(1);
  });

  it("verified email whose local user is linked to another coreUserId: rejected, never relinked", async () => {
    await linkedBusiness();
    const local = await createUser(db, { email: "owner@example.test", coreUserId: "core-user-OTHER" });
    const res = await signIn();
    expect(isLoginError(res)).toBe(true);
    expect((await db.user.findUniqueOrThrow({ where: { id: local.id } })).coreUserId).toBe("core-user-OTHER");
    expect(await db.user.count()).toBe(1);
    expect(await db.session.count()).toBe(0);
  });

  it("an unverified email with no link is refused even when no local user holds it (no squatting)", async () => {
    await linkedBusiness();
    const res = await signIn({ emailVerified: false });
    expect(isLoginError(res)).toBe(true);
    expect(await db.user.count()).toBe(0);
    expect(await db.session.count()).toBe(0);
    expect(await db.rtStaff.count()).toBe(0);
  });

  it("a new user is stored with the lowercased email", async () => {
    await linkedBusiness();
    expect(isLoginError(await signIn({ email: "  New.Owner@Example.TEST " }))).toBe(false);
    expect((await db.user.findUniqueOrThrow({ where: { coreUserId: "core-user-1" } })).email).toBe("new.owner@example.test");
  });

  it("email lookup ignores case: stored Owner@Shop.com, verified token owner@shop.com links it", async () => {
    await linkedBusiness();
    const local = await createUser(db, { email: "Owner@Shop.com" });
    expect(isLoginError(await signIn({ email: "owner@shop.com" }))).toBe(false);
    expect((await db.user.findUniqueOrThrow({ where: { id: local.id } })).coreUserId).toBe("core-user-1");
    expect(await db.user.count()).toBe(1);
  });

  it("email lookup ignores case: stored Owner@Shop.com, unverified token owner@shop.com is refused", async () => {
    await linkedBusiness();
    const local = await createUser(db, { email: "Owner@Shop.com" });
    expect(isLoginError(await signIn({ email: "owner@shop.com", emailVerified: false }))).toBe(true);
    expect((await db.user.findUniqueOrThrow({ where: { id: local.id } })).coreUserId).toBeNull();
    expect(await db.user.count()).toBe(1);
    expect(await db.session.count()).toBe(0);
  });

  it("two local users differing only in email case: refused, neither linked", async () => {
    await linkedBusiness();
    await createUser(db, { email: "Owner@Shop.com" });
    await createUser(db, { email: "owner@shop.com" });
    expect(isLoginError(await signIn({ email: "owner@shop.com" }))).toBe(true);
    expect(await db.user.count({ where: { coreUserId: { not: null } } })).toBe(0);
    expect(await db.user.count()).toBe(2);
    expect(await db.session.count()).toBe(0);
  });

  it("never links a platform admin by email, even verified; an admin already linked by coreUserId signs in", async () => {
    await linkedBusiness();
    const admin = await createUser(db, { email: "owner@example.test" });
    await db.rtPlatformAdmin.create({ data: { userId: admin.id } });
    expect(isLoginError(await signIn())).toBe(true);
    expect((await db.user.findUniqueOrThrow({ where: { id: admin.id } })).coreUserId).toBeNull();
    expect(await db.user.count()).toBe(1);
    expect(await db.session.count()).toBe(0);

    await db.user.update({ where: { id: admin.id }, data: { coreUserId: "core-user-1" } });
    expect(isLoginError(await signIn())).toBe(false);
    expect(await db.session.count({ where: { userId: admin.id } })).toBe(1);
  });

  it("a coreUserId already linked under a different email resolves to the same user", async () => {
    await linkedBusiness();
    const local = await createUser(db, { email: "old@example.test", coreUserId: "core-user-1" });
    const res = await signIn({ email: "new@example.test", emailVerified: false });
    expect(isLoginError(res)).toBe(false);
    expect(await db.user.count()).toBe(1);
    const sessions = await db.session.findMany();
    expect(sessions.map((s) => s.userId)).toEqual([local.id]);
  });

  it("a non-owner signs in but gets no staff row", async () => {
    const { business } = await linkedBusiness();
    const res = await signIn({ coreUserId: "core-user-2", email: "member@example.test" });
    expect(isLoginError(res)).toBe(false);
    const user = await db.user.findUniqueOrThrow({ where: { coreUserId: "core-user-2" } });
    expect(await db.rtStaff.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.rtStaff.count({ where: { businessId: business.id } })).toBe(0);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
  });

  it("a non-owner who is already staff keeps their own role", async () => {
    const { business, staff } = await linkedBusiness({ staff: [{ key: "cashier", role: "CASHIER" }] });
    await db.user.update({ where: { id: staff.cashier!.user.id }, data: { coreUserId: "core-user-3" } });
    expect(isLoginError(await signIn({ coreUserId: "core-user-3", email: "x@example.test" }))).toBe(false);
    const rows = await db.rtStaff.findMany({ where: { businessId: business.id } });
    expect(rows.map((r) => r.role)).toEqual(["CASHIER"]);
  });

  it("an unknown coreBusinessId is rejected, nothing created", async () => {
    await linkedBusiness();
    const res = await signIn({ coreBusinessId: "core-biz-unknown" });
    expect(isLoginError(res)).toBe(true);
    expect(await db.user.count()).toBe(0);
    expect(await db.session.count()).toBe(0);
  });

  describe("staff token without a Studio business", () => {
    const staffClaims = (over: Record<string, unknown> = {}) => {
      const rest: Record<string, unknown> = claims({ coreUserId: "core-user-9", email: "cashier@example.test", name: "Cashier" });
      delete rest.coreBusinessId;
      return { ...rest, ...over } as unknown as HandoffClaims;
    };
    const signInRaw = async (c: HandoffClaims) => {
      const s = await start(""); // no returnTo: the default landing page
      return callback(signHandoffForTests({ ...c, nonce: nonceFor(s.state) }, SECRET), s.state, s.cookie);
    };

    it("signs in with a session, lands on /retail/home, and creates no staff row and no OWNER row", async () => {
      const { business } = await linkedBusiness();
      const staffBefore = await db.rtStaff.count();
      const res = await signInRaw(staffClaims());
      expect(isLoginError(res)).toBe(false);
      expect(res.headers.get("location")).toBe("/retail/home");
      const user = await db.user.findUniqueOrThrow({ where: { coreUserId: "core-user-9" } });
      expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
      expect(await db.rtStaff.count()).toBe(staffBefore);
      expect(await db.rtStaff.count({ where: { role: "OWNER", businessId: business.id } })).toBe(0);
      expect(await db.rtBusiness.count()).toBe(1);
    });

    it("null and empty-string coreBusinessId are treated as absent", async () => {
      await linkedBusiness();
      const owners = await db.rtStaff.count({ where: { role: "OWNER" } });
      for (const [i, v] of [null, ""].entries()) {
        const res = await signInRaw(staffClaims({ coreUserId: `core-user-n${i}`, email: `n${i}@example.test`, coreBusinessId: v }));
        expect(isLoginError(res)).toBe(false);
      }
      expect(await db.rtStaff.count({ where: { role: "OWNER" } })).toBe(owners);
    });

    it("even the Studio owner of a linked business gets no OWNER row without a coreBusinessId", async () => {
      const { business } = await linkedBusiness();
      const res = await signInRaw(staffClaims({ coreUserId: "core-user-1", email: "owner@example.test" }));
      expect(isLoginError(res)).toBe(false);
      const user = await db.user.findUniqueOrThrow({ where: { coreUserId: "core-user-1" } });
      expect(await db.rtStaff.count({ where: { businessId: business.id, userId: user.id } })).toBe(0);
    });

    it("an already-linked staff user keeps their existing membership untouched", async () => {
      const { business, staff } = await linkedBusiness({ staff: [{ key: "cashier", role: "CASHIER" }] });
      await db.user.update({ where: { id: staff.cashier!.user.id }, data: { coreUserId: "core-user-9" } });
      expect(isLoginError(await signInRaw(staffClaims()))).toBe(false);
      const rows = await db.rtStaff.findMany({ where: { businessId: business.id } });
      expect(rows.filter((r) => r.userId === staff.cashier!.user.id).map((r) => r.role)).toEqual(["CASHIER"]);
    });

    it("unverified email with no link is still refused, nothing created", async () => {
      await linkedBusiness();
      const res = await signInRaw(staffClaims({ emailVerified: false }));
      expect(isLoginError(res)).toBe(true);
      expect(await db.user.count({ where: { coreUserId: "core-user-9" } })).toBe(0);
      expect(await db.session.count()).toBe(0);
    });

    it("never creates a Retails business or staff row (no businesses at all)", async () => {
      const res = await signInRaw(staffClaims());
      expect(isLoginError(res)).toBe(false);
      expect(await db.rtBusiness.count()).toBe(0);
      expect(await db.rtStaff.count()).toBe(0);
    });

    it("an existing local user with a verified email is linked by it, as with a business", async () => {
      const u = await createUser(db, { email: "Cashier@Example.test" });
      expect(isLoginError(await signInRaw(staffClaims()))).toBe(false);
      expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).coreUserId).toBe("core-user-9");
    });

    it("a platform admin is never linked by email without a business either", async () => {
      const a = await createUser(db, { email: "cashier@example.test" });
      await db.rtPlatformAdmin.create({ data: { userId: a.id } });
      expect(isLoginError(await signInRaw(staffClaims()))).toBe(true);
    });
  });

  describe("verifyHandoff and coreBusinessId", () => {
    const sign = (o: Record<string, unknown>) => {
      const rest: Record<string, unknown> = claims();
      delete rest.coreBusinessId;
      return signHandoffForTests({ ...rest, ...o } as unknown as HandoffClaims, SECRET);
    };
    it("accepts an absent or null field, and a string", () => {
      expect(verifyHandoff(sign({})).ok).toBe(true);
      expect(verifyHandoff(sign({ coreBusinessId: null })).ok).toBe(true);
      expect(verifyHandoff(sign({ coreBusinessId: "core-biz-1" })).ok).toBe(true);
    });
    it("rejects a non-string value", () => {
      for (const v of [5, true, {}, []]) expect(verifyHandoff(sign({ coreBusinessId: v }))).toEqual({ ok: false, reason: "FORMAT" });
    });
  });

  it.each(["//evil.com", "https://evil.com", "/\\evil", "\\\\evil", "evil", "/%2F%2Fevil.com", "", "/ok\nx"])(
    "returnTo %j falls back to /retail/home",
    async (returnTo) => {
      await linkedBusiness();
      const res = await signIn({}, returnTo);
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
    const jti = randomUUID();
    await signIn({ jti });
    const n = await db.rtCoreNonce.findUniqueOrThrow({ where: { jti } });
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
