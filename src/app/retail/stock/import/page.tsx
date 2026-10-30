import Link from "next/link";
import { formatDate, formatNumber } from "@/messages";
import { can } from "@/server/domain/permissions";
import { listOpeningImports } from "@/server/stock/import";
import { getI18n } from "../../../_lib/i18n";
import { StateBlock } from "../../../_ui/state";
import { RefusedPage } from "../../catalog/_lib/state-pages";
import { batchStatusKey } from "../../catalog/import/_lib/parts";
import { loadStockAccess } from "../_lib/access";
import { receiptFailureMessage } from "../_lib/receipt-rules";
import { ReadOnlyBanner } from "../_lib/views";
import { OpeningUploadForm } from "./upload-form";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Opening stock from a file: upload (then the wizard opens) and the earlier files. Needs stock.receive and catalog.import. */
export default async function OpeningImportPage({ searchParams }: { searchParams: SearchParams }) {
  const { locale, t } = await getI18n();
  const access = await loadStockAccess();
  if (!access.ok) return <RefusedPage code={access.code} t={t} />;
  const ti = t.stock.openingImport;
  const fromSetup = (await searchParams).from === "setup";
  const back = (
    <Link href={fromSetup ? "/retail/setup" : "/retail/stock"} className="btn btn-secondary" data-testid="opening-back">
      {fromSetup ? ti.backToSetup : ti.back}
    </Link>
  );
  if (!access.context.canReceive || !can(access.context.role, "catalog.import")) {
    return (
      <main className="page">
        <StateBlock kind="locked" title={ti.noPermissionTitle} body={ti.noPermissionBody} testId="state-forbidden" action={back} />
      </main>
    );
  }

  const batches = await listOpeningImports({ page: 0 }, access.meta);
  if (!batches.ok) {
    return (
      <main className="page">
        <StateBlock kind="alert" title={t.common.errorTitle} body={receiptFailureMessage(t, batches, locale)} testId="state-error" action={back} />
      </main>
    );
  }

  return (
    <main className="page page-narrow">
      <div className="page-head">
        <div className="title-row">
          <h1>{ti.title}</h1>
          {back}
        </div>
        <p>{ti.intro}</p>
      </div>
      {access.readOnly ? <ReadOnlyBanner t={t} /> : null}

      <section className="section panel" aria-labelledby="opening-upload-title">
        <h2 id="opening-upload-title">{ti.uploadTitle}</h2>
        <OpeningUploadForm t={t} fromSetup={fromSetup} />
      </section>

      <section className="section" aria-labelledby="opening-history-title" data-testid="opening-history">
        <div className="section-head">
          <h2 id="opening-history-title">{ti.history}</h2>
        </div>
        {batches.value.length === 0 ? (
          <p className="muted" data-testid="opening-history-empty">
            {ti.historyEmpty}
          </p>
        ) : (
          <table className="data-table import-history">
            <thead>
              <tr>
                <th scope="col">{ti.colFile}</th>
                <th scope="col">{ti.colStatus}</th>
                <th scope="col">{ti.colRows}</th>
                <th scope="col">{ti.colPosted}</th>
                <th scope="col">{ti.colDate}</th>
              </tr>
            </thead>
            <tbody>
              {batches.value.map((b) => {
                const stats = (b.stats ?? {}) as { total?: number };
                const status = batchStatusKey(b.status, b.postedRows);
                return (
                  <tr key={b.id} data-testid="opening-batch">
                    <td>
                      <Link href={`/retail/stock/import/${b.id}${fromSetup ? "?from=setup" : ""}`} className="truncate import-file-link" dir="auto">
                        {b.fileName}
                      </Link>
                    </td>
                    <td>
                      <span className="badge" data-tone={status === "COMMITTED" ? "accent" : status === "PARTIAL" ? "warn" : undefined}>
                        {ti.batchStatus[status]}
                      </span>
                    </td>
                    <td data-secondary>{formatNumber(locale, stats.total ?? 0)}</td>
                    <td data-secondary>{formatNumber(locale, b.postedRows)}</td>
                    <td data-secondary>{formatDate(locale, b.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
