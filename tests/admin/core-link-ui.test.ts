import { readFileSync } from "node:fs";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ar } from "@/messages/ar";
import { ckb } from "@/messages/ckb";
import { en } from "@/messages/en";
import { listBusinesses } from "@/server/admin/directory";
import { AiSwitchRow } from "../../src/app/admin/ai-switch";
import { useTestDb } from "../helpers/db";
import { createBusinessWithStaff, createPlatformAdmin } from "../helpers/fixtures";

const { db } = useTestDb();
const html = (el: ReactElement) => renderToStaticMarkup(el);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

describe("admin: businesses linked to Studio", () => {
  it("the directory says which businesses are linked (coreBusinessId), standalone ones are not", async () => {
    const admin = await createPlatformAdmin(db);
    const linked = await createBusinessWithStaff(db);
    const standalone = await createBusinessWithStaff(db);
    await db.rtBusiness.update({ where: { id: linked.business.id }, data: { coreBusinessId: "core-1" } });
    const r = await listBusinesses({}, { userId: admin.id, idempotencyKey: "k1" });
    if (!r.ok) throw new Error(r.code);
    const by = (id: string) => r.value.businesses.find((b) => b.id === id)!;
    expect(by(linked.business.id).coreLinked).toBe(true);
    expect(by(standalone.business.id).coreLinked).toBe(false);
  });

  const row = (coreLinked: boolean, t = ar) =>
    html(
      createElement(
        "table",
        null,
        createElement(
          "tbody",
          null,
          createElement(AiSwitchRow, { businessId: "b1", businessName: "متجر النور", enabled: false, columns: 6, coreLinked, t }, createElement("td", null, "اسم")),
        ),
      ),
    );

  it("a linked business shows the Studio notice with its reason visible and the switch aria-disabled", () => {
    for (const t of [ar, ckb, en]) {
      const out = row(true, t);
      expect(out).toContain(esc(t.adminCore.notice));
      expect(out).toContain(esc(t.adminCore.badge));
      expect(out).toMatch(/data-testid="ai-switch-toggle"/);
      const button = out.match(/<button[^>]*data-testid="ai-switch-toggle"[^>]*>|<button[^>]*aria-disabled="true"[^>]*>/)![0];
      expect(button).toContain('aria-disabled="true"');
      expect(button).toContain("aria-describedby=");
      // The reason is text on the page, referenced by the button; the native disabled flag is not used.
      expect(button).not.toMatch(/\sdisabled=""/);
      const id = button.match(/aria-describedby="([^"]+)"/)![1];
      expect(out).toContain(`id="${id}"`);
    }
  });

  it("a standalone business is unchanged: no notice, an enabled switch", () => {
    const out = row(false);
    expect(out).not.toContain(esc(ar.adminCore.notice));
    expect(out).not.toContain('aria-disabled="true"');
    expect(out).not.toContain("aria-describedby");
  });

  it("messages: adminCore has the same keys in ar, ckb and en, none empty", () => {
    const keys = Object.keys(ar.adminCore).sort();
    expect(keys.length).toBeGreaterThanOrEqual(2);
    for (const t of [ckb, en]) expect(Object.keys(t.adminCore).sort()).toEqual(keys);
    for (const t of [ar, ckb, en]) for (const v of Object.values(t.adminCore)) expect(v.trim()).not.toBe("");
  });

  it("no coloured side stripes in the admin sources or the admin CSS block", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    const start = css.indexOf("/* Admin: the ai.intake switch");
    const block = css.slice(start, css.indexOf("/* Admin layout", start));
    expect(block).not.toMatch(/border-(inline-start|inline-end|left|right)(-color)?\s*:/);
    for (const f of ["ai-switch.tsx", "page.tsx"]) {
      expect(readFileSync(`src/app/admin/${f}`, "utf8")).not.toMatch(/border(Inline(Start|End)|Left|Right)/);
    }
  });
});
