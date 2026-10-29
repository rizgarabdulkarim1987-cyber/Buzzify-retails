"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { formatNumber, type Locale, type Messages } from "@/messages";
import { fill } from "../../_lib/format";
import { Notice } from "../../_ui/state";
import { newKey } from "../catalog/_lib/keys";
import { removeTrialItems, type TrialRemoveState } from "./actions";

type Props = {
  locale: Locale;
  businessId: string;
  /** Real (not trial) active products, and active trial items. */
  products: number;
  testProducts: number;
  canImport: boolean;
  canManage: boolean;
  /** staff.manage and catalog.manage: may delete the trial items. */
  canRemoveTrial: boolean;
  /** The business is read-only: links still open the catalog (read), nothing can be removed. */
  disabled: boolean;
  t: Pick<Messages["setup"], "catalogStep"> & Pick<Messages, "errors" | "internalError">;
};

/**
 * Setup step 4 (the catalog). No form: the step completes by itself once a real product or a real
 * import exists. It links to quick entry and the import (marked "from setup", where products can be
 * flagged as trial items) and offers to remove (delete) the trial items before launch.
 */
export function CatalogStep({ locale, businessId, products, testProducts, canImport, canManage, canRemoveTrial, disabled, t }: Props) {
  const c = t.catalogStep;
  const [confirm, setConfirm] = useState(false);
  const [state, setState] = useState<TrialRemoveState | null>(null);
  const [pending, startTransition] = useTransition();
  const key = useRef(newKey());

  const remove = () =>
    startTransition(async () => {
      const r = await removeTrialItems(key.current, businessId);
      setState(r);
      setConfirm(false);
      key.current = newKey();
    });

  return (
    <div className="setup-catalog" data-testid="setup-catalog">
      <p className="muted">{c.intro}</p>
      <p data-testid="setup-catalog-counts">
        {fill(c.counts, { products: formatNumber(locale, products), test: formatNumber(locale, testProducts) })}
      </p>
      <div className="setup-catalog-links">
        {canManage ? (
          <Link href="/retail/catalog/new?from=setup" className="btn btn-secondary" data-testid="setup-catalog-add">
            {c.addItems}
          </Link>
        ) : null}
        {canImport ? (
          <Link href="/retail/catalog/import?from=setup" className="btn btn-secondary" data-testid="setup-catalog-import">
            {c.importFile}
          </Link>
        ) : null}
      </div>
      <div aria-live="polite">
        {state?.status === "removed" ? <Notice tone="success">{fill(c.removed, { count: formatNumber(locale, state.count) })}</Notice> : null}
        {state?.status === "failed" ? <Notice tone="danger">{state.code === "INTERNAL" ? t.internalError : t.errors[state.code]}</Notice> : null}
      </div>
      {testProducts > 0 && canRemoveTrial ? (
        <section className="setup-trial" data-testid="setup-trial">
          <h3>{c.trialTitle}</h3>
          <p className="muted">{fill(c.trialBody, { count: formatNumber(locale, testProducts) })}</p>
          {confirm ? (
            <div className="confirm-actions">
              <button type="button" className="btn btn-danger-solid" onClick={remove} disabled={disabled || pending} aria-busy={pending} data-testid="setup-trial-confirm">
                {pending ? c.removing : fill(c.removeConfirm, { count: formatNumber(locale, testProducts) })}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setConfirm(false)} disabled={pending}>
                {c.cancel}
              </button>
            </div>
          ) : (
            <div>
              <button type="button" className="btn btn-danger" onClick={() => setConfirm(true)} disabled={disabled} data-testid="setup-trial-remove">
                {c.removeTrial}
              </button>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
