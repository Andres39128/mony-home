/** Month navigation helpers for the filters bar (no ICU dependency). */

const MONTH_ABBRS = [
  "ene",
  "feb",
  "mar",
  "abr",
  "may",
  "jun",
  "jul",
  "ago",
  "sep",
  "oct",
  "nov",
  "dic",
] as const;

/** 'YYYY-MM' → 'sep 2026'; malformed input passes through unchanged. */
export function monthLabel(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return month;
  return `${MONTH_ABBRS[Number(match[2]) - 1]} ${match[1]}`;
}

/** 'YYYY-MM' shifted by delta months (UTC math rolls the year over). */
export function shiftMonth(month: string, delta: number): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return month;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
