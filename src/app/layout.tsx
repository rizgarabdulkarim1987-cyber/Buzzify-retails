import type { Metadata } from "next";
import type { ReactNode } from "react";
import { dirOf } from "@/messages";
import { packById } from "@/packs";
import { productBrand } from "@/packs/brand";
import { currentHost } from "./_lib/host";
import { getLocale } from "./_lib/i18n";
import "./globals.css";

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
    <html lang={locale} dir={dirOf(locale)}>
      <body>{children}</body>
    </html>
  );
}
