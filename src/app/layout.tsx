import type { Metadata } from "next";
import { Geist_Mono, Space_Grotesk } from "next/font/google";
import type { ReactNode } from "react";
import { dirOf } from "@/messages";
import { packById } from "@/packs";
import { productBrand } from "@/packs/brand";
import { currentHost } from "./_lib/host";
import { getLocale } from "./_lib/i18n";
import "./globals.css";

/*
 * The app's two faces (self-hosted by next/font at build, Latin subset, swapped in when loaded):
 * Space Grotesk for text, Geist Mono for small labels, counts, indices and table headers. Neither has
 * Arabic glyphs: Arabic and Sorani letters come from the system Arabic stack named in tokens.css.
 */
const grotesk = Space_Grotesk({ subsets: ["latin"], display: "swap", weight: ["400", "500", "700"], variable: "--font-grotesk" });
const mono = Geist_Mono({ subsets: ["latin"], display: "swap", weight: ["400", "500"], variable: "--font-mono" });

/** The tab title names the product of this address; the shared address shows "Buzzify Retails". */
export async function generateMetadata(): Promise<Metadata> {
  const { packId } = await currentHost();
  const name = productBrand(packId ? packById(packId) : null, await getLocale()).name;
  return { title: { default: name, template: `%s · ${name}` } };
}

export const viewport = { width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} dir={dirOf(locale)} className={`${grotesk.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
