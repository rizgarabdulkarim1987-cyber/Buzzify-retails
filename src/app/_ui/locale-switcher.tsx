"use client";

import { useRef } from "react";
import { setLocale } from "../locale-actions";
import type { Locale } from "@/messages";

type Props = {
  locale: Locale;
  label: string;
  names: Record<Locale, string>;
  tone?: "bar" | "light";
};

/** A native, labelled select that submits its form (the setLocale server action) on change. */
export function LocaleSwitcher({ locale, label, names, tone = "bar" }: Props) {
  const form = useRef<HTMLFormElement>(null);
  return (
    <form ref={form} action={setLocale}>
      <label>
        <span className="visually-hidden">{label}</span>
        <select
          name="locale"
          defaultValue={locale}
          className={tone === "light" ? "locale-select locale-select--light" : "locale-select"}
          onChange={() => form.current?.requestSubmit()}
          data-testid="locale-switcher"
        >
          {(Object.keys(names) as Locale[]).map((l) => (
            <option key={l} value={l} lang={l} dir={l === "en" ? "ltr" : "rtl"}>
              {names[l]}
            </option>
          ))}
        </select>
      </label>
    </form>
  );
}
