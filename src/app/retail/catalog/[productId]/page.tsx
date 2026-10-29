import Link from "next/link";
import { getProduct } from "@/server/catalog/products";
import { listUnitPrices, suggestedUnitPrice } from "@/server/catalog/prices";
import { listBrands, listCategories } from "@/server/catalog/taxonomy";
import { getI18n } from "../../../_lib/i18n";
import { isId } from "../../../_lib/workplace";
import { baghdadToday } from "../_lib/numbers";
import { StateBlock } from "../../../_ui/state";
import { loadCatalogAccess } from "../_lib/access";
import { RefusedPage } from "../_lib/state-pages";
import type { BrandDto, CategoryDto, Currency, PriceCellDto, ProductDto, UnitDto } from "../_lib/types";
import { ProductScreen } from "./product-screen";

export const dynamic = "force-dynamic";

type Params = Promise<{ productId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ProductPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { locale, t } = await getI18n();
  const access = await loadCatalogAccess();
  if (!access.ok) return <RefusedPage code={access.code} t={t} />;
  const { productId } = await params;
  const existing = (await searchParams).existing === "1";

  const missing = (
    <main className="page">
      <StateBlock
        kind="alert"
        title={t.errors.NOT_FOUND}
        body={t.catalog.product.back}
        testId="state-not-found"
        action={
          <Link href="/retail/catalog" className="btn btn-secondary">
            {t.catalog.product.back}
          </Link>
        }
      />
    </main>
  );
  if (!isId(productId)) return missing;
  const found = await getProduct({ id: productId }, access.meta);
  if (!found.ok) return found.code === "NOT_FOUND" ? missing : <RefusedPage code={found.code} t={t} />;
  const p = found.value;

  const [categories, brands] = await Promise.all([listCategories({}, access.meta), listBrands({}, access.meta)]);
  const currencies = access.context.enabledCurrencies;

  const unitDto = async (u: (typeof p.variants)[number]["units"][number]): Promise<UnitDto> => {
    const rows = await listUnitPrices({ unitId: u.id }, access.meta);
    const defaults = rows.ok ? rows.value.filter((r) => r.listKind === "DEFAULT") : [];
    const prices: Partial<Record<Currency, PriceCellDto>> = {};
    for (const currency of currencies) {
      const mine = defaults.filter((r) => r.currency === currency);
      const current = mine.find((r) => r.status === "CURRENT");
      const scheduled = [...mine].reverse().find((r) => r.status === "SCHEDULED"); // the next one to start
      let suggestedMinor: string | null = null;
      if (!u.isBase) {
        const s = await suggestedUnitPrice({ unitId: u.id, currency }, access.meta);
        if (s.ok && s.value) suggestedMinor = s.value.amountMinor.toString();
      }
      prices[currency] = {
        latestId: mine[0]?.id ?? null,
        current: current ? { amountMinor: current.amountMinor.toString() } : null,
        scheduled: scheduled ? { amountMinor: scheduled.amountMinor.toString(), validFrom: scheduled.validFrom.toISOString() } : null,
        suggestedMinor,
      };
    }
    return {
      id: u.id,
      name: u.name,
      factor: u.factor,
      isBase: u.isBase,
      quantityScale: u.quantityScale,
      archived: u.archivedAt !== null,
      version: u.version,
      barcodes: u.barcodes.map((b) => ({ id: b.id, code: b.code, archived: b.archivedAt !== null, version: b.version })),
      prices,
    };
  };

  const dto: ProductDto = {
    id: p.id,
    version: p.version,
    nameAr: p.nameAr,
    nameCkb: p.nameCkb,
    nameEn: p.nameEn,
    category: p.category,
    brand: p.brand,
    tracksExpiry: p.tracksExpiry,
    expiryAlertDays: p.expiryAlertDays,
    soldByWeight: p.soldByWeight,
    archived: p.archivedAt !== null,
    variants: await Promise.all(
      p.variants.map(async (v) => ({
        id: v.id,
        sku: v.sku,
        options:
          v.options && typeof v.options === "object" && !Array.isArray(v.options)
            ? Object.fromEntries(Object.entries(v.options as Record<string, unknown>).map(([k, val]) => [k, String(val)]))
            : null,
        archived: v.archivedAt !== null,
        version: v.version,
        units: await Promise.all(v.units.map(unitDto)),
      })),
    ),
  };

  const categoryList: CategoryDto[] = categories.ok
    ? categories.value.map((c) => ({ id: c.id, parentId: c.parentId, nameAr: c.nameAr, nameCkb: c.nameCkb, nameEn: c.nameEn }))
    : [];
  const brandList: BrandDto[] = brands.ok ? brands.value.map((b) => ({ id: b.id, nameAr: b.nameAr, nameCkb: b.nameCkb, nameEn: b.nameEn })) : [];

  return (
    <main className="page">
      <ProductScreen
        locale={locale}
        t={t}
        product={dto}
        categories={categoryList}
        brands={brandList}
        currencies={currencies}
        canManage={access.canManage}
        canPrice={access.canPrice}
        existing={existing}
        today={baghdadToday(new Date())}
      />
    </main>
  );
}
