import { describe, expect, it } from "vitest";
import {
  BIP39_WORDLIST_SIZE,
  VARY_SLOTS_MAX,
  templateSpace,
  varySlotError,
} from "./keyspace.js";

describe("templateSpace", () => {
  it("scales the space with each varied prefix slot", () => {
    // One varied slot among the first eleven: 2048 prefixes, 2048² raw.
    expect(templateSpace([1])).toEqual({
      prefixes: 2048,
      rawAssemblies: 2048 ** 2,
      estimatedChecksumValid: 2048 * 128,
    });
    // Two prefix slots: 2048² prefixes, 2048³ raw, 2048²×128 valid.
    expect(templateSpace([0, 5])).toEqual({
      prefixes: 2048 ** 2,
      rawAssemblies: 2048 ** 3,
      estimatedChecksumValid: 2048 ** 2 * 128,
    });
  });

  it("folds the twelfth slot into the checksum sweep, not the prefix space", () => {
    // [1, 11]: one prefix slot (position 2) + the folded twelfth.
    expect(templateSpace([1, 11])).toEqual({
      prefixes: 2048,
      rawAssemblies: 2048 ** 2,
      estimatedChecksumValid: 2048 * 128,
    });
    // The twelfth alone: a single prefix, 2048 raw assemblies.
    expect(templateSpace([11])).toEqual({
      prefixes: 1,
      rawAssemblies: 2048,
      estimatedChecksumValid: 128,
    });
  });

  it("counts no space without marked slots", () => {
    expect(templateSpace([])).toEqual({
      prefixes: 1,
      rawAssemblies: BIP39_WORDLIST_SIZE,
      estimatedChecksumValid: 128,
    });
  });
});

describe("varySlotError", () => {
  const twelve = 12;

  it("allows marking and unmarking under the cap", () => {
    expect(varySlotError([], 3, twelve)).toBeNull();
    expect(varySlotError([3], 3, twelve)).toBeNull(); // unmark is always fine
  });

  it("rejects marking beyond the cap with the honest reason", () => {
    const marked = [0, 1, 2, 3];
    const err = varySlotError(marked, 4, twelve);
    expect(err).toContain(`at most ${VARY_SLOTS_MAX}`);
  });

  it("restricts varying to 12-word phrases", () => {
    expect(varySlotError([], 0, 24)).toContain("12-word");
    expect(varySlotError([], 0, 15)).toContain("12-word");
  });
});
