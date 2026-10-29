"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Locale, Messages } from "@/messages";
import { normalizeSearchText } from "@/server/domain/catalog";
import { fill, formatMoney } from "../../../_lib/format";
import { Notice } from "../../../_ui/state";
import { createCategoryAction, lookupBarcodeAction, quickCreateAction } from "../actions";
import { categoryOptions } from "../_lib/categories";
import { failureMessage, ownerOfBarcode } from "../_lib/failures";
import { useHydrated } from "../_lib/hydrated";
import { newKey } from "../_lib/keys";
import type { CategoryDto, UiFailure } from "../_lib/types";

type Props = {
  locale: Locale;
  t: Messages;
  categories: CategoryDto[];
  /** The user holds price.change: the price field exists. Otherwise products are added without a price. */
  canPrice: boolean;
  currency: "IQD" | "USD";
};

type Added = { id: string; productId: string; name: string; barcode: string; price: string | null };
type Status = { tone: "danger" | "success"; text: string; link?: { href: string; label: string } } | null;
type Option = { kind: "category"; id: string; label: string } | { kind: "create"; name: string };

const KEEP = 10;

/**
 * Quick entry: barcode, name, category, price, Enter, next. The keyboard is the interface: a
 * scanner types the barcode and Enter, and every field passes the cursor on with Enter. The last
 * Enter saves and the form is empty again with the cursor back on the barcode, with no page
 * change. A barcode that already exists opens that product instead (no duplicate is made).
 */
