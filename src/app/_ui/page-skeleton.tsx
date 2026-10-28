/** Loading placeholder shaped like a page head and a short list; announced once to screen readers. */
export function PageSkeleton({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <main className="page" aria-busy="true">
      <span className="visually-hidden" role="status">
        {label}
      </span>
      <div className="page-head" aria-hidden="true">
        <div className="skeleton" style={{ width: "12rem", height: "1.75rem" }} />
      </div>
      <div className="choice-list" aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="skeleton" style={{ height: "5.5rem", borderRadius: "var(--radius-lg)" }} />
        ))}
      </div>
    </main>
  );
}
