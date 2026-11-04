import { CATALOG, SCAN, SELL, SETUP, STOCK } from "../shared-nav";
import type { Capability } from "@/server/domain/profiles";
import type { PackManifest } from "../types";

/** Buzzify Clothing: clothes and shoes. Sizes and colours as variants, held sales. */
export const clothing: PackManifest = Object.freeze({
  id: "CLOTHING",
  activityType: "CLOTHING",
  hostKey: "clothing",
  wordSet: "clothing",
  home: "/retail/home",
  nav: Object.freeze([SELL, CATALOG, STOCK, SCAN, SETUP]),
  capabilities: Object.freeze<Capability[]>(["VARIANTS", "HOLDS"]),
});
