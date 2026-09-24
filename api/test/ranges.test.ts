import { describe, expect, it } from "vitest";
import { splitSpace } from "../src/ranges.js";

describe("splitSpace", () => {
  it("splits evenly with disjoint covering ranges", () => {
    const ranges = splitSpace(1000, 4);
    expect(ranges).toEqual([
      { start: 0, count: 250 },
      { start: 250, count: 250 },
      { start: 500, count: 250 },
      { start: 750, count: 250 },
    ]);
  });

  it("absorbs the remainder in the last lane", () => {
    const ranges = splitSpace(10, 3);
    expect(ranges).toEqual([
      { start: 0, count: 4 },
      { start: 4, count: 3 },
      { start: 7, count: 3 },
    ]);
  });

  it("caps lanes at the space size (CLI rejects empty ranges)", () => {
    const ranges = splitSpace(3, 8);
    expect(ranges).toEqual([
      { start: 0, count: 1 },
      { start: 1, count: 1 },
      { start: 2, count: 1 },
    ]);
  });

  it("single lane covers the whole space", () => {
    expect(splitSpace(7, 1)).toEqual([{ start: 0, count: 7 }]);
  });

  it("rejects non-positive inputs", () => {
    expect(() => splitSpace(0, 4)).toThrow(RangeError);
    expect(() => splitSpace(100, 0)).toThrow(RangeError);
    expect(() => splitSpace(1.5, 2)).toThrow(RangeError);
  });
});
