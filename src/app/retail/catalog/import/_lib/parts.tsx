import Link from "next/link";
import type { Messages } from "@/messages";
import { StateBlock } from "../../../../_ui/state";

export type BatchStatusKey = "STAGED" | "VALIDATED" | "COMMITTED" | "FAILED" | "PARTIAL";

/** A batch's status for people: a VALIDATED batch with rows already in the catalog is "partly saved". */
export function batchStatusKey(status: string, committedRows: number): BatchStatusKey {
  if (status === "VALIDATED" && committedRows > 0) return "PARTIAL";
  return status === "STAGED" || status === "VALIDATED" || status === "COMMITTED" ? status : "FAILED";
}

/** The page body for a member without catalog.import (cashier, stock officer, ...). */
export function ImportRefused({ t }: { t: Messages }) {
  return (
    <main className="page">
      <StateBlock
        kind="locked"
        title={t.catalog.import.noPermissionTitle}
        body={t.catalog.import.noPermissionBody}
        testId="state-forbidden"
        action={
          <Link href="/retail/catalog" className="btn btn-secondary">
            {t.catalog.import.back}
          </Link>
        }
      />
    </main>
  );
}
