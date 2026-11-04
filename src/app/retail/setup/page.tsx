import { randomUUID } from "node:crypto";
import Link from "next/link";
import { redirect } from "next/navigation";
import { formatNumber, type Locale, type Messages } from "@/messages";
import type { RtRole } from "@/generated/prisma/client";
import { userLabels } from "@/server/auth/users";
import { can } from "@/server/domain/permissions";
import { getPack, packWords } from "@/packs";
import { CAPABILITIES } from "@/server/domain/profiles";
import { currentGate } from "@/server/framework/business-info";
import {
  AVAILABLE_STEPS,
  CURRENCIES,
  DEFAULT_TIMEZONE,
  MANAGER_GRANTABLE,
  STAFF_ROLES,
  getSetupProgress,
  setupOverview,
  type SetupOverview,
  type SetupStep,
} from "@/server/setup/progress";
import { getI18n } from "../../_lib/i18n";
import { Notice, StateBlock } from "../../_ui/state";
import { requireShell } from "../_shell";
import { CatalogStep } from "./catalog-step";
import { OpeningStep } from "./opening-step";
import { StepForm } from "./step-form";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const shell = await requireShell();
  const { locale, t } = await getI18n();
  if (!shell.businessId) redirect("/retail/select");
  const businessId = shell.businessId;
  const meta = { userId: shell.user.id, businessId, idempotencyKey: "" };

  const progress = await getSetupProgress({}, meta);
  if (!progress.ok) {
    return (
      <main className="page">
        {progress.code === "READ_ONLY" ? (
          <StateBlock kind="alert" title={t.access.closedTitle} body={t.access.closedBody} testId="state-closed" />
        ) : (
          <StateBlock
            kind="locked"
            title={t.setup.noPermissionTitle}
            body={t.setup.noPermissionBody}
            testId="state-forbidden"
            action={
              <Link href="/retail/home" className="btn btn-secondary">
                {t.setup.backToHome}
              </Link>
            }
          />
        )}
      </main>
    );
  }
  const overview = await setupOverview({}, meta);
  if (!overview.ok) {
    return (
      <main className="page">
        <StateBlock kind="alert" title={t.common.errorTitle} body={t.errors[overview.code]} testId="state-error" />
      </main>
    );
  }
  const readOnly = (await currentGate(businessId)) !== "FULL";
  const labels = await userLabels(overview.value.staff.map((s) => s.userId));
  const role = shell.options?.ok ? shell.options.value.role : null;

  const steps = progress.value;
  // An optional step counts once it is done or skipped.
  const done = steps.filter((s) => s.available && (s.status === "DONE" || (s.optional && s.status === "SKIPPED"))).length;
  const formT = { ...t.setup, errors: t.errors, internalError: t.internalError };


  return (
    <main className="page">
      <div className="page-head">
        <div className="title-row">
          <h1>{t.setup.title}</h1>
          <span className="badge" data-tone={done === AVAILABLE_STEPS.length ? "accent" : undefined} data-testid="setup-done-count">
            <span className="visually-hidden">{t.setup.progress}: </span>
            {formatNumber(locale, done)} / {formatNumber(locale, AVAILABLE_STEPS.length)}
          </span>
        </div>
        <p>{t.setup.intro}</p>
      </div>

      {readOnly ? (
        <div className="section" data-testid="setup-read-only">
          <Notice tone="danger">
            <strong>{t.setup.readOnlyTitle}.</strong> {t.setup.readOnlyBody}
          </Notice>
        </div>
      ) : null}

      <ol className="choice-list setup-steps">
        {steps.map((s) => (
          <li
            key={s.step}
            className="choice-card"
            data-testid={`setup-step-${s.step}`}
            data-status={s.available ? s.status : "SOON"}
          >
            <div className="choice-card-head">
              <span className="setup-step-num" aria-hidden="true">
                {formatNumber(locale, s.step)}
              </span>
              <h2 className="setup-step-title">
                <span className="visually-hidden">
                  {t.setup.stepLabel} {formatNumber(locale, s.step)}:{" "}
                </span>
                {t.setup.steps[s.key]}
              </h2>
              {s.optional ? (
                <span className="badge" data-testid={`setup-optional-${s.step}`}>
                  {t.setup.optional}
                </span>
              ) : null}
              <StatusBadge step={s} t={t} />
            </div>
            {s.step === 4 ? (
              <CatalogStep
                locale={locale}
                businessId={businessId}
                products={overview.value.catalog.products}
                testProducts={overview.value.catalog.testProducts}
                canImport={role !== null && can(role, "catalog.import")}
                canManage={role !== null && can(role, "catalog.manage")}
                canRemoveTrial={role !== null && can(role, "catalog.manage") && can(role, "staff.manage")}
                disabled={readOnly}
                t={formT}
              />
            ) : s.step === 6 && s.available ? (
              <OpeningStep
                businessId={businessId}
                status={s.status}
                canReceive={role !== null && can(role, "stock.receive")}
                canImport={role !== null && can(role, "stock.receive") && can(role, "catalog.import")}
                canSkip
                disabled={readOnly}
                t={formT}
              />
            ) : s.available ? (
              <StepForm step={s.step} businessId={businessId} idempotencyKey={randomUUID()} disabled={readOnly} t={formT}>
                <StepFields step={s.step} overview={overview.value} labels={labels} role={role} locale={locale} t={t} />
              </StepForm>
            ) : (
              <p className="muted">{t.setup.soonBody}</p>
            )}
          </li>
        ))}
      </ol>
    </main>
  );
}

