import { describe, expect, it } from "vitest";
import { PAGE_SIZE, parseTransactionFilters } from "@/features/transactions/filters";
import { todayIso } from "@/lib/date";

/**
 * Pure suite: ONE shared parsing of the /movimientos + CSV-export query
 * params, so the list page and the export always agree.
 */
describe("parseTransactionFilters", () => {
  it("defaults month to the current one and page to 1", () => {
    const { filters, page } = parseTransactionFilters({});
    expect(filters.month).toBe(todayIso().slice(0, 7));
    expect(page).toBe(1);
    expect(filters.type).toBeUndefined();
    expect(filters.q).toBeUndefined();
  });

  it("parses every list param, trimming the search term", () => {
    const { filters, page } = parseTransactionFilters({
      month: "2026-09",
      type: "income",
      scope: "individual",
      memberId: "m1",
      categoryId: "c1",
      groupId: "g1",
      q: "  super  ",
      page: "3",
    });
    expect(filters).toEqual({
      month: "2026-09",
      type: "income",
      scope: "individual",
      memberId: "m1",
      categoryId: "c1",
      groupId: "g1",
      q: "super",
    });
    expect(page).toBe(3);
  });

  it("falls back to no-filter/1 on invalid values and array params", () => {
    const { filters, page } = parseTransactionFilters({
      type: "otro",
      scope: "x",
      page: "-2",
      q: ["array", "value"],
    });
    expect(filters.type).toBeUndefined();
    expect(filters.scope).toBeUndefined();
    expect(filters.q).toBeUndefined();
    expect(page).toBe(1);
  });

  it("uses the fixed page size of 100", () => {
    expect(PAGE_SIZE).toBe(100);
  });
});
