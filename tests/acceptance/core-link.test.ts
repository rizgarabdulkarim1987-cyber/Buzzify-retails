import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as callbackGET } from "@/app/api/core/v1/handoff/callback/route";
import { GET as startGET } from "@/app/api/core/v1/handoff/start/route";
import { POST as provisionPOST } from "@/app/api/core/v1/provision/route";
import { GET as stateGET, POST as statePOST } from "@/app/api/core/v1/state/route";
import { createProduct } from "@/server/catalog/products";
import { resetCoreKeyCache, resolveAnthropicKey } from "@/server/core/client";
import { setCoreClientFake } from "@/server/core/client-fake";
import { signHandoffForTests } from "@/server/core/handoff";
import { signRequest } from "@/server/core/signing";
import { AI_INTAKE_FEATURE, featureEnabled } from "@/server/framework/features";
import { gateOf } from "@/server/framework/gate";
import { grantAiConsent } from "@/server/intake/consent";
import { getAiStatus } from "@/server/intake/quota";
import { createIntake, runIntakeRead } from "@/server/intake/receipts";
import { completeSetupStep } from "@/server/setup/progress";
import { useTestDb } from "../helpers/db";
import { createUser } from "../helpers/fixtures";

/*
 * Retails <-> Studio link, part A, end to end against a fake Studio: Studio provisions the shop
 * (signed), pushes snapshots (signed), its owner signs in through a handoff, the owner adds a staff
 * member who already has a verified Studio identity, the shop is suspended (READ_ONLY), re-enabled
 * with the AI switch on, reads a receipt with the key pulled from Studio, and is archived (CLOSED
 * for good). Nothing secret may reach the console on the way.
 */

const { db } = useTestDb();

const SYNC = "acceptance-sync-secret-0001";
const OUT = "acceptance-out-secret-0002";
const HANDOFF = "acceptance-handoff-secret-0003";
const STUDIO = "https://studio.example";
const APP = "http://localhost:3000"; // APP_URL from vitest.config.ts
const STUDIO_KEY = "sk-ant-acceptance-studio-key-0004";
const CORE_BIZ = "core-biz-acceptance";
const OWNER = { coreUserId: "core-user-owner", email: "owner@acceptance.test", emailVerified: true, name: "Owner" };

const ENV = [
  "CORE_BASE_URL",
  "CORE_SYNC_SECRET",
  "CORE_SYNC_SECRET_PREVIOUS",
  "CORE_OUT_SECRET",
  "CORE_HANDOFF_SECRET",
  "CORE_HANDOFF_SECRET_PREVIOUS",
  "ANTHROPIC_API_KEY",
] as const;
const saved: Record<string, string | undefined> = {};
const logged: string[] = [];

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, { CORE_BASE_URL: STUDIO, CORE_SYNC_SECRET: SYNC, CORE_OUT_SECRET: OUT, CORE_HANDOFF_SECRET: HANDOFF });
  resetCoreKeyCache();
  logged.length = 0;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(
        args
          .map((a) => (typeof a === "string" ? a : JSON.stringify(a, (_k, v: unknown) => (v instanceof Error ? `${v.name}: ${v.message}` : v))))
          .join(" "),
      );
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  setCoreClientFake(undefined);
  globalThis.__intakeFake = undefined;
  resetCoreKeyCache();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const DAY = 86_400_000;
function snapshot(version: number, over: Record<string, unknown> = {}) {
  return {
    coreBusinessId: CORE_BIZ,
    version,
    status: "ACTIVE",
    plan: { code: "retail-pro", name: "Retail Pro", maxBranches: 2, maxTerminals: 4, maxUsers: 9, storageMb: 2048, aiMonthly: 10 },
    subscription: {
      status: "ACTIVE",
      trialEndsAt: null,
      currentPeriodStart: new Date(Date.now() - DAY).toISOString(),
      currentPeriodEnd: new Date(Date.now() + 30 * DAY).toISOString(),
      graceDays: 5,
    },
    aiIntake: false,
    owner: OWNER,
    ...over,
  };
}

