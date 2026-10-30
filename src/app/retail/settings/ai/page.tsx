import Link from "next/link";
import { formatNumber } from "@/messages";
import { CONSENT_VERSION } from "@/server/intake/consent";
import { fill } from "../../../_lib/format";
import { getI18n } from "../../../_lib/i18n";
import { Notice, StateBlock } from "../../../_ui/state";
import { RefusedPage } from "../../catalog/_lib/state-pages";
import { consentState, scanRole, settingsView, usageView } from "../../catalog/scan/_lib/rules";
import { loadStockAccess } from "../../stock/_lib/access";
import { ConsentPanel } from "../../stock/receive/photo/consent-panel";
import { loadAiStatus } from "../../stock/receive/photo/_lib/load";
import { FocusOnChange, RevokeConsent } from "./revoke-consent";

export const dynamic = "force-dynamic";

const CONSENT_HEADING = "ai-consent-title";

/**
 * AI settings (spec 3.10, 3.11, 3ب.4-5, 9): the consent and its text version, and this month's
 * reads against the plan's aiMonthly with the 80% warning. The owner grants (switch on) and
 * withdraws (also with the switch off or read-only); the manager sees the same page without the
 * controls; nobody else opens it. The actions check all of it again.
 */
export default async function AiSettingsPage() {
  const { locale, t } = await getI18n();
  const access = await loadStockAccess();
  if (!access.ok) return <RefusedPage code={access.code} t={t} />;
  const a = t.aiSettings;
  const role = scanRole(access.context.role);
  const mayView = role.isOwner || (role.isManager && role.canUseAi);
  const status = mayView ? await loadAiStatus(access.meta) : "UNAVAILABLE";
  const view = settingsView(role, status, access.readOnly);

  const home = (
    <Link href="/retail/home" className="btn btn-secondary" data-testid="ai-settings-back">
      {a.back}
    </Link>
  );
  const head = (
    <div className="page-head">
      <div className="title-row">
        <h1>{a.title}</h1>
        <div className="title-actions">{home}</div>
      </div>
      <p>{a.intro}</p>
    </div>
  );

  if (view.access !== "OK" || status === "UNAVAILABLE") {
    return (
      <main className="page page-narrow">
        {head}
        {view.access === "NO_PERMISSION" ? (
          <StateBlock kind="locked" title={a.noPermissionTitle} body={a.noPermissionBody} testId="state-forbidden" action={home} />
        ) : (
          <StateBlock
            kind="alert"
            title={t.common.errorTitle}
            body={t.stock.intake.statusFailed}
            testId="state-status-failed"
            action={
              <Link href="/retail/settings/ai" className="btn btn-primary" data-testid="ai-settings-retry">
                {t.common.retry}
              </Link>
            }
          />
        )}
      </main>
    );
  }

  const consent = consentState(status);
  const usage = usageView(status);
  const n = (v: number) => formatNumber(locale, v);

  return (
    <main className="page page-narrow ai-settings">
      {head}
      {!status.enabled ? (
        <section className="section panel" data-testid="ai-switch-off">
          <h2>{a.switchOffTitle}</h2>
          <p className="muted">{a.switchOffBody}</p>
        </section>
      ) : null}

      <section className="section panel ai-consent" aria-labelledby={CONSENT_HEADING} data-testid="ai-consent">
        <h2 id={CONSENT_HEADING} tabIndex={-1}>
          {a.consent.title}
        </h2>
        <p className="ai-consent-state" aria-live="polite" data-state={consent} data-testid="ai-consent-state">
          {a.consent.state[consent]}
        </p>
        <p className="muted" data-testid="ai-consent-version">
          {fill(a.consent.version, { v: n(CONSENT_VERSION) })}
        </p>
        {role.isOwner ? null : <p className="hint">{a.consent.ownerOnly}</p>}
        {view.revoke === "SHOW" ? <RevokeConsent t={t} locale={locale} /> : null}
        <FocusOnChange targetId={CONSENT_HEADING} value={consent} />
      </section>

      {view.grant === "READ_ONLY" ? (
        <p className="hint" data-testid="ai-grant-read-only">
          {t.errors.READ_ONLY}
        </p>
      ) : null}
      {view.grant !== "HIDE" ? <ConsentPanel t={t} locale={locale} version={CONSENT_VERSION} readOnly={view.grant === "READ_ONLY"} /> : null}

      <section className="section panel ai-usage" aria-labelledby="ai-usage-title" data-testid="ai-usage">
        <h2 id="ai-usage-title">{a.usage.title}</h2>
        {usage.closed ? (
          <p data-testid="ai-usage-closed">{a.usage.closed}</p>
        ) : (
          <>
            <p className="ai-usage-figure" data-testid="ai-usage-used">
              {fill(a.usage.used, { used: n(usage.used), limit: n(usage.limit) })}
            </p>
            <meter className="ai-meter" min={0} max={usage.limit} low={usage.limit * 0.8} high={usage.limit * 0.8} optimum={0} value={Math.min(usage.used, usage.limit)} aria-label={a.usage.meter}>
              {fill(a.usage.used, { used: n(usage.used), limit: n(usage.limit) })}
            </meter>
            <p className="muted" data-testid="ai-usage-remaining">
              {fill(a.usage.remaining, { remaining: n(usage.remaining) })}
            </p>
            {usage.warn ? (
              <div data-testid="ai-usage-warn">
                <Notice tone="danger">{a.usage.warn}</Notice>
              </div>
            ) : null}
          </>
        )}
        <p className="hint">{a.usage.note}</p>
      </section>
    </main>
  );
}
