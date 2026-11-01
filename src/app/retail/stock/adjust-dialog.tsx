"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { formatDay, type Locale, type Messages } from "@/messages";
import { fill, pickName } from "../../_lib/format";
import { Notice } from "../../_ui/state";
import { newKey } from "../catalog/_lib/keys";
import { adjustAction, adjustSetupAction } from "./actions";
import { batchChoices, checkAdjustForm, isStaleFailure, reasonsFor, stockFailureMessage, type AdjustProblem, type BatchChoices } from "./_lib/adjust-rules";
import { formatQty } from "./_lib/format";
import type { AdjustDone, AdjustMode, AdjustSetup, StockFailure, StockResult } from "./_lib/types";

export type AdjustTarget = { productId: string; variantId: string; name: string };

type Props = {
  locale: Locale;
  t: Messages;
  target: AdjustTarget;
  onClose: () => void;
  /** Called once the document is posted; the caller closes the dialog and refreshes what it shows. */
  onDone: (done: AdjustDone) => void;
};

const MODES: AdjustMode[] = ["IN", "OUT", "WRITE_OFF"];
/** The select value of the no-batch row (a batch id is never this). */
const NO_BATCH = "-";

/** The batch preselected for a movement: the only one offered, else none (or the no-batch row when allowed). */
function defaultBatch(c: BatchChoices): string {
  if (c.allowNone) return NO_BATCH;
  return c.batches.length === 1 ? c.batches[0]!.batchId! : "";
}

type Load = { state: "loading" } | { state: "failed"; failure: StockFailure | null } | { state: "ready"; setup: AdjustSetup };

/**
 * The adjust / write-off dialog: a native modal <dialog> (focus stays inside, Escape closes it,
 * focus returns to the button that opened it). The item is read fresh when it opens. One post at a
 * time: the submit button stays disabled until the server answers, and the idempotency key is kept
 * while the same form is retried after a lost answer, so a retry never posts twice.
 */