function signedPost(path: string, body: unknown) {
  const text = JSON.stringify(body);
  return new Request(`http://localhost${path}`, {
    method: "POST",
    body: text,
    headers: { "content-type": "application/json", ...signRequest("POST", path, text, SYNC) },
  });
}

const push = (state: ReturnType<typeof snapshot>) => statePOST(signedPost("/api/core/v1/state", state));

const nonceFor = (state: string) => createHash("sha256").update(state, "utf8").digest("base64url");

/** The owner's sign-in: /start, then Studio (this test) sends a token bound to the start's nonce back. */
async function ownerSignsIn() {
  const start = await startGET(new Request(`${APP}/api/core/v1/handoff/start`));
  const location = new URL(start.headers.get("location")!);
  const state = location.searchParams.get("state")!;
  const cookie = start.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .join("; ");
  const iat = Math.floor(Date.now() / 1000);
  const token = signHandoffForTests(
    { aud: "retail", iat, exp: iat + 60, nonce: location.searchParams.get("nonce")!, jti: randomUUID(), ...OWNER, coreBusinessId: CORE_BIZ },
    HANDOFF,
  );
  expect(location.searchParams.get("nonce")).toBe(nonceFor(state));
  const res = await callbackGET(
    new Request(`${APP}/api/core/v1/handoff/callback?token=${encodeURIComponent(token)}&state=${encodeURIComponent(state)}`, {
      headers: { cookie },
    }),
  );
  return { res, token, state };
}

