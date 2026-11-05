import type { ReactNode } from "react";
import type { CategoryIconKind } from "./till";

/*
 * The category pictures of the till: one simple outline per kind of goods, on the same 24px grid
 * and stroke as the app's icon set. They are decoration (the name is always written beside them),
 * so they are hidden from screen readers.
 */

const SHAPES: Record<CategoryIconKind, ReactNode> = {
  grain: (
    <>
      <path d="M12 21V8" />
      <path d="M12 8c-2.6 0-4-1.6-4-4 2.6 0 4 1.6 4 4z" />
      <path d="M12 8c2.6 0 4-1.6 4-4-2.6 0-4 1.6-4 4z" />
      <path d="M12 14c-2.6 0-4-1.6-4-4 2.6 0 4 1.6 4 4z" />
      <path d="M12 14c2.6 0 4-1.6 4-4-2.6 0-4 1.6-4 4z" />
      <path d="M12 20c-2.6 0-4-1.6-4-4 2.6 0 4 1.6 4 4z" />
      <path d="M12 20c2.6 0 4-1.6 4-4-2.6 0-4 1.6-4 4z" />
    </>
  ),
  can: (
    <>
      <ellipse cx="12" cy="6" rx="6" ry="2.5" />
      <path d="M6 6v12c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V6" />
      <path d="M6 11c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5" />
    </>
  ),
  cup: (
    <>
      <path d="M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z" />
      <path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16" />
      <path d="M8 3.5c0 1.2 1 1.3 1 2.5M12 3.5c0 1.2 1 1.3 1 2.5" />
    </>
  ),
  bottle: (
    <>
      <path d="M10 3h4v3.5l1.6 2.3c.3.5.4 1 .4 1.5V19a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-8.7c0-.5.1-1 .4-1.5L10 6.5z" />
      <path d="M8 13h8" />
    </>
  ),
  milk: (
    <>
      <path d="M8 3h8l1.5 4v12a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2V7z" />
      <path d="M6.5 7h11" />
      <path d="M10 12h4v4h-4z" />
    </>
  ),
  candy: (
    <>
      <circle cx="12" cy="12" r="4.5" />
      <path d="M7.7 9.5 3.5 7.5v9l4.2-2" />
      <path d="m16.3 9.5 4.2-2v9l-4.2-2" />
      <path d="M10 10.5c1.2-.8 2.800-.8 4 0" />
    </>
  ),
  spray: (
    <>
      <path d="M8 21V11h6v10z" />
      <path d="M9 11V8h4v3" />
      <path d="M13 6h4" />
      <path d="M17 3.500l1.500 1M17.500 8l2-.6M17 5.800h2.500" />
    </>
  ),
  paper: (
    <>
      <path d="M6 3h9l3 3v15H6z" />
      <path d="M14 3v4h4" />
      <path d="M9 12h6M9 15.500h6" />
    </>
  ),
  leaf: (
    <>
      <path d="M5 19c0-8 5-13 14-14 0 9-5 14-13 14" />
      <path d="M5 19c3-4 6-7 10-9" />
    </>
  ),
  meat: (
    <>
      <path d="M14.500 4.500a5.500 5.500 0 0 1 5 8l-1.500 2.500a4 4 0 0 1-5.500 1.500L8 14.500a4 4 0 0 1 1.500-5.500z" />
      <circle cx="15" cy="9.500" r="1.200" />
      <path d="m8 16-3 3m0 0a1.500 1.500 0 1 0-2-2m2 2a1.500 1.500 0 1 0 2-2" />
    </>
  ),
  bread: (
    <>
      <path d="M5 11a4 4 0 0 1 2.500-7h9A4 4 0 0 1 19 11v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z" />
      <path d="M9 8.500l1.500 2.500M13 8.500l1.500 2.500" />
    </>
  ),
  shirt: <path d="m8.500 3-5 3 2 4 2-1V20h9V9l2 1 2-4-5-3a3.500 3.500 0 0 1-7 0z" />,
  plug: (
    <>
      <path d="M9 3v5M15 3v5" />
      <path d="M6 8h12v3a6 6 0 0 1-12 0z" />
      <path d="M12 17v4" />
    </>
  ),
  box: (
    <>
      <path d="m12 3 8 4v10l-8 4-8-4V7z" />
      <path d="m4 7 8 4 8-4M12 11v10" />
    </>
  ),
};

export function CatIcon({ kind, className = "icon" }: { kind: CategoryIconKind; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {SHAPES[kind]}
    </svg>
  );
}
