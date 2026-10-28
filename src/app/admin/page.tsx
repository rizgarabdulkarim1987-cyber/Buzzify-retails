import { randomUUID } from "node:crypto";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { formatDate, formatNumber, type Locale, type Messages } from "@/messages";
import { listBusinesses, type DirectoryBusiness } from "@/server/admin/directory";
import { getSessionUser } from "@/server/auth/auth";
import { getI18n } from "../_lib/i18n";
import { SignOutIcon, UserIcon } from "../_ui/icons";
import { LocaleSwitcher } from "../_ui/locale-switcher";
import { StateBlock } from "../_ui/state";
import { signOut } from "../session-actions";
import { CreateBusinessForm } from "./create-form";

export const dynamic = "force-dynamic";

const STATUS_TONE = { SETUP: "warn", ACTIVE: "accent", SUSPENDED: "danger", ARCHIVED: undefined } as const;

export default async function AdminPage() {
  const user = await getSessionUser(await headers());
  if (!user) redirect("/login");
  const { locale, t } = await getI18n();
  const result = await listBusinesses({}, { userId: user.id, idempotencyKey: "" });

  return (
    <>
      <header className="shell-header" data-testid="admin-header">
        <div className="bar">
          <div className="bar-business">
            <span className="wordmark" dir="ltr">
              Buzzify
            </span>
            <span className="truncate bar-sub">
              {t.meta.platformName}
            </span>
          </div>
          <div className="bar-actions">
            <span className="bar-user" title={user.email}>
              <UserIcon />
              <span className="truncate">{user.name || user.email}</span>
            </span>
            <LocaleSwitcher locale={locale} label={t.locale.label} names={{ ar: t.locale.ar, ckb: t.locale.ckb, en: t.locale.en }} />
            <form action={signOut}>
              <button type="submit" className="bar-button" aria-label={t.common.signOut} title={t.common.signOut}>
                <SignOutIcon />
              </button>
            </form>
          </div>
        </div>
      </header>
      {result.ok ? (
        <main className="page">
          <div className="page-head">
            <div className="title-row">
              <h1 id="list-title">{t.admin.title}</h1>
              <span className="badge" title={t.admin.count} data-testid="business-count">
                <span className="visually-hidden">{t.admin.count}: </span>
                {formatNumber(locale, result.value.businesses.length)}
              </span>
            </div>
            <p>{t.admin.intro}</p>
          </div>
          <div className="admin-grid">
            <section aria-labelledby="list-title">
              {result.value.businesses.length === 0 ? (
                <StateBlock kind="empty" title={t.admin.title} body={t.admin.empty} testId="state-no-businesses" />
              ) : (
                <BusinessTable businesses={result.value.businesses} locale={locale} t={t} />
              )}
            </section>
            <section className="panel" aria-labelledby="create-title">
              <h2 id="create-title">{t.adminForm.title}</h2>
              <CreateBusinessForm
                t={{
                  adminForm: t.adminForm,
                  activity: t.activity,
                  capability: t.capability,
                  currency: t.currency,
                  errors: t.errors,
                  internalError: t.internalError,
                }}
                plans={result.value.plans}
                idempotencyKey={randomUUID()}
              />
            </section>
          </div>
        </main>
      ) : result.code !== "FORBIDDEN" ? (
        <main className="page">
          <StateBlock kind="alert" title={t.common.errorTitle} body={t.errors[result.code]} testId="state-error" />
        </main>
      ) : (
        <main className="page">
          <StateBlock
            kind="locked"
            title={t.admin.forbiddenTitle}
            body={t.admin.forbiddenBody}
            testId="state-forbidden"
            action={
              <Link href="/retail/home" className="btn btn-secondary">
                {t.admin.goToRetail}
              </Link>
            }
          />
        </main>
      )}
    </>
  );
}

function BusinessTable({ businesses, locale, t }: { businesses: DirectoryBusiness[]; locale: Locale; t: Messages }) {
  return (
    <table className="data-table" data-testid="business-table">
      <thead>
        <tr>
          <th scope="col">{t.admin.colName}</th>
          <th scope="col">{t.admin.colStatus}</th>
          <th scope="col">{t.admin.colActivity}</th>
          <th scope="col">{t.admin.colSubscription}</th>
          <th scope="col">{t.admin.colCreated}</th>
        </tr>
      </thead>
      <tbody>
        {businesses.map((b) => (
          <tr key={b.id}>
            <td>
              <span className="truncate" title={b.name}>
                {b.name}
              </span>
            </td>
            <td>
              <span className="badge" data-tone={STATUS_TONE[b.status]}>
                {t.status[b.status]}
              </span>
            </td>
            <td data-secondary>{t.activity[b.activityType]}</td>
            <td data-secondary>{b.subscriptionStatus ? t.subscription[b.subscriptionStatus] : t.admin.noSubscription}</td>
            <td data-secondary>
              <time dateTime={b.createdAt.toISOString()}>{formatDate(locale, b.createdAt)}</time>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
