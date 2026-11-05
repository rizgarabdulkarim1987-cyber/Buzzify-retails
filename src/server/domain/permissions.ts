import type { RtRole } from "@/generated/prisma/client";

const PERMISSION_LIST = [
  "cost.view",
  "price.change",
  "discount.override",
  "return.noInvoice",
  "refund",
  "count.adjust.approve",
  "stock.receive",
  "stock.transfer",
  "supplier.pay",
  "staff.manage",
  "data.export",
  "ai.use",
  "multiBranch.access",
  "support.grant",
  "catalog.manage",
  "catalog.import",
  "stock.adjust",
  "stock.view",
  // Grant or withdraw the business's consent to send images to the AI provider (R1b). OWNER only.
  "ai.consent",
  // R3 selling: ring up sales and open and close one's own cash-desk shift.
  "sale.create",
  // R3: close (or look at) another person's shift in one's branches.
  "shift.manage",
  // R3: record a cash expense paid from one's own open shift's drawer.
  "expense.create",
] as const;

export type Permission = (typeof PERMISSION_LIST)[number];

export const PERMISSIONS: readonly Permission[] = Object.freeze([...PERMISSION_LIST]);

const frozen = (list: readonly Permission[]): readonly Permission[] => Object.freeze([...list]);

export const ROLE_PERMISSIONS: Readonly<Record<RtRole, readonly Permission[]>> = Object.freeze({
  OWNER: frozen(PERMISSION_LIST),
  MANAGER: frozen([
    "price.change",
    "discount.override",
    "return.noInvoice",
    "refund",
    "count.adjust.approve",
    "stock.receive",
    "stock.transfer",
    "staff.manage",
    "ai.use",
    "multiBranch.access",
    "catalog.manage",
    "catalog.import",
    "stock.adjust",
    "stock.view",
    "sale.create",
    "shift.manage",
    "expense.create",
  ]),
  CASHIER: frozen(["stock.view", "sale.create", "expense.create"]),
  STOCK: frozen(["stock.receive", "stock.transfer", "catalog.manage", "stock.adjust", "stock.view"]),
  PURCHASING: frozen(["stock.receive", "ai.use", "stock.view"]),
  ACCOUNTANT: frozen(["cost.view", "data.export", "supplier.pay", "multiBranch.access", "stock.view"]),
  AUDITOR: frozen(["multiBranch.access", "stock.view"]),
});

export function permissionsOf(role: RtRole): ReadonlySet<Permission> {
  return new Set(ROLE_PERMISSIONS[role]);
}

export function can(role: RtRole, p: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(p);
}
