import type { Instrumentation } from "next";

/**
 * Server error observability (docs: file-conventions/instrumentation.md —
 * this file goes in src/ because the app uses a src folder).
 *
 * Every server-side error (render, route handler, server action, proxy) is
 * logged as one structured JSON line so logs are greppable and the digest
 * can be correlated with the client-facing error boundary. Console is the
 * sink for now; an external provider plugs in right here — e.g. Sentry:
 * replace the console.error with `Sentry.captureRequestError(err, request,
 * context)` once the DSN is configured (no new deps until then).
 */
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
};
