import type { ReactNode } from "react";
import type { CategoryKind } from "./category-kind";

/*
 * One small line glyph per department key (24px grid, 2px round strokes, drawn in the tile's accent).
 * "all" has its own and "other" doubles as the generic fallback.
 */

const GLYPH: Record<CategoryKind, ReactNode> = {
  all: <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />,
  dairy: <path d="M7 8l2-5h6l2 5v12a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1zM7 8h10M10 14h4" />,
  bakery: <path d="M5 10a4 4 0 0 1 3-6h8a4 4 0 0 1 3 6v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1zM9 12v4M12 12v4M15 12v4" />,
  fruit_veg: <path d="M12 7c-2-2-7-1-7 5 0 4 3 8 5 8 1 0 1-.5 2-.5s1 .5 2 .5c2 0 5-4 5-8 0-6-5-7-7-5zM12 7c0-2 1-3 3-4" />,
  meat_poultry: <path d="M15.5 3.5a5 5 0 0 1 5 5c0 2.5-1.8 4.5-4 4.9L14 15.5 9.5 20a2 2 0 1 1-3-3L11 12.5l2-2.4c.4-2.2 2.4-4.1 4.5-4.6z" />,
  fish: <path d="M3 12c3-5 8-6 12-4l4-3v14l-4-3c-4 2-9 1-12-4zM8 11.5h.01" />,
  frozen: <path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9M9.5 4.5 12 6l2.5-1.5M9.5 19.5 12 18l2.5 1.5" />,
  staples: <path d="M9 3h6l-1 3c3 2 5 6 5 10a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4c0-4 2-8 5-10zM8 6.5h8" />,
  canned: <path d="M6 6c0-1.7 2.7-3 6-3s6 1.3 6 3-2.7 3-6 3-6-1.3-6-3zM6 6v12c0 1.7 2.7 3 6 3s6-1.3 6-3V6M6 12c0 1.7 2.7 3 6 3s6-1.3 6-3" />,
  spices: <path d="M9 3h6v3H9zM8 6h8l1 3v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V9zM10 12h4M10 16h4" />,
  breakfast: <path d="M12 3c3.5 0 6 5 6 9a6 6 0 0 1-12 0c0-4 2.5-9 6-9z" />,
  snacks: <path d="M6 4h12l-1 4 1 12H6l1-12zM6 4l1.5 2L9 4l1.5 2L12 4l1.5 2L15 4l1.5 2L18 4M9 13h6" />,
  sweets: <path d="M9 9a4 4 0 1 1 6 6 4 4 0 0 1-6-6zM6.5 9.5 3 8l1.5 3.5M17.5 14.5 21 16l-1.5-3.5" />,
  tea_coffee: <path d="M5 9h11v6a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5zM16 11h2a2 2 0 0 1 0 4h-2M8 3v3M11 3v3M14 3v3" />,
  beverages: <path d="M10 3h4v4l2 3v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10l2-3zM8 14h8" />,
  cleaning: <path d="M9 11h6v9a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1zM10 11V8h4v3M10 5h4l3-1v3l-3-.5M18 10h2M18 13h2" />,
  personal_care: <path d="M12 3c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11zM9.5 15a2.5 2.5 0 0 0 2.5 2.5" />,
  baby: <path d="M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM9 11h.01M15 11h.01M9.5 15c1.5 1.5 3.5 1.5 5 0M12 4c1 1.5 2.5 2 3.5 1.5" />,
  pet: (
    <>
      <path d="M12 13c-3 0-5 2-5 4 0 1.5 1.5 2.5 3 2.5 1 0 1.3-.5 2-.5s1 .5 2 .5c1.5 0 3-1 3-2.5 0-2-2-4-5-4z" />
      <circle cx="5.5" cy="11" r="1.4" />
      <circle cx="9.5" cy="6.5" r="1.4" />
      <circle cx="14.5" cy="6.5" r="1.4" />
      <circle cx="18.5" cy="11" r="1.4" />
    </>
  ),
  household: <path d="M4 11l8-7 8 7M6 10v10h12V10M10 20v-5h4v5" />,
  stationery: <path d="M4 20l1-4L16 5l3 3L8 19zM14 7l3 3" />,
  health: <path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z" />,
  tobacco: <path d="M3 15h13v3H3zM18 15v3M21 15v3M18 11c0-2 2-2 2-4" />,
  phones: <path d="M8 2h8a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM11 18h2" />,
  phone_accessories: <path d="M9 2v5M15 2v5M7 7h10v4a5 5 0 0 1-10 0zM12 16v6" />,
  computers: <path d="M5 5h14v10H5zM3 19h18" />,
  computer_accessories: <path d="M12 3a6 6 0 0 1 6 6v6a6 6 0 0 1-12 0V9a6 6 0 0 1 6-6zM12 3v6" />,
  gaming: <path d="M7 8h10a5 5 0 0 1 5 5v1a3 3 0 0 1-5.2 2L15 14H9l-1.8 2A3 3 0 0 1 2 14v-1a5 5 0 0 1 5-5zM8 10.5v3M6.5 12h3M16 11.5h.01M18 13.5h.01" />,
  tv_audio: <path d="M3 6h18v11H3zM8 21h8M12 17v4" />,
  smart_devices: <path d="M8 3h8l1 4v10l-1 4H8l-1-4V7zM12 9v3l2 1.5" />,
  cameras: <path d="M4 8h3l2-3h6l2 3h3v11H4zM12 11a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z" />,
  networking: <path d="M2 9a14 14 0 0 1 20 0M5 12.5a9.5 9.5 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01" />,
  power: <path d="M13 2 4 14h7l-1 8 9-12h-7z" />,
  small_appliances: <path d="M6 10h10l1 10H5zM16 13h2.5a2 2 0 0 1 0 4H16.5M9 10V7h4v3M8 7h6" />,
  sim_credit: <path d="M6 2h8l4 4v16H6zM9 12h6v6H9zM12 12v6" />,
  spare_parts: <path d="M14.5 6.5a4 4 0 0 0-5 5L3 18l3 3 6.5-6.5a4 4 0 0 0 5-5l-2.5 2.5-2.5-.5-.5-2.5z" />,
  women: <path d="M9 3l3 3 3-3 1.5 6L18 21H6l1.5-12zM8 11h8" />,
  men: <path d="M8 3l4 3 4-3 5 4-3 4-2-1.5V21H8v-9.5L6 13 3 7z" />,
  kids: <path d="M12 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM6 21v-4a6 6 0 0 1 12 0v4" />,
  infants: <path d="M8 4l4 2 4-2 3 4-2.5 2V20h-9V10L5 8zM9 14h6" />,
  shoes: <path d="M3 16V9l4 3 4-2 4 3h4a2 2 0 0 1 2 2v1zM3 19h18" />,
  bags: <path d="M5 8h14l1 13H4zM9 8V6a3 3 0 0 1 6 0v2" />,
  accessories: <path d="M2 11h20M5.5 11v3a3 3 0 0 0 6 0v-3M12.5 11v3a3 3 0 0 0 6 0v-3" />,
  underwear: <path d="M9 3h6v9l5 4a3 3 0 0 1-2 5h-3a3 3 0 0 1-2-1l-4-4zM9 7h6" />,
  sportswear: <path d="M5 4l4-1c.5 1.5 1.5 2 3 2s2.5-.5 3-2l4 1 2 5-3 1v10H6V10L3 9zM12 5v15" />,
  outerwear: <path d="M9 3l3 4 3-4 4 2v16h-4V11l-3 3-3-3v10H5V5zM12 7v14" />,
  perfumes: <path d="M10 3h4v3h-4zM8 6h8v3H8zM6 9h12v12H6zM12 13v4" />,
  fabrics: <path d="M7 4h10M7 20h10M8 4v16M16 4v16M8 9l8 2M8 13l8 2" />,
  other: <path d="M3 12V4h8l10 10-8 8zM7.5 8h.01" />,
};

export function CategoryGlyph({ kind }: { kind: CategoryKind }) {
  return (
    <svg className="till-cattile-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {GLYPH[kind]}
    </svg>
  );
}

/** The arrow of the "Open" label; it mirrors in right-to-left text. */
export function OpenArrow() {
  return (
    <svg className="till-cattile-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

export const hasGlyph = (kind: CategoryKind) => Object.prototype.hasOwnProperty.call(GLYPH, kind);
