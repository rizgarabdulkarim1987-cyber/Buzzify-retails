import Link from "next/link";
import { formatDateTime, formatDay, formatNumber, type Locale, type Messages } from "@/messages";
import { fill, formatMoney, pickName } from "../../../_lib/format";
import { PageSkeleton } from "../../../_ui/page-skeleton";
import { Notice, StateBlock } from "../../../_ui/state";
import { breakdownText, formatQty, signedQty, type ExpiringDto } from "./format";
import type { BatchDto, Currency, ExpiryState, MovementDto, StockRowDto } from "./types";

/*
 * The stock screens' drawing, without state: the client parts (search, paging, the dialog) and the
 * server pages both use these. Value cells exist only when canSeeCost and the server sent the value.
 */

export const variantHref = (variantId: string) => `/retail/stock/${encodeURIComponent(variantId)}`;

export function ExpiryBadge({ t, status }: { t: Messages; status: ExpiryState }) {
  if (status === "SOON") {
    return (
      <span className="badge" data-tone="warn" data-testid="stock-badge-soon">
        {t.stock.badge.SOON}
      </span>
    );
  }
  if (status === "EXPIRED") {
    return (
      <span className="badge" data-tone="danger" data-testid="stock-badge-expired">
        {t.stock.badge.EXPIRED}
      </span>
    );
  }
  return null;
}

type ListProps = {
  locale: Locale;
  t: Messages;
  rows: StockRowDto[];
  currency: Currency;
  canSeeCost: boolean;
  canAdjust: boolean;
  /** Drawn but not usable: the business is READ_ONLY. */
  adjustDisabled: boolean;
  /**
   * The quantities are being read again: the button stays focusable (aria-disabled, the click does
   * nothing) so focus that returns to it after the dialog closes is not lost to the page body.
   */
  adjustWaiting?: boolean;
  onAdjust: ((row: StockRowDto) => void) | undefined;
  busy?: boolean;
};

