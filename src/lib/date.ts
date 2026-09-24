/**
 * App-calendar helpers, client-safe (no server imports): every module that
 * needs "today" — transactions, savings math, accrual — shares this ONE
 * implementation instead of per-feature copies.
 */

/** App-wide calendar day: filing never depends on the server's TZ setting. */
const APP_TIME_ZONE = "America/Argentina/Buenos_Aires";

/** ISO date ('YYYY-MM-DD') in the app timezone; shared by schema default and pages. */
export function todayIso(now = new Date()): string {
  // en-CA renders Intl dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Months since year 0 of a Date instant, in the APP timezone — accrual
 * engines compare months on the household's calendar, never the server's. */
export function monthIndexOfDate(date: Date): number {
  const [year, month] = todayIso(date).split("-").map(Number);
  return year * 12 + (month - 1);
}
