import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("app fonts", () => {
  it("the root layout loads Space Grotesk and Geist Mono through next/font, Latin only, swapped, with only the weights used", () => {
    const layout = read("src/app/layout.tsx");
    expect(layout).toContain('from "next/font/google"');
    expect(layout).toMatch(/Space_Grotesk\(\{[^}]*subsets: \["latin"\][^}]*display: "swap"[^}]*weight: \["400", "500", "700"\][^}]*--font-grotesk/);
    expect(layout).toMatch(/Geist_Mono\(\{[^}]*subsets: \["latin"\][^}]*display: "swap"[^}]*weight: \["400", "500"\][^}]*--font-mono/);
    expect(layout).toContain("grotesk.variable");
    expect(layout).toContain("mono.variable");
  });

  it("the base stack puts Space Grotesk first and keeps the Arabic system fonts for Arabic and Sorani letters", () => {
    const tokens = read("src/app/tokens.css");
    expect(tokens).toMatch(/--font-ui:\s*var\(--font-grotesk\),\s*var\(--font-arabic\)/);
    expect(tokens).toMatch(/--font-arabic:\s*"Segoe UI",\s*"Noto Sans Arabic"/);
    expect(tokens).toMatch(/--font-data:\s*var\(--font-mono\)[^;]*var\(--font-arabic\)/);
  });

  it("letter-spacing and capitals are for Latin only, and no text is under 11px", () => {
    for (const file of ["src/app/globals.css", "src/app/retail/sell/sell.css"]) {
      const css = read(file);
      expect(css, file).not.toMatch(/font-size:\s*0\.(?:[0-5]\d*|6[0-7]\d*)rem/);
    }
    const sell = read("src/app/retail/sell/sell.css");
    expect(sell).toContain(":root:lang(en) .till-cols");
    expect(read("src/app/globals.css")).toContain(":root:lang(en) .data-table th");
  });
});
