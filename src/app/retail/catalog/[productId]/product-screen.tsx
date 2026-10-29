"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useContext, useMemo, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { formatDate, formatNumber, type Locale, type Messages } from "@/messages";
import { fill, formatMoney, minorToInput, pickName } from "../../../_lib/format";
import { Notice } from "../../../_ui/state";
import {
  addBarcodeAction,
  addUnitAction,
  archiveBarcodeAction,
  archiveProductAction,
  archiveUnitAction,
  archiveVariantAction,
  setPriceAction,
  updateProductAction,
  updateUnitAction,
} from "../actions";
import { categoryOptions } from "../_lib/categories";
import { failureMessage, isStale } from "../_lib/failures";
import { newKey } from "../_lib/keys";
import type { BrandDto, CategoryDto, Currency, ProductDto, UiResult, UnitDto, VariantDto } from "../_lib/types";

type Props = {
  locale: Locale;
  t: Messages;
  product: ProductDto;
  categories: CategoryDto[];
  brands: BrandDto[];
  currencies: Currency[];
  canManage: boolean;
  canPrice: boolean;
  existing: boolean;
};

type Note = { tone: "success" | "danger"; text: string; stale: boolean };

type Ops = {
  t: Messages;
  locale: Locale;
  busy: string | null;
  notes: Record<string, Note | undefined>;
  /** Runs one change (a fresh idempotency key each time); on success shows `ok` and reloads the page data. */
  run(section: string, ok: string, change: (key: string) => Promise<UiResult<unknown>>): Promise<boolean>;
  reload(): void;
};

const OpsContext = createContext<Ops | null>(null);
function useOps(): Ops {
  const ops = useContext(OpsContext);
  if (!ops) throw new Error("OpsContext missing");
  return ops;
}

const text = (f: FormData, name: string) => {
  const v = f.get(name);
  return typeof v === "string" ? v : "";
};

/** The product screen: details, variants, units with their barcodes and prices. Controls exist only for those who may use them. */
export function ProductScreen({ locale, t, product, categories, brands, currencies, canManage, canPrice, existing }: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, Note | undefined>>({});
  const p = t.catalog.product;
  const editable = canManage && !product.archived;
  const pricing = canPrice && !product.archived;

  const ops = useMemo<Ops>(
    () => ({
      t,
      locale,
      busy,
      notes,
      reload: () => startTransition(() => router.refresh()),
      async run(section, ok, change) {
        if (busy) return false;
        setBusy(section);
        let done = false;
        try {
          const result = await change(newKey());
          if (result.ok) {
            setNotes((n) => ({ ...n, [section]: { tone: "success", text: ok, stale: false } }));
            startTransition(() => router.refresh());
            done = true;
          } else {
            setNotes((n) => ({ ...n, [section]: { tone: "danger", text: failureMessage(t, result), stale: isStale(result) } }));
          }
        } catch {
          setNotes((n) => ({ ...n, [section]: { tone: "danger", text: t.internalError, stale: false } }));
        } finally {
          setBusy(null);
        }
        return done;
      },
    }),
    [t, locale, busy, notes, router],
  );

  const activeVariants = product.variants.filter((v) => !v.archived).length;

  return (
    <OpsContext.Provider value={ops}>
      <div className="page-head">
        <div className="title-row">
          <h1 className="product-title">{pickName(locale, product)}</h1>
          <Link href="/retail/catalog" className="btn btn-secondary catalog-add">
            {p.back}
          </Link>
        </div>
        {existing ? <Notice tone="success">{t.catalog.entry.existsToast}</Notice> : null}
        {product.archived ? <Notice tone="danger">{p.archivedBanner}</Notice> : null}
        {!canManage && !product.archived ? <p>{p.readOnlyNote}</p> : null}
      </div>

      <DetailsSection key={`d:${JSON.stringify([product.version, product.nameAr, product.nameCkb, product.nameEn, product.category?.id, product.brand?.id])}`} {...{ product, categories, brands, editable }} />

      <section className="section" aria-labelledby="variants-title">
        <div className="section-head">
          <h2 id="variants-title">{p.units}</h2>
        </div>
        <div className="product-variants">
          {product.variants.map((v) => (
            <VariantBlock key={v.id} variant={v} currencies={currencies} editable={editable} pricing={pricing} canArchiveVariant={activeVariants > 1} showHeader={product.variants.length > 1 || v.archived} />
          ))}
        </div>
      </section>

      {editable ? <ArchiveProduct product={product} /> : null}
    </OpsContext.Provider>
  );
}

