import * as Sentry from "@sentry/nextjs";

/**
 * Client-side Sentry — error capture only (tracesSampleRate 0), initialized
 * solely when NEXT_PUBLIC_SENTRY_DSN was inlined at build time (docs:
 * file-conventions/instrumentation-client — top-level code here runs before
 * hydration; no exports needed). Empty DSN = the SDK never initializes.
 */
if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    tracesSampleRate: 0,
  });
}
