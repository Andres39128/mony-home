import { describe, expect, it } from "vitest";
import { targetDimensions } from "@/lib/receipt-image";

describe("targetDimensions", () => {
  it("scales landscape and portrait down to the longest side", () => {
    expect(targetDimensions(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(targetDimensions(3000, 4000, 1600)).toEqual({ width: 1200, height: 1600 });
  });

  it("never upscales small images", () => {
    expect(targetDimensions(800, 600, 1600)).toEqual({ width: 800, height: 600 });
    expect(targetDimensions(1600, 1600, 1600)).toEqual({ width: 1600, height: 1600 });
  });

  it("rounds fractional scales to whole pixels", () => {
    expect(targetDimensions(2001, 1500, 1600)).toEqual({ width: 1600, height: 1199 });
  });

  it("handles degenerate sizes without dividing by zero", () => {
    expect(targetDimensions(0, 0, 1600)).toEqual({ width: 0, height: 0 });
  });
});
