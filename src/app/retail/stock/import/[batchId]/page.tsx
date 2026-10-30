import Link from "next/link";
import { can } from "@/server/domain/permissions";
import { autoMapOpeningHeaders, getOpeningImport } from "@/server/stock/import";
import { getI18n } from "../../../../_lib/i18n";
import { isId } from "../../../../_lib/workplace";
import { StateBlock } from "../../../../_ui/state";
import { RefusedPage } from "../../../catalog/_lib/state-pages";
import { loadStockAccess } from "../../_lib/access";
import { OPENING_FIELDS, rowDto, type OpeningMappingDto, type OpeningStatsDto, type OpeningSummaryDto } from "../../_lib/opening-import";
import { receiptFailureMessage } from "../../_lib/receipt-rules";
import { ReadOnlyBanner } from "../../_lib/views";
import { OpeningImportWizard } from "./opening-import-wizard";

export const dynamic = "force-dynamic";

type Params = Promise<{ batchId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const num = (o: Record<string, unknown>, k: string) => (typeof o[k] === "number" ? (o[k] as number) : 0);

/** One opening-stock file: column mapping, preview, posting with progress, and the summary. */
export default async function OpeningImportBatchPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { locale, t } = await getI18n();
  const access = await loadStockAccess();
  if (!access.ok) return <RefusedPage code={access.code} t={t} />;
  const ti = t.stock.openingImport;
  const fromSetup = (await searchParams).from === "setup";
  const listHref = `/retail/stock/import${fromSetup ? "?from=setup" : ""}`;
  const back = (
    <Link href={listHref} className="btn btn-secondary">
      {ti.newImport}
    </Link>
  );
  const role = access.context.role;
  if (!access.context.canReceive || !can(role, "catalog.import")) {
    return (
      <main className="page">
        <StateBlock kind="locked" title={ti.noPermissionTitle} body={ti.noPermissionBody} testId="state-forbidden" action={back} />
      </main>
    );
  }
  const { batchId } = await params;
  const missing = (
    <main className="page">
      <StateBlock kind="alert" title={t.errors.NOT_FOUND} body={ti.back} testId="state-not-found" action={back} />
    </main>
  );
  if (!isId(batchId)) return missing;
  const found = await getOpeningImport({ batchId, page: 0 }, access.meta);
  if (!found.ok) {
    if (found.code === "NOT_FOUND") return missing;
    return (
      <main className="page">
        <StateBlock kind="alert" title={t.common.errorTitle} body={receiptFailureMessage(t, found, locale)} testId="state-error" action={back} />
      </main>
    );
  }
  const b = found.value;
  const auto = autoMapOpeningHeaders(b.headers);
  const mapping: OpeningMappingDto = b.mapping
    ? (Object.fromEntries(OPENING_FIELDS.map((f) => [f, b.mapping![f] !== null && b.mapping![f]! < b.headers.length ? b.mapping![f] : null])) as OpeningMappingDto)
    : auto;
  // The columns that hold costs: locked for a role without cost.view (the server refuses a change).
  const costColumns = [...new Set([auto.cost, b.mapping?.cost ?? null].filter((c): c is number => c !== null))];
  const stats = (b.stats ?? {}) as Record<string, unknown>;
  const status = b.status === "STAGED" || b.status === "VALIDATED" || b.status === "COMMITTED" ? b.status : "FAILED";
  const summary: OpeningSummaryDto = {
    total: num(stats, "total"),
    ok: num(stats, "ok"),
    hasStock: num(stats, "hasStock"),
    rejected: num(stats, "rejected"),
    skipped: num(stats, "skipped"),
    expired: num(stats, "expired"),
    costMissing: num(stats, "costMissing"),
  };
  const committed: OpeningStatsDto = {
    total: num(stats, "total"),
    posted: num(stats, "posted"),
    skipped: num(stats, "skipped"),
    skippedHasStock: num(stats, "skippedHasStock"),
    rejected: num(stats, "rejected"),
    documents: num(stats, "documents"),
  };

  return (
    <main className="page">
      <div className="page-head">
        <div className="title-row">
          <h1 className="import-title" dir="auto">
            {b.fileName}
          </h1>
          <div className="title-actions">
            {back}
            {fromSetup ? (
              <Link href="/retail/setup" className="btn btn-secondary">
                {ti.backToSetup}
              </Link>
            ) : null}
          </div>
        </div>
        <p>{ti.intro}</p>
      </div>
      {access.readOnly ? <ReadOnlyBanner t={t} /> : null}
      <OpeningImportWizard
        // A new render after validation brings a new version: the wizard then starts from the new state.
        key={`${b.id}:${b.version}:${status}`}
        locale={locale}
        t={t}
        currency={access.context.defaultCurrency}
        canSeeCost={access.context.canSeeCost}
        readOnly={access.readOnly}
        listHref={listHref}
        batch={{
          id: b.id,
          fileName: b.fileName,
          status,
          version: b.version,
          headers: b.headers,
          mapping,
          costColumns,
          summary,
          committed,
          rowCount: b.rowCount,
          postedRows: b.postedRows,
          numbers: b.documents.map((d) => d.number).filter((n): n is number => n !== null),
        }}
        initialRows={b.rows.map(rowDto)}
      />
    </main>
  );
}
