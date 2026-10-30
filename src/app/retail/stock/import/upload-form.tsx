"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import type { Messages } from "@/messages";
import { Notice } from "../../../_ui/state";
import { useHydrated } from "../../catalog/_lib/hydrated";
import { newKey } from "../../catalog/_lib/keys";
import { MAX_FILE_BYTES } from "../../catalog/import/_lib/types";
import { stockFailureMessage } from "../_lib/adjust-rules";
import { stageOpeningAction } from "./actions";

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
 * Picks a .csv/.xlsx file of opening stock, reads it in the browser and stages it (the server
 * parses it and refuses a file whose stock was already posted). The wizard of the new batch opens next.
 */
export function OpeningUploadForm({ t, fromSetup }: { t: Messages; fromSetup: boolean }) {
  const ti = t.stock.openingImport;
  const router = useRouter();
  const hydrated = useHydrated();
  const id = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const key = useRef<{ name: string; size: number; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload() {
    const file = fileRef.current?.files?.[0];
    setError(null);
    if (!file) return setError(ti.chooseFile);
    if (file.size > MAX_FILE_BYTES) return setError(ti.tooLarge);
    // The same file sent again (after no answer) keeps its key; another file gets a new one.
    if (key.current?.name !== file.name || key.current.size !== file.size) key.current = { name: file.name, size: file.size, key: newKey() };
    const attempt = key.current.key;
    setBusy(true);
    try {
      let content: string;
      try {
        content = await readBase64(file);
      } catch {
        setError(ti.readFailed);
        return;
      }
      const r = await stageOpeningAction(attempt, { fileName: file.name, contentBase64: content });
      key.current = null;
      if (!r.ok) {
        setError(stockFailureMessage(t, r));
        return;
      }
      router.push(`/retail/stock/import/${r.value.batchId}${fromSetup ? "?from=setup" : ""}`);
    } catch {
      setError(t.internalError);
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
      data-testid="opening-upload"
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
          aria-describedby={`${id}-hint`}
          data-testid="opening-file"
          onChange={() => setError(null)}
        />
        <span className="hint" id={`${id}-hint`}>
          {ti.fileHint}
        </span>
      </label>
      <div aria-live="polite" data-testid="opening-upload-status">
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
      <div className="import-actions">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!hydrated}
          aria-disabled={busy || undefined}
          aria-busy={busy || undefined}
          data-testid="opening-upload-submit"
        >
          {busy ? ti.uploading : ti.upload}
        </button>
      </div>
    </form>
  );
}
