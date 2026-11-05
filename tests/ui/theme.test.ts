import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CARD, CARD_DAY, INK_DAY, PALETTE, PALETTE_DAY, WASH_DAY, contrast, dayAccent } from "../../src/app/retail/sell/_lib/category-accent";
import { DEFAULT_THEME, THEMES, THEME_COOKIE, nextTheme, parseTheme, themeCookie } from "../../src/app/theme";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

/* --- reading the two token sets out of tokens.css -------------------------------------------- */
const css = read("src/app/tokens.css");

function block(selector: string, from = 0): string {
  const start = css.indexOf(selector + " {", from);
  if (start < 0) throw new Error(`no ${selector}`);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(css.indexOf("{", start) + 1, i);
  }
  throw new Error("unbalanced");
}
const vars = (body: string) => Object.fromEntries([...body.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)].map((m) => [m[1]!, m[2]!.trim()]));

const night = vars(block(":root"));
const day = vars(block(':root[data-theme="day"]'));
const media = vars(block('  :root[data-theme="system"]', css.indexOf("@media (prefers-color-scheme: light)")));

type RGBA = [number, number, number, number];
function parse(v: string): RGBA {
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1]!.slice(i, i + 2), 16)).concat(1) as RGBA;
  m = /^rgba?\(([^)]+)\)$/.exec(v) as RegExpExecArray | null;
  if (m) {
    const p = m[1]!.split(",").map((x) => Number(x.trim()));
    return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
  }
  throw new Error(`cannot read colour ${v}`);
}
const over = (fg: RGBA, bg: RGBA): RGBA => [0, 1, 2].map((i) => fg[i]! * fg[3] + bg[i]! * (1 - fg[3])).concat(1) as RGBA;
const lum = ([r, g, b]: RGBA) => {
  const c = [r, g, b].map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
const ratio = (a: RGBA, b: RGBA) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

function check(name: string, t: Record<string, string>, base: Record<string, string>) {
  const v = (k: string) => t[k] ?? base[k]!;
  const surfaces = ["--color-paper", "--color-surface", "--color-panel", "--color-raised"];
  const solid = (k: string) => over(parse(v(k)), parse(v("--color-paper")));
  const on = (fg: string, bg: RGBA) => ratio(over(parse(v(fg)), bg), bg);

  describe(`${name} tokens`, () => {
    it("text, dim text and quiet text read at AA (4.5:1) on every surface, placeholders and disabled labels included", () => {
      for (const s of surfaces) {
        const bg = solid(s);
        for (const k of ["--color-ink", "--color-ink-2", "--color-ink-3"]) expect(on(k, bg), `${k} on ${s}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it("accent text, state text and badges read on surfaces and on their own tints", () => {
      for (const s of surfaces) {
        const bg = solid(s);
        for (const k of ["--color-accent", "--color-danger", "--color-warn", "--color-success"]) expect(on(k, bg), `${k} on ${s}`).toBeGreaterThanOrEqual(4.5);
      }
      const surface = solid("--color-surface");
      const tints: [string, string][] = [["--color-accent", "--color-accent-soft"], ["--color-danger", "--color-danger-soft"], ["--color-warn", "--color-warn-soft"], ["--color-success", "--color-success-soft"]];
      for (const [fg, tint] of tints) expect(on(fg, over(parse(v(tint)), surface)), `${fg} on ${tint}`).toBeGreaterThanOrEqual(4.5);
      // chips and badges: dim text on the panel and on the raised surface
      for (const s of ["--color-panel", "--color-raised"]) expect(on("--color-ink-2", solid(s)), s).toBeGreaterThanOrEqual(4.5);
    });

    it("solid fills carry white text at AA, and the bar reads", () => {
      for (const fill of ["--color-brand", "--color-brand-hover", "--color-danger-fill", "--color-warn-fill"]) expect(on("--color-on-fill", solid(fill)), fill).toBeGreaterThanOrEqual(4.5);
      for (const b of ["--color-bar", "--color-bar-2"]) for (const k of ["--color-bar-ink", "--color-bar-ink-2"]) expect(on(k, solid(b)), `${k} on ${b}`).toBeGreaterThanOrEqual(4.5);
    });

    it("control borders reach 3:1 against the page and the cards; the accent line too", () => {
      for (const s of ["--color-paper", "--color-surface"]) {
        expect(on("--color-line-strong", solid(s)), s).toBeGreaterThanOrEqual(3);
        expect(on("--color-accent-line", solid(s)), s).toBeGreaterThanOrEqual(3);
      }
    });

    it("the key glows are defined (hue, glow, strong glow, tint) for blue, violet, red and amber", () => {
      for (const h of ["blue", "violet", "red", "amber"]) for (const k of [`--hue-${h}`, `--glow-${h}`, `--glow-${h}-strong`, `--tint-${h}`]) expect(v(k), k).toBeTruthy();
      expect(v("--glow-blue-xl")).toBeTruthy();
    });

    it("keys keep AA: white or dark ink on every tinted key", () => {
      const surface = solid("--color-surface");
      for (const h of ["blue", "violet", "red", "amber"]) {
        expect(on("--color-ink", over(parse(v(`--tint-${h}-strong`)), surface)), h).toBeGreaterThanOrEqual(4.5);
      }
      expect(on("--color-danger", over(parse(v("--tint-red-strong")), surface))).toBeGreaterThanOrEqual(4.5);
      expect(on("--color-warn", over(parse(v("--tint-amber-strong")), surface))).toBeGreaterThanOrEqual(4.5);
    });
  });
}

check("Night", night, night);
check("Day", day, night);

describe("themes", () => {
  it("Day has every colour token Night has (no token falls back to the dark value by accident)", () => {
    const colourKeys = Object.keys(night).filter((k) => /^--(color|hue|glow|tint|card)-/.test(k));
    for (const k of colourKeys) expect(day[k], k).toBeDefined();
  });

  it('"system" follows the device: its media block holds exactly Day\'s values', () => {
    expect(media).toEqual(day);
  });

  it("color-scheme is set per theme so native controls match", () => {
    expect(/color-scheme:\s*dark/.test(block(":root"))).toBe(true);
    expect(/color-scheme:\s*light/.test(block(':root[data-theme="day"]'))).toBe(true);
    expect(/color-scheme:\s*light/.test(block('  :root[data-theme="system"]', css.indexOf("@media (prefers-color-scheme: light)")))).toBe(true);
  });

  it("Day has no glow", () => {
    for (const h of ["blue", "violet", "red", "amber"]) {
      expect(day[`--glow-${h}`]).toMatch(/transparent$/);
      expect(night[`--glow-${h}`]).toMatch(/rgba/);
    }
  });
});

describe("department cards in both themes", () => {
  it("Night accents read on the near-black card; Day accents read on the white card with its wash, pressed too", () => {
    for (const [name, hex] of Object.entries(PALETTE)) expect(contrast(hex, CARD), name).toBeGreaterThanOrEqual(4.5);
    const wash = (hex: string, w: number) => {
      const a = parse(hex);
      const bg = parse(CARD_DAY);
      return over([a[0], a[1], a[2], w] as RGBA, bg);
    };
    const hexOf = (c: RGBA) => `#${c.slice(0, 3).map((x) => Math.round(x as number).toString(16).padStart(2, "0")).join("")}`;
    for (const [name, hex] of Object.entries(PALETTE_DAY)) {
      expect(contrast(hex, hexOf(wash(hex, WASH_DAY))), name).toBeGreaterThanOrEqual(4.5);
      expect(contrast(hex, hexOf(wash(hex, WASH_DAY + 0.12))), `${name} pressed`).toBeGreaterThanOrEqual(4.5);
      // dim ink (68% of the dark ink) on the washed card
      const dim = over([10, 10, 20, 0.68], wash(hex, WASH_DAY));
      expect(ratio(dim, wash(hex, WASH_DAY))).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(INK_DAY, CARD_DAY)).toBeGreaterThanOrEqual(15);
  });

  it("every Night accent has a Day tone, and All is dark by day", () => {
    for (const hex of Object.values(PALETTE)) expect(dayAccent(hex)).not.toBe(hex);
    expect(dayAccent("#ffffff")).toBe(INK_DAY);
  });
});

describe("the switch", () => {
  it("cycles system, day, night and remembers the choice in a cookie (so a reload renders the same theme)", () => {
    expect(DEFAULT_THEME).toBe("system");
    expect(THEMES).toEqual(["system", "day", "night"]);
    expect(nextTheme("system")).toBe("day");
    expect(nextTheme("day")).toBe("night");
    expect(nextTheme("night")).toBe("system");
    for (const t of THEMES) {
      const cookie = themeCookie(t, false);
      expect(cookie.startsWith(`${THEME_COOKIE}=${t};`)).toBe(true);
      expect(cookie).toContain("path=/");
      expect(cookie).toContain("max-age=31536000");
      // what the server reads back on the next request
      expect(parseTheme(cookie.split(";")[0]!.split("=")[1])).toBe(t);
    }
    expect(themeCookie("night", true)).toContain("secure");
    expect(parseTheme("purple")).toBe("system");
    expect(parseTheme(undefined)).toBe("system");
  });

  it("the layout renders data-theme from the cookie on the server and the switch sits in the rail and the phone menu", () => {
    const layout = read("src/app/layout.tsx");
    expect(layout).toContain("data-theme={theme}");
    expect(layout).toContain("THEME_COOKIE");
    const nav = read("src/app/retail/sell/till-nav.tsx");
    expect(nav).toContain("ThemeSwitch");
    expect(nav).toContain('variant === "rail" ? "cycle" : "row"');
  });
});

describe("no hard-coded colours outside the token files", () => {
  const ALLOWED = new Set(["src/app/tokens.css", "src/app/retail/sell/_lib/category-accent.ts"]);
  function walk(dir: string): string[] {
    return readdirSync(join(root, dir)).flatMap((n) => {
      const rel = `${dir}/${n}`;
      return statSync(join(root, rel)).isDirectory() ? walk(rel) : [rel];
    });
  }
  const files = walk("src").filter((f) => /\.(css|tsx?)$/.test(f) && !f.startsWith("src/messages") && !f.startsWith("src/generated") && !ALLOWED.has(f));
  const stripPrint = (s: string) => {
    const i = s.indexOf("@media print");
    if (i < 0) return s;
    let depth = 0;
    for (let k = s.indexOf("{", i); k < s.length; k++) {
      if (s[k] === "{") depth++;
      if (s[k] === "}" && --depth === 0) return s.slice(0, i) + s.slice(k + 1);
    }
    return s;
  };

  it("styles use var(--color-*) and friends, never a literal colour (the print block and the image canvas are the only exceptions)", () => {
    const bad: string[] = [];
    for (const f of files) {
      if (f === "src/app/retail/stock/receive/photo/_lib/image.ts") continue; // a canvas fill for a JPEG, not UI
      const text = stripPrint(read(f));
      for (const m of text.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\boklch\(|\bhsla?\(/g)) bad.push(`${f}: ${m[0]}`);
    }
    expect(bad).toEqual([]);
  });
});
