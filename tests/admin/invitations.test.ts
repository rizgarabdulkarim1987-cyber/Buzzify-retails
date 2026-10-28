import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acceptInvitation, inviteOwner, resendInvitation } from "@/server/admin/invitations";
import { provisionBusiness } from "@/server/admin/provision";
import { MemoryMailer, setMailer } from "@/server/email/mailer";
import { resolveActor } from "@/server/framework/actor";
import { dumpAllRows, useTestDb } from "../helpers/db";
import { createPlan, createPlatformAdmin, createUser } from "../helpers/fixtures";

const { db } = useTestDb();

let mailer: MemoryMailer;
beforeEach(() => {
  mailer = new MemoryMailer();
  setMailer(mailer);
});
afterEach(() => setMailer(undefined));

const ARABIC = /[؀-ۿ]/;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** A provisioned business with its owner invitation, and an invitee user with the matching email. */
async function world() {
  await createPlan(db);
  const adminUser = await createPlatformAdmin(db);
  const admin = (key: string) => ({ userId: adminUser.id, idempotencyKey: key });
  const r = await provisionBusiness(
    {
      name: "متجر الأناقة",
      activityType: "CLOTHING",
      capabilities: [],
      branches: [{ name: "الرئيسي" }],
      ownerEmail: "owner@example.test",
      currencies: ["IQD"],
      planCode: "basic",
      trialDays: 14,
    },
    admin("provision"),
  );
  if (!r.ok) throw new Error(`provision failed: ${r.code}`);
  // Better Auth may keep the user's email in another case: matching is case-insensitive.
  const invitee = await createUser(db, { email: "Owner@Example.test" });
  const as = (userId: string, key: string) => ({ userId, idempotencyKey: key });
  return { ...r.value, token: r.value.token!, admin, adminUser, invitee, as };
}

const owners = (businessId: string) => db.rtStaff.count({ where: { businessId, role: "OWNER" } });

