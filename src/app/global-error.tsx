"use client";

// Root-level error boundary: replaces the root layout when the layout itself
// fails, so it must render its own <html>/<body> (docs:
// file-conventions/error.md#global-error). Metadata exports are not supported
// here — use the React <title> component instead.
import { useEffect } from "react";
import Link from "next/link";
import { themeInitScript } from "@/lib/theme-init";
import "./globals.css";

export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="es" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <title>Error — mony-home</title>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="flex h-full flex-col font-sans">
        <main className="flex flex-1 items-center justify-center bg-base px-4">
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
      </body>
    </html>
  );
}
