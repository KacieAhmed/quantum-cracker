import { describe, expect, it } from "vitest";
import {
  formatYears,
  groverExtrapolation12Words,
  groverOracleCalls,
  sci,
  wallClockYears,
} from "./grover";

describe("grover closed-form extrapolation", () => {
  it("matches the pinned research note's 12-word figures", () => {
    const x = groverExtrapolation12Words();
    // Raw 2048^12 = 2^132; valid = 2^128.
    expect(x.rawPhrases).toBe(2 ** 132);
    expect(x.validPhrases).toBe(2 ** 128);
    // π/4 · 2^66 ≈ 5.8×10^19 oracle calls (66-bit effective security).
    expect(x.effectiveSecurityBits).toBe(66);
    expect(sci(x.oracleCalls)).toBe("5.8×10^19");
    // 1 ns/oracle-call → ≈ 2,340 years (note §3's optimistic table row).
    expect(formatYears(x.yearsAtOneNs)).toBe("2,340");
  });

  it("scales oracle calls as (π/4)·2^(bits/2)", () => {
    expect(groverOracleCalls(16)).toBeCloseTo((Math.PI / 4) * 256, 10);
  });

  it("converts seconds-per-call to years", () => {
    // 10^9 calls × 1 s = 10^9 s ≈ 31.7 years.
    expect(wallClockYears(1e9, 1)).toBeCloseTo(1e9 / 31_557_600, 6);
  });

  it("formats big figures in scientific notation", () => {
    expect(sci(5.795e19)).toBe("5.8×10^19");
    expect(sci(2 ** 128)).toBe("3.4×10^38");
    expect(sci(1500)).toBe("1,500");
  });
});
