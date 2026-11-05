/*
 * Day / Night. The choice lives in a cookie so the server renders the right theme on the first
 * paint (no flash); "system" (the default) follows the device through prefers-color-scheme in CSS.
 */
export const THEME_COOKIE = "rt_theme";
export const THEMES = ["system", "day", "night"] as const;
export type Theme = (typeof THEMES)[number];
export const DEFAULT_THEME: Theme = "system";

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/** The cookie's theme, or "system" when it is missing or unknown. */
export function parseTheme(value: string | undefined | null): Theme {
  return isTheme(value) ? value : DEFAULT_THEME;
}

/** The next choice when the switch is tapped: system, day, night, and round again. */
export function nextTheme(theme: Theme): Theme {
  return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]!;
}

/** The `Set-Cookie`-style string the switch writes in the browser (a year, whole site). */
export function themeCookie(theme: Theme, secure: boolean): string {
  return `${THEME_COOKIE}=${theme}; path=/; max-age=31536000; samesite=lax${secure ? "; secure" : ""}`;
}
