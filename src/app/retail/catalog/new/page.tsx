import Link from "next/link";
import { listCategories } from "@/server/catalog/taxonomy";
import { getI18n } from "../../../_lib/i18n";
import { StateBlock } from "../../../_ui/state";
import { loadCatalogAccess } from "../_lib/access";
import { RefusedPage } from "../_lib/state-pages";
import type { CategoryDto } from "../_lib/types";
import { QuickEntry } from "./quick-entry";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function NewProductsPage({ searchParams }: { searchParams: SearchParams }) {
  const { locale, t } = await getI18n();
  // Opened from setup step 4: the products can be marked as trial items (archived before launch).
  const fromSetup = (await searchParams).from === "setup";
  const access = await loadCatalogAccess();
  if (!access.ok) return <RefusedPage code={access.code} t={t} />;
  if (!access.canManage) {
    return (
      <main className="page">
        <StateBlock
          kind="locked"
          title={t.catalog.entry.noPermissionTitle}
          body={t.catalog.entry.noPermissionBody}
          testId="state-forbidden"
          action={
            <Link href="/retail/catalog" className="btn btn-secondary">
              {t.catalog.entry.back}
            </Link>
          }
        />
      </main>
    );
  }
  const categories = await listCategories({}, access.meta);
  const list: CategoryDto[] = categories.ok
    ? categories.value.map((c) => ({ id: c.id, parentId: c.parentId, nameAr: c.nameAr, nameCkb: c.nameCkb, nameEn: c.nameEn }))
    : [];

  return (
    <main className="page page-narrow">
      <div className="page-head">
        <div className="title-row">
          <h1>{t.catalog.entry.title}</h1>
          <Link href={fromSetup ? "/retail/setup" : "/retail/catalog"} className="btn btn-secondary catalog-add">
            {fromSetup ? t.catalog.entry.backToSetup : t.catalog.entry.back}
          </Link>
        </div>
        <p>{t.catalog.entry.intro}</p>
      </div>
      <QuickEntry locale={locale} t={t} categories={list} canPrice={access.canPrice} currency={access.context.defaultCurrency} trialOption={fromSetup && access.canMarkTrial} />
    </main>
  );
}
