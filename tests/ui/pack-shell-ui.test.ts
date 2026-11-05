import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LOCALES, messagesFor, type Locale } from "@/messages";
import { allPacks, packWords, visibleNav, type PackManifest } from "@/packs";
import { productBrand } from "@/packs/brand";
import { can } from "@/server/domain/permissions";
import { AuthCard } from "../../src/app/login/auth-card";
import { ShellHeader } from "../../src/app/retail/_header";

/* The shell and the sign-in card name the product of the address or business, in every locale. */

function header(pack: PackManifest | null, locale: Locale) {
  const t = messagesFor(locale);
  const nav = pack
    ? visibleNav(pack, { can: (p) => can("OWNER", p), hasBranch: true }, "bar").map((s) => ({ id: s.id, href: s.route, label: packWords(pack, locale).nav[s.id] }))
    : [];
  return renderToStaticMarkup(
    createElement(ShellHeader, {
      locale,
      t,
      business: "متجر النور",
      branch: "Main",
      terminal: null,
      user: "Owner",
      product: productBrand(pack, locale),
      nav,
    }),
  );
}

function card(pack: PackManifest | null, locale: Locale) {
  const t = messagesFor(locale);
  const product = pack ? { brand: productBrand(pack, locale), heading: packWords(pack, locale).loginTitle } : undefined;
  return renderToStaticMarkup(createElement(Card, { locale, t, intro: null, product }, createElement("p", null, "form")));
}

/** AuthCard with children passed the createElement way. */
const Card = AuthCard as (p: Omit<Parameters<typeof AuthCard>[0], "children"> & { children?: ReactNode }) => ReturnType<typeof AuthCard>;
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const others = (pack: PackManifest) => allPacks().filter((p) => p.id !== pack.id);

describe("pack shell", () => {
  for (const pack of allPacks()) {
    for (const locale of LOCALES) {
      const w = packWords(pack, locale);

      it(`${pack.id} header (${locale}): its wordmark, its section words, no other product's`, () => {
        const html = header(pack, locale);
        const shown = text(html);
        expect(shown).toContain(`Buzzify ${w.productWord}`);
        expect(html).toContain('<bdi dir="ltr">Buzzify</bdi>');
        for (const id of ["sell", "catalog", "stock"] as const) {
          expect(html).toContain(`data-testid="nav-${id}"`);
          expect(html).toContain(`aria-label="${w.nav[id]}"`);
        }
        for (const o of others(pack)) {
          expect(shown).not.toContain(packWords(o, locale).productWord);
          if (packWords(o, locale).nav.catalog !== w.nav.catalog) expect(html).not.toContain(packWords(o, locale).nav.catalog);
        }
        expect(shown).not.toMatch(/studio|\bcore\b|restaurant|pharmac|cashier/i);
      });

      it(`${pack.id} sign-in card (${locale}): the product in the wordmark and the heading`, () => {
        const html = card(pack, locale);
        expect(html).toContain(`<h1>${w.loginTitle}</h1>`);
        expect(text(html)).toContain(`Buzzify ${w.productWord}`);
        for (const o of others(pack)) expect(text(html)).not.toContain(packWords(o, locale).productWord);
      });
    }
  }

  it("the shared address before a business is chosen stays neutral (Buzzify Retails, the plain sign-in heading)", () => {
    for (const locale of LOCALES) {
      expect(text(header(null, locale))).toContain("Buzzify Retails");
      const html = card(null, locale);
      expect(html).toContain(`<h1>${messagesFor(locale).auth.title}</h1>`);
      expect(text(html)).toContain("Buzzify Retails");
      for (const p of allPacks()) expect(text(html)).not.toContain(packWords(p, locale).productWord);
    }
  });

  it("a till operator's header shows only the sections the role allows", () => {
    const pack = allPacks()[0]!;
    const nav = visibleNav(pack, { can: (p) => can("CASHIER", p), hasBranch: false }, "bar").map((s) => ({ id: s.id, href: s.route, label: s.id }));
    const html = renderToStaticMarkup(
      createElement(ShellHeader, { locale: "en", t: messagesFor("en"), business: null, branch: null, terminal: null, user: "u", product: productBrand(pack, "en"), nav }),
    );
    expect(html).not.toContain('data-testid="nav-sell"');
    expect(html).toContain('data-testid="nav-catalog"');
    expect(html).toContain('data-testid="nav-stock"');
  });
});
