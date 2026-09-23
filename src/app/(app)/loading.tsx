/**
 * Route-segment loading boundary for every (app) page.
 *
 * Beyond the visible fallback, its presence is what lets Next prefetch the
 * app's dynamic routes (see docs prefetching.md: dynamic routes without a
 * loading boundary are skipped), so nav clicks hit the prefetched boundary
 * instead of a blocking render.
 */
export default function Loading() {
  return (
    <section aria-busy="true" className="flex flex-col gap-6">
      <span className="sr-only">Cargando…</span>
      <div className="h-8 w-44 animate-pulse rounded-lg bg-muted dark:bg-line" />
      <div className="grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-24 animate-pulse rounded-2xl border border-line bg-surface"
            style={{ animationDelay: `${i * 120}ms` }}
          />
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-40 animate-pulse rounded-2xl border border-line bg-surface"
            style={{ animationDelay: `${i * 90}ms` }}
          />
        ))}
      </div>
    </section>
  );
}
