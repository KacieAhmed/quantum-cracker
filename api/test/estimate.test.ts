import { describe, expect, it } from "vitest";
import { estimateAggregateRate, etaSeconds } from "../src/estimate.js";

describe("estimateAggregateRate", () => {
  it("scales linearly with workers up to the core count", () => {
    const perCore = 685;
    expect(estimateAggregateRate(1, 8, perCore)).toBe(685);
    expect(estimateAggregateRate(4, 8, perCore)).toBe(4 * 685);
    expect(estimateAggregateRate(8, 8, perCore)).toBe(8 * 685);
  });

  it("flattens beyond the core count (diminishing returns)", () => {
    const perCore = 685;
    expect(estimateAggregateRate(16, 8, perCore)).toBe(8 * 685);
    expect(estimateAggregateRate(64, 8, perCore)).toBe(8 * 685);
  });
});

describe("etaSeconds", () => {
  it("estimates remaining time at the given rate", () => {
    expect(etaSeconds(1000, 250, 500)).toBe(1.5);
  });

  it("is null before any rate is known and clamps at zero", () => {
    expect(etaSeconds(1000, 0, 0)).toBeNull();
    expect(etaSeconds(1000, 0, Number.NaN)).toBeNull();
    expect(etaSeconds(1000, 2000, 500)).toBe(0);
  });
});
