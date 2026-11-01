"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { Locale, Messages } from "@/messages";
import { fill, pickName } from "../../../_lib/format";
import { Notice } from "../../../_ui/state";
import { nextAttempt } from "../../stock/_lib/receipt-rules";
import { addBarcodeAction, scanItemAction, searchAction, type ScanItem } from "../actions";
import { newKey } from "../_lib/keys";
import type { HitDto } from "../_lib/types";
import { itemHref, scanFailure } from "./_lib/rules";
import Link from "next/link";

type Props = {
  t: Messages;
  locale: Locale;
  code: string;
  readOnly: boolean;
  onCancel: () => void;
  onLinked: (name: string, productId: string) => void;
};

/**
 * "Link it to an item": find the item with the catalog search, choose the unit that carries the
 * code (the base unit first), and link it with R1's addBarcode. A code that another unit owns is
 * refused with BARCODE_TAKEN, naming that item.
 */
export function LinkItem({ t, locale, code, readOnly, onCancel, onLinked }: Props) {
  const l = t.catalog.scan.link;
  const uid = useId();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<HitDto[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [item, setItem] = useState<ScanItem | null>(null);
  const [loadingItem, setLoadingItem] = useState(false);
  const [unitId, setUnitId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ReturnType<typeof scanFailure> | null>(null);
  const busyRef = useRef(false);
  const attempt = useRef<{ payload: string; key: string } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const unitsRef = useRef<HTMLHeadingElement>(null);
  const failureRef = useRef<HTMLDivElement>(null);

  useEffect(() => searchRef.current?.focus(), []);
  useEffect(() => {
    if (failure) failureRef.current?.focus();
  }, [failure]);

  const busy = searching || loadingItem || saving;

  async function search(event: FormEvent) {
    event.preventDefault();
    const q = query.trim();
    if (q === "" || busyRef.current) return;
    busyRef.current = true;
    setSearching(true);
    setFailure(null);
    try {
      const res = await searchAction({ query: q });
      if (res.ok) setHits(res.value.items.filter((h) => !h.archived).slice(0, 10));
      else setFailure(scanFailure(t, res, locale));
    } catch {
      setFailure(scanFailure(t, { code: "INTERNAL" }, locale));
    }
    busyRef.current = false;
    setSearching(false);
  }

  async function pick(hit: HitDto) {
    if (busyRef.current) return;
    busyRef.current = true;
    setLoadingItem(true);
    setFailure(null);
    try {
      const res = await scanItemAction(hit.productId, hit.variantId);
      if (res.ok) {
        setItem(res.value);
        setUnitId(res.value.units[0]?.id ?? null);
        attempt.current = null;
      } else setFailure(scanFailure(t, res, locale));
    } catch {
      setFailure(scanFailure(t, { code: "INTERNAL" }, locale));
    }
    busyRef.current = false;
    setLoadingItem(false);
  }

  useEffect(() => {
    if (item) unitsRef.current?.focus();
  }, [item]);

  async function link() {
    if (busyRef.current || readOnly || !item || !unitId) return;
    busyRef.current = true;
    setSaving(true);
    setFailure(null);
    // The same unit and code sent again after no answer keep their key (linked once).
    attempt.current = nextAttempt(attempt.current, `${unitId}:${code}`, newKey);
    try {
      const res = await addBarcodeAction(attempt.current.key, { unitId, code });
      attempt.current = null;
      if (res.ok) {
        onLinked(pickName(locale, item), item.productId);
        return;
      }
      setFailure(scanFailure(t, res, locale));
    } catch {
      setFailure({ text: t.stock.intake.review.noAnswer, owner: null });
    }
    busyRef.current = false;
    setSaving(false);
  }

  return (
    <div className="scan-link" data-testid="scan-link-panel">
      <h3>{fill(l.title, { code: "⁦" + code + "⁩" })}</h3>
      {item === null ? (
        <>
          <form className="scan-manual" role="search" onSubmit={(e) => void search(e)}>
            <label className="field" htmlFor={`${uid}-q`}>
              <span>{l.search}</span>
            </label>
            <div className="scan-manual-row">
              <input
                id={`${uid}-q`}
                ref={searchRef}
                className="input"
                type="search"
                dir="auto"
                autoComplete="off"
                maxLength={100}
                value={query}
                placeholder={l.searchHint}
                onChange={(e) => setQuery(e.target.value)}
                data-testid="scan-link-search"
              />
              <button type="submit" className="btn btn-secondary" aria-disabled={busy || undefined} aria-busy={searching || undefined}>
                {searching ? l.searching : l.find}
              </button>
            </div>
          </form>
          {hits !== null ? (
            hits.length === 0 ? (
              <p className="muted" role="status">
                {l.none}
              </p>
            ) : (
              <ul className="scan-hits" aria-label={l.search}>
                {hits.map((h) => {
                  const name = pickName(locale, h);
                  return (
                    <li key={h.variantId}>
                      <button
                        type="button"
                        className="scan-hit"
                        aria-label={fill(l.pick, { name })}
                        aria-disabled={busy || undefined}
                        onClick={() => void pick(h)}
                        data-testid="scan-link-hit"
                      >
                        <span className="truncate" dir="auto">
                          {name}
                        </span>
                        <span className="muted" dir="ltr">
                          {h.sku}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )
          ) : null}
          {loadingItem ? (
            <p className="muted" role="status">
              {l.loadingUnits}
            </p>
          ) : null}
        </>
      ) : (
        <fieldset className="scan-units">
          <legend>
            <h4 ref={unitsRef} tabIndex={-1}>
              {pickName(locale, item)} <span className="muted" dir="ltr">{item.sku}</span>
            </h4>
            <span>{l.unit}</span>
          </legend>
          {item.units.length === 0 ? <p className="hint">{l.noUnits}</p> : null}
          {item.units.map((u) => (
            <label key={u.id} className="check scan-unit">
              <input type="radio" name={`${uid}-unit`} value={u.id} checked={unitId === u.id} onChange={() => setUnitId(u.id)} data-testid="scan-link-unit" />
              <span>{u.name}</span>
            </label>
          ))}
          {readOnly ? (
            <p className="hint" id={`${uid}-ro`}>
              {t.catalog.scan.blocked.READ_ONLY}
            </p>
          ) : null}
          <div className="scan-actions">
            <button
              type="button"
              className="btn btn-primary"
              aria-disabled={readOnly || busy || unitId === null || undefined}
              aria-describedby={readOnly ? `${uid}-ro` : undefined}
              aria-busy={saving || undefined}
              onClick={() => void link()}
              data-testid="scan-link-confirm"
            >
              {saving ? l.linking : l.confirm}
            </button>
          </div>
        </fieldset>
      )}
      <div ref={failureRef} tabIndex={-1}>
        {failure ? (
          <Notice tone="danger">
            {failure.text}
            {failure.owner ? (
              <>
                {" "}
                <Link href={itemHref(failure.owner.productId)}>
                  {l.takenBy} {failure.owner.name}
                </Link>
              </>
            ) : null}
          </Notice>
        ) : null}
      </div>
      <div className="scan-actions">
        <button
          type="button"
          className="btn btn-secondary"
          aria-disabled={saving || undefined}
          onClick={() => {
            if (!busyRef.current) onCancel();
          }}
          data-testid="scan-link-cancel"
        >
          {l.cancel}
        </button>
      </div>
    </div>
  );
}
