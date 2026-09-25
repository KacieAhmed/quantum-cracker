import type { CorpusDoc, TargetVerdict } from "../types";

interface AddressPanelProps {
  address: string;
  onAddress: (address: string) => void;
  verdict: TargetVerdict | null;
  /** True between keystroke and the debounced engine check. */
  checking: boolean;
  corpus: CorpusDoc | null;
  corpusError: string | null;
  onDemoWallet: () => void;
  disabled: boolean;
}

export function AddressPanel({
  address,
  onAddress,
  verdict,
  checking,
  corpus,
  corpusError,
  onDemoWallet,
  disabled,
}: AddressPanelProps) {
  const valid = verdict?.valid === true;
  return (
    <section className="card" aria-label="Target address">
      <div className="card-title-row">
        <h2>Target address</h2>
        <button
          type="button"
          className="btn subtle"
          onClick={onDemoWallet}
          disabled={disabled || corpusError !== null}
        >
          Try a demo wallet
        </button>
      </div>
      <input
        className={`address-input${verdict ? (valid ? " valid" : " invalid") : ""}`}
        type="text"
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="off"
        placeholder={
          "0x… or 1… / bc1… — a corpus address (demo wallets only)"
        }
        value={address}
        onChange={(e) => onAddress(e.target.value)}
        disabled={disabled}
        aria-label="Wallet address to search for"
      />
      <p className={`verdict ${checking ? "pending" : valid ? "ok" : "bad"}`} role="status">
        {checking
          ? "checking with the engine…"
          : verdict === null
            ? "awaiting an address"
            : verdict.valid
              ? `✓ valid ${verdict.kind ?? "address"}${verdict.normalized && verdict.normalized !== verdict.target ? ` — normalized: ${verdict.normalized}` : ""}`
              : `✗ ${verdict.error ?? "not a valid address"}`}
      </p>
      {corpusError !== null ? (
        <p className="note bad-note">demo corpus unavailable: {corpusError}</p>
      ) : (
        corpus !== null && (
          <p className="note">
            {corpus.wallets.length} bundled demo wallets · searchable space:{" "}
            {corpus.space.total_prefixes.toLocaleString("en-US")} checksum-valid
            prefixes ({corpus.space.raw_candidates.toLocaleString("en-US")} raw
            assemblies). Addresses outside this corpus can never match.
          </p>
        )
      )}
    </section>
  );
}