export function AdjustDialog({ locale, t, target, onClose, onDone }: Props) {
  const a = t.stock.adjust;
  const dialog = useRef<HTMLDialogElement>(null);
  const uid = useId();
  const titleId = `${uid}-title`;
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [mode, setMode] = useState<AdjustMode>("OUT");
  const [unitId, setUnitId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [batch, setBatch] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [problems, setProblems] = useState<AdjustProblem[]>([]);
  const [failure, setFailure] = useState<StockFailure | null>(null);
  const [sending, setSending] = useState(false);
  const attempt = useRef<{ payload: string; key: string } | null>(null);
  const loadSeq = useRef(0);
  const formRef = useRef<HTMLFormElement>(null);
  const [checkRun, setCheckRun] = useState(0);
  const modeRef = useRef<AdjustMode>("OUT");
  // The element that had focus when the dialog was asked for (the button that opened it), taken
  // while rendering, before showModal moves focus inside (an effect that runs twice would see the dialog).
  const [opener] = useState<HTMLElement | null>(() =>
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  // What a read of the item answered (only the newest read may apply its answer).
  const applySetup = useCallback((seq: number, r: StockResult<AdjustSetup> | null) => {
    if (seq !== loadSeq.current) return;
    if (r === null || !r.ok) {
      setLoad({ state: "failed", failure: r });
      return;
    }
    const s = r.value;
    setLoad({ state: "ready", setup: s });
    setUnitId((s.units.find((u) => u.isBase) ?? s.units[0])?.id ?? "");
    if (s.archived && modeRef.current === "IN") modeRef.current = "OUT";
    setMode(modeRef.current);
    setBatch(defaultBatch(batchChoices(s, modeRef.current)));
  }, []);

  const requestSetup = useCallback(() => {
    const seq = ++loadSeq.current;
    adjustSetupAction({ productId: target.productId, variantId: target.variantId }).then(
      (r) => applySetup(seq, r),
      () => applySetup(seq, null),
    );
  }, [target.productId, target.variantId, applySetup]);

  /** Read the item again (after a failed read, or when the server says the screen is out of date). */
  const readSetup = () => {
    setLoad({ state: "loading" });
    setFailure(null);
    requestSetup();
  };

  // Open as a modal at once; read the item; give focus back to the opener when the dialog goes away.
  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    requestSetup();
    const reads = loadSeq;
    return () => {
      reads.current += 1; // an answer that arrives after closing is dropped
      if (opener?.isConnected) opener.focus();
    };
  }, [requestSetup, opener]);

  // After a refused check, take the user to the first field to fix.
  useEffect(() => {
    if (checkRun > 0) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [checkRun]);

  const setup = load.state === "ready" ? load.setup : null;
  const blocked = setup ? setup.trackingMode === "SERIAL" || setup.isTestData : false;
  const choices = setup ? batchChoices(setup, mode) : null;
  const named = choices?.batches ?? [];
  const showBatch = choices?.show ?? false;
  const noBatchToUse = choices?.blocked ?? false;
  const unit = setup?.units.find((u) => u.id === unitId);
  const reasons = reasonsFor(mode);

  const problemText = (p: AdjustProblem) => a.problems[p];
  const fieldError = (field: AdjustProblem[]) => problems.find((p) => field.includes(p));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!setup || sending || blocked || noBatchToUse) return;
    const found = checkAdjustForm({
      mode,
      unitId,
      ...(unit ? { unit } : {}),
      quantity,
      batch: { needed: choices?.needed ?? false, chosen: batch === "" ? null : batch === NO_BATCH ? "" : batch },
      reason,
      note,
    });
    setProblems(found);
    setFailure(null);
    if (found.length > 0) {
      setCheckRun((n) => n + 1); // focus moves to the first field to fix once it is drawn
      return;
    }
    const input = {
      mode,
      variantId: setup.variantId,
      unitId,
      batchId: showBatch && batch !== NO_BATCH ? batch : null,
      quantity: quantity.trim(),
      reason,
      note: note.trim(),
    };
    const payload = JSON.stringify(input);
    // The same form sent again after a lost answer keeps its key (the server replays, never posts twice).
    if (attempt.current?.payload !== payload) attempt.current = { payload, key: newKey() };
    const key = attempt.current.key;
    setSending(true);
    try {
      const r = await adjustAction(key, input);
      attempt.current = null;
      if (r.ok) {
        onDone(r.value);
        return;
      }
      setFailure(r);
    } catch {
      // No answer (network): the key is kept for a retry of the same form.
      setFailure({ code: "INTERNAL" });
    } finally {
      setSending(false);
    }
  };

  const title = setup ? pickName(locale, setup) : target.name;
  const describedBy = (id: string, problem: AdjustProblem | undefined, hint?: string) =>
    [problem ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean).join(" ") || undefined;

  const unitProblem = fieldError(["UNIT_REQUIRED"]);
  const qtyProblem = fieldError(["QUANTITY_REQUIRED", "BAD_QUANTITY"]);
  const batchProblem = fieldError(["BATCH_REQUIRED"]);
  const reasonProblem = fieldError(["REASON_REQUIRED"]);
  const noteProblem = fieldError(["NOTE_REQUIRED"]);

  return (
    <dialog
      ref={dialog}
      className="stock-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        // Escape: close, unless a post is on its way (its answer must be seen).
        event.preventDefault();
        if (!sending) onClose();
      }}
      onClose={() => {
        // Closed by the browser itself: keep the screen in step (reopen while a post is on its way).
        if (sending) dialog.current?.showModal();
        else onClose();
      }}
      data-testid="adjust-dialog"
    >
      <form ref={formRef} className="form" onSubmit={(event) => void submit(event)} noValidate>
        <header className="stock-dialog-head">
          <div className="stock-dialog-title">
            <h2 id={titleId}>{a.title}</h2>
            <p className="stock-dialog-item" title={title}>
              {title}
            </p>
          </div>
          <button type="button" className="btn btn-secondary btn-small" onClick={onClose} disabled={sending}>
            {a.close}
          </button>
        </header>

        {load.state === "loading" ? (
          <p className="muted" role="status">
            {a.loading}
          </p>
        ) : null}
        {load.state === "failed" ? (
          <div className="product-note">
            <Notice tone="danger">{load.failure ? stockFailureMessage(t, load.failure) : a.loadFailed}</Notice>
            <div>
              <button type="button" className="btn btn-secondary" onClick={readSetup}>
                {t.common.retry}
              </button>
            </div>
          </div>
        ) : null}

        {setup && blocked ? <Notice tone="danger">{setup.trackingMode === "SERIAL" ? a.serial : a.trial}</Notice> : null}

        {setup && !blocked ? (
          <>
            <p className="muted">{a.intro}</p>
            {failure ? (
              <div className="product-note">
                <Notice tone="danger">{stockFailureMessage(t, failure)}</Notice>
                {isStaleFailure(failure) ? (
                  <div>
                    <button type="button" className="btn btn-secondary" onClick={readSetup} disabled={sending}>
                      {t.catalog.product.reload}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
            <fieldset className="fieldset" disabled={sending}>
              <legend>{a.mode}</legend>
              <div className="stock-modes" data-testid="adjust-mode">
                {MODES.map((m) => (
                  <label key={m} className="check stock-mode">
                    <input
                      type="radio"
                      name="mode"
                      value={m}
                      checked={mode === m}
                      disabled={m === "IN" && setup.archived}
                      onChange={() => {
                        modeRef.current = m;
                        setMode(m);
                        if (!(reasonsFor(m) as readonly string[]).includes(reason)) setReason("");
                        // The batches on offer depend on the movement: keep the choice only if it is still offered.
                        const next = batchChoices(setup, m);
                        if (batch !== NO_BATCH && !next.batches.some((b) => b.batchId === batch)) setBatch(defaultBatch(next));
                      }}
                    />
                    {a.modes[m]}
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="fieldset" disabled={sending}>
              <div className="field-row">
                <label className="field">
                  <span>{a.unit}</span>
                  <select
                    className="input"
                    value={unitId}
                    onChange={(event) => setUnitId(event.target.value)}
                    aria-invalid={unitProblem ? true : undefined}
                    aria-describedby={describedBy(`${uid}-unit`, unitProblem)}
                    data-testid="adjust-unit"
                  >
                    {setup.units.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </select>
                  {unitProblem ? <FieldError id={`${uid}-unit-error`} text={problemText(unitProblem)} /> : null}
                </label>
                <label className="field">
                  <span>{a.quantity}</span>
                  <input
                    className="input"
                    dir="ltr"
                    inputMode="decimal"
                    autoComplete="off"
                    maxLength={40}
                    value={quantity}
                    onChange={(event) => setQuantity(event.target.value)}
                    aria-invalid={qtyProblem ? true : undefined}
                    aria-describedby={describedBy(`${uid}-qty`, qtyProblem, a.quantityHint)}
                    data-testid="adjust-quantity"
                  />
                  <span className="hint" id={`${uid}-qty-hint`}>
                    {a.quantityHint}
                  </span>
                  {qtyProblem ? <FieldError id={`${uid}-qty-error`} text={problemText(qtyProblem)} /> : null}
                </label>
              </div>

              {showBatch ? (
                <label className="field">
                  <span>{a.batch}</span>
                  <select
                    className="input"
                    value={batch}
                    onChange={(event) => setBatch(event.target.value)}
                    aria-invalid={batchProblem ? true : undefined}
                    aria-describedby={describedBy(`${uid}-batch`, batchProblem)}
                    data-testid="adjust-batch"
                  >
                    {choices?.needed ? (
                      <option value="" disabled>
                        {a.batchChoose}
                      </option>
                    ) : null}
                    {choices?.allowNone ? <option value={NO_BATCH}>{a.batchNone}</option> : null}
                    {named.map((b) => {
                      const qty = fill(t.stock.qty.baseUnits, { qty: formatQty(locale, b.qty) });
                      const code = b.code ?? t.stock.movement.noCode;
                      return (
                        <option key={b.batchId} value={b.batchId!}>
                          {b.expiry
                            ? fill(a.batchOption, { code, date: formatDay(locale, new Date(b.expiry)), qty })
                            : fill(a.batchOptionNoDate, { code, qty })}
                        </option>
                      );
                    })}
                  </select>
                  {batchProblem ? <FieldError id={`${uid}-batch-error`} text={problemText(batchProblem)} /> : null}
                </label>
              ) : null}
              {noBatchToUse ? <Notice tone="danger">{a.noBatches}</Notice> : null}

              <label className="field">
                <span>{a.reason}</span>
                <select
                  className="input"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  aria-invalid={reasonProblem ? true : undefined}
                  aria-describedby={describedBy(`${uid}-reason`, reasonProblem)}
                  required
                  data-testid="adjust-reason"
                >
                  <option value="" disabled>
                    {a.reasonChoose}
                  </option>
                  {reasons.map((r) => (
                    <option key={r} value={r}>
                      {a.reasons[r]}
                    </option>
                  ))}
                </select>
                {reasonProblem ? <FieldError id={`${uid}-reason-error`} text={problemText(reasonProblem)} /> : null}
              </label>

              <label className="field">
                <span>{a.note}</span>
                <textarea
                  className="input"
                  maxLength={1000}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  required={reason === "OTHER"}
                  aria-invalid={noteProblem ? true : undefined}
                  aria-describedby={describedBy(`${uid}-note`, noteProblem, a.noteHint)}
                  data-testid="adjust-note"
                />
                <span className="hint" id={`${uid}-note-hint`}>
                  {a.noteHint}
                </span>
                {noteProblem ? <FieldError id={`${uid}-note-error`} text={problemText(noteProblem)} /> : null}
              </label>
            </fieldset>

            <div className="stock-dialog-actions">
              <button type="submit" className="btn btn-primary" disabled={sending || noBatchToUse} aria-busy={sending} data-testid="adjust-submit">
                {sending ? a.saving : a.submit}
              </button>
              <button type="button" className="btn btn-secondary" onClick={onClose} disabled={sending}>
                {a.cancel}
              </button>
            </div>
          </>
        ) : null}
      </form>
    </dialog>
  );
}

function FieldError({ id, text }: { id: string; text: string }) {
  return (
    <span className="field-error" id={id}>
      {text}
    </span>
  );
}
