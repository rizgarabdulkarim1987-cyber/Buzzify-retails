import type { RtRole } from "@/generated/prisma/client";

export const PERMISSIONS = [
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
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<RtRole, readonly Permission[]> = {
  OWNER: PERMISSIONS,
  MANAGER: [
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
  ],
  CASHIER: [],
  STOCK: ["stock.receive", "stock.transfer"],
  PURCHASING: ["stock.receive", "ai.use"],
  ACCOUNTANT: ["cost.view", "data.export", "supplier.pay", "multiBranch.access"],
  AUDITOR: ["multiBranch.access"],
};

export function permissionsOf(role: RtRole): ReadonlySet<Permission> {
  return new Set(ROLE_PERMISSIONS[role]);
}

export function can(role: RtRole, p: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(p);
}