/** The stock rows: name, SKU, badges, on hand in the item's units, available when it differs, value (cost.view only). */
export function StockList({ locale, t, rows, currency, canSeeCost, canAdjust, adjustDisabled, adjustWaiting, onAdjust, busy }: ListProps) {
  const l = t.stock.list;
  return (
    <ul className="stock-list" aria-label={l.resultsList} aria-busy={busy ? true : undefined} data-testid="stock-list">
      {rows.map((r) => {
        const showValue = canSeeCost && r.valueMinor !== undefined;
        const name = pickName(locale, r);
        return (
          <li key={r.variantId} className="stock-row" data-testid="stock-row" data-status={r.status}>
            <div className="stock-row-main">
              <Link href={variantHref(r.variantId)} className="stock-row-name" title={name} data-testid="stock-row-name">
                {name}
              </Link>
              <span className="stock-row-meta">
                <span dir="ltr" className="catalog-sku">
                  {l.sku} {r.sku}
                </span>
                <ExpiryBadge t={t} status={r.status} />
                {r.nearestExpiry && (r.status === "SOON" || r.status === "EXPIRED") ? (
                  <span>{fill(l.nearestExpiry, { date: formatDay(locale, new Date(r.nearestExpiry)) })}</span>
                ) : null}
              </span>
            </div>
            <div className="stock-row-qty">
              <span className="visually-hidden">{l.onHand}: </span>
              <strong className="stock-qty" data-testid="stock-qty" data-zero={BigInt(r.qty) === 0n ? "true" : undefined}>
                {breakdownText(locale, t, r.breakdown)}
              </strong>
              {r.availableQty !== r.qty ? (
                <span className="stock-available" data-testid="stock-available">
                  {fill(l.available, { qty: fill(t.stock.qty.baseUnits, { qty: formatQty(locale, r.availableQty) }) })}
                </span>
              ) : null}
              {showValue ? (
                <span className="stock-value" data-testid="stock-value">
                  <span className="visually-hidden">{l.value}: </span>
                  {formatMoney(locale, currency, r.valueMinor!, t.catalog.currencyShort[currency])}
                </span>
              ) : null}
            </div>
            {canAdjust ? (
              <div className="stock-row-actions">
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  disabled={adjustDisabled}
                  aria-disabled={adjustWaiting ? true : undefined}
                  aria-label={fill(l.adjustFor, { name })}
                  onClick={onAdjust && !adjustWaiting ? () => onAdjust(r) : undefined}
                  data-testid="stock-adjust"
                >
                  {l.adjust}
                </button>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function StockListEmpty({ t, filtered }: { t: Messages; filtered: boolean }) {
  const l = t.stock.list;
  return filtered ? (
    <StateBlock kind="empty" title={l.noResultsTitle} body={l.noResultsBody} testId="stock-no-results" />
  ) : (
    <StateBlock kind="empty" title={l.emptyTitle} body={l.emptyBody} testId="stock-empty" />
  );
}

export function StockSkeleton({ label }: { label: string }) {
  return <PageSkeleton label={label} rows={6} />;
}

/** The business is READ_ONLY: reading works, writing is paused. */
export function ReadOnlyBanner({ t }: { t: Messages }) {
  return (
    <div className="section" data-testid="stock-read-only">
      <Notice tone="danger">
        <strong>{t.stock.readOnlyTitle}.</strong> {t.stock.readOnlyBody}
      </Notice>
    </div>
  );
}

/** A label shown in front of a table cell at phone width, where the table head is hidden. */
const CellLabel = ({ children }: { children: string }) => <span className="stock-cell-label">{children}</span>;

/** The movement history, newest first, with the balance right after each movement. */
export function MovementTable({ locale, t, rows, currency, canSeeCost }: { locale: Locale; t: Messages; rows: MovementDto[]; currency: Currency; canSeeCost: boolean }) {
  const m = t.stock.movement;
  const short = t.catalog.currencyShort[currency];
  return (
    <table className="data-table stock-movements" data-testid="movement-table">
      <thead>
        <tr>
          <th scope="col">{m.colKind}</th>
          <th scope="col">{m.colDate}</th>
          <th scope="col">{m.colBatch}</th>
          <th scope="col">{m.colChange}</th>
          <th scope="col">{m.colBalance}</th>
          {canSeeCost ? <th scope="col">{m.colValueChange}</th> : null}
          {canSeeCost ? <th scope="col">{m.colValueAfter}</th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} data-testid="movement-row">
            <td>
              {m.kinds[r.documentKind]}
              {r.documentNumber !== null ? <span className="muted"> · {fill(m.docNumber, { number: formatNumber(locale, r.documentNumber) })}</span> : null}
            </td>
            <td data-secondary>
              <time dateTime={r.createdAt}>{formatDateTime(locale, new Date(r.createdAt))}</time>
            </td>
            <td data-secondary>
              <CellLabel>{m.colBatch}</CellLabel>
              {r.batchCode ? (
                <span dir="ltr" className="catalog-sku">
                  {r.batchCode}
                </span>
              ) : (
                m.noBatch
              )}
            </td>
            <td className="stock-num">
              <CellLabel>{m.colChange}</CellLabel>
              <span dir="ltr" data-tone={BigInt(r.qtyDelta) < 0n ? "out" : "in"} data-testid="movement-change">
                {signedQty(locale, r.qtyDelta)}
              </span>
            </td>
            <td className="stock-num">
              <CellLabel>{m.colBalance}</CellLabel>
              <strong data-testid="movement-balance">{formatQty(locale, r.qtyAfter)}</strong>
            </td>
            {canSeeCost ? (
              <td className="stock-num">
                <CellLabel>{m.colValueChange}</CellLabel>
                {r.valueDeltaMinor !== undefined ? <span dir="ltr">{signedMoney(locale, currency, r.valueDeltaMinor, short)}</span> : null}
              </td>
            ) : null}
            {canSeeCost ? (
              <td className="stock-num">
                <CellLabel>{m.colValueAfter}</CellLabel>
                {r.valueAfterMinor !== undefined ? <span data-testid="movement-value">{formatMoney(locale, currency, r.valueAfterMinor, short)}</span> : null}
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function signedMoney(locale: Locale, currency: Currency, minor: string, label: string): string {
  const v = BigInt(minor);
  return v < 0n ? `−${formatMoney(locale, currency, -v, label)}` : `+${formatMoney(locale, currency, v, label)}`;
}

/** The batches of one variant that hold stock, earliest expiry first. */
export function BatchList({ locale, t, batches }: { locale: Locale; t: Messages; batches: BatchDto[] }) {
  const m = t.stock.movement;
  if (batches.length === 0) return <p className="muted">{m.batchesEmpty}</p>;
  return (
    <ul className="stock-batches" data-testid="stock-batches">
      {batches.map((b) => (
        <li key={b.batchId ?? "none"}>
          <span className="stock-batch-code">
            {b.batchId === null ? (
              m.noBatch
            ) : (
              <span dir="ltr" className="catalog-sku">
                {b.code ?? m.noCode}
              </span>
            )}
          </span>
          <span className="muted">{b.expiry ? formatDay(locale, new Date(b.expiry)) : b.batchId === null ? "" : m.noExpiry}</span>
          <ExpiryBadge t={t} status={b.status} />
          <strong className="stock-num">{fill(t.stock.qty.baseUnits, { qty: formatQty(locale, b.qty) })}</strong>
        </li>
      ))}
    </ul>
  );
}

/** Days left as words: "in 5 days", "expires today", "expired 3 days ago". */
export function daysLeftText(locale: Locale, t: Messages, daysLeft: number): string {
  const e = t.stock.expiring;
  if (daysLeft === 0) return e.today;
  if (daysLeft < 0) return fill(e.expiredAgo, { days: formatNumber(locale, -daysLeft) });
  return fill(e.daysLeft, { days: formatNumber(locale, daysLeft) });
}

/** The expiring batches, earliest first. */
export function ExpiringTable({ locale, t, rows }: { locale: Locale; t: Messages; rows: ExpiringDto[] }) {
  const e = t.stock.expiring;
  return (
    <table className="data-table stock-expiring" data-testid="expiring-table">
      <thead>
        <tr>
          <th scope="col">{e.colItem}</th>
          <th scope="col">{e.colBatch}</th>
          <th scope="col">{e.colExpiry}</th>
          <th scope="col">{e.colLeft}</th>
          <th scope="col">{e.colQty}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.batchId} data-testid="expiring-row" data-status={r.status}>
            <td>
              <Link href={variantHref(r.variantId)} className="stock-cell-name" title={pickName(locale, r)}>
                {pickName(locale, r)}
              </Link>
            </td>
            <td data-secondary>
              <CellLabel>{e.colBatch}</CellLabel>
              <span dir="ltr" className="catalog-sku">
                {r.code ?? t.stock.movement.noCode}
              </span>
            </td>
            <td data-secondary>
              <CellLabel>{e.colExpiry}</CellLabel>
              {formatDay(locale, new Date(r.expiry))}
            </td>
            <td>
              <span className="stock-left">
                <ExpiryBadge t={t} status={r.status} />
                <span>{daysLeftText(locale, t, r.daysLeft)}</span>
              </span>
            </td>
            <td className="stock-num">
              <CellLabel>{e.colQty}</CellLabel>
              <strong>{breakdownText(locale, t, r.breakdown)}</strong>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
