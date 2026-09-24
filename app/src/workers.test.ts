import { describe, expect, it } from "vitest";
import { workerHint, workerLevel, workerPresets } from "./workers";

describe("workerLevel", () => {
  it("is normal at or under the core count", () => {
    expect(workerLevel(1, 8, 8)).toBe("normal");
    expect(workerLevel(8, 8, 8)).toBe("normal");
  });

  it("is amber above cores but within safe-max", () => {
    expect(workerLevel(9, 8, 16)).toBe("amber");
  });

  it("is red above safe-max (which never exceeds cores)", () => {
    expect(workerLevel(17, 8, 16)).toBe("red");
    expect(workerLevel(64, 8, 8)).toBe("red");
  });
});

describe("workerHint", () => {
  it("carries the crash-prevention wording at red", () => {
    const hint = workerHint("red", 64, 8, 8);
    expect(hint).toContain("at some point your computer crashes");
    expect(hint).toContain("force-override");
  });

  it("carries the diminishing-returns wording at amber", () => {
    expect(workerHint("amber", 12, 8, 16)).toContain("diminishing returns");
  });

  it("is reassuring at normal", () => {
    expect(workerHint("normal", 8, 8, 8)).toContain("comfortably parallel");
  });
});

describe("workerPresets", () => {
  it("keeps 4/8/16 under safe-max and caps at MAX-safe", () => {
    const presets = workerPresets(16);
    expect(presets.map((p) => p.value)).toEqual([4, 8, 16]);
    expect(presets.at(-1)?.label).toBe("MAX-safe (16)");
  });

  it("drops base presets at or above safe-max", () => {
    const presets = workerPresets(4);
    expect(presets.map((p) => p.value)).toEqual([4]);
    expect(presets[0]?.label).toBe("MAX-safe (4)");
  });
});
