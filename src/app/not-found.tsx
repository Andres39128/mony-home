import Link from "next/link";

/**
 * Root not-found: serves unmatched URLs app-wide and any notFound() call.
 * Server Component — renders inside the root layout (theme + tokens apply).
 */
export default function NotFound() {
  return (
    <main className="flex flex-1 items-center justify-center bg-base px-4 font-sans">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-8 text-center shadow-sm">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Página no encontrada</h1>
        <p className="mt-2 text-sm text-muted">
          La dirección que buscás no existe o fue movida.
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex min-h-11 items-center justify-center rounded-lg bg-ink px-4 py-2 font-medium text-base transition-colors hover:bg-ink/90"
        >
          Ir al inicio
        </Link>
      </div>
    </main>
  );
}
