import { MAX_SELL_ITEMS, listSellCategories, listSellItems } from "@/server/sales/catalog";
import { can } from "@/server/domain/permissions";
import { tillState } from "@/server/sales/shifts";
import { FALLBACK_PACK, packById, packWords } from "@/packs";
import { getI18n } from "../../_lib/i18n";
import { RefusedPage } from "../catalog/_lib/state-pages";
import { categoryDto, itemDto, shiftDto } from "./_lib/dto";
import { tillGate } from "./_lib/load";
import { SellScreen } from "./sell-screen";
import { OpenShiftForm } from "./shift-forms";

export const dynamic = "force-dynamic";

/** The till: the open-shift screen when the user has no open shift, the sale screen otherwise. */
export default async function SellPage() {
  const { locale, t } = await getI18n();
  const gate = await tillGate();
  if (!gate.ok) return <RefusedPage code={gate.code} t={t} />;
  const { shell, meta } = gate;

  const till = await tillState({}, meta);
  if (!till.ok) return <RefusedPage code={till.code} t={t} />;

  if (!till.value.open) {
    return (
      <main className="till-form-page">
        <div className="till-form-head">
          <h1>{t.sell.open.title}</h1>
          <p>{t.sell.open.intro}</p>
        </div>
        <OpenShiftForm
          locale={locale}
          t={t}
          currency={till.value.currency}
          usdEnabled={till.value.usdEnabled}
          lastRateMicro={till.value.lastUsdRateMicro === null ? null : till.value.lastUsdRateMicro.toString()}
        />
      </main>
    );
  }

  const open = till.value.open;
  const [cats, items] = await Promise.all([listSellCategories({}, meta), listSellItems({ locationId: open.shift.locationId }, meta)]);
  const pack = shell.pack?.id ?? FALLBACK_PACK;
  const departmentWords = packWords(packById(pack), locale).till;
  const businessName = shell.options?.ok ? shell.options.value.business.name : "";
  return (
    <main className="till-page">
      <h1 className="visually-hidden">{t.sell.title}</h1>
      <SellScreen
        locale={locale}
        t={t}
        currency={open.shift.currency}
        shift={shiftDto(open)}
        usdEnabled={till.value.usdEnabled}
        locationId={open.shift.locationId}
        categories={cats.ok ? cats.value.map(categoryDto) : []}
        initialItems={items.ok ? items.value.map(itemDto) : []}
        pageSize={MAX_SELL_ITEMS}
        pack={pack}
        departmentWords={departmentWords}
        heldKey={`till-held:${meta.businessId}:${meta.userId}`}
        business={businessName}
        branch={shell.branch?.name ?? ""}
        operator={shell.user.name || shell.user.email}
        canVoidExpense={shell.options?.ok === true && can(shell.options.value.role, "shift.manage")}
      />
    </main>
  );
}
