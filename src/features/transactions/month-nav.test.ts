import { describe, expect, it } from "vitest";
import { monthLabel, shiftMonth } from "@/features/transactions/month-nav";

describe("monthLabel", () => {
  it("abbreviates in Spanish", () => {
    expect(monthLabel("2026-09")).toBe("sep 2026");
    expect(monthLabel("2026-01")).toBe("ene 2026");
    expect(monthLabel("2026-12")).toBe("dic 2026");
  });

  it("passes malformed input through", () => {
    expect(monthLabel("junk")).toBe("junk");
  });
});

describe("shiftMonth", () => {
  it("rolls over year boundaries", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2025-12", 1)).toBe("2026-01");
  });

  it("shifts within the year", () => {
    expect(shiftMonth("2026-09", -1)).toBe("2026-08");
    expect(shiftMonth("2026-09", 1)).toBe("2026-10");
  });
});
