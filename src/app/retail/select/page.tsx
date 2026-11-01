import Link from "next/link";
import { formatNumber, type Locale, type Messages } from "@/messages";
import type { ErrorCode } from "@/server/framework/errors";
import type { ShellOptions } from "@/server/shell/options";
import { getI18n } from "../../_lib/i18n";
import { isId } from "../../_lib/workplace";
import { BranchIcon, StoreIcon, TerminalIcon } from "../../_ui/icons";
import { Notice, StateBlock } from "../../_ui/state";
import { optionsFor, requireShell, type Shell } from "../_shell";
import { selectWorkplace } from "../actions";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function errorText(t: Messages, error: unknown): string | null {
  if (typeof error !== "string") return null;
  if (error === "OPEN_DRAFTS") return t.select.switchRefusedDrafts;
  if (error === "OPEN_SHIFT") return t.select.switchRefusedShift;
  return Object.hasOwn(t.errors, error) ? t.errors[error as ErrorCode] : null;
}

export default async function SelectPage({ searchParams }: { searchParams: SearchParams }) {
  const shell = await requireShell();
  const { locale, t } = await getI18n();
  const params = await searchParams;
  const error = errorText(t, params.error);

  const member = (id: unknown) => (isId(id) ? shell.memberships.find((m) => m.businessId === id) : undefined);
  const picking = params.pick === "business" && shell.memberships.length > 1;
  const chosen = picking ? undefined : (member(params.business) ?? member(shell.businessId));

  return (
    <main className="page">
      <div className="page-head">
        <h1>{t.select.title}</h1>
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {shell.memberships.length === 0 ? (
        <StateBlock kind="locked" title={t.select.noBusinessesTitle} body={t.select.noBusinessesBody} testId="state-no-business" />
      ) : chosen ? (
        <BranchSection
          shell={shell}
          locale={locale}
          t={t}
          businessId={chosen.businessId}
          canChangeBusiness={shell.memberships.length > 1}
        />
      ) : (
        <BusinessSection shell={shell} t={t} />
      )}
    </main>
  );
}

function BusinessSection({ shell, t }: { shell: Shell; t: Messages }) {
  return (
    <section className="section" aria-labelledby="business-title">
      <div className="section-head">
        <h2 id="business-title">{t.select.businessTitle}</h2>
      </div>
      <p className="muted section-intro">
        {t.select.businessIntro}
      </p>
      <ul className="choice-list" data-testid="business-list">
        {shell.memberships.map((m) => (
          <li key={m.businessId}>
            <Link className="business-link" href={`/retail/select?business=${encodeURIComponent(m.businessId)}`} title={m.name}>
              <StoreIcon />
              <strong className="truncate">{m.name}</strong>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

async function BranchSection(props: {
  shell: Shell;
  locale: Locale;
  t: Messages;
  businessId: string;
  canChangeBusiness: boolean;
}) {
  const { shell, locale, t, businessId } = props;
  const options = await optionsFor(shell.user.id, businessId);

  if (!options.ok) {
    return options.code === "READ_ONLY" ? (
      <StateBlock kind="alert" title={t.access.closedTitle} body={t.access.closedBody} testId="state-closed" />
    ) : (
      <StateBlock kind="locked" title={t.access.noPermissionTitle} body={t.access.noPermissionBody} testId="state-forbidden" />
    );
  }

  return (
    <section className="section" aria-labelledby="branch-title">
      <div className="section-head">
        <h2 id="branch-title">{t.select.branchTitle}</h2>
        {props.canChangeBusiness ? <Link href="/retail/select?pick=business">{t.select.changeBusiness}</Link> : null}
      </div>
      {options.value.branches.length === 0 ? (
        <StateBlock kind="empty" title={t.select.noBranchesTitle} body={t.select.noBranchesBody} testId="state-no-branches" />
      ) : (
        <>
          <p className="muted section-intro">
            {t.select.branchIntro}
          </p>
          <BranchList options={options.value} shell={shell} locale={locale} t={t} />
        </>
      )}
    </section>
  );
}

function BranchList({ options, shell, locale, t }: { options: ShellOptions; shell: Shell; locale: Locale; t: Messages }) {
  const isCurrent = (branchId: string) => shell.businessId === options.business.id && shell.branch?.id === branchId;
  return (
    <ul className="choice-list" data-testid="branch-list">
      {options.branches.map((branch) => (
        <li key={branch.id} className="choice-card" data-current={isCurrent(branch.id)} data-testid="branch-option">
          <div className="choice-card-head">
            <BranchIcon />
            <h3 className="truncate" title={branch.name} data-testid="branch-name">
              {branch.name}
            </h3>
            {isCurrent(branch.id) ? (
              <span className="badge" data-tone="accent">
                {t.select.current}
              </span>
            ) : null}
            {branch.terminals.length > 0 ? (
              <span className="badge" title={t.select.terminalsLabel}>
                <span className="visually-hidden">{t.select.terminalsLabel}: </span>
                {formatNumber(locale, branch.terminals.length)}
              </span>
            ) : null}
          </div>
          <form action={selectWorkplace} className="choice-buttons">
            <input type="hidden" name="business" value={options.business.id} />
            <input type="hidden" name="branch" value={branch.id} />
            {branch.terminals.map((terminal) => (
              <button key={terminal.id} type="submit" name="terminal" value={terminal.id} className="btn btn-secondary" title={terminal.name}>
                <TerminalIcon />
                <span className="truncate">{terminal.name}</span>
              </button>
            ))}
            <button
              type="submit"
              name="terminal"
              value=""
              className={branch.terminals.length > 0 ? "btn btn-secondary" : "btn btn-primary"}
            >
              <span className="truncate">{branch.terminals.length > 0 ? t.select.withoutTerminal : t.select.chooseBranch}</span>
            </button>
          </form>
        </li>
      ))}
    </ul>
  );
}
