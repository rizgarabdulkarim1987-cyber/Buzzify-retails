import { describe, expect, it } from "vitest";
import { z } from "zod";
import { definePlatformAction } from "@/server/framework/platform-action";
import { useTestDb } from "../helpers/db";
import { createPlatformAdmin, createUser } from "../helpers/fixtures";

const { db } = useTestDb();

let runs = 0;
const issue = definePlatformAction({
  name: "platform.test.issue",
  input: z.object({ label: z.string().min(1) }),
  writes: true,
  async run({ adminId, input }) {
    runs += 1;
    return { label: input.label, adminId, secret: "s3cr3t-value" as string | null };
  },
  storedValue: (v) => ({ ...v, secret: null }),
});

const whoami = definePlatformAction({
  name: "platform.test.whoami",
  input: z.object({}),
  writes: false,
  run: async ({ adminId }) => adminId,
});

describe("definePlatformAction", () => {
  it("a non-admin is FORBIDDEN before anything runs or is written", async () => {
    runs = 0;
    const user = await createUser(db);
    expect(await issue({ label: "a" }, { userId: user.id, idempotencyKey: "k" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await whoami({}, { userId: user.id, idempotencyKey: "" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(runs).toBe(0);
    expect(await db.rtAuditLog.count()).toBe(0);
    expect(await db.rtIdempotency.count()).toBe(0);
  });

  it("writes one platform audit row (no business) and a redacted idempotency result", async () => {
    runs = 0;
    const admin = await createPlatformAdmin(db);
    const first = await issue({ label: "a" }, { userId: admin.id, idempotencyKey: "k" });
    expect(first).toEqual({ ok: true, value: { label: "a", adminId: admin.id, secret: "s3cr3t-value" } });
    const replay = await issue({ label: "a" }, { userId: admin.id, idempotencyKey: "k" });
    expect(replay).toEqual({ ok: true, value: { label: "a", adminId: admin.id, secret: null } });
    expect(runs).toBe(1);
    expect(await db.rtAuditLog.findFirstOrThrow()).toMatchObject({
      businessId: null,
      actorId: admin.id,
      action: "platform.test.issue",
    });
    const idem = await db.rtIdempotency.findFirstOrThrow();
    expect(idem.scope).toBe("platform");
    expect(JSON.stringify(idem.result)).not.toContain("s3cr3t");
  });

  it("the same key by another admin is IDEMPOTENCY_MISMATCH; reads need no key", async () => {
    const a = await createPlatformAdmin(db);
    const b = await createPlatformAdmin(db);
    expect(await issue({ label: "a" }, { userId: a.id, idempotencyKey: "k" })).toMatchObject({ ok: true });
    expect(await issue({ label: "a" }, { userId: b.id, idempotencyKey: "k" })).toMatchObject({
      ok: false,
      code: "IDEMPOTENCY_MISMATCH",
    });
    expect(await whoami({}, { userId: b.id, idempotencyKey: "" })).toEqual({ ok: true, value: b.id });
  });
});
