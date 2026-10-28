import { describe, expect, it } from "vitest";
import { guardDatabaseUrl, isLocalHost } from "../../scripts/local-db";

const LOCAL = "postgresql://postgres:postgres@localhost:54329/retails_dev";
const REMOTE = "postgresql://u:p@ep-cool-name.eu-central-1.aws.neon.tech/db";

describe("guardDatabaseUrl (prisma.config.ts)", () => {
  it("passes local hosts and an unset url", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      const url = `postgresql://postgres:postgres@${host}:5432/x`;
      expect(isLocalHost(url)).toBe(true);
      expect(guardDatabaseUrl(url, {})).toBe(url);
    }
    expect(guardDatabaseUrl(undefined, {})).toBeUndefined();
    expect(guardDatabaseUrl("", {})).toBeUndefined();
    expect(guardDatabaseUrl(LOCAL, {})).toBe(LOCAL);
  });

  it("refuses a remote host unless ALLOW_REMOTE_DATABASE=1", () => {
    expect(() => guardDatabaseUrl(REMOTE, {})).toThrow(/non-local host "ep-cool-name/);
    expect(() => guardDatabaseUrl(REMOTE, { ALLOW_REMOTE_DATABASE: "true" })).toThrow(/ALLOW_REMOTE_DATABASE=1/);
    expect(() => guardDatabaseUrl(REMOTE, {}, "SHADOW_DATABASE_URL")).toThrow(/^Refusing SHADOW_DATABASE_URL/);
    // A look-alike host is not local.
    expect(() => guardDatabaseUrl("postgresql://u:p@localhost.evil.test/db", {})).toThrow();
    expect(guardDatabaseUrl(REMOTE, { ALLOW_REMOTE_DATABASE: "1" })).toBe(REMOTE);
  });

  it("refuses a value that is not a URL", () => {
    expect(() => guardDatabaseUrl("not a url", {})).toThrow(/not a valid URL/);
  });
});
