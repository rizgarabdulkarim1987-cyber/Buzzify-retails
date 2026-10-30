import Link from "next/link";
import type { Ref } from "react";
import { formatDate, formatNumber, type Locale, type Messages } from "@/messages";
import { fill, formatMoney, pickName } from "../../../_lib/format";
import { Notice, StateBlock } from "../../../_ui/state";
import { receiptFailureMessage, receiveHref, showsRate, unitOf, type LineProblem, type LineWarning, type ReceiptKind, type ReceiptLine, type ReceiptSettings } from "./receipt-rules";
import type { Currency, StockFailure } from "./types";

/*
 * The receiving screen's drawing, without state: the form (receipt-form.tsx) holds the lines and
 * the server calls; these draw one line's fields, the post bar, the save state and the summary.
 */

export type LineField = "unitId" | "quantity" | "cost" | "currency" | "rate" | "batchCode" | "expiryDate";

const FIELD_PROBLEMS: Record<"quantity" | "cost" | "rate" | "batchCode" | "expiryDate", readonly LineProblem[]> = {
  quantity: ["QUANTITY_REQUIRED", "BAD_QUANTITY"],
  cost: ["BAD_COST", "COST_REQUIRED"],
  rate: ["BAD_RATE", "RATE_REQUIRED"],
  batchCode: ["BAD_BATCH"],
  expiryDate: ["BAD_EXPIRY", "EXPIRY_REQUIRED", "EXPIRED"],
};

type LineProps = {
  locale: Locale;
  t: Messages;
  line: ReceiptLine;
  index: number;
  kind: ReceiptKind;
  settings: ReceiptSettings;
  /** The problems to show now (the form decides when: a field with text, or after a post attempt). */
  problems: readonly LineProblem[];
  warnings: readonly LineWarning[];
  disabled: boolean;
  onChange: (field: LineField, value: string) => void;
  onRemove: () => void;
};

