import { cookies } from "next/headers";
import { LOCALE_COOKIE, messagesFor, parseLocale, type Locale, type Messages } from "@/messages";

/** The UI language from the locale cookie (Arabic when missing or unknown). */
export async function getLocale(): Promise<Locale> {
  return parseLocale((await cookies()).get(LOCALE_COOKIE)?.value);
}

export async function getI18n(): Promise<{ locale: Locale; t: Messages }> {
  const locale = await getLocale();
  return { locale, t: messagesFor(locale) };
}
