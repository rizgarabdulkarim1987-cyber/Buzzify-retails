import Link from "next/link";
import { currentGate } from "@/server/framework/business-info";
import { getI18n } from "../../../_lib/i18n";
import { StateBlock } from "../../../_ui/state";
import { loadAiStatus } from "../../stock/receive/photo/_lib/load";
import { loadCatalogAccess } from "../_lib/access";
import { RefusedPage } from "../_lib/state-pages";
import { aiFallback, scanRole } from "./_lib/rules";
import { Scanner } from "./scanner";

export const dynamic = "force-dynamic";

/**
 * "Scan a barcode" (spec 3.7-3.9): camera, photo, typing or a USB scanner; the code is decoded on
 * the device and looked up. Looking up is open to anyone who sees stock or manages the catalog and
 * does not follow the AI switch; linking and new items need catalog.manage; the AI fallback also
 * needs ai.use, the switch, the owner's consent and quota (the page asks for the AI status only for
 * a role that could use it). The actions decide all of it again.
 */
export default async function ScanPage() {
  const { locale, t } = await getI18n();
  const access = await loadCatalogAccess();
  if (!access.ok) return <RefusedPage code={access.code} t={t} />;
  const s = t.catalog.scan;
  const role = scanRole(access.context.role);
  const back = (
    <Link href="/retail/catalog" className="btn btn-secondary" data-testid="scan-back">
      {s.back}
    </Link>
  );
  if (!role.canLookup) {
    return (
      <main className="page page-narrow">
        <StateBlock kind="locked" title={t.access.noPermissionTitle} body={t.access.noPermissionBody} testId="state-forbidden" action={back} />
      </main>
    );
  }
  const readOnly = (await currentGate(access.meta.businessId)) !== "FULL";
  const status = role.canUseAi && role.canManage ? await loadAiStatus(access.meta) : "UNAVAILABLE";

  return (
    <main className="page page-narrow">
      <div className="page-head">
        <div className="title-row">
          <h1>{s.title}</h1>
          <div className="title-actions">{back}</div>
        </div>
        <p>{s.intro}</p>
      </div>
      {readOnly && role.canManage ? (
        <p className="hint" data-testid="scan-read-only">
          {s.blocked.READ_ONLY}
        </p>
      ) : null}
      <Scanner t={t} locale={locale} role={role} ai={aiFallback(role, status, readOnly)} readOnly={readOnly} />
    </main>
  );
}