describe("acceptInvitation", () => {
  it("creates the OWNER, activates the business, marks the invitation used and audits, together", async () => {
    const w = await world();
    const r = await acceptInvitation({ token: w.token }, w.as(w.invitee.id, "a1"));
    expect(r).toMatchObject({ ok: true, value: { businessId: w.businessId } });

    const staff = await db.rtStaff.findMany({ where: { businessId: w.businessId } });
    expect(staff).toHaveLength(1);
    expect(staff[0]).toMatchObject({ userId: w.invitee.id, role: "OWNER", deactivatedAt: null });
    expect(await db.rtStaffBranch.count()).toBe(0);
    // OWNER resolves to every branch without RtStaffBranch rows.
    expect(await resolveActor(w.invitee.id, w.businessId)).toMatchObject({ role: "OWNER", branchIds: "ALL" });

    const business = await db.rtBusiness.findUniqueOrThrow({ where: { id: w.businessId } });
    expect(business.status).toBe("ACTIVE");
    expect(business.version).toBe(2);
    const inv = await db.rtInvitation.findUniqueOrThrow({ where: { id: w.invitationId } });
    expect(inv.usedAt).toBeInstanceOf(Date);

    const audit = await db.rtAuditLog.findFirstOrThrow({ where: { action: "invitation.accept" } });
    expect(audit).toMatchObject({ businessId: w.businessId, actorId: w.invitee.id, entity: "RtInvitation", entityId: w.invitationId });
    expect(await dumpAllRows(db)).not.toContain(w.token);
  });

  it("accepting an invitation twice or after resend of a newer one fails and creates one owner", async () => {
    const w = await world();
    // Resend: the first token stops working, only the newest one does.
    const resent = await resendInvitation({ invitationId: w.invitationId }, w.admin("resend"));
    expect(resent.ok).toBe(true);
    if (!resent.ok) return;
    const newToken = resent.value.token!;
    expect(newToken).not.toBe(w.token);

    const old = await acceptInvitation({ token: w.token }, w.as(w.invitee.id, "old"));
    expect(old).toMatchObject({ ok: false, code: "INVITATION_INVALID" });
    expect((old as { message: string }).message).toMatch(ARABIC);
    expect(await owners(w.businessId)).toBe(0);

    expect(await acceptInvitation({ token: newToken }, w.as(w.invitee.id, "new"))).toMatchObject({ ok: true });
    // A second accept (new idempotency key) of the used token fails.
    expect(await acceptInvitation({ token: newToken }, w.as(w.invitee.id, "again"))).toMatchObject({
      ok: false,
      code: "INVITATION_INVALID",
    });
    // Same key: the stored result is replayed, nothing runs twice.
    expect(await acceptInvitation({ token: newToken }, w.as(w.invitee.id, "new"))).toMatchObject({ ok: true });
    expect(await owners(w.businessId)).toBe(1);
    expect(await db.rtAuditLog.count({ where: { action: "invitation.accept" } })).toBe(1);
  });

  it("concurrent accepts of one token create one owner", async () => {
    const w = await world();
    const results = await Promise.all(
      ["c1", "c2", "c3"].map((k) => acceptInvitation({ token: w.token }, w.as(w.invitee.id, k)).catch((e: unknown) => e)),
    );
    expect(results.filter((r) => (r as { ok?: boolean }).ok === true)).toHaveLength(1);
    expect(await owners(w.businessId)).toBe(1);
  });

  it("an expired invitation is refused", async () => {
    const w = await world();
    await db.rtInvitation.update({ where: { id: w.invitationId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const r = await acceptInvitation({ token: w.token }, w.as(w.invitee.id, "k"));
    expect(r).toMatchObject({ ok: false, code: "INVITATION_EXPIRED" });
    expect(await owners(w.businessId)).toBe(0);
    expect((await db.rtBusiness.findUniqueOrThrow({ where: { id: w.businessId } })).status).toBe("SETUP");
    expect((await db.rtInvitation.findUniqueOrThrow({ where: { id: w.invitationId } })).usedAt).toBeNull();
  });

  it("a user with a different email is FORBIDDEN and the invitation stays unused", async () => {
    const w = await world();
    const stranger = await createUser(db, { email: "attacker@example.test" });
    const r = await acceptInvitation({ token: w.token }, w.as(stranger.id, "k"));
    expect(r).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await owners(w.businessId)).toBe(0);
    expect((await db.rtInvitation.findUniqueOrThrow({ where: { id: w.invitationId } })).usedAt).toBeNull();
    expect(await db.rtAuditLog.count({ where: { action: "invitation.accept" } })).toBe(0);
    // The rightful invitee can still accept.
    expect(await acceptInvitation({ token: w.token }, w.as(w.invitee.id, "k"))).toMatchObject({ ok: true });
  });

  it("an unknown token, an unknown user and a malformed token are refused", async () => {
    const w = await world();
    expect(await acceptInvitation({ token: "A".repeat(43) }, w.as(w.invitee.id, "k1"))).toMatchObject({
      code: "INVITATION_INVALID",
    });
    expect(await acceptInvitation({ token: w.token }, w.as("no-such-user", "k2"))).toMatchObject({ code: "FORBIDDEN" });
    expect(await acceptInvitation({ token: "short" }, w.as(w.invitee.id, "k3"))).toMatchObject({ code: "INVALID_INPUT" });
    expect(await acceptInvitation({ token: w.token }, w.as(w.invitee.id, ""))).toMatchObject({ code: "INVALID_INPUT" });
    expect(await owners(w.businessId)).toBe(0);
  });

  it("a user already staff of the business gets a clear error and nothing changes", async () => {
    const w = await world();
    await db.rtStaff.create({ data: { businessId: w.businessId, userId: w.invitee.id, role: "CASHIER" } });
    const r = await acceptInvitation({ token: w.token }, w.as(w.invitee.id, "k"));
    expect(r).toMatchObject({ ok: false, code: "ALREADY_MEMBER" });
    expect((r as { message: string }).message).toMatch(ARABIC);
    expect((await db.rtInvitation.findUniqueOrThrow({ where: { id: w.invitationId } })).usedAt).toBeNull();
    expect(await owners(w.businessId)).toBe(0);
  });
});

describe("inviteOwner and resendInvitation", () => {
  it("the token is stored only as its sha256; the mail carries the APP_URL link", async () => {
    const w = await world();
    const inv = await db.rtInvitation.findUniqueOrThrow({ where: { id: w.invitationId } });
    expect(inv.tokenHash).toBe(sha256(w.token));
    expect(inv.tokenHash).not.toBe(w.token);
    expect(mailer.messages.at(-1)!.text).toContain(`http://localhost:3000/invite#token=${w.token}`);
    const audits = await db.rtAuditLog.findMany();
    expect(JSON.stringify(audits)).not.toContain(w.token);
    expect(JSON.stringify(await db.rtIdempotency.findMany())).not.toContain(w.token);
  });

  it("resend supersedes every older unused invitation and mails the new link", async () => {
    const w = await world();
    const second = await inviteOwner({ businessId: w.businessId, email: "OWNER@example.test" }, w.admin("i2"));
    expect(second.ok).toBe(true);
    const third = await resendInvitation({ invitationId: w.invitationId }, w.admin("i3"));
    expect(third.ok).toBe(true);
    if (!second.ok || !third.ok) return;

    const all = await db.rtInvitation.findMany({ where: { businessId: w.businessId }, orderBy: { createdAt: "asc" } });
    expect(all).toHaveLength(3);
    expect(all.filter((i) => i.supersededAt === null).map((i) => i.id)).toEqual([third.value.invitationId]);
    expect(all.every((i) => i.email === "owner@example.test")).toBe(true);
    expect(mailer.messages).toHaveLength(3);
    expect(mailer.messages[2]!.text).toContain(third.value.token!);

    expect(await acceptInvitation({ token: second.value.token! }, w.as(w.invitee.id, "x"))).toMatchObject({
      code: "INVITATION_INVALID",
    });
    expect(await acceptInvitation({ token: third.value.token! }, w.as(w.invitee.id, "y"))).toMatchObject({ ok: true });
  });

  it("no new owner invitation once the business has an owner", async () => {
    const w = await world();
    expect(await acceptInvitation({ token: w.token }, w.as(w.invitee.id, "a"))).toMatchObject({ ok: true });
    expect(await resendInvitation({ invitationId: w.invitationId }, w.admin("r"))).toMatchObject({
      ok: false,
      code: "OWNER_EXISTS",
    });
    expect(await inviteOwner({ businessId: w.businessId, email: "other@example.test" }, w.admin("i"))).toMatchObject({
      ok: false,
      code: "OWNER_EXISTS",
    });
    expect(await db.rtInvitation.count()).toBe(1);
  });

  it("only a platform admin may invite or resend; unknown targets are NOT_FOUND", async () => {
    const w = await world();
    const before = await db.rtInvitation.count();
    expect(await inviteOwner({ businessId: w.businessId, email: "x@example.test" }, w.as(w.invitee.id, "k"))).toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await resendInvitation({ invitationId: w.invitationId }, w.as(w.invitee.id, "k"))).toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await inviteOwner({ businessId: "nope", email: "x@example.test" }, w.admin("k1"))).toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await resendInvitation({ invitationId: "nope" }, w.admin("k2"))).toMatchObject({ code: "NOT_FOUND" });
    expect(await db.rtInvitation.count()).toBe(before);
    expect(mailer.messages).toHaveLength(1);
  });
});
