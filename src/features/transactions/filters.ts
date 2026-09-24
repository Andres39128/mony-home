/**
 * Shared parsing of the /movimientos list query params (month, scope,
 * memberId, categoryId, groupId, type, q, page). ONE source of truth used
 * by the page, the CSV export route and their tests, so both surfaces
 * always agree on what a filter means. Pure — no Next.js imports.
 */
import { todayIso } from "@/lib/date";
import type { TransactionFilters } from "@/features/transactions/service";

/** Page shape of searchParams: same type Next passes to pages. */
export type RawParams = { [key: string]: string | string[] | undefined };

/** Rows per page on the movements list. */
export const PAGE_SIZE = 100;

export interface ListParams {
  /** month is ALWAYS set: it defaults to the current month like the UI. */
  filters: TransactionFilters & { month: string };
  /** 1-based page number; invalid/negative input falls back to 1. */
  page: number;
}

function single(params: RawParams, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Route-handler shape (URLSearchParams) → page shape. A repeated param keeps
 * ALL its values as an array so `single()` discards it exactly like it does
 * for a page — Object.fromEntries would instead take the LAST value, letting
 * one URL list unfiltered but export filtered.
 */
function fromSearchParams(params: URLSearchParams): RawParams {
  const out: RawParams = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    out[key] = values.length > 1 ? values : values[0];
  }
  return out;
}

export function parseTransactionFilters(params: RawParams | URLSearchParams): ListParams {
  const raw = params instanceof URLSearchParams ? fromSearchParams(params) : params;
  const rawMonth = single(raw, "month");
  // Trust boundary: `month` reaches the DB query AND the CSV export's
  // Content-Disposition filename. Anything but YYYY-MM (e.g. CRLF smuggled
  // into the filename) falls back to the default — one shared point fixes
  // the list page and the export route together.
  const month = rawMonth && /^\d{4}-\d{2}$/.test(rawMonth) ? rawMonth : todayIso().slice(0, 7);
  const type = single(raw, "type");
  const scope = single(raw, "scope");

  return {
    filters: {
      month,
      categoryId: single(raw, "categoryId"),
      memberId: single(raw, "memberId"),
      groupId: single(raw, "groupId"),
      type: type === "income" || type === "expense" ? type : undefined,
      scope: scope === "individual" || scope === "common" ? scope : undefined,
      q: single(raw, "q")?.trim() || undefined,
    },
    page: Math.max(1, Number.parseInt(single(raw, "page") ?? "1", 10) || 1),
  };
}
