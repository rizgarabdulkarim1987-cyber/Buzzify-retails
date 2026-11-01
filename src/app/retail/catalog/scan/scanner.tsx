"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent, type RefObject } from "react";
import type { Locale, Messages } from "@/messages";
import { fill, pickName } from "../../../_lib/format";
import { AlertIcon } from "../../../_ui/icons";
import { Notice } from "../../../_ui/state";
import { blobBase64, preparePage } from "../../stock/receive/photo/_lib/image";
import { scanLookupAction, scanReadImageAction } from "../actions";
import { useHydrated } from "../_lib/hydrated";
import { newKey } from "../_lib/keys";
import { captureFrame, createDecoder, stopStream, type Decoded, type Decoder } from "./_lib/decode";
import {
  SCAN_IMAGE_SIDE,
  decodedCode,
  emptyWedge,
  itemHref,
  newItemHref,
  normalizeScan,
  readAttempt,
  scanFailure,
  scanOutcome,
  wedgeKey,
  type AiFallback,
  type ScanOutcome,
  type ScanRole,
} from "./_lib/rules";
import { LinkItem } from "./link-item";

type Props = { t: Messages; locale: Locale; role: ScanRole; ai: AiFallback; readOnly: boolean };

type Camera = "off" | "starting" | "on" | "denied" | "unavailable";
type Busy = null | "looking" | "decoding" | "ai" | "opening";
type Shown = ScanOutcome | { kind: "DECODE_FAILED" } | { kind: "LINKED"; name: string; productId: string };
type Still = { id: string; blob: Blob };

/** How often a live frame is tried, in ms (a phone keeps up; the decoders take 10-60 ms). */
const FRAME_EVERY_MS = 250;

/** True when the key went to a field the user types in (then the field handles a scanner's keys itself). */
function typingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

/**
 * The barcode scan screen. The camera (or a photo, or typed digits, or a USB scanner) gives a code,
 * decoded on this device; the code is looked up (lookupBarcode). A known item opens; an unknown
 * code can be linked to an item (addBarcode) or start a new item (R1's quick entry). When a photo
 * cannot be decoded, "Read with AI" is offered to those who may use it. The camera stops when a
 * code is found, when the page is hidden, and when the screen goes away.
 */
