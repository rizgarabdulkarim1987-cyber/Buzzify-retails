import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "@/server/auth/auth";
import { CoreClientError } from "@/server/core/client";
import { signHandoffForTests, type HandoffClaims } from "@/server/core/handoff";
import { codeSignIn, forwardedClientIp, passwordSignIn } from "@/server/core/own-sign-in";
import { SIGNIN_EMAIL_LIMIT, SIGNIN_IP_LIMIT, SIGNIN_WINDOW_MS, signInKey } from "@/server/core/rate-limit";
import { createHttpCoreSignInClient, setCoreSignInFake, type CoreSignInClient, type SignInAnswer } from "@/server/core/sign-in-client";
import { verifyRequest } from "@/server/core/signing";
import { dumpAllRows, useTestDb } from "../helpers/db";
import { createBusinessWithStaff } from "../helpers/fixtures";

/*
 * The /login form signed in through Studio (src/server/core/own-sign-in.ts and the server action
 * signInWithAccount): Studio is a fake that answers like the real one and signs real handoff
 * tokens with the nonce it was sent; everything on Retails' side (the redemption, the session, the
 * challenge cookie) is real. Next's request APIs are an in-memory cookie jar and fixed headers.
 */

const jar = vi.hoisted(() => ({
  cookies: new Map<string, { value: string; options: Record<string, unknown> }>(),
  headers: new Headers(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.cookies.has(name) ? { name, value: jar.cookies.get(name)!.value } : undefined),
    set: (name: string, value: string, options: Record<string, unknown> = {}) => {
      if (options.maxAge === 0) jar.cookies.delete(name);
      else jar.cookies.set(name, { value, options });
    },
  }),
  headers: async () => jar.headers,
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { to });
  },
}));

const { signInWithAccount } = await import("@/app/login/actions");
const { db } = useTestDb();

