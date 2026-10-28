import { describe, expect, it } from "vitest";
import { can, permissionsOf, ROLE_PERMISSIONS } from "@/server/domain/permissions";
import type { RtRole } from "@/generated/prisma/client";

describe("permissions", () => {
  it("CASHIER cannot view cost or change prices", () => {
    expect(can("CASHIER", "cost.view")).toBe(false);
    expect(can("CASHIER", "price.change")).toBe(false);
  });

  it("only OWNER and ACCOUNTANT hold cost.view and data.export", () => {
    const roles = Object.keys(ROLE_PERMISSIONS) as RtRole[];
    for (const p of ["cost.view", "data.export"] as const) {
      expect(roles.filter((r) => can(r, p)).sort()).toEqual(["ACCOUNTANT", "OWNER"]);
    }
  });

  it("AUDITOR holds no write permission", () => {
    const writes = ["price.change", "discount.override", "refund", "stock.receive", "stock.transfer", "supplier.pay", "staff.manage"] as const;
    const set = permissionsOf("AUDITOR");
    for (const p of writes) expect(set.has(p)).toBe(false);
    expect([...set]).toEqual(["multiBranch.access"]);
  });

  it("OWNER holds every permission", () => {
    const all = new Set(Object.values(ROLE_PERMISSIONS).flat());
    expect(permissionsOf("OWNER").size).toBe(14);
    expect(all.size).toBe(14);
  });
});
