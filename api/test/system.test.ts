import { describe, expect, it } from "vitest";
import { safeMaxWorkers } from "../src/system.js";

describe("safeMaxWorkers (factory formula)", () => {
  it("is min(cores, floor(available_ram / per_worker_footprint))", () => {
    expect(safeMaxWorkers(8, 1 << 30)).toBe(8); // RAM 1 GiB / 64 MiB = 16 > cores
    expect(safeMaxWorkers(64, 1 << 30)).toBe(16); // RAM-bound: floor(1024/64)
    expect(safeMaxWorkers(4, 1 << 30)).toBe(4); // core-bound
    expect(safeMaxWorkers(2, 63 * 1024 * 1024)).toBe(0); // cannot afford one
  });
});
