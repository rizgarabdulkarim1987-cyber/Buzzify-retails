import { CATALOG, SCAN, SELL, SETUP, STOCK } from "../shared-nav";
import type { Capability } from "@/server/domain/profiles";
import type { PackManifest } from "../types";

/** Buzzify Supermarket: groceries and everyday goods. Batches and expiry, weighed items, several units per item, held sales. */
export const supermarket: PackManifest = Object.freeze({
  id: "SUPERMARKET",
  activityType: "MARKET",
  hostKey: "supermarket",
  wordSet: "supermarket",
  home: "/retail/home",
  nav: Object.freeze([SELL, CATALOG, STOCK, SCAN, SETUP]),
  capabilities: Object.freeze<Capability[]>(["BATCH", "WEIGHT", "MULTI_UNIT", "HOLDS"]),
});