// ---------------------------------------------------------------------------------------------

function NoteView({ section }: { section: string }) {
  const { notes, reload, t } = useOps();
  const note = notes[section];
  if (!note) return null;
  return (
    <div className="product-note">
      <Notice tone={note.tone}>{note.text}</Notice>
      {note.stale ? (
        <button type="button" className="btn btn-secondary" onClick={reload}>
          {t.catalog.product.reload}
        </button>
      ) : null}
    </div>
  );
}

function SubmitButton({ section, children, testId, disabledExtra }: { section: string; children: ReactNode; testId?: string; disabledExtra?: boolean }) {
  const { busy, t } = useOps();
  return (
    <button type="submit" className="btn btn-primary" disabled={busy !== null || disabledExtra} aria-busy={busy === section} data-testid={testId}>
      {busy === section ? t.catalog.product.saving : children}
    </button>
  );
}

/** Two-step archive: the first press asks, the second does it. Archiving cannot be undone from the screen. */
function ConfirmButton({ section, label, body, onConfirm, testId }: { section: string; label: string; body?: string; onConfirm: () => void; testId?: string }) {
  const { t, busy } = useOps();
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" className="btn btn-secondary btn-danger" onClick={() => setAsking(true)} disabled={busy !== null} data-testid={testId}>
        {label}
      </button>
    );
  }
  return (
    <div className="confirm" role="group" aria-label={label} data-section={section}>
      <p>
        <strong>{t.catalog.product.archiveConfirm}</strong> {body}
      </p>
      <div className="confirm-actions">
        <button type="button" className="btn btn-primary btn-danger-solid" onClick={onConfirm} disabled={busy !== null}>
          {t.catalog.product.confirm}
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => setAsking(false)}>
          {t.catalog.product.cancel}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Details

