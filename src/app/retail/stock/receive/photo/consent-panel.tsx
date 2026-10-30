"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { formatNumber, type Locale, type Messages } from "@/messages";
import { fill } from "../../../../_lib/format";
import { Notice } from "../../../../_ui/state";
import { useHydrated } from "../../../catalog/_lib/hydrated";
import { newKey } from "../../../catalog/_lib/keys";
import { nextAttempt } from "../../_lib/receipt-rules";
import type { StockFailure } from "../../_lib/types";
import { grantAiConsentAction } from "../../actions";
import { intakeFailureMessage } from "./_lib/rules";

/**
 * The owner's one-time consent to send the business's images to the AI provider, with the text of
 * the current version (raising the version voids earlier consents). After it the page reloads into
 * the capture screen.
 */
export function ConsentPanel({ t, locale, version, readOnly }: { t: Messages; locale: Locale; version: number; readOnly: boolean }) {
  const c = t.stock.intake.consent;
  const router = useRouter();
  const hydrated = useHydrated();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<StockFailure | null>(null);
  const [noAnswer, setNoAnswer] = useState(false);
  const attempt = useRef<{ payload: string; key: string } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const text = (c as Readonly<Record<string, string>>)[`v${version}`] ?? "";

  useEffect(() => {
    if (failure || noAnswer) headingRef.current?.focus();
  }, [failure, noAnswer]);

  const blocked = !hydrated || readOnly || busy || text === "";
  async function grant() {
    if (blocked) return;
    setBusy(true);
    setFailure(null);
    setNoAnswer(false);
    // Sent again after no answer: the same key (the server replays, never records twice).
    attempt.current = nextAttempt(attempt.current, `consent:${version}`, newKey);
    try {
      const res = await grantAiConsentAction(attempt.current.key);
      attempt.current = null;
      if (res.ok) {
        router.refresh();
        return;
      }
      setFailure(res);
    } catch {
      setNoAnswer(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section panel intake" aria-labelledby="intake-consent-title" data-testid="intake-consent">
      <h2 id="intake-consent-title" ref={headingRef} tabIndex={-1}>
        {c.title}
      </h2>
      <p className="muted">{fill(c.version, { v: formatNumber(locale, version) })}</p>
      <p className="intake-consent-text" data-testid="intake-consent-text">
        {text}
      </p>
      {failure ? <Notice tone="danger">{intakeFailureMessage(t, failure, locale)}</Notice> : null}
      {noAnswer ? <Notice tone="danger">{t.stock.intake.review.noAnswer}</Notice> : null}
      <div className="intake-line-actions">
        <button
          type="button"
          className="btn btn-primary"
          aria-disabled={blocked || undefined}
          aria-busy={busy || undefined}
          onClick={() => void grant()}
          data-testid="intake-consent-grant"
        >
          {busy ? c.granting : c.grant}
        </button>
      </div>
    </section>
  );
}
