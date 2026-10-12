import type { Instrumentation } from "next";
import * as Sentry from "@sentry/nextjs";

/**
 * Server error observability (docs: file-conventions/instrumentation.md —
 * this file goes in src/ because the app uses a src folder).
 *
 * Every server-side error (render, route handler, server action, proxy) is
 * logged as one structured JSON line so logs are greppable and the digest
 * can be correlated with the client-facing error boundary — and, once
 * SENTRY_DSN is set, forwarded to Sentry via captureRequestError. Without
 * the DSN nothing initializes and every Sentry call below stays dormant.
 */
export function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.SENTRY_DSN) {
    // Dynamic import keeps the server SDK out of the edge bundle.
    return import("./sentry.server.config");
  }
}

export const onRequestError: Instrumentation.onRequestError = (
  err,
  request,
  context,
) => {
  const message = err instanceof Error ? err.message : String(err);
  const digest =
    typeof err === "object" && err !== null && "digest" in err
      ? String(err.digest)
      : undefined;

  console.error(
    JSON.stringify({
      level: "error",
      event: "request_error",
      message,
      digest,
      path: request.path,
      method: request.method,
      routePath: context.routePath,
      routeType: context.routeType,
      routerKind: context.routerKind,
    }),
  );

  // The DSN check (not SDK internals) guarantees the strict no-op.
  if (process.env.SENTRY_DSN) {
    Sentry.captureRequestError(err, request, context);
  }
};
