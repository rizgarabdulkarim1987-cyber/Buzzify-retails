import { describe, expect, it } from "vitest";
import { checkEnv } from "../scripts/check-env";

describe("smoke", () => {
  it("check-env refuses a missing DATABASE_URL", () => {
    expect(() => checkEnv({})).toThrow(/DATABASE_URL/);
  });
});
