import type { ActivityType, Capability } from "@/server/domain/profiles";
import type { Permission } from "@/server/domain/permissions";

/*
 * A pack is what one Buzzify retail product is made of on top of the shared engine: its product
 * name and words, where a signed-in user lands, the sections it shows and the capabilities it
 * switches on by default. Data only: no database, no I/O, no React.
 */

export const PACK_IDS = ["SUPERMARKET", "ELECTRONICS", "CLOTHING"] as const;
export type PackId = (typeof PACK_IDS)[number];

export function isPackId(value: unknown): value is PackId {
  return typeof value === "string" && (PACK_IDS as readonly string[]).includes(value);
}

/** The sections a pack can show. Each one is an existing shared screen. */
export type NavId = "sell" | "catalog" | "stock" | "scan" | "setup";

export type NavSection = {
  id: NavId;
  route: string;
  /** The permission the user's role needs to see the section; null = every member. */
  permission: Permission | null;
  /** The section also needs a chosen branch (selling does). */
  needsBranch: boolean;
  /** "bar": an icon in the header bar; "more": under More on the shop menu. */
  placement: "bar" | "more";
};

/** The words a pack owns, per locale. Every pack has exactly these keys (tests/messages/parity). */
export type PackWords = {
  /** The full product name, brand included ("Buzzify Supermarket"). */
  productName: string;
  /** The product word shown after the brand in the wordmark ("Supermarket"). */
  productWord: string;
  /** The sign-in page heading. */
  loginTitle: string;
  nav: Readonly<Record<NavId | "more", string>>;
  /** The department cards of the till: the count line of the All card, the item count of a card, the "open" label. */
  till: { departments: string; categoryItems: string; open: string };
};

export type PackManifest = {
  id: PackId;
  /** The business activity type this pack serves. */
  activityType: ActivityType;
  /** Lowercase key used for the product address (supermarket.<domain>) and Studio's RETAIL_URL_<ID>. */
  hostKey: string;
  /** Which word set (src/packs/<wordSet>/words.ts) the pack speaks. */
  wordSet: string;
  /** Where a signed-in user lands. */
  home: string;
  nav: readonly NavSection[];
  /** Capabilities a new business of this pack starts with. */
  capabilities: readonly Capability[];
};
