import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "@/server/auth/auth";
import { EMAIL_LIMIT, IP_LIMIT, WINDOW_MS, clientIp, signInThrottled } from "@/server/auth/login-throttle";
import { useTestDb } from "../helpers/db";

const { db } = useTestDb();

const PASSWORD = "right-password-1";
const START = new Date("2026-10-29T09:00:00Z");

const from = (ip: string) => new Headers({ "x-forwarded-for": `${ip}, 10.0.0.1` });
const attempt = (email: string, password: string, ip = "198.51.100.7") =>
  signInThrottled({ email, password }, from(ip));

async function user(email: string) {
  await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: email } });
}

async function fail(email: string, times: number, ip?: string) {
  for (let i = 0; i < times; i++) expect(await attempt(email, "wrong-password", ip)).toEqual({ ok: false, reason: "INVALID_CREDENTIALS" });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("login throttle", () => {
  it("the attempt after the email limit is refused even with the right password", async () => {
    await user("sara@shop.test");
    await fail("sara@shop.test", EMAIL_LIMIT);
    expect(await attempt("sara@shop.test", PASSWORD)).toEqual({ ok: false, reason: "THROTTLED" });
    // Case and spaces do not make a new counter.
    expect(await attempt("  SARA@Shop.TEST ", PASSWORD)).toEqual({ ok: false, reason: "THROTTLED" });
  });

  it("an unknown account is throttled the same way, so the answer does not reveal whether it exists", async () => {
    await fail("ghost@shop.test", EMAIL_LIMIT);
    expect(await attempt("ghost@shop.test", PASSWORD)).toEqual({ ok: false, reason: "THROTTLED" });
  });

  it("the window slides: failures older than the window stop counting", async () => {
    await user("sara@shop.test");
    await fail("sara@shop.test", 3);
    vi.setSystemTime(new Date(START.getTime() + 10 * 60_000));
    await fail("sara@shop.test", EMAIL_LIMIT - 3);
    expect(await attempt("sara@shop.test", PASSWORD)).toEqual({ ok: false, reason: "THROTTLED" });

    // The first three fall out of the window; two remain, so a sign-in is allowed again.
    vi.setSystemTime(new Date(START.getTime() + WINDOW_MS + 1));
    expect(await attempt("sara@shop.test", PASSWORD)).toMatchObject({ ok: true });
  });

  it("a successful sign-in clears the email counter", async () => {
    await user("sara@shop.test");
    await fail("sara@shop.test", EMAIL_LIMIT - 1);
    expect(await attempt("sara@shop.test", PASSWORD)).toMatchObject({ ok: true });
    await fail("sara@shop.test", EMAIL_LIMIT - 1);
    expect(await attempt("sara@shop.test", PASSWORD)).toMatchObject({ ok: true });
  });

  it("different emails do not interfere", async () => {
    await user("sara@shop.test");
    await user("ali@shop.test");
    await fail("sara@shop.test", EMAIL_LIMIT);
    expect(await attempt("ali@shop.test", PASSWORD)).toMatchObject({ ok: true });
    expect(await attempt("sara@shop.test", PASSWORD)).toEqual({ ok: false, reason: "THROTTLED" });
  });

  it("one client address is refused after the address limit, across emails; another address is not", async () => {
    await user("sara@shop.test");
    for (let i = 0; i < IP_LIMIT; i++) await fail(`spray${i}@shop.test`, 1, "203.0.113.9");
    expect(await attempt("sara@shop.test", PASSWORD, "203.0.113.9")).toEqual({ ok: false, reason: "THROTTLED" });
    expect(await attempt("sara@shop.test", PASSWORD, "192.0.2.44")).toMatchObject({ ok: true });
  });

  it("stores only hashed keys, never the email or the address", async () => {
    await fail("sara@shop.test", 1, "203.0.113.9");
    const rows = await db.rtLoginAttempt.findMany();
    expect(rows).toHaveLength(2);
    const text = JSON.stringify(rows);
    expect(text).not.toContain("sara");
    expect(text).not.toContain("203.0.113.9");
  });

  it("the client address is the first forwarded hop, else x-real-ip, else a constant", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": " 203.0.113.9 , 10.0.0.1" }))).toBe("203.0.113.9");
    expect(clientIp(new Headers({ "x-real-ip": "192.0.2.1" }))).toBe("192.0.2.1");
    expect(clientIp(new Headers())).toBe("unknown");
    expect(clientIp(new Headers({ "x-forwarded-for": "x".repeat(500) })).length).toBeLessThanOrEqual(64);
  });
});