export function Scanner({ t, locale, role, ai, readOnly }: Props) {
  const s = t.catalog.scan;
  const router = useRouter();
  const hydrated = useHydrated();
  const uid = useId();
  const [camera, setCamera] = useState<Camera>("off");
  const [reader, setReader] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [busy, setBusy] = useState<Busy>(null);
  const [looking, setLooking] = useState("");
  const [shown, setShown] = useState<Shown | null>(null);
  const [failure, setFailure] = useState<ReturnType<typeof scanFailure> | null>(null);
  const [noAnswer, setNoAnswer] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [code, setCode] = useState("");

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const decoderRef = useRef<Promise<Decoder> | null>(null);
  const loopRef = useRef<number | null>(null);
  // Bumped by every start and stop: a start that resumes after an await sees whether it is still current.
  const cameraGen = useRef(0);
  // Set at once (state lags a render): a double press or a second scan never sends twice.
  const busyRef = useRef(false);
  const stillRef = useRef<Still | null>(null);
  const attempt = useRef<{ payload: string; key: string } | null>(null);
  const wedge = useRef(emptyWedge());
  const resultRef = useRef<HTMLHeadingElement>(null);
  const failureRef = useRef<HTMLDivElement>(null);
  const manualRef = useRef<HTMLInputElement>(null);
  const cameraButtonRef = useRef<HTMLButtonElement>(null);

  // ---------------------------------------------------------------------------------------------
  // Camera

  const stopCamera = useCallback((next: Camera = "off") => {
    cameraGen.current += 1;
    if (loopRef.current !== null) window.clearTimeout(loopRef.current);
    loopRef.current = null;
    stopStream(streamRef.current);
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCamera((c) => (c === "denied" || c === "unavailable" ? c : next));
  }, []);

  // The stream ends with the screen (a route change unmounts it) and when the page is hidden.
  useEffect(() => {
    const hide = () => {
      if (document.visibilityState === "hidden") stopCamera();
    };
    const leave = () => stopCamera();
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", leave);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", leave);
      if (loopRef.current !== null) window.clearTimeout(loopRef.current);
      stopStream(streamRef.current);
      streamRef.current = null;
    };
  }, [stopCamera]);

  const decoder = useCallback(() => {
    if (!decoderRef.current) {
      setReader("loading");
      decoderRef.current = createDecoder().then(
        (d) => {
          setReader("ready");
          return d;
        },
        (err: unknown) => {
          decoderRef.current = null;
          setReader("failed");
          throw err;
        },
      );
    }
    return decoderRef.current;
  }, []);

  // ---------------------------------------------------------------------------------------------
  // A code found: look it up

  const lookUp = useCallback(
    async (raw: string) => {
      if (busyRef.current) return;
      const value = normalizeScan(raw);
      if (value === null) {
        setManualError(s.manual.invalid);
        manualRef.current?.focus();
        return;
      }
      busyRef.current = true;
      setBusy("looking");
      setLooking(value);
      setShown(null);
      setFailure(null);
      setNoAnswer(false);
      setManualError(null);
      setLinking(false);
      setAnnounce(fill(s.looking, { code: value }));
      try {
        const res = await scanLookupAction(value);
        if (!res.ok) {
          setFailure(scanFailure(t, res, locale));
        } else {
          const outcome = scanOutcome(res.value, role);
          if (outcome.kind === "OPEN") {
            // Stays busy while the item opens.
            setBusy("opening");
            setAnnounce(s.result.opening);
            router.push(itemHref(outcome.productId));
            return;
          }
          setShown(outcome);
        }
      } catch {
        setFailure(scanFailure(t, { code: "INTERNAL" }, locale));
      }
      busyRef.current = false;
      setBusy(null);
    },
    [locale, role, router, s, t],
  );

  const found = useCallback(
    (raw: string) => {
      stopCamera();
      setCode(normalizeScan(raw) ?? raw);
      setAnnounce(fill(s.camera.found, { code: raw }));
      void lookUp(raw);
    },
    [lookUp, s, stopCamera],
  );

  /** A camera / photo decode: its symbology is known, so a UPC-E is expanded before the look-up. */
  const foundDecoded = useCallback((d: Decoded) => found(decodedCode(d) ?? d.text), [found]);

  async function startCamera() {
    if (!hydrated || busyRef.current || camera === "starting" || camera === "on") return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setCamera("unavailable");
      return;
    }
    const gen = ++cameraGen.current;
    // The page was hidden, the camera stopped or a code was found while we waited: this start is void.
    const stale = () => gen !== cameraGen.current;
    setCamera("starting");
    setShown(null);
    setFailure(null);
    setNoAnswer(false);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    } catch (err) {
      if (stale()) return;
      const name = err instanceof DOMException ? err.name : "";
      setCamera(name === "NotAllowedError" || name === "SecurityError" ? "denied" : "unavailable");
      return;
    }
    if (stale()) {
      stopStream(stream);
      return;
    }
    streamRef.current = stream;
    const video = videoRef.current;
    if (!video) {
      stopCamera();
      return;
    }
    video.srcObject = stream;
    try {
      await video.play();
    } catch {
      // Autoplay of a muted inline video is allowed; a failure leaves the frame black, the loop just finds nothing.
    }
    if (stale()) return; // whoever stopped it already released the stream
    setCamera("on");
    let d: Decoder;
    try {
      d = await decoder();
    } catch {
      return; // the reader failed: the camera still serves "take a photo" for the AI, and typing works
    }
    if (stale()) return;
    const tick = async () => {
      if (streamRef.current !== stream) return;
      if (!busyRef.current) {
        try {
          const value = await d.frame(video);
          if (value && streamRef.current === stream) {
            foundDecoded(value);
            return;
          }
        } catch {
          // A frame that cannot be read is skipped.
        }
      }
      if (streamRef.current === stream) loopRef.current = window.setTimeout(() => void tick(), FRAME_EVERY_MS);
    };
    void tick();
  }

  // ---------------------------------------------------------------------------------------------
  // A photo: decode it here; when that fails, the AI may read it

  async function decodeStill(blob: Blob) {
    const still: Still = { id: newKey(), blob };
    stillRef.current = still;
    attempt.current = null;
    busyRef.current = true;
    setBusy("decoding");
    setShown(null);
    setFailure(null);
    setNoAnswer(false);
    setLinking(false);
    let value: Decoded | null = null;
    try {
      value = await (await decoder()).still(blob);
    } catch {
      value = null;
    }
    busyRef.current = false;
    setBusy(null);
    if (value) {
      foundDecoded(value);
      return;
    }
    setShown({ kind: "DECODE_FAILED" });
  }

  async function snap() {
    if (busyRef.current || camera !== "on" || !videoRef.current) return;
    const blob = await captureFrame(videoRef.current, SCAN_IMAGE_SIDE);
    stopCamera();
    if (blob) await decodeStill(blob);
  }

  async function onPhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || busyRef.current) return;
    stopCamera();
    try {
      // The receipt pages' shrink: upright, at most 1800 px, a JPEG under 1 MB.
      const page = await preparePage(file);
      if (page.contentType !== "image/jpeg") throw new Error("not an image");
      await decodeStill(page.blob);
    } catch {
      setShown(null);
      setFailure({ text: fill(t.stock.intake.capture.unreadable, { name: file.name }), owner: null });
    }
  }

  async function readWithAi() {
    const still = stillRef.current;
    if (busyRef.current || ai !== "SHOW" || !still) return;
    busyRef.current = true;
    setBusy("ai");
    setFailure(null);
    setNoAnswer(false);
    setAnnounce(s.ai.reading);
    // The same photo after no answer keeps its key: the server answers from the first attempt.
    attempt.current = readAttempt(attempt.current, still.id, newKey);
    try {
      const res = await scanReadImageAction(attempt.current.key, { contentType: still.blob.type || "image/jpeg", data: await blobBase64(still.blob) });
      // INTERNAL is our side failing mid-way (the read may have happened): a retry of the same photo
      // keeps the key, so the server answers it from the first attempt without a second charge.
      if (res.ok || res.code !== "INTERNAL") attempt.current = null;
      if (!res.ok) {
        setFailure(scanFailure(t, res, locale));
      } else {
        const outcome = scanOutcome(res.value, role);
        if (outcome.kind === "OPEN") {
          setBusy("opening");
          setAnnounce(s.result.opening);
          router.push(itemHref(outcome.productId));
          return;
        }
        if (outcome.kind === "UNKNOWN" || outcome.kind === "KNOWN") setCode(outcome.kind === "UNKNOWN" ? outcome.code : outcome.item.code);
        setShown(outcome);
      }
    } catch {
      setNoAnswer(true);
    }
    busyRef.current = false;
    setBusy(null);
  }

  // ---------------------------------------------------------------------------------------------
  // Typing and the USB scanner

  function onManual(event: FormEvent) {
    event.preventDefault();
    if (!hydrated || busyRef.current) return;
    if (code.trim() === "") {
      setManualError(s.manual.empty);
      manualRef.current?.focus();
      return;
    }
    stopCamera();
    void lookUp(code);
  }

  // A scanner typing while no field has the focus: fast keys ending in Enter are a code.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A field's own keys, shortcuts, and any scan while a look-up or read is under way are not a code.
      if (event.ctrlKey || event.metaKey || event.altKey || typingTarget(event.target) || busyRef.current) {
        wedge.current = emptyWedge();
        return;
      }
      const r = wedgeKey(wedge.current, event.key, event.timeStamp);
      wedge.current = r.state;
      if (r.code) {
        event.preventDefault();
        setCode(r.code);
        found(r.code);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [found]);

  // Focus: the result's title when it appears, the notices on a refusal.
  useEffect(() => {
    if (shown) resultRef.current?.focus();
  }, [shown]);
  useEffect(() => {
    if (failure || noAnswer) failureRef.current?.focus();
  }, [failure, noAnswer]);

  function again() {
    if (busyRef.current) return;
    setShown(null);
    setFailure(null);
    setNoAnswer(false);
    setLinking(false);
    setCode("");
    stillRef.current = null;
    attempt.current = null;
    manualRef.current?.focus();
  }

  // ---------------------------------------------------------------------------------------------
  // Drawing

  const working = !hydrated || busy !== null;
  const manageBlock = !hydrated ? s.blocked.LOADING : busy !== null ? s.blocked.BUSY : readOnly ? s.blocked.READ_ONLY : null;
  const cameraNote =
    camera === "denied"
      ? s.camera.denied
      : camera === "unavailable"
        ? s.camera.unavailable
        : reader === "failed"
          ? s.camera.readerFailed
          : camera === "starting"
            ? s.camera.starting
            : camera === "on"
              ? reader === "loading"
                ? s.camera.loadingReader
                : s.camera.live
              : null;

  return (
    <div className="scan" data-testid="scan">
      <div aria-live="polite" className="visually-hidden" data-testid="scan-announce">
        {announce}
      </div>

      <section className="section panel scan-camera" aria-labelledby={`${uid}-camera`}>
        <h2 id={`${uid}-camera`}>{s.camera.title}</h2>
        <div className="scan-view" hidden={camera !== "on" && camera !== "starting"}>
          <video ref={videoRef} className="scan-video" playsInline muted aria-label={s.camera.title} data-testid="scan-video" />
          {camera === "on" ? <span className="scan-frame" aria-hidden="true" /> : null}
        </div>
        {cameraNote ? (
          <p className="hint" role="status" data-testid="scan-camera-note">
            {cameraNote}
          </p>
        ) : null}
        <div className="scan-actions">
          {camera === "on" ? (
            <>
              <button type="button" className="btn btn-primary" aria-disabled={working || undefined} onClick={() => void snap()} data-testid="scan-snap">
                {s.camera.snap}
              </button>
              <button
                type="button"
                ref={cameraButtonRef}
                className="btn btn-secondary"
                onClick={() => {
                  stopCamera();
                  cameraButtonRef.current?.focus();
                }}
                data-testid="scan-stop"
              >
                {s.camera.stop}
              </button>
            </>
          ) : (
            <button
              type="button"
              ref={cameraButtonRef}
              className="btn btn-primary"
              aria-disabled={working || camera === "starting" || undefined}
              aria-busy={camera === "starting" || undefined}
              onClick={() => void startCamera()}
              data-testid="scan-start"
            >
              {camera === "starting" ? s.camera.starting : s.camera.start}
            </button>
          )}
          <label className="btn btn-secondary scan-pick" data-disabled={working || undefined}>
            <input className="visually-hidden" type="file" accept="image/*" capture="environment" onChange={(e) => void onPhoto(e)} disabled={working} data-testid="scan-photo" />
            {s.camera.choose}
          </label>
        </div>
      </section>

      <section className="section panel" aria-labelledby={`${uid}-manual`}>
        <form className="scan-manual" onSubmit={onManual} noValidate>
          <label className="field" htmlFor={`${uid}-code`}>
            <span id={`${uid}-manual`}>{s.manual.label}</span>
          </label>
          <div className="scan-manual-row">
            <input
              id={`${uid}-code`}
              ref={manualRef}
              className="input"
              dir="ltr"
              inputMode="text"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="search"
              maxLength={64}
              value={code}
              aria-invalid={manualError ? true : undefined}
              aria-describedby={`${uid}-manual-hint`}
              onChange={(e) => {
                setCode(e.target.value);
                setManualError(null);
              }}
              data-testid="scan-code"
            />
            <button type="submit" className="btn btn-primary" aria-disabled={working || undefined} aria-busy={busy === "looking" || undefined} data-testid="scan-find">
              {s.manual.find}
            </button>
          </div>
          <p className="hint" id={`${uid}-manual-hint`}>
            {manualError ?? s.manual.hint}
          </p>
        </form>
      </section>

      <div ref={failureRef} tabIndex={-1} className="scan-notices" data-testid="scan-notices">
        {busy === "looking" ? (
          <p className="muted" role="status">
            {fill(s.looking, { code: looking })}
          </p>
        ) : null}
        {busy === "decoding" ? (
          <p className="muted" role="status">
            {s.camera.decoding}
          </p>
        ) : null}
        {busy === "opening" ? (
          <p className="muted" role="status">
            {s.result.opening}
          </p>
        ) : null}
        {failure ? (
          <Notice tone="danger">
            {failure.text}
            {failure.owner ? (
              <>
                {" "}
                <Link href={itemHref(failure.owner.productId)}>
                  {s.link.takenBy} {failure.owner.name}
                </Link>
              </>
            ) : null}
          </Notice>
        ) : null}
        {noAnswer ? <Notice tone="danger">{s.ai.noAnswer}</Notice> : null}
      </div>

      {shown ? (
        <section className="section panel scan-result" aria-labelledby={`${uid}-result`} data-testid="scan-result" data-kind={shown.kind}>
          <Result
            t={t}
            locale={locale}
            shown={shown}
            headingId={`${uid}-result`}
            headingRef={resultRef}
            ai={ai}
            busy={busy}
            manageBlock={manageBlock}
            onAi={() => void readWithAi()}
            onLink={() => {
              if (manageBlock) return;
              setLinking(true);
            }}
            onAgain={again}
          />
          {linking && shown.kind === "UNKNOWN" ? (
            <LinkItem
              t={t}
              locale={locale}
              code={shown.code}
              readOnly={readOnly}
              onCancel={() => {
                setLinking(false);
                resultRef.current?.focus();
              }}
              onLinked={(name, productId) => {
                setLinking(false);
                setShown({ kind: "LINKED", name, productId });
                setAnnounce(fill(s.link.linked, { name }));
              }}
            />
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

type ResultProps = {
  t: Messages;
  locale: Locale;
  shown: Shown;
  headingId: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
  ai: AiFallback;
  busy: Busy;
  manageBlock: string | null;
  onAi: () => void;
  onLink: () => void;
  onAgain: () => void;
};

function Result({ t, locale, shown, headingId, headingRef, ai, busy, manageBlock, onAi, onLink, onAgain }: ResultProps) {
  const r = t.catalog.scan.result;
  const again = (
    <button type="button" className="btn btn-secondary" aria-disabled={busy !== null || undefined} onClick={onAgain} data-testid="scan-again">
      {r.again}
    </button>
  );
  const heading = (text: string) => (
    <h2 id={headingId} ref={headingRef} tabIndex={-1}>
      {text}
    </h2>
  );

  switch (shown.kind) {
    case "OPEN":
      return null;
    case "KNOWN": {
      const item = shown.item;
      return (
        <>
          {heading(r.knownTitle)}
          <p className="scan-item-name" dir="auto">
            <strong>{pickName(locale, item)}</strong>
          </p>
          <p className="muted">
            {fill(r.unit, { unit: item.unitName })} · <span dir="ltr">{fill(r.sku, { sku: item.sku })}</span> · <span dir="ltr">{item.code}</span>
          </p>
          <ul className="scan-flags" data-testid="scan-flags">
            {shown.archived ? (
              <li>
                <span className="badge" data-tone="warn">
                  {r.archived}
                </span>{" "}
                {r.archivedNote}
              </li>
            ) : null}
            {shown.trial ? (
              <li>
                <span className="badge" data-tone="warn">
                  {r.trial}
                </span>{" "}
                {r.trialNote}
              </li>
            ) : null}
          </ul>
          <div className="scan-actions">
            <Link href={itemHref(item.productId)} className="btn btn-primary" data-testid="scan-open">
              {r.openItem}
            </Link>
            {again}
          </div>
        </>
      );
    }
    case "UNKNOWN":
      return (
        <>
          {heading(r.unknownTitle)}
          <p>
            {fill(r.unknownBody, { code: "⁦" + shown.code + "⁩" })}
          </p>
          {!shown.verified ? (
            <p className="scan-warn" data-testid="scan-unverified">
              <AlertIcon />
              <span>{r.unverified}</span>
            </p>
          ) : null}
          {shown.canLink || shown.canCreate ? (
            <>
              {manageBlock ? (
                <p className="hint" id={`${headingId}-block`}>
                  {manageBlock}
                </p>
              ) : null}
              <div className="scan-actions">
                {shown.canLink ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    aria-disabled={manageBlock !== null || undefined}
                    aria-describedby={manageBlock ? `${headingId}-block` : undefined}
                    onClick={onLink}
                    data-testid="scan-link"
                  >
                    {r.link}
                  </button>
                ) : null}
                {shown.canCreate ? (
                  manageBlock ? (
                    <span className="btn btn-secondary" role="link" tabIndex={0} aria-disabled="true" aria-describedby={`${headingId}-block`} data-testid="scan-create">
                      {r.create}
                    </span>
                  ) : (
                    <Link href={newItemHref(shown.code)} className="btn btn-secondary" data-testid="scan-create">
                      {r.create}
                    </Link>
                  )
                ) : null}
                {again}
              </div>
            </>
          ) : (
            <>
              <p className="hint">{r.noManage}</p>
              <div className="scan-actions">{again}</div>
            </>
          )}
        </>
      );
    case "LINKED":
      return (
        <>
          {heading(fill(t.catalog.scan.link.linked, { name: shown.name }))}
          <div className="scan-actions">
            <Link href={itemHref(shown.productId)} className="btn btn-primary" data-testid="scan-open">
              {r.openItem}
            </Link>
            {again}
          </div>
        </>
      );
    case "INVALID_CHECKSUM":
    case "NOT_READABLE":
    case "DECODE_FAILED": {
      const title = shown.kind === "INVALID_CHECKSUM" ? r.invalidTitle : shown.kind === "NOT_READABLE" ? r.notReadableTitle : r.failedTitle;
      const body = shown.kind === "INVALID_CHECKSUM" ? r.invalidBody : shown.kind === "NOT_READABLE" ? r.notReadableBody : r.failedBody;
      return (
        <>
          {heading(title)}
          <p>{body}</p>
          {shown.kind === "DECODE_FAILED" ? <AiOffer t={t} ai={ai} busy={busy} onAi={onAi} /> : null}
          <div className="scan-actions">{again}</div>
        </>
      );
    }
  }
}

/** "Read with AI" when the photo could not be decoded here: the button, or why it is not available. */
function AiOffer({ t, ai, busy, onAi }: { t: Messages; ai: AiFallback; busy: Busy; onAi: () => void }) {
  const a = t.catalog.scan.ai;
  const hintId = useId();
  switch (ai) {
    case "HIDE":
      return null;
    case "CONSENT_OWNER":
      return (
        <p className="hint" data-testid="scan-ai-consent">
          {a.CONSENT_OWNER}{" "}
          <Link href="/retail/settings/ai" data-testid="scan-ai-settings">
            {a.settings}
          </Link>
        </p>
      );
    case "CONSENT_ASK":
      return (
        <p className="hint" data-testid="scan-ai-consent">
          {a.CONSENT_ASK}
        </p>
      );
    default: {
      const blocked = ai !== "SHOW";
      const reading = busy === "ai";
      return (
        <div className="scan-ai" data-testid="scan-ai">
          <button
            type="button"
            className="btn btn-primary"
            aria-disabled={blocked || busy !== null || undefined}
            aria-busy={reading || undefined}
            aria-describedby={hintId}
            onClick={onAi}
            data-testid="scan-ai-read"
          >
            {a.read}
          </button>
          <p className="hint" id={hintId} role={reading ? "status" : undefined}>
            {reading ? a.reading : blocked ? a[ai] : a.hint}
          </p>
          {reading ? <span className="intake-spinner" aria-hidden="true" /> : null}
        </div>
      );
    }
  }
}
