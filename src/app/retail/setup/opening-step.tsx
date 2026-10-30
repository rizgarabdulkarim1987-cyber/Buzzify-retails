"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import type { Messages } from "@/messages";
import { Notice } from "../../_ui/state";
import { newKey } from "../catalog/_lib/keys";
import { skipSetupStep, type SkipState } from "./actions";

type Props = {
  businessId: string;
  status: "PENDING" | "DONE" | "SKIPPED";
  /** stock.receive: may enter opening stock by hand. */
  canReceive: boolean;
  /** stock.receive and catalog.import: may import it from a file. */
  canImport: boolean;
  /** Who may finish setup steps (the page is theirs): may skip this one. */
  canSkip: boolean;
  /** The business is read-only: the links still open the screens (read), nothing can be skipped. */
  disabled: boolean;
  t: Pick<Messages["setup"], "openingStep"> & Pick<Messages, "errors" | "internalError">;
};

/**
 * Setup step 6 (opening stock), optional. No form: it completes by itself with the first opening
 * stock posted for a real (not trial) item. It links to the opening stock screen and the file
 * import (marked "from setup") and can be skipped.
 */
export function OpeningStep({ businessId, status, canReceive, canImport, canSkip, disabled, t }: Props) {
  const o = t.openingStep;
  const [state, setState] = useState<SkipState | null>(null);
  const [pending, startTransition] = useTransition();
  const key = useRef(newKey());
  const enterRef = useRef<HTMLAnchorElement>(null);

  // The skip button goes away once skipped: focus moves to the step's first link, never the body.
  useEffect(() => {
    if (state?.status === "skipped") enterRef.current?.focus();
  }, [state]);

  const skip = () =>
    startTransition(async () => {
      const r = await skipSetupStep(key.current, businessId, 6);
      setState(r);
      key.current = newKey();
    });

  return (
    <div className="setup-catalog" data-testid="setup-opening">
      <p className="muted">{o.intro}</p>
      {status === "SKIPPED" ? <p data-testid="setup-opening-skipped">{o.skipped}</p> : null}
      {canReceive ? (
        <div className="setup-catalog-links">
          <Link ref={enterRef} href="/retail/stock/receive?kind=opening&from=setup" className="btn btn-secondary" data-testid="setup-opening-enter">
            {o.enter}
          </Link>
          {canImport ? (
            <Link href="/retail/stock/import?from=setup" className="btn btn-secondary" data-testid="setup-opening-import">
              {o.importFile}
            </Link>
          ) : null}
          {status === "PENDING" && canSkip ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                if (!pending) skip();
              }}
              disabled={disabled}
              aria-disabled={pending || undefined}
              aria-busy={pending || undefined}
              data-testid="setup-opening-skip"
            >
              {pending ? o.skipping : o.skip}
            </button>
          ) : null}
        </div>
      ) : (
        <p className="muted" data-testid="setup-opening-no-access">
          {o.noAccess}
        </p>
      )}
      <div aria-live="polite">
        {state?.status === "failed" ? <Notice tone="danger">{state.code === "INTERNAL" ? t.internalError : t.errors[state.code]}</Notice> : null}
      </div>
    </div>
  );
}
