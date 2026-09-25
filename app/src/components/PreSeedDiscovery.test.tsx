/**
 * The pre-seed discovery card must read as a DISCOVERY — a watchlisted key
 * that was already public — and never as a recovery of a user target (there
 * is no user target in this mode). It must freeze-and-display the full key
 * material, and upgrade its label when the derived address is also on the
 * rich-address watchlist. Asserted against react-dom/server output.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { emptyRunUiState } from "../reducer";
import type { PreSeedDiscoveryInfo, RunReport } from "../types";
import { ResultPanel } from "./ResultPanel";

const DISCOVERY: PreSeedDiscoveryInfo = {
  privateKeyHex: "0000000000000000000000000000000000000000000000000000000000000001",
  wif: "KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn",
  pubkeyCompressedHex:
    "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  pubkeyUncompressedHex:
    "0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8",
  matchedWatchlistKey:
    "0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8",
  p2pkhCompressed: "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
  p2pkhUncompressed: "1EHNa6P4xnJ8CdwfccaKchjbpfZuQuTsWt",
  richWatchlistHit: false,
};

function preseedReport(overrides: Partial<RunReport>): RunReport {
  return {
    runId: "run_preseed_test",
    status: "matched",
    chain: "bitcoin",
    mode: "preseed",
    address: "",
    workersRequested: 1,
    lanes: [],
    totalCandidates: 0,
    rawCandidates: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    elapsedMs: 1200,
    aggregate: null,
    match: DISCOVERY,
    preseedDiscovery: DISCOVERY,
    ...overrides,
  } as RunReport;
}

function renderReport(report: RunReport): string {
  return renderToStaticMarkup(
    <ResultPanel ui={{ ...emptyRunUiState, report }} chain="bitcoin" />,
  );
}

describe("ResultPanel — pre-seed discovery", () => {
  it("freezes and displays the full key material with the discovery label", () => {
    const html = renderReport(preseedReport({}));
    expect(html).toContain("Run frozen — stopped on a watchlist discovery");
    expect(html).toContain("discovery — not a recovery");
    expect(html).toContain(DISCOVERY.privateKeyHex);
    expect(html).toContain(DISCOVERY.wif);
    expect(html).toContain(DISCOVERY.pubkeyCompressedHex);
    expect(html).toContain(DISCOVERY.pubkeyUncompressedHex);
    expect(html).toContain(DISCOVERY.matchedWatchlistKey);
    expect(html).toContain(DISCOVERY.p2pkhCompressed);
    expect(html).toContain(DISCOVERY.p2pkhUncompressed);
    // Never presented as a recovery of a target.
    expect(html).not.toContain("recovered seed phrase");
    expect(html).not.toContain("target address (what the run searched for)");
  });

  it("upgrades the label when the address is also rich-listed", () => {
    const html = renderReport(
      preseedReport({ match: { ...DISCOVERY, richWatchlistHit: true } }),
    );
    expect(html).toContain("Upgraded label");
    expect(html).toContain("ALSO on the rich-address watchlist");
  });

  it("renders no plain match card without a discovery payload", () => {
    const html = renderReport(preseedReport({ match: null, preseedDiscovery: null }));
    expect(html).not.toContain("Run frozen");
  });

  it("states the budget end is not an exhausted search, in preseed terms", () => {
    const html = renderReport(
      preseedReport({
        status: "budget-reached",
        match: null,
        preseedDiscovery: null,
        totalCandidates: 1_100_000,
        aggregate: {
          derived: 1_100_000,
          derivedPerSec: 112_000,
          fractionOfKeyspace: 0,
          etaSeconds: null,
          matches: 0,
        },
      }),
    );
    expect(html).toContain("the draw budget is spent");
    expect(html).toContain("not an exhausted search");
    expect(html).toContain("1.16×10^77");
    // The phrase-lottery budget sentence must NOT render for a pre-seed run;
    // the scope note footer legitimately still mentions 2^128, so pin the
    // sentence, not the bare power.
    expect(html).not.toContain("sweeping 2^128 phrases");
  });
});
