import { getI18n } from "../../_lib/i18n";

/** The till's own loading state: the same frame as the sale screen (rail, ticket, products), so nothing jumps when it arrives. */
export default async function Loading() {
  const { t } = await getI18n();
  const cards = Array.from({ length: 12 }, (_, i) => i);
  return (
    <div className="till-app" role="status" aria-busy="true" data-testid="till-loading">
      <span className="visually-hidden">{t.common.loading}</span>
      <nav className="till-nav" aria-hidden="true" />
      <aside className="till-ticket" aria-hidden="true">
        <div className="till-ticket-head" />
        <div className="till-lines" />
        <div className="till-ticket-foot" />
      </aside>
      <div className="till-side" aria-hidden="true">
        <header className="till-top">
          <span className="till-skel-bar" />
        </header>
        <nav className="till-cats">
          {Array.from({ length: 6 }, (_, i) => (
            <span key={i} className="till-cat till-cat-skel" />
          ))}
        </nav>
        <section className="till-products">
          <div className="till-tiles">
            {cards.map((i) => (
              <span key={i} className="till-tile-skel" />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
