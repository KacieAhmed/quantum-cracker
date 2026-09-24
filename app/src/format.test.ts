import { describe, expect, it } from "vitest";
import { formatCount, formatDuration, formatPercent, formatRate } from "./format";

describe("formatCount", () => {
  it("groups thousands", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1000)).toBe("1,000");
    expect(formatCount(1_048_576)).toBe("1,048,576");
    expect(formatCount(16_777_216)).toBe("16,777,216");
  });
});

describe("formatRate", () => {
  it("shows full grouped precision below 10k", () => {
    expect(formatRate(5479)).toBe("5,479/s");
    expect(formatRate(0)).toBe("0/s");
  });

  it("goes compact above 10k (3 significant figures)", () => {
    expect(formatRate(12_340)).toBe("12.3k/s");
    expect(formatRate(1_234_000)).toBe("1.23M/s");
    expect(formatRate(2_500_000_000)).toBe("2.50B/s");
    expect(formatRate(123_400)).toBe("123k/s");
  });

  it("handles non-finite and negative inputs", () => {
    expect(formatRate(Number.NaN)).toBe("—");
    expect(formatRate(-1)).toBe("—");
  });
});

describe("formatDuration", () => {
  it("renders em-dash for null and non-finite", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
  });

  it("renders seconds, minutes, hours", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(59)).toBe("59s");
    expect(formatDuration(60)).toBe("1m 00s");
    expect(formatDuration(65)).toBe("1m 05s");
    expect(formatDuration(3661)).toBe("1h 01m");
  });
});

describe("formatPercent", () => {
  it("formats one decimal and clamps", () => {
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(0.12345)).toBe("12.3%");
    expect(formatPercent(1)).toBe("100.0%");
    expect(formatPercent(2)).toBe("100.0%");
    expect(formatPercent(-0.5)).toBe("0.0%");
    expect(formatPercent(Number.NaN)).toBe("—");
  });
});
