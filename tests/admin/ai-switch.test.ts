import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ar } from "@/messages/ar";
import { ckb } from "@/messages/ckb";
import { en } from "@/messages/en";
import { listBusinesses } from "@/server/admin/directory";
import { overrideFeature } from "@/server/admin/lifecycle";
import { AI_INTAKE_FEATURE, featureEnabled } from "@/server/framework/features";
import { AiSwitchRow } from "../../src/app/admin/ai-switch";
import { aiAttempt, aiFailureText, aiReasonProblem, AI_REASON_MAX, AI_REASON_MIN } from "../../src/app/admin/ai-switch-rules";
import { AiReasonForm, AiStateBadge } from "../../src/app/admin/ai-switch-views";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createPlatformAdmin, createUser } from "../helpers/fixtures";

const { db } = useTestDb();

const REASON = "طلب المالك عبر الهاتف";
const html = (el: ReactElement) => renderToStaticMarkup(el);
/** A message as React writes it into markup. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

async function world() {
  const a = await createBusinessWithStaff(db, {
    staff: [
      { key: "owner", role: "OWNER" },
      { key: "manager", role: "MANAGER" },
    ],
  });
  const b = await createBusinessWithStaff(db);
  const admin = await createPlatformAdmin(db);
  let n = 0;
  const as = (userId: string) => ({ userId, idempotencyKey: `k${++n}` });
  const set = (businessId: string, enabled: boolean, userId = admin.id, reason = REASON) =>
    overrideFeature({ businessId, feature: AI_INTAKE_FEATURE, enabled, reason }, as(userId));
  return { a, b, admin, set };
}

describe("ai.intake switch: who may set it", () => {
  it("only a platform admin: the shop's owner, its manager and a plain user are refused and nothing is written", async () => {
    const w = await world();
    const outsider = await createUser(db);
    for (const userId of [w.a.staff.owner!.user.id, w.a.staff.manager!.user.id, outsider.id]) {
      expect(await w.set(w.a.business.id, true, userId)).toMatchObject({ ok: false, code: "FORBIDDEN" });
    }
    expect(await db.rtFeatureOverride.count()).toBe(0);
    expect(await db.rtAuditLog.count()).toBe(0);
    expect(await featureEnabled(w.a.business.id, AI_INTAKE_FEATURE)).toBe(false);

    expect(await w.set(w.a.business.id, true)).toMatchObject({ ok: true });
    expect(await featureEnabled(w.a.business.id, AI_INTAKE_FEATURE)).toBe(true);
  });

  it("a reason is required (10 characters after trimming); without one nothing is written", async () => {
    const w = await world();
    for (const reason of ["", "   ", "قصير", "         x         "]) {
      expect(await w.set(w.a.business.id, true, w.admin.id, reason), reason).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    }
    expect(await db.rtFeatureOverride.count()).toBe(0);
    expect(await db.rtAuditLog.count()).toBe(0);
  });

  it("each change is audited with the admin, the shop, the state and the reason", async () => {
    const w = await world();
    await w.set(w.a.business.id, true);
    await w.set(w.a.business.id, false, w.admin.id, "توقف مؤقت لحين الدفع");
    const audit = await db.rtAuditLog.findMany();
    expect(audit).toHaveLength(2);
    // Looked up by state, not by time: two audit rows can share a timestamp.
    const byState = (enabled: boolean) => audit.find((row) => (row.changes as { enabled?: unknown }).enabled === enabled);
    expect(byState(true)).toMatchObject({
      businessId: w.a.business.id,
      actorId: w.admin.id,
      action: "platform.feature.override",
      entity: "RtFeatureOverride",
      changes: { feature: "ai.intake", enabled: true, reason: REASON },
    });
    expect(byState(false)).toMatchObject({
      businessId: w.a.business.id,
      actorId: w.admin.id,
      changes: { feature: "ai.intake", enabled: false, reason: "توقف مؤقت لحين الدفع" },
    });
  });

  it("the same key sent twice (a retry after a lost answer) records one change", async () => {
    const w = await world();
    const meta = { userId: w.admin.id, idempotencyKey: "retry-1" };
    const input = { businessId: w.a.business.id, feature: AI_INTAKE_FEATURE, enabled: true, reason: REASON };
    const first = await overrideFeature(input, meta);
    const second = await overrideFeature(input, meta);
    expect(second).toEqual(first);
    expect(await db.rtFeatureOverride.count()).toBe(1);
  });
});

describe("ai.intake switch: the admin directory", () => {
  it("shows each shop's current state: none is off, the latest decides, one shop does not affect another", async () => {
    const w = await world();
    const state = async () => {
      const r = await listBusinesses({}, { userId: w.admin.id, idempotencyKey: "" });
      if (!r.ok) throw new Error(r.code);
      return Object.fromEntries(r.value.businesses.map((x) => [x.id, x.aiIntake]));
    };
    expect(await state()).toEqual({ [w.a.business.id]: false, [w.b.business.id]: false });
    await w.set(w.a.business.id, true);
    expect(await state()).toEqual({ [w.a.business.id]: true, [w.b.business.id]: false });
    await w.set(w.b.business.id, true);
    await w.set(w.a.business.id, false);
    expect(await state()).toEqual({ [w.a.business.id]: false, [w.b.business.id]: true });
    // Another feature's override never shows as this switch.
    await overrideFeature(
      { businessId: w.a.business.id, feature: "ai.assistant", enabled: true, reason: REASON },
      { userId: w.admin.id, idempotencyKey: "other" },
    );
    expect(await state()).toEqual({ [w.a.business.id]: false, [w.b.business.id]: true });
  });
});

describe("ai.intake switch: rules", () => {
  it("the reason must be 10 to 500 characters after trimming", () => {
    expect(AI_REASON_MIN).toBe(10);
    expect(AI_REASON_MAX).toBe(500);
    expect(aiReasonProblem("")).toBe("REASON_SHORT");
    expect(aiReasonProblem("  قصير جداً  ")).toBe("REASON_SHORT");
    expect(aiReasonProblem(REASON)).toBeNull();
    expect(aiReasonProblem("x".repeat(501))).toBe("REASON_LONG");
  });

  it("a retry of the same change keeps its key; a different change gets a new one", () => {
    let n = 0;
    const make = () => `key${++n}`;
    const first = aiAttempt(null, "b1:true:r", make);
    expect(first.key).toBe("key1");
    expect(aiAttempt(first, "b1:true:r", make)).toBe(first);
    expect(aiAttempt(first, "b1:false:r", make).key).toBe("key2");
  });

  it("failures read in the UI locale: INTERNAL, a reused key and a framework code", () => {
    expect(aiFailureText("INTERNAL", en)).toBe(en.internalError);
    expect(aiFailureText("FORBIDDEN", ckb)).toBe(ckb.errors.FORBIDDEN);
    expect(aiFailureText("IDEMPOTENCY_MISMATCH", ar)).toBe(ar.errors.IDEMPOTENCY_MISMATCH);
  });
});

describe("ai.intake switch: the UI", () => {
  const props = (enabled: boolean) => ({ businessId: "b1", businessName: "متجر النور", enabled, t: ar, columns: 6 });
  const row = (enabled: boolean) =>
    html(
      createElement(
        "table",
        null,
        createElement("tbody", null, createElement(AiSwitchRow, props(enabled), createElement("td", null, "اسم"))),
      ),
    );

  it("shows the current state and offers the opposite move, naming the shop for screen readers", () => {
    const off = row(false);
    expect(off).toContain(ar.adminAi.off);
    expect(off).toContain(ar.adminAi.enable);
    expect(off).toContain('data-state="off"');
    expect(off).toContain("متجر النور");
    expect(off).toContain('aria-expanded="false"');
    // The reason form is closed until asked for.
    expect(off).not.toContain("<textarea");
    // The page's own cells come first; the switch is the last cell of the same row.
    expect(off).toMatch(/^<table><tbody><tr><td>اسم<\/td><td class="ai-cell">/);

    const on = row(true);
    expect(on).toContain(ar.adminAi.on);
    expect(on).toContain(ar.adminAi.disable);
    expect(on).toContain('data-state="on"');
  });

  it("the badge reads in every locale", () => {
    for (const t of [ar, ckb, en]) {
      expect(html(createElement(AiStateBadge, { enabled: true, t }))).toContain(t.adminAi.on);
      expect(html(createElement(AiStateBadge, { enabled: false, t }))).toContain(t.adminAi.off);
    }
  });

  const form = (over: Partial<Parameters<typeof AiReasonForm>[0]> = {}) =>
    html(
      createElement(AiReasonForm, {
        id: "ai-b1",
        next: true,
        reason: "",
        problem: null,
        failure: null,
        sending: false,
        t: en,
        onReason: () => {},
        onSubmit: () => {},
        onCancel: () => {},
        ...over,
      }),
    );

  it("asks for a reason: a required, labelled field with the length limits and a hint", () => {
    const out = form();
    expect(out).toContain("<textarea");
    expect(out).toContain("required");
    expect(out).toContain('minLength="10"');
    expect(out).toContain('maxLength="500"');
    expect(out).toContain(en.adminAi.reason);
    expect(out).toContain(esc(en.adminAi.reasonHint));
    expect(out).toContain(en.adminAi.confirmEnable);
    expect(out).toContain(en.adminAi.cancel);
    expect(form({ next: false })).toContain(en.adminAi.confirmDisable);
  });

  it("a short reason is marked on the field; a failure is announced", () => {
    const out = form({ problem: "REASON_SHORT", failure: en.errors.FORBIDDEN });
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain(en.adminAi.reasonShort);
    expect(out).toContain('role="alert"');
    expect(out).toContain(en.errors.FORBIDDEN);
  });

  it("while sending, the confirm button keeps focus but is aria-disabled and busy", () => {
    const out = form({ sending: true });
    expect(out).toContain('aria-disabled="true"');
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain(en.adminAi.sending);
    // Not the disabled attribute: that would drop focus to the body.
    expect(out).not.toMatch(/<button[^>]*\sdisabled=""/);
  });

  it("messages: ar, ckb and en have the same adminAi keys, none empty", () => {
    const keys = Object.keys(ar.adminAi).sort();
    expect(keys.length).toBeGreaterThanOrEqual(10);
    for (const t of [ckb, en]) expect(Object.keys(t.adminAi).sort()).toEqual(keys);
    for (const t of [ar, ckb, en]) for (const v of Object.values(t.adminAi)) expect(v.trim()).not.toBe("");
    for (const t of [ar, ckb, en]) expect(t.errors.AI_DISABLED.trim()).not.toBe("");
  });
});
