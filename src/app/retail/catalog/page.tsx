import Link from "next/link";
import { listBrands, listCategories } from "@/server/catalog/taxonomy";
import { searchCatalog } from "@/server/catalog/search";
import { getI18n } from "../../_lib/i18n";
import { StateBlock } from "../../_ui/state";
import { loadCatalogAccess } from "./_lib/access";
import { RefusedPage } from "./_lib/state-pages";
import type { BrandDto, CategoryDto, HitDto } from "./_lib/types";
import { CatalogBrowser } from "./catalog-browser";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function CatalogPage({ searchParams }: { searchParams: SearchParams }) {
  const { locale, t } = await getI18n();
  const access = await loadCatalogAccess();
  if (!access.ok) return <RefusedPage code={access.code} t={t} />;
  const params = await searchParams;
  const query = one(params.q).slice(0, 100);
  const categoryId = one(params.category) || null;
  const brandId = one(params.brand) || null;
  const archived = access.canManage && one(params.archived) === "1";

  const [first, categories, brands] = await Promise.all([
    searchCatalog(
      {
        query,
        ...(categoryId ? { categoryId } : {}),
        ...(brandId ? { brandId } : {}),
        includeArchived: archived,
      },
      access.meta,
    ),
    listCategories({}, access.meta),
    listBrands({}, access.meta),
  ]);
  if (!first.ok) {
    return (
      <main className="page">
        <StateBlock kind="alert" title={t.common.errorTitle} body={t.errors[first.code]} testId="state-error" />
      </main>
    );
  }

  const initialItems: HitDto[] = first.value.items.map(({ unitPrice, ...h }) => ({
    ...h,
    ...(unitPrice ? { unitPrice: { currency: unitPrice.currency, amountMinor: unitPrice.amountMinor.toString() } } : {}),
  }));
  const categoryList: CategoryDto[] = categories.ok
    ? categories.value.map((c) => ({ id: c.id, parentId: c.parentId, nameAr: c.nameAr, nameCkb: c.nameCkb, nameEn: c.nameEn }))
    : [];
  const brandList: BrandDto[] = brands.ok ? brands.value.map((b) => ({ id: b.id, nameAr: b.nameAr, nameCkb: b.nameCkb, nameEn: b.nameEn })) : [];

  return (
    <main className="page">
      <div className="page-head">
        <div className="title-row">
          <h1>{t.catalog.title}</h1>
          {access.canManage ? (
            <Link href="/retail/catalog/new" className="btn btn-primary catalog-add" data-testid="catalog-add">
              {t.catalog.list.add}
            </Link>
          ) : null}
        </div>
      </div>
      <CatalogBrowser
        locale={locale}
        t={t}
        canManage={access.canManage}
        categories={categoryList}
        brands={brandList}
        initial={{ query, categoryId, brandId, archived, items: initialItems, nextCursor: first.value.nextCursor }}
      />
    </main>
  );
}