export function QuickEntry({ locale, t, categories: initialCategories, canPrice, currency }: Props) {
  const router = useRouter();
  const hydrated = useHydrated();
  const e = t.catalog.entry;
  const listId = useId();
  const [barcode, setBarcode] = useState("");
  const [name, setName] = useState("");
  const [categoryText, setCategoryText] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [price, setPrice] = useState("");
  const [categories, setCategories] = useState(initialCategories);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  /** The user moved through the list with the arrows: Enter then picks the highlighted option even with nothing typed. */
  const [navigated, setNavigated] = useState(false);
  const [busy, setBusy] = useState<"idle" | "saving">("idle");
  const [status, setStatus] = useState<Status>(null);
  const [added, setAdded] = useState<Added[]>([]);
  const barcodeRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const categoryRef = useRef<HTMLInputElement>(null);
  const priceRef = useRef<HTMLInputElement>(null);
  const key = useRef(newKey());
  const working = useRef(false);
  /** The barcode check of the current barcode (true: free to create), null when there is none to wait for. */
  const lookup = useRef<Promise<boolean> | null>(null);
  const [checking, setChecking] = useState(false);
  /** Bumped whenever the barcode changes or the form clears: an older lookup answer is then ignored. */
  const lookupToken = useRef(0);
  const statusRef = useRef<HTMLDivElement>(null);

  useEffect(() => barcodeRef.current?.focus(), []);
  // An error at phone width can sit below the fold (the cursor stays in the fields): show it.
  useEffect(() => {
    if (status?.tone === "danger") statusRef.current?.scrollIntoView({ block: "nearest" });
  }, [status]);

  const choices = useMemo(() => categoryOptions(locale, categories), [locale, categories]);
  const options = useMemo<Option[]>(() => {
    const wanted = normalizeSearchText(categoryText);
    if (wanted === "") return choices.slice(0, 8).map((c) => ({ kind: "category", id: c.id, label: c.label }));
    const matches = choices.filter((c) => normalizeSearchText(c.label).includes(wanted));
    const list: Option[] = matches.slice(0, 8).map((c) => ({ kind: "category", id: c.id, label: c.label }));
    const exact = choices.some((c) => normalizeSearchText(c.label.split(" › ").pop() ?? "") === wanted);
    if (!exact) list.push({ kind: "create", name: categoryText.trim() });
    return list;
  }, [choices, categoryText]);

  const failWith = (f: UiFailure) => {
    const owner = ownerOfBarcode(f, locale);
    setStatus({
      tone: "danger",
      text: failureMessage(t, f),
      ...(owner ? { link: { href: `/retail/catalog/${owner.productId}`, label: `${e.takenBy} ${owner.name}. ${e.openExisting}` } } : {}),
    });
  };

  const reset = () => {
    setBarcode("");
    setName("");
    setCategoryText("");
    setCategoryId(null);
    setPrice("");
    setOpen(false);
    setNavigated(false);
    setActive(0);
    lookup.current = null;
    lookupToken.current += 1;
    setChecking(false);
    key.current = newKey();
    barcodeRef.current?.focus();
  };

  /**
   * Enter in the barcode box: the cursor moves to the name at once (the check must not slow a
   * scanner down) and the barcode is looked up in the background. If it already belongs to a
   * product, that product opens; saving waits for this answer, so a duplicate is never created.
   */
  function submitBarcode() {
    const code = barcode.trim();
    nameRef.current?.focus();
    if (code === "") {
      lookup.current = null;
      return;
    }
    setChecking(true);
    setStatus(null);
    const token = ++lookupToken.current;
    lookup.current = (async () => {
      try {
        const found = await lookupBarcodeAction(code);
        if (token !== lookupToken.current) return false; // the barcode changed meanwhile: this answer is about an older one
        if (!found.ok) {
          failWith(found);
          barcodeRef.current?.select();
          return false;
        }
        if (found.value.exists) {
          setStatus({ tone: "success", text: e.existsToast });
          router.push(`/retail/catalog/${found.value.productId}?existing=1`);
          return false;
        }
        return true;
      } catch {
        failWith({ code: "INTERNAL" });
        return false;
      } finally {
        if (token === lookupToken.current) setChecking(false);
      }
    })();
  }

  async function save(chosenCategory: string | null = categoryId) {
    if (working.current) return;
    if (lookup.current && !(await lookup.current)) return; // the barcode is taken or invalid: that message is showing
    if (name.trim() === "") {
      setStatus({ tone: "danger", text: e.nameRequired });
      nameRef.current?.focus();
      return;
    }
    working.current = true;
    setBusy("saving");
    setStatus(null);
    try {
      const result = await quickCreateAction(key.current, { barcode, name, categoryId: chosenCategory, price: canPrice ? price : "" });
      if (!result.ok) {
        failWith(result);
        if (result.code === "BAD_PRICE") priceRef.current?.select();
        else if (result.code === "BAD_BARCODE" || result.code === "BARCODE_TAKEN") barcodeRef.current?.select();
        else if (result.code === "BAD_NAME") nameRef.current?.focus();
        return;
      }
      const label = result.value.price
        ? formatMoney(locale, result.value.price.currency, result.value.price.amountMinor, t.catalog.currencyShort[result.value.price.currency])
        : null;
      setAdded((prev) => [{ id: result.value.productId, productId: result.value.productId, name: name.trim(), barcode: barcode.trim(), price: label }, ...prev].slice(0, KEEP));
      setStatus({ tone: "success", text: fill(e.savedToast, { name: name.trim() }) });
      reset();
    } catch {
      failWith({ code: "INTERNAL" });
    } finally {
      working.current = false;
      setBusy("idle");
    }
  }

  const afterCategory = (id: string | null) => {
    if (canPrice) priceRef.current?.focus();
    else void save(id);
  };

  async function choose(option: Option) {
    setOpen(false);
    if (option.kind === "category") {
      setCategoryId(option.id);
      setCategoryText(option.label);
      afterCategory(option.id);
      return;
    }
    if (working.current) return;
    working.current = true;
    setBusy("saving");
    let created: Awaited<ReturnType<typeof createCategoryAction>>;
    try {
      created = await createCategoryAction(newKey(), { name: option.name });
    } catch {
      created = { ok: false, code: "INTERNAL" };
    }
    working.current = false;
    setBusy("idle");
    if (!created.ok) {
      failWith(created);
      return;
    }
    setCategories((prev) => [...prev, created.value]);
    setCategoryId(created.value.id);
    setCategoryText(option.name);
    afterCategory(created.value.id);
  }

  const onFormKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== "Escape") return;
    if (working.current) {
      event.preventDefault(); // a save is in flight: clearing now would wipe what the next product has typed
      return;
    }
    if (open) {
      setOpen(false);
      return;
    }
    event.preventDefault();
    reset();
    setStatus({ tone: "success", text: e.cleared });
  };

  const onCategoryKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setNavigated(true);
      setActive((a) => (navigated || categoryText.trim() !== "" ? Math.min(a + 1, options.length - 1) : a));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setNavigated(true);
      setActive((a) => Math.max(a - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const wanted = categoryText.trim();
      if (wanted === "" && categoryId === null && !navigated) {
        afterCategory(null); // nothing typed: skip the category
      } else if (categoryId !== null && open === false) {
        afterCategory(categoryId); // already chosen
      } else {
        const pick = options[Math.min(active, options.length - 1)];
        if (pick) void choose(pick);
      }
    }
  };

  const busyText = busy === "saving" ? e.saving : checking ? e.checking : "";

  return (
    <div className="qe">
      <form className="qe-form form" onSubmit={(event) => event.preventDefault()} onKeyDown={onFormKeyDown} noValidate>
        <label className="field">
          <span>{e.barcode}</span>
          <input
            ref={barcodeRef}
            className="input qe-barcode"
            dir="ltr"
            name="barcode"
            value={barcode}
            maxLength={64}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="next"
            onChange={(event) => {
              setBarcode(event.target.value);
              lookup.current = null;
              lookupToken.current += 1;
              setChecking(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submitBarcode();
              }
            }}
            data-testid="qe-barcode"
          />
          <span className="hint">{e.barcodeHint}</span>
        </label>

        <label className="field">
          <span>{e.name}</span>
          <input
            ref={nameRef}
            className="input"
            name="name"
            value={name}
            maxLength={200}
            autoComplete="off"
            enterKeyHint="next"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (name.trim() === "") setStatus({ tone: "danger", text: e.nameRequired });
                else categoryRef.current?.focus();
              }
            }}
            data-testid="qe-name"
          />
          <span className="hint">{e.nameHint}</span>
        </label>

        <div className="field qe-combo">
          <label htmlFor={`${listId}-input`}>
            <span>{e.category}</span>
          </label>
          <div className="qe-combo-box">
          <input
            id={`${listId}-input`}
            ref={categoryRef}
            className="input"
            name="category"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
            value={categoryText}
            autoComplete="off"
            enterKeyHint={canPrice ? "next" : "done"}
            onChange={(event) => {
              setCategoryText(event.target.value);
              setCategoryId(null);
              setActive(0);
              setNavigated(false);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={onCategoryKeyDown}
            data-testid="qe-category"
          />
          {open && options.length > 0 ? (
            <ul id={listId} role="listbox" className="qe-options" data-testid="qe-category-options">
              {options.map((option, i) => (
                <li
                  key={option.kind === "category" ? option.id : "create"}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  data-active={i === active}
                  data-kind={option.kind}
                  // mousedown (not click): it fires before the input loses focus and closes the list.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    void choose(option);
                  }}
                >
                  {option.kind === "category" ? option.label : fill(e.categoryCreate, { name: option.name })}
                </li>
              ))}
            </ul>
          ) : null}
          </div>
          <span className="hint">{e.categoryHint}</span>
        </div>

        {canPrice ? (
          <label className="field">
            <span>{fill(e.price, { currency: t.catalog.currencyShort[currency] })}</span>
            <input
              ref={priceRef}
              className="input"
              dir="ltr"
              name="price"
              inputMode="decimal"
              value={price}
              maxLength={24}
              autoComplete="off"
              enterKeyHint="done"
              onChange={(event) => setPrice(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void save();
                }
              }}
              data-testid="qe-price"
            />
            <span className="hint">{e.priceHint}</span>
          </label>
        ) : (
          <p className="muted">{e.noPriceNote}</p>
        )}

        <div className="qe-actions">
          <button type="button" className="btn btn-primary" disabled={!hydrated || busy !== "idle"} aria-busy={busy !== "idle"} onClick={() => void save()} data-testid="qe-save">
            {busy === "saving" ? e.saving : e.save}
          </button>
          <span className="muted" role="status">
            {busyText || e.saveHint}
          </span>
        </div>

        <div aria-live="polite" className="qe-status" ref={statusRef} data-testid="qe-status">
          {status ? (
            <Notice tone={status.tone}>
              {status.text}
              {status.link ? (
                <>
                  {" "}
                  <Link href={status.link.href}>{status.link.label}</Link>
                </>
              ) : null}
            </Notice>
          ) : null}
        </div>
      </form>

      <section className="qe-added" aria-labelledby={`${listId}-added`}>
        <h2 id={`${listId}-added`}>{e.added}</h2>
        {added.length === 0 ? (
          <p className="muted">{e.addedEmpty}</p>
        ) : (
          <ul className="qe-added-list">
            {added.map((item) => (
              <li key={item.id} data-testid="qe-added-item">
                <Link href={`/retail/catalog/${item.productId}`} className="qe-added-link">
                  <span className="qe-added-name">{item.name}</span>
                  <span className="muted qe-added-meta">
                    {item.barcode ? (
                      <span dir="ltr">{item.barcode}</span>
                    ) : null}
                    {item.price ? <span>{item.price}</span> : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
