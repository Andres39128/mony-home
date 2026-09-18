import { describe, expect, it } from "vitest";
import {
  FALLBACK_COLOR,
  buildBarsData,
  buildDonutData,
  buildLinesData,
  hasCumulativeData,
  hasFlowData,
  shortMonthLabel,
} from "@/features/analytics/transform";

describe("analytics transforms (pure)", () => {
  describe("shortMonthLabel", () => {
    it("formats es-AR short month + 2-digit year", () => {
      expect(shortMonthLabel("2026-01")).toBe("ene 26");
      expect(shortMonthLabel("2026-03")).toBe("mar 26");
      expect(shortMonthLabel("2025-12")).toBe("dic 25");
    });

    it("returns malformed input untouched", () => {
      expect(shortMonthLabel("not-a-month")).toBe("not-a-month");
    });
  });

  describe("buildDonutData", () => {
    it("returns [] for empty or all-invalid input", () => {
      expect(buildDonutData([])).toEqual([]);
      expect(
        buildDonutData([
          { categoryId: "c1", name: "Super", color: "#123456", cents: 0, pct: 0 },
        ]),
      ).toEqual([]);
    });

    it("keeps cents and rounds pct passthrough", () => {
      const [slice] = buildDonutData([
        { categoryId: "c1", name: "Super", color: "#16a34a", cents: 150_50, pct: 33.333333 },
      ]);
      expect(slice).toEqual({
        categoryId: "c1",
        name: "Super",
        color: "#16a34a",
        cents: 150_50,
        pct: 33.33,
      });
    });

    it("falls back to constant color and name, recomputing pct when missing", () => {
      const [slice] = buildDonutData([
        { categoryId: "c1", name: "", color: "nope", cents: 100, pct: Number.NaN },
        { categoryId: "c2", name: "Ocio", color: "", cents: 300, pct: Number.NaN },
      ]);
      expect(slice.name).toBe("Sin categoría");
      expect(slice.color).toBe(FALLBACK_COLOR);
      expect(slice.pct).toBe(25);
      expect(slice.color).toBe(FALLBACK_COLOR);
    });
  });

  describe("buildBarsData / buildLinesData", () => {
    it("maps totals to labeled points", () => {
      expect(
        buildBarsData([
          { month: "2026-02", incomeCents: 0, expenseCents: 500 },
        ]),
      ).toEqual([{ month: "2026-02", label: "feb 26", incomeCents: 0, expenseCents: 500 }]);
    });

    it("maps cumulative points to labeled points", () => {
      expect(
        buildLinesData([
          { month: "2026-01", plannedCumCents: 100, actualCumCents: 50 },
        ]),
      ).toEqual([
        { month: "2026-01", label: "ene 26", plannedCumCents: 100, actualCumCents: 50 },
      ]);
    });

    it("detects all-zero windows for empty states", () => {
      const zeroBars = buildBarsData([
        { month: "2026-01", incomeCents: 0, expenseCents: 0 },
      ]);
      expect(hasFlowData(zeroBars)).toBe(false);
      expect(hasFlowData(buildBarsData([{ month: "2026-01", incomeCents: 1, expenseCents: 0 }]))).toBe(true);

      const zeroLines = buildLinesData([
        { month: "2026-01", plannedCumCents: 0, actualCumCents: 0 },
      ]);
      expect(hasCumulativeData(zeroLines)).toBe(false);
      expect(
        hasCumulativeData(
          buildLinesData([{ month: "2026-01", plannedCumCents: 0, actualCumCents: 7 }]),
        ),
      ).toBe(true);
    });
  });
});
