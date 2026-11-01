import Link from "next/link";
import type { ReactNode } from "react";
import { getI18n } from "../../../../../_lib/i18n";
import { isId } from "../../../../../_lib/workplace";
import { StateBlock } from "../../../../../_ui/state";
import { RefusedPage } from "../../../../catalog/_lib/state-pages";
import { loadStockAccess } from "../../../_lib/access";
import { ReadOnlyBanner } from "../../../_lib/views";
import { IntakeScreen } from "../intake-review";
import { loadIntakeReview, photoRole } from "../_lib/load";
import { intakeFailureMessage } from "../_lib/rules";

export const dynamic = "force-dynamic";

type Params = Promise<{ intakeId: string }>;

/**
 * One receipt intake: reading it (with a waiting state), its failure, or its review (the image
 * beside the lines, a decision per line, the total check, "create the draft").
 */
export default async function IntakePage({ params }: { params: Params }) {
  const { locale, t } = await getI18n();
  const access = await loadStockAccess();
  if (!access.ok) return <RefusedPage code={access.code} t={t} />;
  const m = t.stock.intake;
  const role = photoRole(access.context.role);
  const { intakeId } = await params;

  const back = (
    <Link href="/retail/stock/receive/photo" className="btn btn-secondary" data-testid="intake-back">
      {m.title}
    </Link>
  );
  const manual = (
    <Link href="/retail/stock/receive" className="btn btn-secondary" data-testid="intake-manual">
      {m.manual}
    </Link>
  );
  const page = (body: ReactNode) => (
    <main className="page">
      <div className="page-head">
        <div className="title-row">
          <h1>{m.review.title}</h1>
          <div className="title-actions">{back}</div>
        </div>
        <p>{m.review.intro}</p>
      </div>
      {body}
    </main>
  );

  if (!role.canUseAi || !role.canReceive || !role.seesCost) {
    return page(<StateBlock kind="locked" title={m.noPermissionTitle} body={m.noPermissionBody} testId="state-forbidden" action={manual} />);
  }
  if (!isId(intakeId)) return page(<StateBlock kind="alert" title={t.errors.NOT_FOUND} body={m.reading.failedTitle} testId="state-not-found" action={manual} />);

  const loaded = await loadIntakeReview(intakeId, access.meta, role.seesCost);
  if (!loaded.ok) {
    if (loaded.code === "AI_DISABLED") return page(<StateBlock kind="locked" title={m.disabledTitle} body={t.errors.AI_DISABLED} testId="state-ai-disabled" action={manual} />);
    if (loaded.code === "NOT_FOUND") return page(<StateBlock kind="alert" title={t.errors.NOT_FOUND} body={m.reading.failedTitle} testId="state-not-found" action={manual} />);
    return page(<StateBlock kind="alert" title={t.common.errorTitle} body={intakeFailureMessage(t, loaded, locale)} testId="state-error" action={manual} />);
  }

  return page(
    <>
      {access.readOnly ? <ReadOnlyBanner t={t} /> : null}
      <IntakeScreen
        key={loaded.value.intake.id}
        t={t}
        locale={locale}
        initial={loaded.value}
        readOnly={access.readOnly}
        canCreateItems={role.canCreateItems}
        enabledCurrencies={access.context.enabledCurrencies}
      />
    </>,
  );
}