describe("Studio link: the whole chain", () => {
  it("provision -> snapshots -> handoff -> staff identity -> suspend -> AI read -> archive", async () => {
    const secrets: string[] = [SYNC, OUT, HANDOFF, STUDIO_KEY];

    // Studio's fake: the key it hands out, and an identity service that already knows the cashier.
    const getAiConfig = vi.fn(async () => ({ apiKey: STUDIO_KEY, model: null }));
    const ensureIdentity = vi.fn(async (email: string) => ({ coreUserId: `cu_${email}`, created: false, emailVerified: true }));
    setCoreClientFake({ getAiConfig, ensureIdentity });

    // 1. Provision (signed): a shop with its branch, the Studio link, the first snapshot (AI off).
    const provisioned = await provisionPOST(
      signedPost("/api/core/v1/provision", {
        coreBusinessId: CORE_BIZ,
        name: "سوق الاعتماد",
        activityType: "MARKET",
        capabilities: [],
        branches: [{ name: "Main" }],
        currencies: ["IQD", "USD"],
        state: snapshot(1),
      }),
    );
    expect(provisioned.status).toBe(200);
    const { businessId } = (await provisioned.json()) as { businessId: string };
    expect(await db.rtInvitation.count({ where: { businessId } })).toBe(0);
    expect((await db.rtBusiness.findUniqueOrThrow({ where: { id: businessId } })).coreBusinessId).toBe(CORE_BIZ);

    // 2. A later snapshot (AI still off), then the reconcile read agrees.
    expect((await push(snapshot(2))).status).toBe(200);
    expect(await featureEnabled(businessId, AI_INTAKE_FEATURE)).toBe(false);
    const path = `/api/core/v1/state?coreBusinessId=${CORE_BIZ}`;
    const reconcile = await stateGET(new Request(`http://localhost${path}`, { headers: signRequest("GET", path, "", SYNC) }));
    expect(reconcile.status).toBe(200);
    expect(JSON.stringify(await reconcile.json())).toContain('"version":2');

    // 3. The owner signs in through the handoff and lands in the shop as its OWNER.
    const signedIn = await ownerSignsIn();
    secrets.push(signedIn.token, signedIn.state);
    expect(signedIn.res.status).toBe(302);
    expect(signedIn.res.headers.get("location")).toBe("/retail/home");
    expect(signedIn.res.headers.getSetCookie().some((c) => /session_token=/.test(c))).toBe(true);
    const owner = await db.user.findUniqueOrThrow({ where: { coreUserId: OWNER.coreUserId } });
    expect(await db.rtStaff.findFirst({ where: { businessId, userId: owner.id, role: "OWNER", deactivatedAt: null } })).not.toBeNull();
    const ownerMeta = () => ({ userId: owner.id, businessId, idempotencyKey: randomUUID() });

    // 4. The owner adds a cashier whose email already has a verified Studio identity.
    const cashier = await createUser(db, { email: "cashier@acceptance.test" });
    const branch = await db.rtBranch.findFirstOrThrow({ where: { businessId } });
    const added = await completeSetupStep(
      { step: 5, data: { staff: [{ email: cashier.email, role: "CASHIER", branchIds: [branch.id] }] } },
      ownerMeta(),
    );
    expect(added.ok).toBe(true);
    expect(ensureIdentity).toHaveBeenCalledWith(cashier.email, cashier.name);
    expect((await db.user.findUniqueOrThrow({ where: { id: cashier.id } })).coreUserId).toBe(`cu_${cashier.email}`);
    expect(await db.rtStaff.count({ where: { businessId, userId: cashier.id } })).toBe(1);

    // 5. SUSPENDED: read only; a write action is refused and writes nothing.
    expect((await push(snapshot(3, { status: "SUSPENDED" }))).status).toBe(200);
    expect(await gateOf(businessId, db)).toBe("READ_ONLY");
    const products = await db.rtProduct.count({ where: { businessId } });
    const refused = await createProduct(
      { nameAr: "سكر", baseUnit: { name: "قطعة", barcodes: [] }, price: { currency: "IQD", amountMinor: 1000n } },
      ownerMeta(),
    );
    expect(refused).toMatchObject({ ok: false, code: "READ_ONLY" });
    expect(await db.rtProduct.count({ where: { businessId } })).toBe(products);

    // 6. Active again with aiIntake on: the master switch flips (by the snapshot, not by hand).
    expect((await push(snapshot(4, { aiIntake: true }))).status).toBe(200);
    expect(await gateOf(businessId, db)).toBe("FULL");
    expect(await featureEnabled(businessId, AI_INTAKE_FEATURE)).toBe(true);

    // 7. A receipt read: consent, the fake provider, and the key pulled from Studio. Charged once.
    const consent = await grantAiConsent({}, ownerMeta());
    expect(consent.ok).toBe(true);
    const key = await resolveAnthropicKey();
    expect(key?.apiKey).toBe(STUDIO_KEY);
    expect(getAiConfig).toHaveBeenCalledTimes(1);
    globalThis.__intakeFake = {
      supplier: "شركة الرافدين",
      date: "2026-10-30",
      currency: "IQD",
      receiptNo: "9001",
      total: "2500",
      lines: [{ description: "سكر 1 كغم", quantity: "2", unitText: "قطعة", unitPrice: "1250", lineTotal: "2500", confidence: 0.9 }],
    };
    const created = await createIntake(
      { files: [{ contentType: "image/jpeg", bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...randomBytes(252)]) }] },
      ownerMeta(),
    );
    if (!created.ok) throw new Error(created.code);
    const read = await runIntakeRead({ intakeId: created.value.intakeId }, ownerMeta());
    expect(read.ok, JSON.stringify(read)).toBe(true);
    const status = await getAiStatus({}, ownerMeta());
    if (!status.ok) throw new Error(status.code);
    expect(status.value.limitHalfUnits).toBe(20); // the plan came from Studio's snapshot (aiMonthly 10)
    expect(status.value.usedHalfUnits).toBe(2);

    // 8. ARCHIVED: closed. A later ACTIVE snapshot does not reopen it.
    expect((await push(snapshot(5, { status: "ARCHIVED", aiIntake: true }))).status).toBe(200);
    expect(await gateOf(businessId, db)).toBe("CLOSED");
    expect((await push(snapshot(6, { status: "ACTIVE", aiIntake: true }))).status).toBe(200);
    expect(await gateOf(businessId, db)).toBe("CLOSED");
    expect((await db.rtBusiness.findUniqueOrThrow({ where: { id: businessId } })).status).toBe("ARCHIVED");

    // Nothing secret reached the console during the whole run.
    const escaped = secrets.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    expect(logged.join("\n")).not.toMatch(new RegExp(escaped.join("|")));
  });
});
