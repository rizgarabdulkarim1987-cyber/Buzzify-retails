import Link from "next/link";
import { formatDate, formatNumber } from "@/messages";
import { listImportBatches } from "@/server/catalog/import/actions";
import { getI18n } from "../../../_lib/i18n";
import { StateBlock } from "../../../_ui/state";
import { loadCatalogAccess } from "../_lib/access";
import { RefusedPage } from "../_lib/state-pages";
import { ImportRefused, batchStatusKey } from "./_lib/parts";
import { UploadForm } from "./upload-form";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Import start: upload a file (then the wizard opens) and the list of earlier files. OWNER and MANAGER only. */
export default async function ImportPage({ searchParams }: { searchParams: SearchParams }) {
  const { locale, t } = await getI18n();
  const access = await loadCatalogAccess();
  if (!access.ok) return <RefusedPage code={access.code} t={t} />;
  if (!access.canImport) return <ImportRefused t={t} />;
  const fromSetup = (await searchParams).from === "setup";
  const ti = t.catalog.import;

  const batches = await listImportBatches({ page: 0 }, access.meta);
  if (!batches.ok) {
    return (
      <main className="page">
        <StateBlock kind="alert" title={t.common.errorTitle} body={t.errors[batches.code]} testId="state-error" />
      </main>
    );
  }

  return (
    <main className="page page-narrow">
      <div className="page-head">
        <div className="title-row">
          <h1>{ti.title}</h1>
          <Link href={fromSetup ? "/retail/setup" : "/retail/catalog"} className="btn btn-secondary catalog-add">
            {fromSetup ? ti.backToSetup : ti.back}
          </Link>
        </div>
        <p>{ti.intro}</p>
      </div>

      <section className="section panel" aria-labelledby="import-upload-title">
        <h2 id="import-upload-title">{ti.uploadTitle}</h2>
        <UploadForm t={t} fromSetup={fromSetup} trialOption={fromSetup && access.canMarkTrial} />
      </section>

      <section className="section" aria-labelledby="import-history-title" data-testid="import-history">
        <div className="section-head">
          <h2 id="import-history-title">{ti.history}</h2>
        </div>
        {batches.value.length === 0 ? (
          <p className="muted" data-testid="import-history-empty">
            {ti.historyEmpty}
          </p>
        ) : (
          <table className="data-table import-history">
            <thead>
              <tr>
                <th scope="col">{ti.colFile}</th>
                <th scope="col">{ti.colStatus}</th>
                <th scope="col">{ti.colRows}</th>
                <th scope="col">{ti.colSaved}</th>
                <th scope="col">{ti.colDate}</th>
              </tr>
            </thead>
            <tbody>
              {batches.value.map((b) => {
                const stats = (b.stats ?? {}) as { total?: number };
                const status = batchStatusKey(b.status, b.committedRows);
                return (
                  <tr key={b.id} data-testid="import-batch">
                    <td>
                      <Link href={`/retail/catalog/import/${b.id}${fromSetup ? "?from=setup" : ""}`} className="truncate import-file-link" dir="auto">
                        {b.fileName}
                      </Link>
                      {b.isTestData ? (
                        <>
                          {" "}
                          <span className="badge">{ti.trialBadge}</span>
                        </>
                      ) : null}
                    </td>
                    <td>
                      <span className="badge" data-tone={status === "COMMITTED" ? "accent" : status === "PARTIAL" ? "warn" : undefined}>
                        {ti.batchStatus[status]}
                      </span>
                    </td>
                    <td data-secondary>{formatNumber(locale, stats.total ?? 0)}</td>
                    <td data-secondary>{formatNumber(locale, b.committedRows)}</td>
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
