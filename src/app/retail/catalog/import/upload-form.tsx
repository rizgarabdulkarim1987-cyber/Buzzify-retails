"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import type { Messages } from "@/messages";
import { Notice } from "../../../_ui/state";
import { failureMessage } from "../_lib/failures";
import { useHydrated } from "../_lib/hydrated";
import { newKey } from "../_lib/keys";
import { stageImportAction } from "./actions";
import { MAX_FILE_BYTES } from "./_lib/types";

/** The file's bytes as base64 (FileReader data URL without its prefix). */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      const comma = url.indexOf(",");
      resolve(comma >= 0 ? url.slice(comma + 1) : "");
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Picks a .csv/.xlsx file, reads it in the browser and stages it (the server parses it; the bytes
 * themselves are never stored). On success the wizard of the new batch opens.
 */
export function UploadForm({ t, fromSetup }: { t: Messages; fromSetup: boolean }) {
  const ti = t.catalog.import;
  const router = useRouter();
  const hydrated = useHydrated();
  const id = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const key = useRef(newKey());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trial, setTrial] = useState(false);

  async function upload() {
    const file = fileRef.current?.files?.[0];
    setError(null);
    if (!file) return setError(ti.chooseFile);
    if (file.size > MAX_FILE_BYTES) return setError(ti.tooLarge);
    setBusy(true);
    try {
      let content: string;
      try {
        content = await readBase64(file);
      } catch {
        setError(ti.readFailed);
        return;
      }
      const r = await stageImportAction(key.current, { fileName: file.name, contentBase64: content, isTestData: fromSetup && trial });
      if (!r.ok) {
        setError(failureMessage(t, r));
        key.current = newKey();
        return;
      }
      const params = new URLSearchParams();
      if (r.value.sameFileBatchId) params.set("same", "1");
      if (fromSetup) params.set("from", "setup");
      const query = params.toString();
      router.push(`/retail/catalog/import/${r.value.batchId}${query ? `?${query}` : ""}`);
    } catch {
      setError(t.internalError);
      key.current = newKey();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) void upload();
      }}
      noValidate
      data-testid="import-upload"
    >
      <label className="field" htmlFor={`${id}-file`}>
        <span>{ti.file}</span>
        <input
          id={`${id}-file`}
          ref={fileRef}
          className="input import-file"
          type="file"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          disabled={!hydrated || busy}
          aria-describedby={`${id}-hint ${id}-tip`}
          data-testid="import-file"
          onChange={() => setError(null)}
        />
        <span className="hint" id={`${id}-hint`}>
          {ti.fileHint}
        </span>
      </label>
      <p className="import-tip" id={`${id}-tip`}>
        {ti.barcodeTip}
      </p>
      {fromSetup ? (
        <label className="check">
          <input type="checkbox" checked={trial} onChange={(e) => setTrial(e.target.checked)} disabled={!hydrated || busy} data-testid="import-trial" />
          {ti.trialLabel}
        </label>
      ) : null}
      <div aria-live="polite" data-testid="import-upload-status">
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
      <div className="import-actions">
        <button type="submit" className="btn btn-primary" disabled={!hydrated || busy} aria-busy={busy} data-testid="import-upload-submit">
          {busy ? ti.uploading : ti.upload}
        </button>
      </div>
    </form>
  );
}
