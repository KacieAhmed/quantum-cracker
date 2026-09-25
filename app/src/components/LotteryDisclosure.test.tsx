/**
 * The lottery odds disclosure must read "1 in <denominator> per hour" —
 * lotteryOddsOneInPerHour() IS that denominator (≈6.7×10^31). A prior
 * revision inverted it into the raw probability (≈1.5×10^-32) and printed
 * the nonsense form "1 in 1.5×10^-32". Pin the rendered copy so the
 * inversion cannot come back on either lottery surface.
 *
 * Asserted against react-dom/server output, so no DOM environment is needed.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { lotteryOddsOneInPerHour } from "../keyspace";
import { sci } from "../grover";
import { LotteryDisclosure } from "./LotteryDisclosure";

function disclosureHtml(pinnedIsUserPhrase: boolean): string {
  return renderToStaticMarkup(
    <LotteryDisclosure pinnedIsUserPhrase={pinnedIsUserPhrase} />,
  );
}

describe("LotteryDisclosure", () => {
  it("discloses the one-in denominator per hour, not the raw probability", () => {
    // The component must render the "1 in X" denominator (≈6.75×10^31 →
    // sci() rounds to "6.8×10^31") — inverting it would print the raw
    // probability, the nonsense form "1 in 1.5×10^-32".
    const expected = `1 in ${sci(lotteryOddsOneInPerHour())} per hour`;
    expect(disclosureHtml(false)).toContain(expected);
    // Honest magnitude pin: the demo-rate figure stays in the 10^31 range.
    expect(disclosureHtml(false)).toMatch(/1 in 6\.\d×10\^31 per hour/);
  });

  it("never shows an inverted probability (< 1) as a one-in figure", () => {
    const html = disclosureHtml(true);
    expect(html).not.toMatch(/1 in [^p]*×10<sup>-\d+<\/sup>/);
  });

  it("labels the calibration pin as not random on both surfaces", () => {
    expect(disclosureHtml(false)).toContain("pinned");
    expect(disclosureHtml(true)).toContain("pinned — not random");
  });
});
