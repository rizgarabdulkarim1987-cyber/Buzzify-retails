import Link from "next/link";
import { getImportBatch, listMappingPresets } from "@/server/catalog/import/actions";
import { KNOWN_COLUMNS, autoMapHeaders } from "@/server/catalog/import/mapping";
import { getI18n } from "../../../../_lib/i18n";
import { isId } from "../../../../_lib/workplace";
import { StateBlock } from "../../../../_ui/state";
import { loadCatalogAccess } from "../../_lib/access";
import { RefusedPage } from "../../_lib/state-pages";
import { ImportRefused } from "../_lib/parts";
import type { BatchStats, Choice, ImportRowDto, MappingDto, PresetDto, RowStatusDto } from "../_lib/types";
import { ImportWizard } from "./import-wizard";

export const dynamic = "force-dynamic";

type Params = Promise<{ batchId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function mappingOf(stored: unknown, headers: string[]): MappingDto {
  if (typeof stored === "object" && stored !== null) {
    const m = stored as Record<string, unknown>;
    return Object.fromEntries(
      KNOWN_COLUMNS.map((c) => [c, typeof m[c] === "number" && (m[c] as number) < headers.length ? (m[c] as number) : null]),
    ) as MappingDto;
  }
  return autoMapHeaders(headers);
}

/** The wizard of one import batch: mapping, preview with decisions, save, summary. */
export default async function ImportBatchPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { locale, t } = await getI18n();
  const access = await loadCatalogAccess();
  if (!access.ok) return <RefusedPage code={access.code} t={t} />;
  if (!access.canImport) return <ImportRefused t={t} />;
  const { batchId } = await params;
  const query = await searchParams;
  const fromSetup = query.from === "setup";
  const ti = t.catalog.import;

  const missing = (
    <main className="page">
      <StateBlock
        kind="alert"
        title={t.errors.NOT_FOUND}
        body={ti.back}
        testId="state-not-found"
        action={
          <Link href="/retail/catalog/import" className="btn btn-secondary">
            {ti.newImport}
          </Link>
        }
      />
    </main>
  );
  if (!isId(batchId)) return missing;
  const [found, presets] = await Promise.all([getImportBatch({ batchId, page: 0 }, access.meta), listMappingPresets({}, access.meta)]);
  if (!found.ok) return found.code === "NOT_FOUND" ? missing : <RefusedPage code={found.code} t={t} />;
  const b = found.value;
  const headers = Array.isArray(b.columns) ? b.columns.map((c) => (typeof c === "string" ? c : "")) : [];

  const rows: ImportRowDto[] = b.rows.map((r) => ({
    rowNumber: r.rowNumber,
    status: r.status as RowStatusDto,
    reason: r.reason,
    raw: Array.isArray(r.raw) ? r.raw.map((c) => (typeof c === "string" ? c : "")) : [],
    diff: Array.isArray(r.diff) ? (r.diff as ImportRowDto["diff"]) : null,
    resolution: r.resolution === "UPDATE" || r.resolution === "SKIP" ? (r.resolution as Choice) : null,
  }));
  const presetList: PresetDto[] = presets.ok
    ? presets.value.map((p) => ({ id: p.id, name: p.name, mapping: mappingOf(p.mapping, headers) }))
    : [];

  return (
    <main className="page">
      <div className="page-head">
        <div className="title-row">
          <h1 className="import-title" dir="auto">
            {b.fileName}
          </h1>
          <Link href={`/retail/catalog/import${fromSetup ? "?from=setup" : ""}`} className="btn btn-secondary catalog-add">
            {ti.newImport}
          </Link>
        </div>
        <p>{ti.intro}</p>
      </div>
      <ImportWizard
        // A new render after every step (router.refresh) brings a new version: the wizard then re-reads its rows.
        key={`${b.id}:${b.version}:${b.status}`}
        locale={locale}
        t={t}
        batch={{
          id: b.id,
          fileName: b.fileName,
          status: b.status,
          version: b.version,
          isTestData: b.isTestData,
          headers,
          mapping: mappingOf(b.mapping, headers),
          stats: (b.stats ?? {}) as BatchStats,
          committedRows: b.committedRows,
          rowCount: b.rowCount,
        }}
        initialRows={rows}
        presets={presetList}
        sameFile={query.same === "1"}
      />
    </main>
  );
}
