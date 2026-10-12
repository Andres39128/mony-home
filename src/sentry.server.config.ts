import * as Sentry from "@sentry/nextjs";

/**
 * Server-side Sentry — error capture only (tracesSampleRate 0 disables
 * performance/tracing). Only ever imported when SENTRY_DSN is set (see
 * src/instrumentation.ts), so an empty DSN means the SDK never initializes.
 */
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0,
  environment: process.env.NODE_ENV,
});