const SECRET = "handoff-secret-current";
const OUT = "out-secret-0123456789";
const PASSWORD = "correct horse battery staple";
const ENV = ["CORE_HANDOFF_SECRET", "CORE_HANDOFF_SECRET_PREVIOUS", "CORE_BASE_URL", "CORE_OUT_SECRET", "CORE_SYNC_SECRET", "TRUSTED_PROXY_HOPS"] as const;
const saved: Record<string, string | undefined> = {};
let logs: string[] = [];

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.CORE_HANDOFF_SECRET = SECRET;
  process.env.CORE_BASE_URL = "https://accounts.example";
  process.env.CORE_OUT_SECRET = OUT;
  process.env.CORE_SYNC_SECRET = OUT;
  jar.cookies.clear();
  jar.headers = new Headers({ "x-forwarded-for": "10.0.0.1, 203.0.113.9", "user-agent": "Test Browser" });
  logs = [];
  for (const level of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));
  }
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setCoreSignInFake(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const nowS = () => Math.floor(Date.now() / 1000);
function tokenFor(nonce: string, over: Partial<HandoffClaims> = {}): string {
  const iat = nowS();
  return signHandoffForTests(
    {
      aud: "retail",
      iat,
      exp: iat + 60,
      nonce,
      jti: randomUUID(),
      coreUserId: "core-user-1",
      email: "owner@example.test",
      emailVerified: true,
      name: "Owner",
      coreBusinessId: "core-biz-1",
      ...over,
    },
    SECRET,
  );
}

async function linkedBusiness() {
  const w = await createBusinessWithStaff(db, {});
  await db.rtBusiness.update({ where: { id: w.business.id }, data: { coreBusinessId: "core-biz-1", coreOwnerUserId: "core-user-1", status: "ACTIVE" } });
  return w;
}

type Calls = { password: unknown[]; code: unknown[]; choose: unknown[] };
/** A Studio that knows one account (owner@example.test / PASSWORD), with or without two-factor. */
function fakeStudio(opts: { twoFactor?: boolean; shops?: number; answer?: SignInAnswer } = {}): { client: CoreSignInClient; calls: Calls } {
  const calls: Calls = { password: [], code: [], choose: [] };
  const finish = (nonce: string, shopId?: string): SignInAnswer =>
    opts.shops && !shopId
      ? { status: "choose", challenge: "pk.pick-challenge", shops: [{ id: "core-biz-1", name: "Main shop", ready: true }, { id: "core-biz-2", name: "Second", ready: false }] }
      : { status: "ok", handoffToken: tokenFor(nonce, shopId ? { coreBusinessId: shopId } : {}) };
  const client: CoreSignInClient = {
    async checkPassword(input) {
      calls.password.push(input);
      if (opts.answer) return opts.answer;
      if (input.email.trim().toLowerCase() !== "owner@example.test" || input.password !== PASSWORD) return { status: "invalid" };
      return opts.twoFactor ? { status: "needs_2fa", challenge: "tf.the-challenge" } : finish(input.nonce);
    },
    async checkCode(input) {
      calls.code.push(input);
      if (input.challenge !== "tf.the-challenge") return { status: "expired" };
      return input.code === "123456" ? finish(input.nonce) : { status: "invalid_code" };
    },
    async choose(input) {
      calls.choose.push(input);
      return input.challenge === "pk.pick-challenge" ? finish(input.nonce, input.shopId) : { status: "expired" };
    },
  };
  return { client, calls };
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const initial = { step: "password" as const, failed: null, email: "", shops: [] };

/** Runs the action; a redirect comes back as { to }. */
async function act(prev: Parameters<typeof signInWithAccount>[0], fields: Record<string, string>) {
  try {
    return { state: await signInWithAccount(prev, form(fields)), to: null as string | null };
  } catch (err) {
    if (err instanceof Error && err.message === "NEXT_REDIRECT") return { state: null, to: (err as Error & { to: string }).to };
    throw err;
  }
}

const sessionCookie = () => [...jar.cookies].find(([name]) => /session_token/.test(name));

describe("the /login form, through Studio", () => {
  it("a right password signs in: the token is redeemed here, a session is opened, and the shop opens", async () => {
    await linkedBusiness();
    const { client, calls } = fakeStudio();
    setCoreSignInFake(client);

    const { to } = await act(initial, { intent: "password", email: " Owner@Example.test ", password: PASSWORD });
    expect(to).toBe("/retail/home");
    const [name, cookie] = sessionCookie()!;
    expect(cookie.options).toMatchObject({ httpOnly: true, path: "/", sameSite: "lax" });
    const session = await auth.api.getSession({ headers: new Headers({ cookie: `${name}=${encodeURIComponent(cookie.value)}` }) });
    const user = await db.user.findUniqueOrThrow({ where: { coreUserId: "core-user-1" } });
    expect(session?.user.id).toBe(user.id);

    // What Studio was sent: the email as typed, the password, a fresh 43-char nonce, and the browser's address as the
    // nearest proxy saw it (the last X-Forwarded-For entry), never the first entry a browser could forge.
    const sent = calls.password[0] as Record<string, string>;
    expect(Object.keys(sent).sort()).toEqual(["clientIp", "email", "nonce", "password", "userAgent"]);
    expect(sent.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sent.clientIp).toBe("203.0.113.9");
    expect(sent.userAgent).toBe("Test Browser");
    // The password is in no log line and in no row.
    expect(logs.join("\n")).not.toContain(PASSWORD);
    expect(await dumpAllRows(db)).not.toContain(PASSWORD);
  });

  it("a token is redeemed once: the same answer cannot sign in a second time", async () => {
    await linkedBusiness();
    let first: SignInAnswer | null = null;
    const { client } = fakeStudio();
    setCoreSignInFake({
      ...client,
      async checkPassword(input) {
        first ??= await client.checkPassword(input);
        return first;
      },
    });
    expect((await act(initial, { email: "owner@example.test", password: PASSWORD })).to).toBe("/retail/home");
    jar.cookies.clear();
    const again = await act(initial, { email: "owner@example.test", password: PASSWORD });
    expect(again.to).toBeNull();
    expect(again.state).toMatchObject({ step: "password", failed: "FAILED" });
    expect(sessionCookie()).toBeUndefined();
    expect(await db.session.count()).toBe(1);
  });

  it("a wrong password, an unknown email or Studio's limit say so, generically, and open nothing", async () => {
    await linkedBusiness();
    setCoreSignInFake(fakeStudio().client);
    for (const [email, password] of [["owner@example.test", "wrong"], ["nobody@example.test", PASSWORD]]) {
      const { state } = await act(initial, { email, password });
      expect(state).toEqual({ step: "password", failed: "INVALID_CREDENTIALS", email, shops: [] });
    }
    setCoreSignInFake(fakeStudio({ answer: { status: "throttled" } }).client);
    expect((await act(initial, { email: "owner@example.test", password: PASSWORD })).state?.failed).toBe("THROTTLED");
    expect(await db.session.count()).toBe(0);
    // The returned state never carries the password.
    expect(JSON.stringify((await act(initial, { email: "x@example.test", password: "a secret typed" })).state)).not.toContain("a secret typed");
  });

  it("two-factor: the code step, a wrong code keeps it, the right code signs in; the challenge lives in an HttpOnly cookie", async () => {
    await linkedBusiness();
    const { client, calls } = fakeStudio({ twoFactor: true });
    setCoreSignInFake(client);

    const first = await act(initial, { email: "owner@example.test", password: PASSWORD });
    expect(first.state).toEqual({ step: "code", failed: null, email: "owner@example.test", shops: [] });
    const step = jar.cookies.get("rt_signin_step")!;
    expect(step.value).toBe("code~tf.the-challenge");
    expect(step.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/login", maxAge: 600 });
    expect(JSON.stringify(first.state)).not.toContain("tf.the-challenge");

    const wrong = await act(first.state!, { intent: "code", email: "owner@example.test", code: "000000" });
    expect(wrong.state).toMatchObject({ step: "code", failed: "INVALID_CODE" });
    const right = await act(wrong.state!, { intent: "code", email: "owner@example.test", code: "123456" });
    expect(right.to).toBe("/retail/home");
    expect(jar.cookies.has("rt_signin_step")).toBe(false);
    expect(calls.code.map((c) => (c as { challenge: string }).challenge)).toEqual(["tf.the-challenge", "tf.the-challenge"]);
    // Each step gets its own nonce.
    const nonces = [...calls.password, ...calls.code].map((c) => (c as { nonce: string }).nonce);
    expect(new Set(nonces).size).toBe(nonces.length);
  });

  it("a code step without its cookie (expired, another browser) starts over", async () => {
    setCoreSignInFake(fakeStudio({ twoFactor: true }).client);
    const { state } = await act({ step: "code", failed: null, email: "owner@example.test", shops: [] }, { intent: "code", code: "123456" });
    expect(state).toMatchObject({ step: "password", failed: "EXPIRED" });
  });

  it("an owner of several businesses picks one", async () => {
    await linkedBusiness();
    const { client, calls } = fakeStudio({ shops: 2 });
    setCoreSignInFake(client);
    const first = await act(initial, { email: "owner@example.test", password: PASSWORD });
    expect(first.state?.step).toBe("choose");
    expect(first.state?.shops.map((s) => s.id)).toEqual(["core-biz-1", "core-biz-2"]);
    const picked = await act(first.state!, { intent: "choose", email: "owner@example.test", shop: "core-biz-1" });
    expect(picked.to).toBe("/retail/home");
    expect(calls.choose[0]).toMatchObject({ challenge: "pk.pick-challenge", shopId: "core-biz-1", clientIp: "203.0.113.9" });
  });

  it("restart drops the pending step", async () => {
    setCoreSignInFake(fakeStudio({ twoFactor: true }).client);
    await act(initial, { email: "owner@example.test", password: PASSWORD });
    expect(jar.cookies.has("rt_signin_step")).toBe(true);
    const { state } = await act({ step: "code", failed: null, email: "owner@example.test", shops: [] }, { intent: "code", restart: "1" });
    expect(state).toEqual({ step: "password", failed: null, email: "owner@example.test", shops: [] });
    expect(jar.cookies.has("rt_signin_step")).toBe(false);
  });

  it("Studio unreachable: a generic failure, the error class logged, never the password", async () => {
    setCoreSignInFake({
      checkPassword: async () => {
        throw new CoreClientError("timeout");
      },
      checkCode: async () => ({ status: "expired" }),
      choose: async () => ({ status: "expired" }),
    });
    const { state } = await act(initial, { email: "owner@example.test", password: PASSWORD });
    expect(state?.failed).toBe("FAILED");
    expect(logs.join("\n")).toContain("timeout");
    expect(logs.join("\n")).not.toContain(PASSWORD);
  });

  it("holds Studio's own limits on Retails' side first: 20 steps per address and 5 passwords per email in ten minutes", async () => {
    const { client, calls } = fakeStudio();
    const meta = { clientIp: "203.0.113.9" };
    // Every attempt counts, the right password included, as on Studio.
    for (let i = 0; i < SIGNIN_EMAIL_LIMIT; i++) await passwordSignIn(client, { email: i % 2 ? "Owner@Example.test" : "owner@example.test", password: i ? "wrong" : PASSWORD }, meta);
    expect(calls.password).toHaveLength(SIGNIN_EMAIL_LIMIT);
    expect(await passwordSignIn(client, { email: " owner@example.test", password: PASSWORD }, { clientIp: "198.51.100.1" })).toEqual({ kind: "failed", reason: "THROTTLED" });
    expect(calls.password).toHaveLength(SIGNIN_EMAIL_LIMIT);
    // Another email from the same address is still asked about, up to the per-address limit.
    expect((await passwordSignIn(client, { email: "other@example.test", password: "x" }, meta)).kind).toBe("failed");
    expect(calls.password).toHaveLength(SIGNIN_EMAIL_LIMIT + 1);

    const ipKey = signInKey("ip", "192.0.2.50");
    await db.rtLoginAttempt.createMany({ data: Array.from({ length: SIGNIN_IP_LIMIT }, () => ({ key: ipKey, at: new Date() })) });
    const before = calls.password.length + calls.code.length;
    expect(await passwordSignIn(client, { email: "fresh@example.test", password: "x" }, { clientIp: "192.0.2.50" })).toEqual({ kind: "failed", reason: "THROTTLED" });
    expect(await codeSignIn(client, { challenge: "tf.the-challenge", code: "123456" }, { clientIp: "192.0.2.50" })).toEqual({ kind: "failed", reason: "THROTTLED" });
    expect(calls.password.length + calls.code.length).toBe(before);

    // Ten minutes on, the address is free again. Only hashes are stored, never the email or the address.
    await db.rtLoginAttempt.updateMany({ where: { key: ipKey }, data: { at: new Date(Date.now() - SIGNIN_WINDOW_MS - 1000) } });
    expect((await passwordSignIn(client, { email: "fresh@example.test", password: "x" }, { clientIp: "192.0.2.50" })).kind).toBe("failed");
    expect(calls.password.length).toBe(before + 1);
    const rows = JSON.stringify(await db.rtLoginAttempt.findMany());
    expect(rows).not.toContain("owner@example.test");
    expect(rows).not.toContain("192.0.2.50");
  });

  it("refuses, generically and without asking Studio, a sign-in whose browser address cannot be told", async () => {
    await linkedBusiness();
    const { client, calls } = fakeStudio();
    setCoreSignInFake(client);
    jar.headers = new Headers({ "user-agent": "Test Browser" });
    const { state } = await act(initial, { email: "owner@example.test", password: PASSWORD });
    expect(state).toMatchObject({ step: "password", failed: "FAILED" });
    expect(await passwordSignIn(client, { email: "owner@example.test", password: PASSWORD }, { clientIp: "" })).toEqual({ kind: "failed", reason: "FAILED" });
    expect(calls.password).toHaveLength(0);
    expect(await db.rtLoginAttempt.count()).toBe(0);
  });

  it("an account Studio will not sign in here (a platform account) is sent to Studio's own sign-in", async () => {
    setCoreSignInFake(fakeStudio({ answer: { status: "unavailable" } }).client);
    const { state } = await act(initial, { email: "root@example.test", password: PASSWORD });
    expect(state).toEqual({ step: "password", failed: "ELSEWHERE", email: "root@example.test", shops: [] });
    expect(sessionCookie()).toBeUndefined();
  });

  it("without the account system configured, /login checks local passwords like /admin/login", async () => {
    delete process.env.CORE_BASE_URL;
    const { state } = await act(initial, { email: "nobody@example.test", password: "whatever" });
    expect(state).toMatchObject({ step: "password", failed: "INVALID_CREDENTIALS" });
  });
});

describe("forwardedClientIp", () => {
  it("is the entry the nearest proxy added, honours TRUSTED_PROXY_HOPS, and is empty for anything that is not an address", () => {
    expect(forwardedClientIp(new Headers({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" }))).toBe("203.0.113.9");
    process.env.TRUSTED_PROXY_HOPS = "2";
    expect(forwardedClientIp(new Headers({ "x-forwarded-for": "1.1.1.1, 203.0.113.9, 10.0.0.2" }))).toBe("203.0.113.9");
    // Fewer entries than proxies: the one that would be the browser's was never added by a proxy.
    expect(forwardedClientIp(new Headers({ "x-forwarded-for": "203.0.113.9" }))).toBe("");
    delete process.env.TRUSTED_PROXY_HOPS;
    expect(forwardedClientIp(new Headers({ "x-forwarded-for": "2001:db8::1" }))).toBe("2001:db8::1");
    // X-Real-IP is whatever the browser wrote: never read.
    expect(forwardedClientIp(new Headers({ "x-real-ip": "198.51.100.3" }))).toBe("");
    expect(forwardedClientIp(new Headers({ "x-forwarded-for": "<script>" }))).toBe("");
    expect(forwardedClientIp(new Headers())).toBe("");
  });
});

describe("the signed calls to Studio", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("signs each POST over its raw body with CORE_OUT_SECRET, and reads a 429 as the limit", async () => {
    const fetchMock = vi.fn(async () => json({ status: "needs_2fa", challenge: "tf.x" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createHttpCoreSignInClient();
    expect(await client.checkPassword({ email: "a@b.co", password: PASSWORD, nonce: "n".repeat(43), clientIp: "203.0.113.9" })).toEqual({
      status: "needs_2fa",
      challenge: "tf.x",
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://accounts.example/api/retail/v1/credentials");
    expect(url).not.toContain(PASSWORD);
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(verifyRequest({ method: "POST", path: "/api/retail/v1/credentials", body: init.body as string, headers })).toEqual({ ok: true });

    fetchMock.mockImplementationOnce(async () => json({ code: "RATE_LIMITED" }, 429));
    expect(await client.checkCode({ challenge: "tf.x", code: "123456", nonce: "n".repeat(43), clientIp: "" })).toEqual({ status: "throttled" });
    expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toBe("https://accounts.example/api/retail/v1/credentials/two-factor");

    fetchMock.mockImplementationOnce(async () => json({ status: "something new" }));
    await expect(client.choose({ challenge: "pk.x", shopId: "s", nonce: "n".repeat(43), clientIp: "" })).rejects.toMatchObject({ kind: "schema" });
    fetchMock.mockImplementationOnce(async () => json({ code: "UNAUTHORIZED" }, 401));
    await expect(client.checkPassword({ email: "a@b.co", password: PASSWORD, nonce: "n".repeat(43), clientIp: "" })).rejects.toSatisfy(
      (e: unknown) => e instanceof CoreClientError && e.kind === "http" && e.status === 401 && !String(e.message).includes(PASSWORD),
    );
  });
});