function DetailsSection({ product, categories, brands, editable }: { product: ProductDto; categories: CategoryDto[]; brands: BrandDto[]; editable: boolean }) {
  const { t, locale, run } = useOps();
  const p = t.catalog.product;
  const [tracksExpiry, setTracksExpiry] = useState(product.tracksExpiry);
  const categoryChoices = useMemo(() => categoryOptions(locale, categories), [locale, categories]);
  const current = product.category;
  const currentBrand = product.brand;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    void run("details", p.saved, (key) =>
      updateProductAction(key, {
        id: product.id,
        expectedVersion: product.version,
        nameAr: text(f, "nameAr"),
        nameCkb: text(f, "nameCkb"),
        nameEn: text(f, "nameEn"),
        categoryId: text(f, "categoryId"),
        brandId: text(f, "brandId"),
        tracksExpiry,
        expiryAlertDays: text(f, "expiryAlertDays"),
        soldByWeight: f.get("soldByWeight") === "on",
      }),
    );
  };

  return (
    <section className="section" aria-labelledby="details-title">
      <div className="section-head">
        <h2 id="details-title">{p.details}</h2>
      </div>
      <form className="form panel" onSubmit={submit} data-testid="product-form">
        <NoteView section="details" />
        <fieldset className="fieldset setup-fields" disabled={!editable}>
          <label className="field">
            <span>{p.nameAr}</span>
            <input className="input" name="nameAr" required maxLength={200} defaultValue={product.nameAr} data-testid="product-name-ar" />
          </label>
          <div className="field-row">
            <label className="field">
              <span>{p.nameCkb}</span>
              <input className="input" name="nameCkb" maxLength={200} defaultValue={product.nameCkb ?? ""} data-testid="product-name-ckb" />
            </label>
            <label className="field">
              <span>{p.nameEn}</span>
              <input className="input" name="nameEn" dir="ltr" maxLength={200} defaultValue={product.nameEn ?? ""} data-testid="product-name-en" />
            </label>
          </div>
          <div className="field-row">
            <label className="field">
              <span>{p.category}</span>
              <select className="input" name="categoryId" defaultValue={current?.id ?? ""}>
                <option value="">{p.none}</option>
                {current && !categoryChoices.some((c) => c.id === current.id) ? (
                  <option value={current.id}>{pickName(locale, current)}</option>
                ) : null}
                {categoryChoices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{p.brand}</span>
              <select className="input" name="brandId" defaultValue={currentBrand?.id ?? ""}>
                <option value="">{p.none}</option>
                {currentBrand && !brands.some((b) => b.id === currentBrand.id) ? (
                  <option value={currentBrand.id}>{pickName(locale, currentBrand)}</option>
                ) : null}
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {pickName(locale, b)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="check-grid">
            <label className="check">
              <input type="checkbox" checked={tracksExpiry} onChange={(event) => setTracksExpiry(event.target.checked)} data-testid="product-tracks-expiry" />
              {p.tracksExpiry}
            </label>
            <label className="check">
              <input type="checkbox" name="soldByWeight" defaultChecked={product.soldByWeight} data-testid="product-sold-by-weight" />
              {p.soldByWeight}
            </label>
          </div>
          {tracksExpiry ? (
            <label className="field narrow">
              <span>{p.expiryAlertDays}</span>
              <input className="input" name="expiryAlertDays" dir="ltr" inputMode="numeric" maxLength={4} defaultValue={product.expiryAlertDays ?? ""} />
            </label>
          ) : null}
        </fieldset>
        {editable ? (
          <div>
            <SubmitButton section="details" testId="product-save">
              {p.save}
            </SubmitButton>
          </div>
        ) : null}
      </form>
    </section>
  );
}

function ArchiveProduct({ product }: { product: ProductDto }) {
  const { t, run } = useOps();
  return (
    <section className="section product-danger" aria-label={t.catalog.product.archive}>
      <NoteView section="archive" />
      <ConfirmButton
        section="archive"
        label={t.catalog.product.archive}
        body={t.catalog.product.archiveConfirmBody}
        testId="product-archive"
        onConfirm={() => void run("archive", t.catalog.product.archivedDone, (key) => archiveProductAction(key, { id: product.id, expectedVersion: product.version }))}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Variants and units

function VariantBlock(props: { variant: VariantDto; currencies: Currency[]; editable: boolean; pricing: boolean; canArchiveVariant: boolean; showHeader: boolean }) {
  const { variant, currencies, editable, pricing, canArchiveVariant, showHeader } = props;
  const { t, run } = useOps();
  const p = t.catalog.product;
  const optionText = variant.options ? Object.entries(variant.options).map(([k, v]) => `${k}: ${v}`).join("، ") : "";
  const section = `variant:${variant.id}`;
  const active = variant.units.filter((u) => !u.archived);
  const archivedUnits = variant.units.filter((u) => u.archived);
  return (
    <article className="variant" data-archived={variant.archived} data-testid="variant">
      {showHeader || optionText ? (
        <header className="variant-head">
          <h3>
            {p.variant} {optionText ? `· ${optionText}` : ""}
          </h3>
          <span className="badge" dir="ltr">
            {p.sku} {variant.sku}
          </span>
          {variant.archived ? <span className="badge" data-tone="danger">{p.archivedTag}</span> : null}
        </header>
      ) : null}
      {!showHeader && !optionText ? (
        <p className="muted variant-sku" dir="ltr">
          {p.sku} {variant.sku}
        </p>
      ) : null}
      <NoteView section={section} />
      <div className="unit-list">
        {active.map((u) => (
          <UnitCard key={`${u.id}:${JSON.stringify(u)}`} unit={u} currencies={currencies} editable={editable && !variant.archived} pricing={pricing && !variant.archived} />
        ))}
        {archivedUnits.map((u) => (
          <UnitCard key={`${u.id}:${JSON.stringify(u)}`} unit={u} currencies={currencies} editable={false} pricing={false} />
        ))}
      </div>
      {editable && !variant.archived ? <AddUnitForm variantId={variant.id} currencies={currencies} pricing={pricing} /> : null}
      {editable && !variant.archived ? (
        canArchiveVariant ? (
          <ConfirmButton
            section={section}
            label={p.archiveVariant}
            onConfirm={() => void run(section, p.archivedDone, (key) => archiveVariantAction(key, { variantId: variant.id, expectedVersion: variant.version }))}
          />
        ) : null
      ) : null}
    </article>
  );
}

function UnitCard({ unit, currencies, editable, pricing }: { unit: UnitDto; currencies: Currency[]; editable: boolean; pricing: boolean }) {
  const { t, locale, run } = useOps();
  const p = t.catalog.product;
  const section = `unit:${unit.id}`;
  const barcodes = unit.barcodes.filter((b) => !b.archived);
  const archivedBarcodes = unit.barcodes.filter((b) => b.archived);

  const rename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    void run(section, p.saved, (key) =>
      updateUnitAction(key, { id: unit.id, expectedVersion: unit.version, name: text(f, "name"), quantityScale: Number(text(f, "quantityScale")) }),
    );
  };
  const addCode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const f = new FormData(form);
    void run(section, p.barcodeAdded, (key) => addBarcodeAction(key, { unitId: unit.id, code: text(f, "code") })).then((done) => {
      if (done) form.reset();
    });
  };

  return (
    <div className="unit panel" data-archived={unit.archived} data-testid="unit-card">
      <header className="unit-head">
        <h4 className="unit-title">
          <span className="truncate">{unit.name}</span>
        </h4>
        {unit.isBase ? <span className="badge" data-tone="accent">{p.baseUnit}</span> : <span className="badge">× {formatNumber(locale, unit.factor)}</span>}
        {unit.archived ? <span className="badge" data-tone="danger">{p.archivedTag}</span> : null}
      </header>
      <NoteView section={section} />

      {editable ? (
        <form className="unit-edit" onSubmit={rename}>
          <label className="field">
            <span>{p.unitName}</span>
            <input className="input" name="name" required maxLength={40} defaultValue={unit.name} />
          </label>
          <label className="field narrow">
            <span>{p.unitDecimals}</span>
            <select className="input" name="quantityScale" defaultValue={String(unit.quantityScale)}>
              {[0, 1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {formatNumber(locale, n)}
                </option>
              ))}
            </select>
          </label>
          <SubmitButton section={section}>{p.save}</SubmitButton>
        </form>
      ) : (
        <p className="muted">
          {p.unitDecimals}: {formatNumber(locale, unit.quantityScale)}
        </p>
      )}

      <div className="unit-block">
        <h5>{p.barcodes}</h5>
        {barcodes.length === 0 ? <p className="muted">{p.noBarcodes}</p> : null}
        <ul className="barcode-list">
          {barcodes.map((b) => (
            <li key={b.id}>
              <span dir="ltr" className="barcode-code">
                {b.code}
              </span>
              {editable ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  aria-label={`${p.archiveBarcode} ${b.code}`}
                  onClick={() => void run(section, p.archivedDone, (key) => archiveBarcodeAction(key, { id: b.id, expectedVersion: b.version }))}
                >
                  {p.archiveBarcode}
                </button>
              ) : null}
            </li>
          ))}
          {archivedBarcodes.map((b) => (
            <li key={b.id} data-archived="true">
              <span dir="ltr" className="barcode-code">
                {b.code}
              </span>
              <span className="badge" data-tone="danger">
                {p.archivedTag}
              </span>
            </li>
          ))}
        </ul>
        {editable ? (
          <form className="inline-add" onSubmit={addCode}>
            <label className="field">
              <span className="visually-hidden">{p.addBarcode}</span>
              <input className="input" dir="ltr" name="code" maxLength={64} autoComplete="off" placeholder={p.barcodePlaceholder} required data-testid="barcode-add-input" />
            </label>
            <SubmitButton section={section}>{p.addBarcode}</SubmitButton>
          </form>
        ) : null}
      </div>

      <div className="unit-block">
        <h5>{p.prices}</h5>
        {currencies.map((currency) => (
          <PriceRow key={currency} unit={unit} currency={currency} pricing={pricing} />
        ))}
      </div>

      {editable && !unit.isBase && !unit.archived ? (
        <ConfirmButton
          section={section}
          label={p.archiveUnit}
          onConfirm={() => void run(section, p.archivedDone, (key) => archiveUnitAction(key, { id: unit.id, expectedVersion: unit.version }))}
        />
      ) : null}
    </div>
  );
}

