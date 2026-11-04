import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { register } from "@/instrumentation";
import { PackHostsError, hostNameOf, knownOrigins, packOrigin, parsePackHosts, resolveHost } from "@/packs/hosts";

/* Test values only: example hosts, no real addresses or secrets. */
const HOSTS = "supermarket.buzzify.test=SUPERMARKET,electronics.buzzify.test=ELECTRONICS,clothing.buzzify.test=CLOTHING";
const ENV = ["PACK_HOSTS", "APP_URL", "NEXT_RUNTIME", "NODE_ENV"] as const;
const saved: Record<string, string | undefined> = {};
const env = process.env as Record<string, string | undefined>;
beforeEach(() => {
  for (const k of ENV) saved[k] = env[k];
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});

const h = (init: Record<string, string>) => new Headers(init);

describe("PACK_HOSTS parsing", () => {
  it("unset or blank = no product addresses (one shared address)", () => {
    expect(parsePackHosts(undefined).size).toBe(0);
    expect(parsePackHosts("").size).toBe(0);
    expect(parsePackHosts("   ").size).toBe(0);
  });

  it("reads host=PACKID pairs, spaces around entries allowed", () => {
    const map = parsePackHosts(` supermarket.buzzify.test=SUPERMARKET , electronics.buzzify.test = ELECTRONICS`);
    expect([...map]).toEqual([
      ["supermarket.buzzify.test", "SUPERMARKET"],
      ["electronics.buzzify.test", "ELECTRONICS"],
    ]);
  });

  it.each([
    ["a scheme", "https://supermarket.buzzify.test=SUPERMARKET"],
    ["a path", "supermarket.buzzify.test/retail=SUPERMARKET"],
    ["a port", "supermarket.buzzify.test:443=SUPERMARKET"],
    ["upper case", "Supermarket.buzzify.test=SUPERMARKET"],
    ["a trailing dot", "supermarket.buzzify.test.=SUPERMARKET"],
    ["no pack", "supermarket.buzzify.test"],
    ["an empty entry", "supermarket.buzzify.test=SUPERMARKET,,clothing.buzzify.test=CLOTHING"],
    ["two equals signs", "a.test=SUPERMARKET=CLOTHING"],
    ["an unknown pack", "pharmacy.buzzify.test=PHARMACY"],
    ["an activity type instead of a pack", "supermarket.buzzify.test=MARKET"],
    ["a lower-case pack id", "supermarket.buzzify.test=supermarket"],
    ["the same host twice", "a.buzzify.test=SUPERMARKET,a.buzzify.test=CLOTHING"],
    ["two hosts for one pack", "a.buzzify.test=SUPERMARKET,b.buzzify.test=SUPERMARKET"],
    ["a wildcard", "*.buzzify.test=SUPERMARKET"],
    ["a user part", "user@supermarket.buzzify.test=SUPERMARKET"],
  ])("refuses %s, naming the variable", (_what, raw) => {
    expect(() => parsePackHosts(raw)).toThrow(PackHostsError);
    expect(() => parsePackHosts(raw)).toThrow(/PACK_HOSTS/);
  });

  it("refuses APP_URL's host as a pack host (it is the shared address)", () => {
    expect(() => parsePackHosts("retail.buzzify.test=SUPERMARKET", "retail.buzzify.test")).toThrow(PackHostsError);
  });

  it("a production start stops on a malformed value; dev and an unset value start", async () => {
    env.NEXT_RUNTIME = "nodejs";
    env.NODE_ENV = "production";
    env.PACK_HOSTS = "https://bad.test=SUPERMARKET";
    await expect(register()).rejects.toThrow(PackHostsError);
    env.PACK_HOSTS = HOSTS;
    await expect(register()).resolves.toBeUndefined();
    delete env.PACK_HOSTS;
    await expect(register()).resolves.toBeUndefined();
    env.NODE_ENV = "development";
    env.PACK_HOSTS = "https://bad.test=SUPERMARKET";
    await expect(register()).resolves.toBeUndefined();
  });
});

