import { CATALOG, SCAN, SELL, SETUP, STOCK } from "../shared-nav";
import type { Capability } from "@/server/domain/profiles";
import type { PackManifest } from "../types";

/** Buzzify Electronics: phones and devices. A serial number (IMEI) per unit and a warranty. */
export const electronics: PackManifest = Object.freeze({
  id: "ELECTRONICS",
  activityType: "ELECTRONICS",
  hostKey: "electronics",
  wordSet: "electronics",
  home: "/retail/home",
  nav: Object.freeze([SELL, CATALOG, STOCK, SCAN, SETUP]),
  capabilities: Object.freeze<Capability[]>(["SERIAL", "WARRANTY"]),
});
