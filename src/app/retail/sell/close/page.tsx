import Link from "next/link";
import { tillState } from "@/server/sales/shifts";
import { getI18n } from "../../../_lib/i18n";
import { StateBlock } from "../../../_ui/state";
import { RefusedPage } from "../../catalog/_lib/state-pages";
import { shiftDto } from "../_lib/dto";
import { tillGate } from "../_lib/load";
import { CloseShiftForm } from "../shift-forms";

export const dynamic = "force-dynamic";

/** Close shift: expected cash, the count, the difference and the day summary. */
export default async function CloseShiftPage() {
  const { locale, t } = await getI18n();
  const gate = await tillGate();
  if (!gate.ok) return <RefusedPage code={gate.code} t={t} />;
  const till = await tillState({}, gate.meta);
  if (!till.ok) return <RefusedPage code={till.code} t={t} />;

  return (
    <main className="page till-page-narrow">
      <div className="page-head">
        <h1>{t.sell.close.title}</h1>
        {till.value.open ? <p>{t.sell.close.intro}</p> : null}
      </div>
      {till.value.open ? (
        <CloseShiftForm locale={locale} t={t} shift={shiftDto(till.value.open)} />
      ) : (
        <StateBlock
          kind="empty"
          title={t.sell.close.noShiftTitle}
          body={t.sell.close.noShiftBody}
          testId="state-no-shift"
          action={
            <Link href="/retail/sell" className="btn btn-primary">
              {t.sell.open.title}
            </Link>
          }
        />
      )}
    </main>
  );
}
