import type { Ref } from "react";
import { formatNumber, type Locale, type Messages } from "@/messages";
import { fill } from "../../../../../_lib/format";
import { lineBadge, type DraftGate, type IntakeDto, type IntakeLineDto, type LineReason } from "./rules";

/*
 * The receipt-photo screens' presentational pieces (no state, no actions): a line's state badge,
 * its reasons in words, the total check and the "create the draft" bar. Buttons that are pressed
 * while unavailable are aria-disabled with the reason beside them (they keep focus); never the
 * native disabled flag.
 */

/** The line's state in words; the tone only repeats it. */
export function LineBadge({ t, line }: { t: Messages; line: Pick<IntakeLineDto, "status" | "discarded"> }) {
  const b = lineBadge(line);
  return (
    <span className="badge" data-tone={b.tone ?? undefined} data-testid="intake-line-badge" data-kind={b.kind}>
      {t.stock.intake.badge[b.kind]}
    </span>
  );
}

/** Why a line needs a look, in words (an unknown reason is left out rather than shown as a code). */
export function ReasonList({ t, reasons }: { t: Messages; reasons: readonly string[] }) {
  const known = t.stock.intake.reasons as Readonly<Record<string, string>>;
  const shown = reasons.filter((r): r is LineReason => Object.hasOwn(known, r));
  if (shown.length === 0) return null;
  return (
    <ul className="intake-reasons" data-testid="intake-line-reasons">
      {shown.map((r) => (
        <li key={r}>{known[r]}</li>
      ))}
    </ul>
  );
}

/** The printed total against the lines; a difference may be accepted (it blocks the draft until then). */
export function TotalBar({
  t,
  intake,
  canAct,
  busy,
  onAccept,
}: {
  t: Messages;
  intake: Pick<IntakeDto, "total" | "totalOk" | "totalAcknowledged">;
  canAct: boolean;
  busy: boolean;
  onAccept: () => void;
}) {
  const r = t.stock.intake.review;
  const state = intake.totalOk ? "ok" : intake.totalAcknowledged ? "accepted" : "mismatch";
  return (
    <section className="intake-total" data-state={state} aria-labelledby="intake-total-title" data-testid="intake-total">
      <h3 id="intake-total-title">{r.totalTitle}</h3>
      {intake.total !== undefined ? (
        <p className="intake-total-value">
          <bdi dir="auto">{fill(r.total, { total: intake.total })}</bdi>
        </p>
      ) : null}
      {intake.total === undefined && intake.totalOk ? (
        <p className="muted">{r.totalNone}</p>
      ) : intake.totalOk ? (
        <p>{r.totalOk}</p>
      ) : (
        <>
          <p className="intake-total-warn">{r.totalMismatch}</p>
          {intake.totalAcknowledged ? (
            <p data-testid="intake-total-accepted">{r.totalAccepted}</p>
          ) : (
            <div>
              <button
                type="button"
                className="btn btn-secondary"
                aria-disabled={busy || !canAct || undefined}
                onClick={() => {
                  if (!busy && canAct) onAccept();
                }}
                data-testid="intake-total-accept"
              >
                {r.totalAccept}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Why "create the draft" is not available, in words (the interface digits). */
export function draftBlockText(t: Messages, locale: Locale, gate: DraftGate): string {
  const r = t.stock.intake.review;
  if (gate.ok) return r.draftHint;
  if (gate.reason === "UNRESOLVED") return fill(r.blocked.UNRESOLVED, { count: formatNumber(locale, gate.count), n: formatNumber(locale, gate.lineNo) });
  return r.blocked[gate.reason];
}

/** "Create the draft": aria-disabled with its reason while the receipt is not settled. */
export function DraftBar({
  t,
  locale,
  gate,
  busy,
  onDraft,
  buttonRef,
}: {
  t: Messages;
  locale: Locale;
  gate: DraftGate;
  busy: boolean;
  onDraft: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  const r = t.stock.intake.review;
  const blocked = !gate.ok || busy;
  return (
    <div className="intake-draft">
      <p className="hint" id="intake-draft-reason" data-testid="intake-draft-reason">
        {draftBlockText(t, locale, gate)}
      </p>
      <div>
        <button
          ref={buttonRef}
          type="button"
          className="btn btn-primary"
          aria-disabled={blocked || undefined}
          aria-busy={busy || undefined}
          aria-describedby="intake-draft-reason"
          onClick={onDraft}
          data-testid="intake-draft"
        >
          {busy ? r.drafting : r.draft}
        </button>
      </div>
    </div>
  );
}
