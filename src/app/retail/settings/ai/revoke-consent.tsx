"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { Locale, Messages } from "@/messages";
import { Notice } from "../../../_ui/state";
import { useHydrated } from "../../catalog/_lib/hydrated";
import { newKey } from "../../catalog/_lib/keys";
import { scanFailure } from "../../catalog/scan/_lib/rules";
import { nextAttempt } from "../../stock/_lib/receipt-rules";
import { revokeAiConsentAction } from "../actions";

/**
 * The owner withdraws the consent (allowed with the AI switch off and while read-only). It asks
 * first; "Keep it" has the focus. After it the page reloads with the new state, and focus moves to
 * the consent heading (FocusOnChange).
 */
export function RevokeConsent({ t, locale }: { t: Messages; locale: Locale }) {
  const c = t.aiSettings.consent;
  const router = useRouter();
  const hydrated = useHydrated();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const busyRef = useRef(false);
  const attempt = useRef<{ payload: string; key: string } | null>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const failureRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (asking) keepRef.current?.focus();
  }, [asking]);
  useEffect(() => {
    if (failure) failureRef.current?.focus();
  }, [failure]);

  async function revoke() {
    if (!hydrated || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    // Sent again after no answer: the same key (recorded once).
    attempt.current = nextAttempt(attempt.current, "revoke", newKey);
    try {
      const res = await revokeAiConsentAction(attempt.current.key);
      attempt.current = null;
      if (res.ok) {
        // Stays busy while the page reloads without this control.
        router.refresh();
        return;
      }
      setFailure(scanFailure(t, res, locale).text);
    } catch {
      setFailure(c.noAnswer);
    }
    busyRef.current = false;
    setBusy(false);
  }

  function keep() {
    if (busyRef.current) return;
    setAsking(false);
    // The question is gone: focus goes back to the button that opened it.
    requestAnimationFrame(() => openRef.current?.focus());
  }

  return (
    <div className="ai-revoke" data-testid="ai-revoke">
      <p className="hint">{c.revokeHint}</p>
      {asking ? (
        <div className="ai-confirm" role="group" aria-label={c.revokeConfirm}>
          <p>{c.revokeConfirm}</p>
          <div className="scan-actions">
            <button type="button" ref={keepRef} className="btn btn-secondary" aria-disabled={busy || undefined} onClick={keep} data-testid="ai-revoke-keep">
              {c.revokeNo}
            </button>
            <button type="button" className="btn btn-danger" aria-disabled={busy || undefined} aria-busy={busy || undefined} onClick={() => void revoke()} data-testid="ai-revoke-yes">
              {busy ? c.revoking : c.revokeYes}
            </button>
          </div>
        </div>
      ) : (
        <div className="scan-actions">
          <button type="button" ref={openRef} className="btn btn-secondary" aria-disabled={!hydrated || undefined} onClick={() => hydrated && setAsking(true)} data-testid="ai-revoke-open">
            {c.revoke}
          </button>
        </div>
      )}
      <div ref={failureRef} tabIndex={-1}>
        {failure ? <Notice tone="danger">{failure}</Notice> : null}
      </div>
    </div>
  );
}

/** Moves focus to `targetId` when `value` changes after the first render (a page refresh changed the state). */
export function FocusOnChange({ targetId, value }: { targetId: string; value: string }) {
  const first = useRef(value);
  useEffect(() => {
    if (value !== first.current) {
      first.current = value;
      document.getElementById(targetId)?.focus();
    }
  }, [targetId, value]);
  return null;
}
