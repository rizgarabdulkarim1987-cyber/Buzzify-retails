import Link from "next/link";
import type { ReactNode } from "react";
import { formatDateTime, formatNumber } from "@/messages";
import { CONSENT_VERSION } from "@/server/intake/consent";
import { listIntakes } from "@/server/intake/receipts";
import { fill } from "../../../../_lib/format";
import { getI18n } from "../../../../_lib/i18n";
import { StateBlock } from "../../../../_ui/state";
import { RefusedPage } from "../../../catalog/_lib/state-pages";
import { loadStockAccess } from "../../_lib/access";
import { ReadOnlyBanner } from "../../_lib/views";
import { ConsentPanel } from "./consent-panel";
import { PhotoCapture } from "./photo-capture";
import { loadAiStatus, photoRole } from "./_lib/load";
import { photoAccess } from "./_lib/rules";

export const dynamic = "force-dynamic";

const RECENT = 10;

/**
 * "From a receipt photo": take or upload the receipt's pages and send them to be read. The page
 * says first why it cannot be used (permission, the ai.intake switch, the owner's consent, the
 * quota); the actions check all of it again.
 */
export default async function ReceiptPhotoPage() {
  const { locale, t } = await getI18n();
  const access = await loadStockAccess();
  if (!access.ok) return <RefusedPage code={access.code} t={t} />;
  const m = t.stock.intake;
  const role = photoRole(access.context.role);
  const permitted = role.canUseAi && role.canReceive && role.seesCost;
  const status = permitted ? await loadAiStatus(access.meta) : "UNAVAILABLE";
  const state = photoAccess(role, status);

  const manual = (
    <Link href="/retail/stock/receive" className="btn btn-secondary" data-testid="intake-manual">
      {m.manual}
    </Link>
  );
  const head = (
    <div className="page-head">
      <div className="title-row">
        <h1>{m.title}</h1>
        <div className="title-actions">
          <Link href="/retail/stock/receive" className="btn btn-secondary" data-testid="intake-back">
            {m.back}
          </Link>
        </div>
      </div>
      <p>{m.intro}</p>
    </div>
  );

  let body: ReactNode;
  switch (state) {
    case "NO_PERMISSION":
      body = <StateBlock kind="locked" title={m.noPermissionTitle} body={m.noPermissionBody} testId="state-forbidden" action={manual} />;
      break;
    case "STATUS_FAILED":
      body = (
        <StateBlock
          kind="alert"
          title={t.common.errorTitle}
          body={m.statusFailed}
          testId="state-status-failed"
          action={
            <>
              <Link href="/retail/stock/receive/photo" className="btn btn-primary" data-testid="intake-status-retry">
                {t.common.retry}
              </Link>
              {manual}
            </>
          }
        />
      );
      break;
    case "DISABLED":
      body = <StateBlock kind="locked" title={m.disabledTitle} body={t.errors.AI_DISABLED} testId="state-ai-disabled" action={manual} />;
      break;
    case "CONSENT_OWNER":
      body = (
        <>
          {access.readOnly ? <ReadOnlyBanner t={t} /> : null}
          <ConsentPanel t={t} locale={locale} version={CONSENT_VERSION} readOnly={access.readOnly} />
        </>
      );
      break;
    case "CONSENT_ASK_OWNER":
      body = <StateBlock kind="locked" title={m.consent.askOwnerTitle} body={m.consent.askOwnerBody} testId="state-consent-ask" action={manual} />;
      break;
    case "QUOTA_CLOSED":
      body = <StateBlock kind="locked" title={m.quota.closedTitle} body={m.quota.closedBody} testId="state-quota-closed" action={manual} />;
      break;
    case "QUOTA_OUT":
      body = <StateBlock kind="alert" title={m.quota.outTitle} body={t.errors.AI_QUOTA_EXCEEDED} testId="state-quota-out" action={manual} />;
      break;
    default:
      body = null;
  }

  if (body !== null) {
    return (
      <main className="page page-narrow">
        {head}
        {body}
      </main>
    );
  }

  const recent = await listIntakes({ limit: RECENT }, access.meta);
  const rows = recent.ok ? recent.value.rows.filter((r) => r.status !== "DRAFTED" && r.status !== "DISCARDED") : [];
  return (
    <main className="page page-narrow">
      {head}
      {access.readOnly ? <ReadOnlyBanner t={t} /> : null}
      {status !== "UNAVAILABLE" && status.warn ? (
        <p className="hint" data-testid="intake-quota-warn">
          {fill(m.quota.warn, { used: formatNumber(locale, status.usedHalfUnits / 2), limit: formatNumber(locale, status.monthlyLimit) })}
        </p>
      ) : null}
      <PhotoCapture t={t} locale={locale} readOnly={access.readOnly} />
      {rows.length > 0 ? (
        <section className="section intake" aria-labelledby="intake-recent-title" data-testid="intake-recent">
          <div className="section-head">
            <h2 id="intake-recent-title">{m.capture.recent}</h2>
          </div>
          <ul className="intake-recent">
            {rows.map((r) => (
              <li key={r.id} className="intake-recent-row">
                <span>
                  <span className="truncate" dir="auto">
                    {r.supplier ?? m.status[r.status]}
                  </span>
                  <span className="muted">
                    {m.status[r.status]} · {fill(m.capture.recentLines, { count: formatNumber(locale, r.lineCount) })} · {formatDateTime(locale, r.createdAt)}
                  </span>
                </span>
                <Link href={`/retail/stock/receive/photo/${encodeURIComponent(r.id)}`} className="btn btn-secondary btn-small" data-testid="intake-recent-open">
                  {m.capture.open}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