function PriceRow({ unit, currency, pricing }: { unit: UnitDto; currency: Currency; pricing: boolean }) {
  const { t, locale, run } = useOps();
  const p = t.catalog.product;
  const cell = unit.prices[currency];
  const short = t.catalog.currencyShort[currency];
  const section = `price:${unit.id}:${currency}`;
  const [value, setValue] = useState("");

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const f = new FormData(form);
    void run(section, p.priceSaved, (key) =>
      setPriceAction(key, { unitId: unit.id, currency, amount: value, startsAt: text(f, "startsAt"), latestId: cell?.latestId ?? null }),
    ).then((done) => {
      if (done) {
        setValue("");
        form.reset();
      }
    });
  };

  return (
    <div className="price-row" data-currency={currency} data-testid="price-row">
      <div className="price-now">
        <span className="price-currency">{t.currency[currency]}</span>
        <strong className="price-amount" data-testid="price-current">
          {cell?.current ? formatMoney(locale, currency, cell.current.amountMinor, short) : p.noPrice}
        </strong>
        {cell?.scheduled ? (
          <span className="badge" data-tone="warn">
            {fill(p.scheduledLabel, { date: formatDate(locale, new Date(cell.scheduled.validFrom)) })}: {formatMoney(locale, currency, cell.scheduled.amountMinor, short)}
          </span>
        ) : null}
      </div>
      {cell?.suggestedMinor ? (
        <p className="muted price-suggest" data-testid="price-suggested">
          {fill(p.suggested, { amount: formatMoney(locale, currency, cell.suggestedMinor, short) })}
        </p>
      ) : null}
      <NoteView section={section} />
      {pricing ? (
        <form className="price-form" onSubmit={submit} data-testid="price-set-form">
          <label className="field">
            <span>{fill(p.newPrice, { currency: short })}</span>
            <input className="input" dir="ltr" inputMode="decimal" name="amount" value={value} onChange={(event) => setValue(event.target.value)} maxLength={24} autoComplete="off" required />
          </label>
          <label className="field">
            <span>{p.startsAt}</span>
            <input className="input" type="date" name="startsAt" dir="ltr" />
          </label>
          <div className="price-form-actions">
            {cell?.suggestedMinor ? (
              <button type="button" className="btn btn-secondary" onClick={() => setValue(minorToInput(currency, cell.suggestedMinor!))}>
                {p.useSuggested}
              </button>
            ) : null}
            <SubmitButton section={section}>{p.setPrice}</SubmitButton>
          </div>
          <span className="hint">{p.startsAtHint}</span>
        </form>
      ) : null}
    </div>
  );
}

