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
