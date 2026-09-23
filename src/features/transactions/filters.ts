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

export function parseTransactionFilters(params: RawParams): ListParams {
  const month = single(params, "month") ?? todayIso().slice(0, 7);
  const type = single(params, "type");
  const scope = single(params, "scope");

  return {
    filters: {
      month,
      categoryId: single(params, "categoryId"),
      memberId: single(params, "memberId"),
      groupId: single(params, "groupId"),
      type: type === "income" || type === "expense" ? type : undefined,
      scope: scope === "individual" || scope === "common" ? scope : undefined,
      q: single(params, "q")?.trim() || undefined,
    },
    page: Math.max(1, Number.parseInt(single(params, "page") ?? "1", 10) || 1),
  };
}
