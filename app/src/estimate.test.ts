import { describe, expect, it } from "vitest";
import { FALLBACK_PER_CORE_RATE, estimateAggregateRate, etaSeconds } from "./estimate";

describe("estimateAggregateRate", () => {
  it("scales linearly with workers up to the core count", () => {
    const perCore = 685;
    expect(estimateAggregateRate(1, 8, perCore)).toBe(perCore);
    expect(estimateAggregateRate(4, 8, perCore)).toBe(4 * perCore);
    expect(estimateAggregateRate(8, 8, perCore)).toBe(8 * perCore);
  });

  it("flattens beyond the core count — the diminishing-returns regime", () => {
    const perCore = 685;
    expect(estimateAggregateRate(12, 8, perCore)).toBe(8 * perCore);
    expect(estimateAggregateRate(64, 8, perCore)).toBe(8 * perCore);
  });

  it("handles zero workers", () => {
    expect(estimateAggregateRate(0, 8, 685)).toBe(0);
  });

  it("engine benchmark fallback equals the api constant (5,479 per 8 cores)", () => {
    expect(FALLBACK_PER_CORE_RATE).toBeCloseTo(5479 / 8, 10);
    expect(estimateAggregateRate(8, 8, FALLBACK_PER_CORE_RATE)).toBeCloseTo(5479, 6);
  });
});

describe("etaSeconds", () => {
  it("returns null when the rate is zero or non-finite", () => {
    expect(etaSeconds(1_000, 0, 0)).toBeNull();
    expect(etaSeconds(1_000, 0, Number.NaN)).toBeNull();
  });

  it("scales remaining work over rate", () => {
    expect(etaSeconds(1_048_576, 0, 5_479)).toBeCloseTo(1_048_576 / 5_479, 6);
    expect(etaSeconds(1_048_576, 548_576, 5_479)).toBeCloseTo(500_000 / 5_479, 6);
  });

  it("clamps at zero when done exceeds total", () => {
    expect(etaSeconds(100, 200, 10)).toBe(0);
  });
});
