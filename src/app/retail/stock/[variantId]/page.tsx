import Link from "next/link";
import { getProduct } from "@/server/catalog/products";
import { getVariantStock, listMovements } from "@/server/stock/queries";
import { pickName } from "../../../_lib/format";
import { getI18n } from "../../../_lib/i18n";
import { isId } from "../../../_lib/workplace";
import { StateBlock } from "../../../_ui/state";
import { RefusedPage } from "../../catalog/_lib/state-pages";
import { loadStockAccess } from "../_lib/access";
import { batchDto, breakdownDto, movementDto } from "../_lib/format";
import { ReadOnlyBanner } from "../_lib/views";
import { VariantScreen, type VariantTotal } from "./variant-screen";

export const dynamic = "force-dynamic";

type Params = Promise<{ variantId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * One variant's stock: the total, its batches and the movement history with the running balance.
 * `?product=` (set by the list's links) names the product, so the page can show the item's name
 * and offer the adjust dialog; without it the stock and history are still shown.
 */
export default async function VariantStockPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { locale, t } = await getI18n();
  const access = await loadStockAccess();
  if (!access.ok) return <RefusedPage code={access.code} t={t} />;
  const { variantId } = await params;
  const productParam = (await searchParams).product;
  const m = t.stock.movement;

  const missing = (
    <main className="page">
      <StateBlock
        kind="alert"
        title={t.errors.NOT_FOUND}
        body={m.back}
        testId="state-not-found"
        action={
          <Link href="/retail/stock" className="btn btn-secondary">
            {m.back}
          </Link>
        }
      />
    </main>
  );
  if (!isId(variantId)) return missing;

  const [stock, movements] = await Promise.all([getVariantStock({ variantId }, access.meta), listMovements({ variantId }, access.meta)]);
  if (!stock.ok) return stock.code === "NOT_FOUND" ? missing : <RefusedPage code={stock.code} t={t} />;
  if (!movements.ok) return movements.code === "NOT_FOUND" ? missing : <RefusedPage code={movements.code} t={t} />;

  let item: { productId: string; name: string; sku: string } | null = null;
  if (isId(productParam)) {
    const product = await getProduct({ id: productParam }, access.meta);
    const variant = product.ok ? product.value.variants.find((v) => v.id === variantId) : undefined;
    if (product.ok && variant) item = { productId: product.value.id, name: pickName(locale, product.value), sku: variant.sku };
  }

  const s = stock.value.total;
  const total: VariantTotal = {
    qty: s.qty.toString(),
    availableQty: s.availableQty.toString(),
    breakdown: breakdownDto(s.breakdown),
    nearestExpiry: s.nearestExpiry ? s.nearestExpiry.toISOString() : null,
    status: s.status,
    ...(s.valueMinor !== undefined ? { valueMinor: s.valueMinor.toString() } : {}),
    ...(s.avgUnitCostMinor !== undefined ? { avgUnitCostMinor: s.avgUnitCostMinor.toString() } : {}),
  };
  const ctx = access.context;

  return (
    <main className="page">
      {access.readOnly ? <ReadOnlyBanner t={t} /> : null}
      <VariantScreen
        locale={locale}
        t={t}
        variantId={variantId}
        item={item}
        currency={ctx.defaultCurrency}
        canSeeCost={ctx.canSeeCost}
        canAdjust={ctx.canAdjust && item !== null}
        readOnly={access.readOnly}
        total={total}
        batches={stock.value.batches.map(batchDto)}
        initial={{ rows: movements.value.rows.map(movementDto), nextCursor: movements.value.nextCursor }}
      />
    </main>
  );
}
