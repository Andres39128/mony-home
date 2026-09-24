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

  it("falls back to the default month on any non-YYYY-MM value", () => {
    // Content-Disposition filename safety: CRLF / junk never reaches the
    // export route — only a strict YYYY-MM passes through.
    const bad = ['x"·', "x\r", "x\n", "2026-9", "09-2026", "2026-09-01", "septiembre"];
    for (const month of bad) {
      expect(parseTransactionFilters({ month }).filters.month).toBe(todayIso().slice(0, 7));
    }
    expect(parseTransactionFilters({ month: "2026-09" }).filters.month).toBe("2026-09");
  });

  it("reads URLSearchParams with page-identical repeat semantics", () => {
    // The export route passes searchParams straight through. Object.fromEntries
    // used to keep the LAST value of a repeated param while the page's single()
    // treated repeats as absent — same URL, divergent list vs export.
    const repeated = new URLSearchParams("month=2026-09&month=x");
    expect(parseTransactionFilters(repeated).filters.month).toBe(todayIso().slice(0, 7));
    expect(parseTransactionFilters(repeated)).toEqual(parseTransactionFilters({}));

    const single = new URLSearchParams("month=2026-09&q=super&page=2");
    expect(parseTransactionFilters(single).filters.month).toBe("2026-09");
    expect(parseTransactionFilters(single).filters.q).toBe("super");
    expect(parseTransactionFilters(single).page).toBe(2);
  });

  it("uses the fixed page size of 100", () => {
    expect(PAGE_SIZE).toBe(100);
  });
});