/** One line of the document: the item, its unit and quantity, the cost (and rate), and the batch when the item has one. */
export function LineFields({ locale, t, line, index, kind, settings, problems, warnings, disabled, onChange, onRemove }: LineProps) {
  const r = t.stock.receive;
  const id = `line-${line.key}`;
  const name = pickName(locale, line.item);
  const problemOf = (field: keyof typeof FIELD_PROBLEMS) => problems.find((p) => FIELD_PROBLEMS[field].includes(p));
  const describedBy = (field: string, problem: LineProblem | undefined, hint?: boolean) =>
    [problem ? `${id}-${field}-error` : null, hint ? `${id}-${field}-hint` : null].filter(Boolean).join(" ") || undefined;
  const qtyProblem = problemOf("quantity");
  const costProblem = problemOf("cost");
  const rateProblem = problemOf("rate");
  const batchProblem = problemOf("batchCode");
  const expiryProblem = problemOf("expiryDate");
  const unit = unitOf(line);
  const choosesCurrency = settings.enabledCurrencies.length > 1 || line.currency !== settings.defaultCurrency;
  const currencies = settings.enabledCurrencies.includes(line.currency) ? settings.enabledCurrencies : [...settings.enabledCurrencies, line.currency];

  return (
    <li className="receipt-line" data-testid="receipt-line" data-line={index + 1} aria-labelledby={`${id}-name`}>
      <div className="receipt-line-head">
        <span className="receipt-line-no">{fill(r.lineNo, { n: formatNumber(locale, index + 1) })}</span>
        <span className="receipt-line-name truncate" id={`${id}-name`} title={name} dir="auto">
          {name}
        </span>
        <span className="receipt-line-sku muted" dir="ltr">
          {line.item.sku}
        </span>
        <button type="button" className="btn btn-secondary btn-small" onClick={onRemove} disabled={disabled} aria-label={fill(r.removeFor, { name })} data-testid="line-remove">
          {r.remove}
        </button>
      </div>
      <div className="receipt-line-fields">
        <label className="field">
          <span>{r.unit}</span>
          <select className="input" value={line.unitId} onChange={(e) => onChange("unitId", e.target.value)} disabled={disabled} data-testid="line-unit">
            {unit ? null : <option value={line.unitId}>—</option>}
            {line.item.units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{r.quantity}</span>
          <input
            className="input"
            dir="ltr"
            inputMode="decimal"
            autoComplete="off"
            maxLength={40}
            value={line.quantity}
            onChange={(e) => onChange("quantity", e.target.value)}
            disabled={disabled}
            aria-invalid={qtyProblem ? true : undefined}
            aria-describedby={describedBy("qty", qtyProblem)}
            data-testid="line-quantity"
          />
          {qtyProblem ? <FieldError id={`${id}-qty-error`} text={r.problems[qtyProblem]} /> : null}
        </label>

        {line.costHidden ? (
          <p className="muted receipt-line-wide" data-testid="line-cost-hidden">
            {r.costHidden}
          </p>
        ) : (
          <>
            <label className="field">
              <span>{kind === "RECEIPT" ? r.cost : r.costOptional}</span>
              <input
                className="input"
                dir="ltr"
                inputMode="decimal"
                autoComplete="off"
                maxLength={40}
                value={line.cost}
                onChange={(e) => onChange("cost", e.target.value)}
                disabled={disabled}
                aria-invalid={costProblem ? true : undefined}
                aria-describedby={describedBy("cost", costProblem, index === 0)}
                data-testid="line-cost"
              />
              {index === 0 ? (
                <span className="hint" id={`${id}-cost-hint`}>
                  {r.costHint}
                </span>
              ) : null}
              {costProblem ? <FieldError id={`${id}-cost-error`} text={r.problems[costProblem]} /> : null}
            </label>
            {choosesCurrency ? (
              <label className="field">
                <span>{r.currency}</span>
                <select className="input" value={line.currency} onChange={(e) => onChange("currency", e.target.value)} disabled={disabled} data-testid="line-currency">
                  {currencies.map((c) => (
                    <option key={c} value={c}>
                      {t.catalog.currencyShort[c]}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {showsRate(line, settings) ? (
              <label className="field">
                <span>{r.rate}</span>
                <input
                  className="input"
                  dir="ltr"
                  inputMode="decimal"
                  autoComplete="off"
                  maxLength={40}
                  value={line.rate}
                  onChange={(e) => onChange("rate", e.target.value)}
                  disabled={disabled}
                  aria-invalid={rateProblem ? true : undefined}
                  aria-describedby={describedBy("rate", rateProblem, true)}
                  data-testid="line-rate"
                />
                <span className="hint" id={`${id}-rate-hint`}>
                  {r.rateHint}
                </span>
                {rateProblem ? <FieldError id={`${id}-rate-error`} text={r.problems[rateProblem]} /> : null}
              </label>
            ) : null}
          </>
        )}

        {line.item.trackingMode === "BATCH" ? (
          <>
            <label className="field">
              <span>{r.batchOptional}</span>
              <input
                className="input"
                dir="auto"
                autoComplete="off"
                maxLength={64}
                value={line.batchCode}
                onChange={(e) => onChange("batchCode", e.target.value)}
                disabled={disabled}
                aria-invalid={batchProblem ? true : undefined}
                aria-describedby={describedBy("batch", batchProblem)}
                data-testid="line-batch"
              />
              {batchProblem ? <FieldError id={`${id}-batch-error`} text={r.problems[batchProblem]} /> : null}
            </label>
            <label className="field">
              <span>{r.expiryDate}</span>
              <input
                className="input"
                type="date"
                dir="ltr"
                value={line.expiryDate}
                onChange={(e) => onChange("expiryDate", e.target.value)}
                disabled={disabled}
                required={line.item.tracksExpiry}
                aria-invalid={expiryProblem ? true : undefined}
                aria-describedby={describedBy("expiry", expiryProblem)}
                data-testid="line-expiry"
              />
              {expiryProblem ? <FieldError id={`${id}-expiry-error`} text={r.problems[expiryProblem]} /> : null}
            </label>
          </>
        ) : null}
      </div>
      {warnings.length > 0 ? (
        <ul className="receipt-line-warnings" data-testid="line-warnings">
          {warnings.map((w) => (
            <li key={w}>
              <span className="badge" data-tone="warn">
                {r.warnings[w]}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function FieldError({ id, text }: { id: string; text: string }) {
  return (
    <span className="field-error" id={id}>
      {text}
    </span>
  );
}

type PostBarProps = {
  t: Messages;
  posting: boolean;
  /** Some line still has a problem: posting shows them instead of sending. */
  blocked: boolean;
  /** A saved draft exists (there is something to delete). */
  canDiscard: boolean;
  /** Writing is impossible here (a read-only business): both buttons are disabled. */
  disabled?: boolean;
  onPost: () => void;
  onDiscard: () => void;
};

/**
 * Post and delete. While a post is on its way the post button is aria-disabled (it keeps focus, so
 * the answer is announced where the user is) and the click does nothing; delete is disabled.
 */
export function PostBar({ t, posting, blocked, canDiscard, disabled = false, onPost, onDiscard }: PostBarProps) {
  const r = t.stock.receive;
  return (
    <div className="receipt-post">
      <p className="hint" id="receipt-post-hint">
        {blocked ? r.fixFirst : r.postHint}
      </p>
      <div className="receipt-post-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={disabled || undefined}
          aria-disabled={posting || undefined}
          aria-busy={posting || undefined}
          aria-describedby="receipt-post-hint"
          onClick={() => {
            if (!posting) onPost();
          }}
          data-testid="receipt-post"
        >
          {posting ? r.posting : r.post}
        </button>
        {canDiscard ? (
          <button type="button" className="btn btn-danger" disabled={disabled || posting} onClick={onDiscard} data-testid="receipt-discard">
            {r.discard}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export type SaveState =
  | { kind: "idle" | "saving" | "saved" | "pending" | "offline" }
  | { kind: "blocked"; line: number }
  | { kind: "failed"; failure: StockFailure };

/** Where the draft stands on the server, announced politely. */
export function SaveStatusText({ locale = "ar", t, state }: { locale?: Locale; t: Messages; state: SaveState }) {
  const s = t.stock.receive.saveState;
  const text =
    state.kind === "blocked"
      ? fill(s.blocked, { n: formatNumber(locale, state.line) })
      : state.kind === "failed"
        ? fill(s.failed, { reason: receiptFailureMessage(t, state.failure, locale) })
        : s[state.kind];
  return (
    <p className="receipt-save muted" data-state={state.kind} data-testid="receipt-save-state">
      {text}
    </p>
  );
}

export function LinesEmpty({ t }: { t: Messages }) {
  return <StateBlock kind="empty" title={t.stock.receive.emptyTitle} body={t.stock.receive.emptyBody} testId="receipt-empty" />;
}

/** A draft holding costs this role cannot see: shown read-only (post or delete only). */
export function HiddenCostNotice({ t }: { t: Messages }) {
  return (
    <div className="section" data-testid="receipt-hidden-costs">
      <Notice tone="danger">
        <strong>{t.stock.receive.hiddenTitle}.</strong> {t.stock.receive.hiddenBody}
      </Notice>
    </div>
  );
}

export type ReceiptDoneDto = {
  documentId: string;
  number: number;
  kind: ReceiptKind;
  lineCount: number;
  /** The document's total value: only for cost.view holders. */
  totalMinor?: string;
  warnings: { lineNo: number; code: "EXPIRED" | "COST_MISSING" | "COST_UNKNOWN" }[];
};

type DoneProps = {
  locale: Locale;
  t: Messages;
  currency: Currency;
  done: ReceiptDoneDto;
  /** Where "New document" goes (the same kind, empty). */
  newHref?: string;
  headingRef?: Ref<HTMLHeadingElement>;
  alreadyPosted?: boolean;
};

/** After posting: the number, the lines, the total (cost.view only) and what posting noted. */
export function ReceiptDone({ locale, t, currency, done, newHref, headingRef, alreadyPosted = false }: DoneProps) {
  const r = t.stock.receive;
  return (
    <section className="section panel receipt-done" aria-labelledby="receipt-done-title" data-testid="receipt-done">
      <h2 id="receipt-done-title" tabIndex={-1} ref={headingRef}>
        {fill(r.doneTitle, { number: formatNumber(locale, done.number) })}
      </h2>
      {alreadyPosted ? <p className="muted">{r.alreadyPosted}</p> : null}
      <p data-testid="receipt-done-lines">{fill(r.doneLines, { count: formatNumber(locale, done.lineCount) })}</p>
      {done.totalMinor !== undefined ? (
        <p data-testid="receipt-done-total">{fill(r.doneTotal, { amount: formatMoney(locale, currency, done.totalMinor, t.catalog.currencyShort[currency]) })}</p>
      ) : null}
      {done.warnings.length > 0 ? (
        <>
          <h3>{r.doneWarnings}</h3>
          <ul className="receipt-done-warnings" data-testid="receipt-done-warnings">
            {done.warnings.map((w) => (
              <li key={`${w.lineNo}-${w.code}`}>{fill(r.doneWarning, { n: formatNumber(locale, w.lineNo), text: r.warnings[w.code] })}</li>
            ))}
          </ul>
        </>
      ) : null}
      <div className="receipt-done-actions">
        <Link href={newHref ?? `/retail/stock/receive${done.kind === "OPENING" ? "?kind=opening" : ""}`} className="btn btn-primary" data-testid="receipt-new">
          {r.newDocument}
        </Link>
        <Link href="/retail/stock" className="btn btn-secondary">
          {r.openStock}
        </Link>
      </div>
    </section>
  );
}

export type DraftRowDto = { id: string; kind: ReceiptKind; lineCount: number; createdAt: string };

/** The open drafts (receipts and opening stock) to continue. */
export function DraftList({ locale, t, drafts, query }: { locale: Locale; t: Messages; drafts: DraftRowDto[]; query: string }) {
  const r = t.stock.receive;
  if (drafts.length === 0) return null;
  return (
    <section className="section" aria-labelledby="receipt-drafts-title" data-testid="receipt-drafts">
      <div className="section-head">
        <h2 id="receipt-drafts-title">{r.drafts}</h2>
      </div>
      <p className="muted">{r.draftsHint}</p>
      <ul className="receipt-drafts">
        {drafts.map((d) => (
          <li key={d.id} className="receipt-draft">
            <span>{fill(r.draftItem, { kind: r.kinds[d.kind], lines: formatNumber(locale, d.lineCount), date: formatDate(locale, new Date(d.createdAt)) })}</span>
            <Link href={receiveHref({ draft: d.id }, query)} className="btn btn-secondary btn-small" data-testid="receipt-draft-open">
              {r.draftOpen}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
