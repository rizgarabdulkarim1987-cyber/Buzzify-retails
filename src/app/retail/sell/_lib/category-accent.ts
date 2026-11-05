import type { CategoryKind } from "./category-kind";

/*
 * The accent of a department tile: light, bright tones that stay readable (4.5:1 or better) on the
 * near-black card. A standard department always has the same accent; an owner-made category gets
 * one from a hash of its name, so it never changes between visits or screens.
 */

/** The near-black card the accents sit on. */
export const CARD = "#05050f";
/** Quiet secondary ink on the card. */
export const DIM = "rgba(255, 255, 255, 0.62)";

export const PALETTE = {
  sky: "#60a5fa",
  amber: "#fbbf24",
  green: "#4ade80",
  red: "#f87171",
  cyan: "#22d3ee",
  indigo: "#a5b4fc",
  lime: "#a3e635",
  orange: "#fb923c",
  peach: "#fdba74",
  yellow: "#facc15",
  pink: "#f472b6",
  fuchsia: "#e879f9",
  teal: "#2dd4bf",
  violet: "#c4b5fd",
} as const;

const ORDER = Object.values(PALETTE);

/** Fixed accents of the 23 standard departments; the All tile is white. */
export const ACCENT: Record<Exclude<CategoryKind, "other">, string> = {
  all: "#ffffff",
  dairy: PALETTE.sky,
  bakery: PALETTE.amber,
  fruit_veg: PALETTE.green,
  meat_poultry: PALETTE.red,
  fish: PALETTE.cyan,
  frozen: PALETTE.indigo,
  staples: PALETTE.lime,
  canned: PALETTE.orange,
  spices: PALETTE.peach,
  breakfast: PALETTE.yellow,
  snacks: PALETTE.pink,
  sweets: PALETTE.fuchsia,
  tea_coffee: PALETTE.amber,
  beverages: PALETTE.teal,
  cleaning: PALETTE.violet,
  personal_care: PALETTE.pink,
  baby: PALETTE.sky,
  pet: PALETTE.lime,
  household: PALETTE.cyan,
  stationery: PALETTE.violet,
  health: PALETTE.green,
  tobacco: PALETTE.orange,
};

/** Small stable string hash (FNV-1a). */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** The accent for a department; `seed` (its id or name) picks one for a category that is no standard department. */
export function accentFor(kind: CategoryKind, seed: string): string {
  if (kind !== "other") return ACCENT[kind];
  return ORDER[hash(seed) % ORDER.length]!;
}

/** WCAG relative luminance of a #rrggbb colour. */
export function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}
