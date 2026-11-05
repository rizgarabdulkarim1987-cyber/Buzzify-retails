import type { NavSection } from "./types";

/*
 * The shared screens every pack shows today, with the role each one needs. A pack lists them in its
 * own manifest so it can drop or reorder a section later without touching another pack.
 */
export const SELL: NavSection = { id: "sell", route: "/retail/sell", permission: "sale.create", needsBranch: true, placement: "bar" };
export const CATALOG: NavSection = { id: "catalog", route: "/retail/catalog", permission: null, needsBranch: false, placement: "bar" };
export const STOCK: NavSection = { id: "stock", route: "/retail/stock", permission: "stock.view", needsBranch: false, placement: "bar" };
/** Same rule as the scan screen itself (scanEntry: catalog.manage). */
export const SCAN: NavSection = { id: "scan", route: "/retail/catalog/scan", permission: "catalog.manage", needsBranch: false, placement: "more" };
export const SETUP: NavSection = { id: "setup", route: "/retail/setup", permission: "staff.manage", needsBranch: false, placement: "more" };