function AddUnitForm({ variantId, currencies, pricing }: { variantId: string; currencies: Currency[]; pricing: boolean }) {
  const { t, run } = useOps();
  const p = t.catalog.product;
  const section = `add-unit:${variantId}`;
  const [currency, setCurrency] = useState<Currency>(currencies[0] ?? "IQD");

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const f = new FormData(form);
    void run(section, p.unitAdded, (key) =>
      addUnitAction(key, { variantId, name: text(f, "name"), factor: text(f, "factor"), barcode: text(f, "barcode"), price: pricing ? text(f, "price") : "", currency }),
    ).then((done) => {
      if (done) form.reset();
    });
  };

  return (
    <form className="form panel add-unit" onSubmit={submit} data-testid="unit-add-form">
      <h4>{p.addUnit}</h4>
      <p className="muted">{p.addUnitHint}</p>
      <NoteView section={section} />
      <div className="field-row">
        <label className="field">
          <span>{p.unitName}</span>
          <input className="input" name="name" required maxLength={40} />
        </label>
        <label className="field">
          <span>{p.unitFactor}</span>
          <input className="input" name="factor" dir="ltr" inputMode="numeric" required maxLength={6} />
        </label>
      </div>
      <div className="field-row">
        <label className="field">
          <span>{p.barcodes}</span>
          <input className="input" name="barcode" dir="ltr" maxLength={64} autoComplete="off" placeholder={p.barcodePlaceholder} />
        </label>
        {pricing ? (
          <label className="field">
            <span>{fill(p.newPrice, { currency: t.catalog.currencyShort[currency] })}</span>
            <div className="price-with-currency">
              <input className="input" name="price" dir="ltr" inputMode="decimal" maxLength={24} autoComplete="off" />
              {currencies.length > 1 ? (
                <select className="input" aria-label={t.currency[currency]} value={currency} onChange={(event) => setCurrency(event.target.value as Currency)}>
                  {currencies.map((c) => (
                    <option key={c} value={c}>
                      {t.catalog.currencyShort[c]}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
          </label>
        ) : null}
      </div>
      <div>
        <SubmitButton section={section}>{p.addUnitSubmit}</SubmitButton>
      </div>
    </form>
  );
}
