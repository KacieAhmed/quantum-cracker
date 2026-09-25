/**
 * Raw private-key proof UI: panel entry toggle, proof card (match), and the
 * honest no-match card. Asserted against react-dom/server output — no DOM
 * environment needed, same convention as the discovery/input-hygiene tests.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { emptyRunUiState } from "../reducer";
import type { RawKeyProofInfo, RunReport } from "../types";
import { CustomWalletPanel, RawKeyEntry } from "./CustomWalletPanel";
import { ResultPanel } from "./ResultPanel";

// k = 1 derives to the generator point — the fixture-verse values.
const PROOF: RawKeyProofInfo = {
  inputForm: "wif",
  inputWif: "KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn",
  wifCompressed: "KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn",
  wifUncompressed: "5HpHagT65TZzG1PH3CSu63k8DbpvD8s5ip4nEB3kEsreAnchuDf",
  privateKeyHex:
    "0000000000000000000000000000000000000000000000000000000000000001",
  pubkeyCompressedHex:
    "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  pubkeyUncompressedHex:
    "0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8",
  addressP2pkhCompressed: "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
  addressP2pkhUncompressed: "1EHNa6P4AAaDEoRCvJ4m1jWWtLxE5vCjyS",
  addressEth: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
  expectedAddress: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
  matchedPath: "eth",
};

function proofReport(overrides: Partial<RunReport> = {}): RunReport {
  return {
    runId: "proof-1",
    status: "proven",
    chain: "bitcoin",
    mode: "classic",
    address: "",
    workersRequested: 0,
    lanes: [],
    totalCandidates: 0,
    rawCandidates: 0,
    startedAt: "2026-09-25T00:00:00.000Z",
    finishedAt: "2026-09-25T00:00:00.000Z",
    elapsedMs: 0,
    aggregate: {
      derived: 0,
      derivedPerSec: 0,
      fractionOfKeyspace: 0,
      etaSeconds: null,
      matches: 1,
    },
    match: null,
    searchKind: "proof",
    rawKeyProof: PROOF,
    ...overrides,
  } as RunReport;
}

function renderReport(report: RunReport): string {
  return renderToStaticMarkup(
    <ResultPanel ui={{ ...emptyRunUiState, report }} chain="bitcoin" />,
  );
}

describe("CustomWalletPanel — key entry toggle", () => {
  it("offers seed-phrase and private-key entry, phrase by default", () => {
    const html = renderToStaticMarkup(
      <CustomWalletPanel
        chain="bitcoin"
        onChain={() => undefined}
        mode="classic"
        disabled={false}
        estimatedRate={null}
        onDerived={() => undefined}
      />,
    );
    expect(html).toContain("Own-wallet key entry mode");
    expect(html).toContain("Seed phrase");
    expect(html).toContain("Private key");
    // Default is phrase entry: the seed-phrase textarea is present, the raw
    // key field is not.
    expect(html).toContain("Your BIP-39 seed phrase");
    expect(html).not.toContain("64-hex scalar or mainnet WIF");
  });

  it("renders the raw-key entry fields and the leaf-of-the-tree disclosure", () => {
    const html = renderToStaticMarkup(
      <RawKeyEntry
        privateKey=""
        expectedAddress=""
        disabled={false}
        onChange={() => undefined}
      />,
    );
    expect(html).toContain("64-hex scalar or mainnet WIF");
    expect(html).toContain("leaf of the derivation tree");
    expect(html).toContain("Nothing is searched and nothing is stored");
    expect(html).toContain("compared by exact match");
    // Paste hygiene: browsers must never rewrite pasted key material.
    // react-dom/server emits spellCheck lowercase but preserves camelCase on
    // the other rewrite props — normalize before matching, as the
    // input-hygiene test does.
    const lowered = html.toLowerCase();
    expect(lowered).toContain('spellcheck="false"');
    expect(lowered).toContain('autocapitalize="none"');
    expect(lowered).toContain('autocorrect="off"');
    expect(lowered).toContain('autocomplete="off"');
  });
});

describe("ResultPanel — raw private-key proof", () => {
  it("freezes and displays the full derivation chain with the match verdict", () => {
    const html = renderReport(proofReport());
    expect(html).toContain("Run frozen — derivation proof complete");
    expect(html).toContain("derivation proof");
    expect(html).toContain("PROVEN: this key genuinely derives");
    // Every intermediate: WIF as typed, raw hex, both pubkeys, all addresses.
    expect(html).toContain("entered key (WIF, as typed)");
    expect(html).toContain(PROOF.inputWif as string);
    expect(html).toContain(PROOF.privateKeyHex);
    expect(html).toContain(PROOF.pubkeyCompressedHex);
    expect(html).toContain(PROOF.pubkeyUncompressedHex);
    expect(html).toContain(PROOF.addressP2pkhCompressed);
    expect(html).toContain(PROOF.addressP2pkhUncompressed);
    expect(html).toContain(PROOF.addressEth);
    // External verification recipe, same treatment as the discovery card.
    expect(html).toContain("Verify externally (recommended)");
  });

  it("renders the honest no-match card with what the key derives to", () => {
    const noMatch = proofReport({
      rawKeyProof: {
        ...PROOF,
        expectedAddress: "1JaUQDVNRdhfNsVncGkXedaPSM5Gc54Hso",
        matchedPath: null,
      },
      aggregate: {
        derived: 0,
        derivedPerSec: 0,
        fractionOfKeyspace: 0,
        etaSeconds: null,
        matches: 0,
      },
    });
    const html = renderReport(noMatch);
    expect(html).toContain("Raw-key proof — no match");
    expect(html).toContain("no match — honest result");
    expect(html).toContain("does not derive 1JaUQDVNRdhfNsVncGkXedaPSM5Gc54Hso");
    expect(html).toContain(
      "The addresses above ARE the ones this key controls",
    );
    // A no-match is not a match: no freeze banner.
    expect(html).not.toContain("Run frozen — derivation proof complete");
    // But the full chain still renders — the user learns what the key does.
    expect(html).toContain(PROOF.addressEth);
  });

  it("renders nothing without a proof payload", () => {
    const html = renderReport(proofReport({ rawKeyProof: null }));
    expect(html).toBe("");
  });
});
