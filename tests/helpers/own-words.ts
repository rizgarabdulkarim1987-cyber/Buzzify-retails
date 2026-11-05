/*
 * Retails speaks only its own words: a shop user never reads the name of another Buzzify product
 * (the Studio, the restaurant product and its menus, the Cashier product, the Pharmacy product) or
 * of the internal "Core" service. Shared by the message guard and the rendered-page checks.
 */
export const FORBIDDEN: { word: string; pattern: RegExp }[] = [
  { word: "Studio", pattern: /studio/i },
  { word: "Core", pattern: /\bcore\b/i },
  { word: "restaurant", pattern: /restaurant/i },
  { word: "menu", pattern: /\bmenus?\b/i },
  { word: "pharmacy", pattern: /pharmac/i },
  { word: "prescription", pattern: /prescription/i },
  { word: "Cashier", pattern: /cashier/i },
  // Arabic
  { word: "ستوديو", pattern: /ستوديو|ستوديـو|ستديو|استوديو/ },
  { word: "مطعم", pattern: /مطعم|مطاعم/ },
  { word: "قائمة الطعام", pattern: /قائمة الطعام|قوائم الطعام|القوائم|منيو|مينيو/ },
  { word: "صيدلية", pattern: /صيدلي/ },
  { word: "كاشير", pattern: /كاشير/ },
  { word: "وصفة طبية", pattern: /وصفة طبية|وصفات طبية/ },
  // Central Kurdish
  { word: "ستۆدیۆ", pattern: /ستۆدیۆ|ستودیو|ستودیۆ/ },
  { word: "چێشتخانە", pattern: /چێشتخانە|ڕێستۆران/ },
  { word: "مینیو", pattern: /مینیو|مێنیو/ },
  { word: "دەرمانخانە", pattern: /دەرمانخانە/ },
  { word: "کاشێر", pattern: /کاشێر|کاشیر/ },
];

/** Every leaf of a message tree as [path, value]. */
export function entries(tree: unknown, prefix = ""): [string, string][] {
  if (typeof tree === "string") return [[prefix, tree]];
  if (typeof tree !== "object" || tree === null) return [];
  return Object.entries(tree).flatMap(([k, v]) => entries(v, prefix ? `${prefix}.${k}` : k));
}

export function offenders(tree: unknown): string[] {
  const found: string[] = [];
  for (const [path, value] of entries(tree)) {
    for (const { word, pattern } of FORBIDDEN) if (pattern.test(value)) found.push(`${path}: "${word}" in ${JSON.stringify(value)}`);
  }
  return found;
}

const decode = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/**
 * What a visitor can read on a rendered page: its text, and the attributes a browser shows or
 * reads aloud (title, aria-label, placeholder, alt, value of a button). Link targets are not text.
 */
export function visibleText(html: string): string {
  const shown = [...html.matchAll(/\s(?:title|aria-label|placeholder|alt)="([^"]*)"/g)].map((m) => m[1]!);
  const text = html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ");
  return decode([text, ...shown].join(" ")).replace(/\s+/g, " ").trim();
}
