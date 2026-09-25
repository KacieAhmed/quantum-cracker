/**
 * The pre-seed disclosure must read "1 in <denominator> per hour" with the
 * denominator COMPUTED from the measured rate and the watchlist count — and
 * the phrase-lottery comparison ratio must be computed, never asserted as a
 * round power of ten. Pins the rendered copy and the math helpers.
 *
 * Asserted against react-dom/server output, so no DOM environment is needed.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { sci } from "../grover";
import { lotteryOddsOneInPerHour } from "../keyspace";
import {
  PRESEED_DRAWS_PER_SEC,
  PRESEED_ODDS_NOTE,
  PRESEED_TARGET_COUNT,
  preseedOddsOneInPerHour,
} from "../preseed";
import { PreSeedPanel } from "./PreSeedPanel";

describe("preseed odds math", () => {
  it("computes the one-in denominator as rate·3600·targets / n", () => {
    // Independent recomputation at the disclosed rate: 110000·3600·102813 /
    // n(log10 77.0637) ≈ 2.8×10^63. A regression that divides the wrong way
    // prints a sub-1 "probability" instead of a one-in denominator.
    const oneIn = preseedOddsOneInPerHour();
    const expectedLog10 = 77.0637 - Math.log10(PRESEED_DRAWS_PER_SEC * 3_600 * PRESEED_TARGET_COUNT);
    expect(oneIn).toBeGreaterThan(10 ** (expectedLog10 - 1e-9));
    expect(oneIn).toBeLessThan(10 ** (expectedLog10 + 1e-9));
    expect(sci(oneIn)).toMatch(/^2\.\d×10\^63$/);
  });

  it("stays dozens of orders beyond the phrase lottery per hour", () => {
    const ratio = preseedOddsOneInPerHour() / lotteryOddsOneInPerHour();
    // Honest magnitude pin: ~4×10^31 — the direction's rough 10^33 was a
    // per-draw figure; per hour at each mode's disclosed rate it is this.
    expect(ratio).toBeGreaterThan(1e30);
    expect(ratio).toBeLessThan(1e33);
  });
});

describe("PRESEED_ODDS_NOTE", () => {
  it("discloses the space, target count, Patoshi subset, and computed odds", () => {
    expect(PRESEED_ODDS_NOTE).toContain("102,813");
    expect(PRESEED_ODDS_NOTE).toContain("21,953");
    expect(PRESEED_ODDS_NOTE).toContain(`1 in ${sci(preseedOddsOneInPerHour())} per hour`);
    expect(PRESEED_ODDS_NOTE).toContain("2^256");
  });

  it("carries the computed phrase-lottery comparison and no coverage claim", () => {
    const ratio = preseedOddsOneInPerHour() / lotteryOddsOneInPerHour();
    expect(PRESEED_ODDS_NOTE).toContain(`roughly ${sci(ratio)} times more remote per hour`);
    expect(PRESEED_ODDS_NOTE).toContain("never claims exhaustive coverage");
    expect(PRESEED_ODDS_NOTE).toContain("no user target");
  });

  it("never shows an inverted probability (< 1) as a one-in figure", () => {
    expect(PRESEED_ODDS_NOTE).not.toMatch(/1 in [^p]*×10\^-/);
  });
});

describe("PreSeedPanel", () => {
  it("discloses the run shape and odds before start", () => {
    const html = renderToStaticMarkup(<PreSeedPanel chain="bitcoin" disabled={false} />);
    expect(html).toContain("no target address");
    expect(html).toContain(PRESEED_ODDS_NOTE);
    expect(html).toContain("Bitcoin only");
  });

  it("annotates the Bitcoin-only restriction on another chain", () => {
    const html = renderToStaticMarkup(<PreSeedPanel chain="ethereum" disabled={false} />);
    expect(html).toContain("Pre-seed mode is Bitcoin-only");
    expect(html).toContain("Switch the chain toggle to Bitcoin");
  });
});
