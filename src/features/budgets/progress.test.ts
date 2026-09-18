import { describe, expect, it } from "vitest";
import {
  computeProgress,
  monthBounds,
} from "@/features/budgets/progress";

/**
 * Pure progress math: threshold boundaries (warn >= 0.75, over >= 1.0),
 * divide-by-zero, negative remaining, and exact month bounds incl. leap years.
 */
describe("computeProgress", () => {
  it("is ok below the warn threshold (74.99%)", () => {
    expect(computeProgress(10000, 7499)).toEqual({
      pct: 74.99,
      remainingCents: 2501,
      status: "ok",
    });
  });

  it("warns exactly at 75% and stays warned at 99.9%", () => {
    expect(computeProgress(10000, 7500).status).toBe("warn");
    expect(computeProgress(1000, 999)).toMatchObject({ pct: 99.9, status: "warn" });
  });

  it("is over at 100% and beyond (120%) with negative remaining", () => {
    expect(computeProgress(100, 100)).toEqual({
      pct: 100,
      remainingCents: 0,
      status: "over",
    });
    expect(computeProgress(100, 120)).toEqual({
      pct: 120,
      remainingCents: -20,
      status: "over",
    });
  });

  it("handles a zero plan: 0% progress and negative remaining when money was spent", () => {
    expect(computeProgress(0, 0)).toEqual({ pct: 0, remainingCents: 0, status: "ok" });
    expect(computeProgress(0, 500)).toEqual({
      pct: 0,
      remainingCents: -500,
      status: "ok",
    });
  });
});

describe("monthBounds", () => {
  it("returns inclusive first/last day ISO strings", () => {
    expect(monthBounds("2026-09")).toEqual({ start: "2026-09-01", end: "2026-09-30" });
    expect(monthBounds("2026-12")).toEqual({ start: "2026-12-01", end: "2026-12-31" });
  });

  it("handles leap and non-leap Februaries", () => {
    expect(monthBounds("2024-02")).toEqual({ start: "2024-02-01", end: "2024-02-29" });
    expect(monthBounds("2025-02")).toEqual({ start: "2025-02-01", end: "2025-02-28" });
  });

  it("rejects malformed months", () => {
    expect(monthBounds("2026-13")).toBeNull();
    expect(monthBounds("2026-9")).toBeNull();
    expect(monthBounds("septiembre")).toBeNull();
    expect(monthBounds("")).toBeNull();
  });
});
