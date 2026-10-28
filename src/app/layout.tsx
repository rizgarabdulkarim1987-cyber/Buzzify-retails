import type { ReactNode } from "react";
import { dirOf } from "@/messages";
import { getLocale } from "./_lib/i18n";
import "./globals.css";

export const metadata = { title: "Buzzify Retails" };

export const viewport = { width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} dir={dirOf(locale)}>
      <body>{children}</body>
    </html>
  );
}
