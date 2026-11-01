"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import { formatNumber, type Locale, type Messages } from "@/messages";
import { fill } from "../../../../_lib/format";
import { Notice } from "../../../../_ui/state";
import { useHydrated } from "../../../catalog/_lib/hydrated";
import { newKey } from "../../../catalog/_lib/keys";
import { nextAttempt } from "../../_lib/receipt-rules";
import type { StockFailure } from "../../_lib/types";
import { createIntakeAction } from "../../actions";
import { blobBase64, MAX_PAGES, PageError, pagesFingerprint, preparePage, roomFor } from "./_lib/image";
import { intakeFailureMessage, readGate } from "./_lib/rules";

type Page = { id: string; contentType: "image/jpeg" | "application/pdf"; blob: Blob; size: number; url: string | null };

/**
 * Taking or uploading a receipt's pages (up to six), each made smaller on the device, with a
 * preview and a remove button per page; "read" uploads them and opens the intake's screen, which
 * runs the read. The upload's idempotency key is kept while the same pages are sent again after a
 * lost answer (the read is reserved once); any change to the pages makes a new key.
 */
export function PhotoCapture({ t, locale, readOnly }: { t: Messages; locale: Locale; readOnly: boolean }) {
  const c = t.stock.intake.capture;
  const router = useRouter();
  const hydrated = useHydrated();
  const uid = useId();
  const [pages, setPages] = useState<Page[]>([]);
  const [processing, setProcessing] = useState(0);
  const [sending, setSending] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const [announce, setAnnounce] = useState("");
  const [failure, setFailure] = useState<StockFailure | null>(null);
  const [noAnswer, setNoAnswer] = useState(false);
  const attempt = useRef<{ payload: string; key: string } | null>(null);
  // Set at once on the first press (state lags a render): a double press never sends twice.
  const sendingRef = useRef(false);
  const urls = useRef(new Set<string>());
  const pagesHead = useRef<HTMLHeadingElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const failureRef = useRef<HTMLDivElement>(null);

  // Object URLs of the previews go when the screen does.
  useEffect(() => {
    const set = urls.current;
    return () => {
      for (const u of set) URL.revokeObjectURL(u);
      set.clear();
    };
  }, []);

  useEffect(() => {
    if (failure || noAnswer) failureRef.current?.focus();
  }, [failure, noAnswer]);

  const gate = readGate({ hydrated, processing: processing > 0, sending, pages });
  const blockedText = readOnly ? t.stock.intake.review.blocked.READ_ONLY : gate.ok ? c.hint : c.blocked[gate.reason];

  async function onFiles(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (files.length === 0 || sendingRef.current) return;
    const { take, dropped } = roomFor(pages.length + processing, files.length);
    const next: string[] = dropped > 0 ? [fill(c.tooMany, { count: formatNumber(locale, dropped) })] : [];
    let added = 0;
    setFailure(null);
    setNoAnswer(false);
    setProcessing((n) => n + take);
    for (const file of files.slice(0, take)) {
      try {
        const prepared = await preparePage(file);
        const url = prepared.contentType === "application/pdf" ? null : URL.createObjectURL(prepared.blob);
        if (url) urls.current.add(url);
        setPages((list) => [...list, { id: newKey(), contentType: prepared.contentType, blob: prepared.blob, size: prepared.blob.size, url }]);
        added += 1;
      } catch (err) {
        const reason = err instanceof PageError ? err.reason : "UNREADABLE";
        next.push(fill(reason === "PDF_TOO_LARGE" ? c.pdfTooLarge : reason === "TOO_LARGE" ? c.fileTooLarge : c.unreadable, { name: file.name }));
      } finally {
        setProcessing((n) => n - 1);
      }
    }
    setNotes(next);
    setAnnounce([added > 0 ? fill(c.added, { count: formatNumber(locale, added) }) : "", ...next].filter(Boolean).join(" "));
  }

  function remove(id: string) {
    if (sendingRef.current) return;
    const page = pages.find((p) => p.id === id);
    if (page?.url) {
      URL.revokeObjectURL(page.url);
      urls.current.delete(page.url);
    }
    setPages((list) => list.filter((p) => p.id !== id));
    setAnnounce(c.removed);
    // The removed button is gone: focus lands on the pages heading, never the body.
    pagesHead.current?.focus();
  }

  async function read() {
    if (sendingRef.current) return;
    if (readOnly || !gate.ok) {
      if (!readOnly && !gate.ok && gate.reason === "NO_PAGES") uploadRef.current?.focus();
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setFailure(null);
    setNoAnswer(false);
    // The same pages sent again (after no answer) keep their key: the server replays the upload.
    attempt.current = nextAttempt(attempt.current, pagesFingerprint(pages), newKey);
    const key = attempt.current.key;
    try {
      const files = await Promise.all(pages.map(async (p) => ({ contentType: p.contentType, data: await blobBase64(p.blob) })));
      const res = await createIntakeAction(key, { files });
      attempt.current = null;
      if (res.ok) {
        // Stays "sending" while the intake screen opens.
        router.push(`/retail/stock/receive/photo/${encodeURIComponent(res.value.intakeId)}`);
        return;
      }
      setFailure(res);
    } catch {
      setNoAnswer(true);
    }
    sendingRef.current = false;
    setSending(false);
  }

  return (
    <div className="intake" data-testid="intake-capture">
      <div aria-live="polite" className="visually-hidden" data-testid="intake-announce">
        {announce}
      </div>
      <section className="section panel intake" aria-labelledby={`${uid}-pages`}>
        <div className="intake-pick-row">
          <label className="btn btn-primary intake-pick">
            <input
              className="visually-hidden"
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => void onFiles(e)}
              disabled={!hydrated || sending || readOnly}
              data-testid="intake-camera"
            />
            {c.camera}
          </label>
          <label className="btn btn-secondary intake-pick">
            <input
              ref={uploadRef}
              className="visually-hidden"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf"
              multiple
              onChange={(e) => void onFiles(e)}
              disabled={!hydrated || sending || readOnly}
              data-testid="intake-upload"
            />
            {c.upload}
          </label>
        </div>
        <h2 id={`${uid}-pages`} ref={pagesHead} tabIndex={-1}>
          {fill(c.pages, { count: formatNumber(locale, pages.length), max: formatNumber(locale, MAX_PAGES) })}
        </h2>
        {notes.length > 0 ? (
          <ul className="intake-reasons" data-testid="intake-notes">
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}
        {processing > 0 ? (
          <p className="muted" role="status">
            {c.processing}
          </p>
        ) : null}
        {pages.length === 0 && processing === 0 ? (
          <p className="muted" data-testid="intake-no-pages">
            {c.empty}
          </p>
        ) : (
          <ol className="intake-pages" data-testid="intake-pages">
            {pages.map((p, i) => (
              <li key={p.id} className="intake-page" data-testid="intake-page">
                <div className="intake-page-thumb">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a local object URL, not an optimisable asset */}
                  {p.url ? <img src={p.url} alt={fill(c.page, { n: formatNumber(locale, i + 1) })} /> : <span>{c.pdf}</span>}
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  aria-disabled={sending || undefined}
                  onClick={() => remove(p.id)}
                  data-testid="intake-page-remove"
                >
                  {fill(c.removePage, { n: formatNumber(locale, i + 1) })}
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>

      <div ref={failureRef} tabIndex={-1} className="intake">
        {failure ? <Notice tone="danger">{intakeFailureMessage(t, failure, locale)}</Notice> : null}
        {noAnswer ? <Notice tone="danger">{c.noAnswer}</Notice> : null}
      </div>

      <section className="section intake-read">
        <p className="hint" id={`${uid}-read-hint`} data-testid="intake-read-hint">
          {blockedText}
        </p>
        <div>
          <button
            type="button"
            className="btn btn-primary"
            aria-disabled={readOnly || !gate.ok || undefined}
            aria-busy={sending || undefined}
            aria-describedby={`${uid}-read-hint`}
            onClick={() => void read()}
            data-testid="intake-read"
          >
            {sending ? c.sending : c.read}
          </button>
        </div>
      </section>
    </div>
  );
}
