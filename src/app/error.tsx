"use client";

// Error boundaries must be Client Components; `retry` is the stable recovery
// prop in this Next version (docs: file-conventions/error.md — re-fetches and
// re-renders the segment).
import { useEffect } from "react";
import Link from "next/link";

/**
 * Segment-level error boundary. Renders inside the root layout, so the
 * design tokens and theme class from globals.css apply. The message is
 * generic: error details (digest) only surface in the server logs.
 */
export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    // Observability sink for now; swap for the reporting service when one exists.
    console.error(error);
  }, [error]);

  return (
    <main className="flex flex-1 items-center justify-center bg-base px-4 font-sans">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-8 text-center shadow-sm">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Algo salió mal</h1>
        <p className="mt-2 text-sm text-muted">
          Ocurrió un error inesperado. Probá de nuevo o volvé al inicio.
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <button
            type="button"
            onClick={() => retry()}
            className="inline-flex min-h-11 items-center justify-center rounded-lg bg-ink px-4 py-2 font-medium text-base transition-colors hover:bg-ink/90"
          >
            Reintentar
          </button>
          <Link
            href="/"
            className="inline-flex min-h-11 items-center justify-center rounded-lg border border-line px-4 py-2 font-medium text-ink transition-colors hover:bg-surface"
          >
            Ir al inicio
          </Link>
        </div>
      </div>
    </main>
  );
}
