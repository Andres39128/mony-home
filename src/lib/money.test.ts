import { describe, expect, it } from "vitest";
import { AmbiguousAmountError, centsToNumber, formatCents, formatCentsCompact, MoneyParseError, parseAmountToCents, percentage } from "@/lib/money";

describe("parseAmountToCents", () => {
  it("parses plain integers", () => {
    expect(parseAmountToCents("1500")).toBe(150000);
    expect(parseAmountToCents("0")).toBe(0);
  });

  it("parses explicit decimal point", () => {
    expect(parseAmountToCents("1500.75")).toBe(150075);
    expect(parseAmountToCents("0.5")).toBe(50);
    expect(parseAmountToCents("0.05")).toBe(5);
  });

  it("parses es-AR thousands + decimal comma", () => {
    expect(parseAmountToCents("1.500,75")).toBe(150075);
    expect(parseAmountToCents("1.234.567,89")).toBe(123456789);
  });

  it("parses decimal comma without thousands", () => {
    expect(parseAmountToCents("1500,75")).toBe(150075);
    expect(parseAmountToCents("0,5")).toBe(50);
  });

  it("strips currency symbols and whitespace", () => {
    expect(parseAmountToCents("$ 1.500,75")).toBe(150075);
    expect(parseAmountToCents("$1500")).toBe(150000);
    expect(parseAmountToCents(" 1 500 ")).toBe(150000);
    expect(parseAmountToCents("$ -1.500,00")).toBe(-150000);
  });

  it("keeps the comma-style thousands reading for a trailing 3-digit group", () => {
    expect(parseAmountToCents("1,234")).toBe(123400);
    expect(parseAmountToCents("1.234.567")).toBe(123456700); // multi-dot: only thousands reading
  });

  it("rejects a single-dot thousands/decimals collision as ambiguous", () => {
    // '1.234' could be es-AR thousands (1234) or a dot-decimal typo for 1.23;
    // the parser refuses to guess, so the user must disambiguate.
    for (const ambiguous of ["1.234", "12.345", "123.456", "0.285", "1234.567", "$ 1.234"]) {
      expect(() => parseAmountToCents(ambiguous)).toThrowError(AmbiguousAmountError);
      try {
        parseAmountToCents(ambiguous);
      } catch (error) {
        expect((error as AmbiguousAmountError).input).toBe(ambiguous);
        expect(error).toBeInstanceOf(MoneyParseError);
      }
    }
  });

  it("still parses unambiguous inputs exactly as before", () => {
    expect(parseAmountToCents("1234")).toBe(123400);
    expect(parseAmountToCents("1.234,56")).toBe(123456);
    expect(parseAmountToCents("1,23")).toBe(123);
    expect(parseAmountToCents("12.345,67")).toBe(1234567);
    expect(parseAmountToCents("1500.75")).toBe(150075); // explicit dot decimals stay accepted
    expect(parseAmountToCents("2.500,00")).toBe(250000); // formatCents round-trip
  });

  it("accepts the other locale style when both separators are present (last wins)", () => {
    expect(parseAmountToCents("1,234.56")).toBe(123456);
    expect(parseAmountToCents("1,234,567.89")).toBe(123456789);
  });

  it("rounds more than two decimals half-up to cents", () => {
    expect(parseAmountToCents("1.2345")).toBe(123); // 1.2345 → 123.45 → 123
    expect(parseAmountToCents("0,2859")).toBe(29); // 0.2859 → 28.59 → 29
    expect(parseAmountToCents("0,2849")).toBe(28); // 0.2849 → 28.49 → 28
  });

  it("reads a trailing 3-digit group after a single separator as thousands", () => {
    expect(parseAmountToCents("2,285")).toBe(228500);
    expect(parseAmountToCents("0,285")).toBe(28500); // es-AR: 285, not 0.285
  });

  it("parses negative amounts to negative cents", () => {
    expect(parseAmountToCents("-1500,75")).toBe(-150075);
    expect(parseAmountToCents("-1500")).toBe(-150000);
    expect(parseAmountToCents("+1500")).toBe(150000);
  });

  it.each(["abc", "", "   ", "$", "-", "12,34.5", "1.2.3", "1..5", "1500,", ",5", ".5", "1500.500.75"])(
    "throws MoneyParseError naming the input for %j",
    (bad) => {
      expect(() => parseAmountToCents(bad)).toThrowError(MoneyParseError);
      try {
        parseAmountToCents(bad);
      } catch (error) {
        expect((error as MoneyParseError).input).toBe(bad);
        expect((error as MoneyParseError).message).toContain(bad.trim() || bad);
      }
    },
  );
});

describe("centsToNumber", () => {
  it("converts cents to float units", () => {
    expect(centsToNumber(150075)).toBe(1500.75);
    expect(centsToNumber(-1)).toBe(-0.01);
  });
});

describe("formatCents", () => {
  // The exact glyph between '$' and the digits (regular vs narrow no-break
  // space) varies across ICU versions, so we assert against an Intl-generated
  // expectation plus a structural regex instead of a hardcoded literal.
  it("formats ARS with es-AR grouping, matching a local Intl expectation", () => {
    const expected = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format(
      1500.75,
    );
    expect(formatCents(150075)).toBe(expected);
    expect(formatCents(150075)).toMatch(/^\$\s?1\.500,75$/u);
  });

  it("formats negative amounts", () => {
    const expected = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format(
      -1500.75,
    );
    expect(formatCents(-150075)).toBe(expected);
  });

  it("honors a custom currency", () => {
    const expected = new Intl.NumberFormat("es-AR", { style: "currency", currency: "USD" }).format(
      10,
    );
    expect(formatCents(1000, "USD")).toBe(expected);
  });
});

describe("formatCentsCompact", () => {
  it("abbreviates for chart axes without losing zero", () => {
    expect(formatCentsCompact(0)).toBe("0");
    // ICU may render the number/suffix gap as a NBSP; tolerate any whitespace.
    expect(formatCentsCompact(1_540_000)).toMatch(/^15,4\s?k$/u);
    expect(formatCentsCompact(250_000_000)).toMatch(/^2,5\s?M$/u);
  });
});

describe("percentage", () => {
  it("returns 0 when total is 0 or negative", () => {
    expect(percentage(50, 0)).toBe(0);
    expect(percentage(50, -10)).toBe(0);
  });

  it("returns the ratio rounded to 2 decimals", () => {
    expect(percentage(50, 100)).toBe(50);
    expect(percentage(1, 3)).toBe(33.33);
    expect(percentage(2, 3)).toBe(66.67);
  });

  it("can exceed 100 when part > total", () => {
    expect(percentage(75, 50)).toBe(150);
  });
});

describe("parseAmountToCents range (bigint-backed money columns)", () => {
  it("accepts real-world ARS magnitudes beyond int4 cents", () => {
    // The exact production case: a $36M ARS emergency-fund target.
    expect(parseAmountToCents("36000000")).toBe(3_600_000_000);
    expect(parseAmountToCents("99.999.999.999,99")).toBe(9_999_999_999_999);
  });

  it("still rejects amounts beyond Number.MAX_SAFE_INTEGER cents", () => {
    expect(() => parseAmountToCents("99999999999999999")).toThrow(MoneyParseError);
  });
});
