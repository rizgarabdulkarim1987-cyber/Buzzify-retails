"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Locale, Messages } from "@/messages";
import { formatMoney, pickName } from "../../_lib/format";
import { SearchIcon } from "../../_ui/icons";
import { Notice, StateBlock } from "../../_ui/state";
import { searchAction } from "./actions";
import { categoryOptions } from "./_lib/categories";
import type { BrandDto, CategoryDto, HitDto } from "./_lib/types";

type Initial = { query: string; categoryId: string | null; brandId: string | null; archived: boolean; items: HitDto[]; nextCursor: string | null };

type Props = {
  locale: Locale;
  t: Messages;
  canManage: boolean;
  categories: CategoryDto[];
  brands: BrandDto[];
  initial: Initial;
};

const DEBOUNCE_MS = 250;

/**
 * The catalog list with instant search. The server renders the first page; typing (after a short
 * pause), a filter or the archived switch asks the server again, and "show more" follows the
 * cursor. Only the newest request may write the list, so a slow answer never replaces a newer one.
 */
export function CatalogBrowser({ locale, t, canManage, categories, brands, initial }: Props) {
  const [query, setQuery] = useState(initial.query);
  const [categoryId, setCategoryId] = useState(initial.categoryId ?? "");
  const [brandId, setBrandId] = useState(initial.brandId ?? "");
  const [archived, setArchived] = useState(initial.archived);
  const [items, setItems] = useState(initial.items);
  const [nextCursor, setNextCursor] = useState(initial.nextCursor);
  const [busy, setBusy] = useState<"idle" | "search" | "more">("idle");
  const [failed, setFailed] = useState(false);
  const latest = useRef(0);
  const first = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const categoryChoices = useMemo(() => categoryOptions(locale, categories), [locale, categories]);
  const catLabel = t.catalog.currencyShort;

  const run = useCallback(
    async (q: string, cat: string, brand: string, arch: boolean, cursor: string | null) => {
      const id = ++latest.current;
      setBusy(cursor ? "more" : "search");
      setFailed(false);
      try {
        const result = await searchAction({ query: q, categoryId: cat, brandId: brand, includeArchived: arch, cursor });
        if (id !== latest.current) return;
        if (!result.ok) {
          setFailed(true);
        } else {
          setItems((prev) => (cursor ? [...prev, ...result.value.items] : result.value.items));
          setNextCursor(result.value.nextCursor);
        }
      } catch {
        if (id === latest.current) setFailed(true);
      } finally {
        if (id === latest.current) setBusy("idle");
      }
    },
    [],
  );

  // A new query or filter: search again (the typed text waits for a pause; filters are immediate).
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(query, categoryId, brandId, archived, null), DEBOUNCE_MS);
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (categoryId) params.set("category", categoryId);
    if (brandId) params.set("brand", brandId);
    if (archived) params.set("archived", "1");
    const qs = params.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
    return () => clearTimeout(timer.current);
  }, [query, categoryId, brandId, archived, run]);

  const filtered = query !== "" || categoryId !== "" || brandId !== "" || archived;

  return (
    <div className="catalog">
      <form
        className="catalog-tools"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          clearTimeout(timer.current);
          void run(query, categoryId, brandId, archived, null);
        }}
      >
        <label className="field catalog-search">
          <span className="visually-hidden">{t.catalog.list.searchLabel}</span>
          <div className="input-icon">
            <SearchIcon />
            <input
              className="input"
              type="search"
              inputMode="search"
              enterKeyHint="search"
              name="q"
              value={query}
              maxLength={100}
              autoComplete="off"
              placeholder={t.catalog.list.searchPlaceholder}
              onChange={(event) => setQuery(event.target.value)}
              data-testid="catalog-search"
            />
          </div>
        </label>
        <div className="catalog-filters">
          <label className="field">
            <span className="visually-hidden">{t.catalog.list.categoryFilter}</span>
            <select className="input" value={categoryId} onChange={(event) => setCategoryId(event.target.value)} data-testid="catalog-category">
              <option value="">{t.catalog.list.allCategories}</option>
              {categoryChoices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="visually-hidden">{t.catalog.list.brandFilter}</span>
            <select className="input" value={brandId} onChange={(event) => setBrandId(event.target.value)} data-testid="catalog-brand">
              <option value="">{t.catalog.list.allBrands}</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {pickName(locale, b)}
                </option>
              ))}
            </select>
          </label>
          {canManage ? (
            <label className="check">
              <input type="checkbox" checked={archived} onChange={(event) => setArchived(event.target.checked)} data-testid="catalog-archived-toggle" />
              {t.catalog.list.showArchived}
            </label>
          ) : null}
        </div>
      </form>

      <div className="visually-hidden" role="status" aria-live="polite">
        {busy === "search" ? t.catalog.list.searching : ""}
      </div>
      {failed ? <Notice tone="danger">{t.catalog.list.searchFailed}</Notice> : null}

      {items.length === 0 && busy !== "search" && !failed ? (
        filtered ? (
          <StateBlock kind="empty" title={t.catalog.list.noResultsTitle} body={t.catalog.list.noResultsBody} testId="catalog-no-results" />
        ) : (
          <StateBlock
            kind="empty"
            title={t.catalog.list.emptyTitle}
            body={canManage ? t.catalog.list.emptyBody : t.catalog.list.emptyReadOnlyBody}
            testId="catalog-empty"
            action={
              canManage ? (
                <Link href="/retail/catalog/new" className="btn btn-primary" data-testid="catalog-empty-add">
                  {t.catalog.list.add}
                </Link>
              ) : undefined
            }
          />
        )
      ) : (
        <ul className="catalog-list" aria-label={t.catalog.list.resultsList} aria-busy={busy !== "idle"}>
          {items.map((hit) => (
            <li key={`${hit.variantId}:${hit.matchedBarcode ?? ""}`} className="catalog-row" data-testid="catalog-row" data-archived={hit.archived}>
              <Link href={`/retail/catalog/${hit.productId}`} className="catalog-row-link">
                <span className="catalog-row-name" title={pickName(locale, hit)} data-testid="catalog-row-name">
                  {pickName(locale, hit)}
                </span>
                <span className="catalog-row-meta">
                  <span dir="ltr" className="catalog-sku">
                    {t.catalog.list.sku} {hit.sku}
                  </span>
                  {hit.matchedBarcode ? (
                    <span dir="ltr" className="catalog-sku">
                      {hit.matchedBarcode}
                      {hit.matchedUnitName ? ` · ${hit.matchedUnitName}` : ""}
                    </span>
                  ) : null}
                  {hit.tracksExpiry ? <span className="badge" data-tone="warn">{t.catalog.list.badgeExpiry}</span> : null}
                  {hit.soldByWeight ? <span className="badge">{t.catalog.list.badgeLoose}</span> : null}
                  {hit.archived ? <span className="badge" data-tone="danger">{t.catalog.list.archived}</span> : null}
                </span>
                <span className="catalog-row-price" data-testid="catalog-row-price" data-empty={hit.unitPrice ? undefined : "true"}>
                  {hit.unitPrice
                    ? formatMoney(locale, hit.unitPrice.currency, hit.unitPrice.amountMinor, catLabel[hit.unitPrice.currency])
                    : t.catalog.list.noPrice}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {nextCursor ? (
        <div className="catalog-more">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy !== "idle"}
            aria-busy={busy === "more"}
            onClick={() => void run(query, categoryId, brandId, archived, nextCursor)}
            data-testid="catalog-load-more"
          >
            {busy === "more" ? t.catalog.list.loadingMore : t.catalog.list.loadMore}
          </button>
        </div>
      ) : null}
    </div>
  );
}