function StatusBadge({ step, t }: { step: SetupStep; t: Messages }) {
  if (!step.available) return <span className="badge">{t.setup.statusLabels.SOON}</span>;
  return (
    <span className="badge" data-tone={step.status === "DONE" ? "accent" : step.status === "PENDING" ? "warn" : undefined} data-testid={`setup-status-${step.step}`}>
      {t.setup.statusLabels[step.status]}
    </span>
  );
}

function StepFields(props: {
  step: number;
  overview: SetupOverview;
  labels: Map<string, { name: string; email: string }>;
  role: RtRole | null;
  locale: Locale;
  t: Messages;
}) {
  const { overview, t } = props;
  const b = overview.business;
  switch (props.step) {
    case 1:
      return (
        <>
          <input type="hidden" name="expectedVersion" value={b.version} />
          <label className="field">
            <span>{t.setup.business.name}</span>
            <input className="input" name="name" required maxLength={120} defaultValue={b.name} autoComplete="organization" />
          </label>
          <div className="field-row">
            <label className="field">
              <span>{t.setup.business.defaultCurrency}</span>
              <select className="input" name="defaultCurrency" defaultValue={b.defaultCurrency}>
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {t.currency[c]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t.setup.business.timezone}</span>
              <input className="input" name="timezone" dir="ltr" maxLength={64} defaultValue={b.timezone || DEFAULT_TIMEZONE} />
              <span className="hint">{t.setup.business.timezoneHint}</span>
            </label>
          </div>
          <fieldset className="fieldset">
            <legend>{t.setup.business.enabledCurrencies}</legend>
            <div className="check-grid">
              {CURRENCIES.map((c) => (
                <label key={c} className="check">
                  <input type="checkbox" name="enabledCurrencies" value={c} defaultChecked={b.enabledCurrencies.includes(c)} />
                  {t.currency[c]}
                </label>
              ))}
            </div>
          </fieldset>
        </>
      );
    case 2:
      return (
        <>
          <fieldset className="fieldset">
            <legend>{t.setup.branches.existing}</legend>
            {overview.branches.length === 0 ? <p className="muted">{t.setup.branches.noBranches}</p> : null}
            {overview.branches.map((br) => (
              <label key={br.id} className="field">
                <input type="hidden" name="branchId" value={br.id} />
                <input type="hidden" name={`orig:${br.id}`} value={br.name} />
                <input type="hidden" name={`version:${br.id}`} value={br.version} />
                <input className="input" name={`name:${br.id}`} required maxLength={80} defaultValue={br.name} aria-label={br.name} />
                {br.stores.length > 0 ? (
                  <span className="hint">
                    {t.setup.branches.store}: {br.stores.join("، ")}
                  </span>
                ) : null}
              </label>
            ))}
          </fieldset>
          <label className="field">
            <span>{t.setup.branches.newBranches}</span>
            <textarea className="input" name="newBranches" rows={2} />
            <span className="hint">{t.setup.branches.newBranchesHint}</span>
          </label>
        </>
      );
    case 3:
      return (
        <>
          <input type="hidden" name="expectedVersion" value={b.version} />
          {/* The product is fixed when the business is created (support changes it), and naming the
              other products here would show another product's words: the field is read-only. */}
          <input type="hidden" name="activityType" value={b.activityType} />
          <div className="field">
            <span>{t.setup.activity.activityType}</span>
            <output className="input input-readonly" data-testid="setup-product">
              {packWords(getPack(b.activityType), props.locale).productName}
            </output>
          </div>
          <fieldset className="fieldset">
            <legend>{t.setup.activity.capabilities}</legend>
            <span className="hint">{t.setup.activity.capabilitiesHint}</span>
            <div className="check-grid">
              {CAPABILITIES.map((c) => (
                <label key={c} className="check">
                  <input type="checkbox" name="capabilities" value={c} defaultChecked={overview.capabilities.includes(c)} />
                  {t.capability[c]}
                </label>
              ))}
            </div>
          </fieldset>
        </>
      );
    case 5: {
      const roles = props.role === "OWNER" ? STAFF_ROLES : STAFF_ROLES.filter((r) => MANAGER_GRANTABLE.includes(r));
      const branchName = new Map(overview.branches.map((br) => [br.id, br.name]));
      const team = overview.staff.filter((s) => s.role !== "OWNER");
      return (
        <>
          <fieldset className="fieldset">
            <legend>{t.setup.staff.team}</legend>
            {team.length === 0 ? (
              <p className="muted" data-testid="setup-no-staff">
                {t.setup.staff.noStaff}
              </p>
            ) : (
              <ul className="setup-team">
                {team.map((s) => {
                  const who = props.labels.get(s.userId);
                  const where = can(s.role, "multiBranch.access")
                    ? t.setup.staff.allBranches
                    : s.branchIds.map((id) => branchName.get(id) ?? "").filter(Boolean).join("، ");
                  return (
                    <li key={s.id}>
                      <span className="truncate" title={who?.email}>
                        {who?.name || who?.email || t.common.none}
                      </span>
                      <span className="badge">{t.setup.roles[s.role]}</span>
                      <span className="muted truncate">{where || t.common.none}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </fieldset>
          <div className="field-row">
            <label className="field">
              <span>{t.setup.staff.email}</span>
              <input className="input" type="email" name="email" dir="ltr" maxLength={254} autoComplete="off" />
              <span className="hint">{t.setup.staff.emailHint}</span>
            </label>
            <label className="field">
              <span>{t.setup.staff.role}</span>
              <select className="input" name="role" defaultValue="CASHIER">
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {t.setup.roles[r]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <fieldset className="fieldset">
            <legend>{t.setup.staff.branches}</legend>
            <span className="hint">{t.setup.staff.branchesHint}</span>
            <div className="check-grid">
              {overview.branches.map((br) => (
                <label key={br.id} className="check">
                  <input type="checkbox" name="branchIds" value={br.id} />
                  <span className="truncate">{br.name}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </>
      );
    }
    default:
      return null;
  }
}
