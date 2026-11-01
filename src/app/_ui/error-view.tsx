"use client";

import { messagesFor, parseLocale } from "@/messages";
import { StateBlock } from "./state";

/** The shared error boundary body: the generic message in the page's language (from <html lang>), and a retry. */
export function ErrorView({ reset }: { reset: () => void }) {
  const lang = typeof document === "undefined" ? undefined : document.documentElement.lang;
  const t = messagesFor(parseLocale(lang));
  return (
    <main className="page">
      <StateBlock
        kind="alert"
        title={t.common.errorTitle}
        body={t.internalError}
        action={
          <button type="button" className="btn btn-secondary" onClick={reset}>
            {t.common.retry}
          </button>
        }
      />
    </main>
  );
}