describe("the current host (trusted only when configured)", () => {
  beforeEach(() => {
    env.APP_URL = "https://retail.buzzify.test";
    env.PACK_HOSTS = HOSTS;
  });

  it("a product address is recognised, with APP_URL's scheme", () => {
    expect(resolveHost(h({ host: "electronics.buzzify.test" }))).toEqual({
      host: "electronics.buzzify.test",
      packId: "ELECTRONICS",
      origin: "https://electronics.buzzify.test",
    });
  });

  it("case, a port and a trailing dot in Host do not matter", () => {
    expect(resolveHost(h({ host: "CLOTHING.buzzify.test:443" })).packId).toBe("CLOTHING");
    expect(resolveHost(h({ host: "clothing.buzzify.test." })).packId).toBe("CLOTHING");
  });

  it("the shared address is APP_URL, with no pack", () => {
    expect(resolveHost(h({ host: "retail.buzzify.test" }))).toEqual({ host: "retail.buzzify.test", packId: null, origin: "https://retail.buzzify.test" });
  });

  it("a spoofed Host (unknown host) builds on APP_URL, never on the given host", () => {
    for (const host of ["evil.example", "supermarket.buzzify.test.evil.example", "evil.example/supermarket.buzzify.test", "[::1]:3000", "", "a b"]) {
      const ctx = resolveHost(h(host ? { host } : {}));
      expect(ctx).toEqual({ host: null, packId: null, origin: "https://retail.buzzify.test" });
    }
  });

  it("X-Forwarded-Host is never read: it cannot pick a pack nor move the origin", () => {
    expect(resolveHost(h({ host: "retail.buzzify.test", "x-forwarded-host": "electronics.buzzify.test" })).packId).toBeNull();
    expect(resolveHost(h({ host: "supermarket.buzzify.test", "x-forwarded-host": "evil.example" }))).toEqual({
      host: "supermarket.buzzify.test",
      packId: "SUPERMARKET",
      origin: "https://supermarket.buzzify.test",
    });
    expect(resolveHost(h({ "x-forwarded-host": "clothing.buzzify.test" })).origin).toBe("https://retail.buzzify.test");
    expect(resolveHost(h({ host: "evil.example", "x-forwarded-host": "clothing.buzzify.test", forwarded: "host=clothing.buzzify.test" })).packId).toBeNull();
  });

  it("product origins and the trusted list", () => {
    expect(packOrigin("CLOTHING")).toBe("https://clothing.buzzify.test");
    expect(knownOrigins()).toEqual([
      "https://retail.buzzify.test",
      "https://supermarket.buzzify.test",
      "https://electronics.buzzify.test",
      "https://clothing.buzzify.test",
    ]);
  });

  it("dev keeps APP_URL's scheme and port on a product address", () => {
    env.APP_URL = "http://localhost:3000";
    env.PACK_HOSTS = "supermarket.localhost=SUPERMARKET";
    expect(resolveHost(h({ host: "supermarket.localhost:3000" })).origin).toBe("http://supermarket.localhost:3000");
    expect(packOrigin("ELECTRONICS")).toBeNull();
  });

  it("unset PACK_HOSTS keeps the single shared address for every request", () => {
    delete env.PACK_HOSTS;
    expect(resolveHost(h({ host: "electronics.buzzify.test" }))).toEqual({ host: null, packId: null, origin: "https://retail.buzzify.test" });
    expect(packOrigin("SUPERMARKET")).toBeNull();
    expect(knownOrigins()).toEqual(["https://retail.buzzify.test"]);
  });

  it("a malformed PACK_HOSTS fails loudly at use", () => {
    env.PACK_HOSTS = "Supermarket.buzzify.test=SUPERMARKET";
    expect(() => resolveHost(h({ host: "retail.buzzify.test" }))).toThrow(PackHostsError);
  });

  it("hostNameOf", () => {
    expect(hostNameOf("Retail.Buzzify.test:8443")).toBe("retail.buzzify.test");
    expect(hostNameOf(null)).toBeNull();
    expect(hostNameOf("http://x.test")).toBeNull();
  });
});
