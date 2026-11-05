import { describe, expect, it } from "vitest";
import { can, permissionsOf, PERMISSIONS, ROLE_PERMISSIONS, type Permission } from "@/server/domain/permissions";
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
    expect([...set].sort()).toEqual(["multiBranch.access", "stock.view"]);
  });

  it("OWNER holds every permission", () => {
    const all = new Set(Object.values(ROLE_PERMISSIONS).flat());
    expect(permissionsOf("OWNER").size).toBe(22);
    expect(all.size).toBe(22);
  });

  it("pins the whole role matrix", () => {
    const expected: Record<RtRole, Permission[]> = {
      OWNER: [...PERMISSIONS],
      MANAGER: ["price.change", "discount.override", "return.noInvoice", "refund", "count.adjust.approve", "stock.receive", "stock.transfer", "staff.manage", "ai.use", "multiBranch.access", "catalog.manage", "catalog.import", "stock.adjust", "stock.view", "sale.create", "shift.manage", "expense.create"],
      CASHIER: ["stock.view", "sale.create", "expense.create"],
      STOCK: ["stock.receive", "stock.transfer", "catalog.manage", "stock.adjust", "stock.view"],
      PURCHASING: ["stock.receive", "ai.use", "stock.view"],
      ACCOUNTANT: ["cost.view", "data.export", "supplier.pay", "multiBranch.access", "stock.view"],
      AUDITOR: ["multiBranch.access", "stock.view"],
    };
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual(Object.keys(expected).sort());
    for (const role of Object.keys(expected) as RtRole[]) {
      expect([...permissionsOf(role)].sort()).toEqual([...expected[role]].sort());
    }
  });

  it("catalog.manage and catalog.import follow the matrix and the permission table stays frozen", () => {
    const roles = Object.keys(ROLE_PERMISSIONS) as RtRole[];
    expect(roles.filter((r) => can(r, "catalog.manage")).sort()).toEqual(["MANAGER", "OWNER", "STOCK"]);
    expect(roles.filter((r) => can(r, "catalog.import")).sort()).toEqual(["MANAGER", "OWNER"]);
    expect(PERMISSIONS).toContain("catalog.manage");
    expect(PERMISSIONS).toContain("catalog.import");
    expect(PERMISSIONS.length).toBe(22);
    expect(Object.isFrozen(PERMISSIONS)).toBe(true);
  });

  it("stock.adjust and stock.view follow the matrix and the permission table stays frozen", () => {
    const roles = Object.keys(ROLE_PERMISSIONS) as RtRole[];
    expect(roles.filter((r) => can(r, "stock.adjust")).sort()).toEqual(["MANAGER", "OWNER", "STOCK"]);
    expect(roles.filter((r) => can(r, "stock.view")).sort()).toEqual(
      ["ACCOUNTANT", "AUDITOR", "CASHIER", "MANAGER", "OWNER", "PURCHASING", "STOCK"],
    );
    expect(PERMISSIONS).toContain("stock.adjust");
    expect(PERMISSIONS).toContain("stock.view");
    expect(PERMISSIONS.length).toBe(22);
    expect(Object.isFrozen(PERMISSIONS)).toBe(true);
  });

  it("ai.consent is the owner's alone and the permission table stays frozen", () => {
    const roles = Object.keys(ROLE_PERMISSIONS) as RtRole[];
    expect(roles.filter((r) => can(r, "ai.consent"))).toEqual(["OWNER"]);
    for (const role of roles.filter((r) => r !== "OWNER")) expect(permissionsOf(role).has("ai.consent"), role).toBe(false);
    expect(PERMISSIONS).toContain("ai.consent");
    expect(PERMISSIONS.length).toBe(22);
    expect(Object.isFrozen(PERMISSIONS)).toBe(true);
  });

  it("sale.create is the selling roles' and shift.manage the managers'", () => {
    const roles = Object.keys(ROLE_PERMISSIONS) as RtRole[];
    expect(roles.filter((r) => can(r, "sale.create")).sort()).toEqual(["CASHIER", "MANAGER", "OWNER"]);
    expect(roles.filter((r) => can(r, "shift.manage")).sort()).toEqual(["MANAGER", "OWNER"]);
  });

  it("the matrix is immutable at runtime and roles do not alias each other", () => {
    const table = ROLE_PERMISSIONS as Record<RtRole, Permission[]>;
    expect(() => table.CASHIER.push("cost.view")).toThrow(TypeError);
    expect(() => table.OWNER.push("refund")).toThrow(TypeError);
    expect(() => {
      table.CASHIER = [];
    }).toThrow(TypeError);
    expect(() => (PERMISSIONS as Permission[]).push("refund")).toThrow(TypeError);
    expect(Object.isFrozen(ROLE_PERMISSIONS)).toBe(true);
    for (const list of Object.values(ROLE_PERMISSIONS)) expect(Object.isFrozen(list)).toBe(true);
    expect(ROLE_PERMISSIONS.OWNER).not.toBe(PERMISSIONS);
    expect(can("CASHIER", "cost.view")).toBe(false);
  });
});
