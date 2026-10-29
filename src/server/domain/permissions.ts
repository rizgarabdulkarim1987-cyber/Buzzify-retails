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
  ]),
  CASHIER: frozen([]),
  STOCK: frozen(["stock.receive", "stock.transfer", "catalog.manage"]),
  PURCHASING: frozen(["stock.receive", "ai.use"]),
  ACCOUNTANT: frozen(["cost.view", "data.export", "supplier.pay", "multiBranch.access"]),
  AUDITOR: frozen(["multiBranch.access"]),
});

export function permissionsOf(role: RtRole): ReadonlySet<Permission> {
  return new Set(ROLE_PERMISSIONS[role]);
}

export function can(role: RtRole, p: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(p);
}
