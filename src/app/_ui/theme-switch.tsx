"use client";

import { useState } from "react";
import { THEMES, nextTheme, parseTheme, themeCookie, type Theme } from "../theme";

export type ThemeLabels = { label: string; day: string; night: string; system: string };

const Glyph = ({ children }: { children: React.ReactNode }) => (
  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {children}
  </svg>
);

const GLYPHS: Record<Theme, React.ReactNode> = {
  day: (
    <Glyph>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" />
    </Glyph>
  ),
  night: (
    <Glyph>
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
    </Glyph>
  ),
  system: (
    <Glyph>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor" />
    </Glyph>
  ),
};

/** The choice now in force: what the server put on <html> (from the cookie). */
const current = (): Theme => (typeof document === "undefined" ? "system" : parseTheme(document.documentElement.dataset.theme));

/** Applies the choice at once (data-theme on <html>, no reload) and remembers it in a cookie. */
function apply(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.cookie = themeCookie(theme, window.location.protocol === "https:");
}

/**
 * The Day / Night switch. "cycle" is one button for the rail and the bars: it shows the glyph and word
 * of the current choice (all three are rendered and CSS shows the one for html[data-theme], so the
 * server-rendered page is right on the first paint) and a tap goes to the next: Auto, Day, Night.
 * "row" lists the three choices for the phone menu.
 */
export function ThemeSwitch({ labels, variant = "cycle" }: { labels: ThemeLabels; variant?: "cycle" | "row" }) {
  const [chosen, setChosen] = useState<Theme>(current);
  if (variant === "row") {
    return (
      <div className="theme-row" role="radiogroup" aria-label={labels.label} data-testid="theme-row">
        {THEMES.map((t) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={chosen === t}
            className="theme-choice"
            onClick={() => {
              apply(t);
              setChosen(t);
            }}
            data-testid={`theme-${t}`}
          >
            {GLYPHS[t]}
            <span>{labels[t]}</span>
          </button>
        ))}
      </div>
    );
  }
  return (
    <button type="button" className="theme-cycle" onClick={() => apply(nextTheme(current()))} aria-label={labels.label} title={labels.label} data-testid="theme-switch">
      {THEMES.map((t) => (
        <span key={t} className="theme-cycle-face" data-for={t}>
          {GLYPHS[t]}
          <span>{labels[t]}</span>
        </span>
      ))}
    </button>
  );
}
