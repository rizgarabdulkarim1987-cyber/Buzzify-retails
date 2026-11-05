import type { Locale } from "@/messages";
import type { Permission } from "@/server/domain/permissions";
import { clothing } from "./clothing/manifest";
import { clothingWords } from "./clothing/words";
import { electronics } from "./electronics/manifest";
import { electronicsWords } from "./electronics/words";
import { supermarket } from "./supermarket/manifest";
import { supermarketWords } from "./supermarket/words";
import { PACK_IDS, type NavSection, type PackId, type PackManifest, type PackWords } from "./types";

export { PACK_IDS, isPackId } from "./types";
export type { NavId, NavSection, PackId, PackManifest, PackWords } from "./types";

/*
 * The pack registry. Adding a product = a folder with manifest.ts and words.ts, one line in each
 * map below, and its words in the guard test. Nothing else in the engine changes.
 */

const PACKS: Readonly<Record<PackId, PackManifest>> = Object.freeze({
  SUPERMARKET: supermarket,
  ELECTRONICS: electronics,
  CLOTHING: clothing,
});

const WORDS: Readonly<Record<string, Readonly<Record<Locale, PackWords>>>> = Object.freeze({
  supermarket: supermarketWords,
  electronics: electronicsWords,
  clothing: clothingWords,
});

/** The pack used for any activity type that has no pack of its own (MIXED, BEAUTY, STATIONERY, unknown). */
export const FALLBACK_PACK: PackId = "SUPERMARKET";

export function packById(id: PackId): PackManifest {
  return PACKS[id];
}

export function allPacks(): PackManifest[] {
  return PACK_IDS.map((id) => PACKS[id]);
}

/** The pack of a business's activity type; MIXED and every type without a pack get the supermarket. */
export function getPack(activityType: string | null | undefined): PackManifest {
  if (activityType === "MIXED") return PACKS[FALLBACK_PACK];
  return allPacks().find((p) => p.activityType === activityType) ?? PACKS[FALLBACK_PACK];
}

export function packWords(pack: PackManifest, locale: Locale): PackWords {
  return WORDS[pack.wordSet]![locale];
}

/** Every word set by its key (for the word-guard and parity tests). */
export function allPackWords(): Readonly<Record<string, Readonly<Record<Locale, PackWords>>>> {
  return WORDS;
}

/**
 * The sections of `pack` this role may open, in manifest order. `can` is the permission check
 * (src/server/domain/permissions), passed in so this file stays free of server imports.
 */
export function visibleNav(
  pack: PackManifest,
  access: { can: (p: Permission) => boolean; hasBranch: boolean },
  placement?: NavSection["placement"],
): NavSection[] {
  return pack.nav.filter(
    (s) => (placement === undefined || s.placement === placement) && (s.permission === null || access.can(s.permission)) && (!s.needsBranch || access.hasBranch),
  );
}
