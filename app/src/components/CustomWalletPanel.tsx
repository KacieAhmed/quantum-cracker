import { useState } from "react";
import { ApiError, CHAINS, deriveAddresses } from "../api";
import type { Chain, DeriveResponse } from "../types";
import { Segmented } from "./Segmented";

interface CustomWalletPanelProps {
  chain: Chain;
  /** Shares App's single chain state with the header toggle — one source of truth. */
  onChain: (chain: Chain) => void;
  disabled: boolean;
  /** Lifted so App can build the /crack request. */
  onDerived: (mnemonic: string, passphrase: string, expectedAddress: string, derived: DeriveResponse | null) => void;
}

/** One chain's row in the preview grid; the active chain is the run target. */
function DeriveRow({
  label,
  isTarget,
  address,
  path,
}: {
  label: string;
  isTarget: boolean;
  address: string;
  path: string;
}) {
  return (
    <>
      <span className="kv-key">
        {label}
        {isTarget ? " → target" : ""}
      </span>
      <span className="kv-value mono">{address}</span>
      <span className="kv-key">derivation path</span>
      <span className="kv-value mono">{path}</span>
    </>
  );
}

/**
 * "Test with your own wallet": paste a BIP-39 mnemonic YOU own. The server
 * derives its addresses with the same engine code path it uses when testing
 * candidates and pins the derived address as the search target. A typed
 * address is only a cross-check — a freeform third-party address is never
 * accepted. Pasting your own phrase exposes nothing: you already hold it.
 */
export function CustomWalletPanel({
  chain,
  onChain,
  disabled,
  onDerived,
}: CustomWalletPanelProps) {
  const [mnemonic, setMnemonic] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [expectedAddress, setExpectedAddress] = useState("");
  const [derived, setDerived] = useState<DeriveResponse | null>(null);
  const [deriving, setDeriving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const derive = async (): Promise<void> => {
    setDeriving(true);
    setError(null);
    try {
      const result = await deriveAddresses(mnemonic.trim(), passphrase);
      setDerived(result);
      onDerived(mnemonic.trim(), passphrase, expectedAddress.trim(), result);
    } catch (err) {
      setDerived(null);
      onDerived(mnemonic.trim(), passphrase, expectedAddress.trim(), null);
      setError(
        err instanceof ApiError
          ? err.message
          : `derivation failed: ${String(err)}`,
      );
    } finally {
      setDeriving(false);
    }
  };

  return (
    <section className="card custom-wallet" aria-label="Test with your own wallet">
      <h2>Test with your own wallet</h2>
      <p className="note">
        Paste a seed phrase <strong>you own</strong> — the demo derives your
        wallet's address with the same code path it uses when testing
        candidates, then searches for that address. You already hold this seed,
        so pasting it here exposes nothing. A freeform third-party address is
        never used as a target; a typed address only cross-checks.
      </p>
      <div className="field">
        <span className="field-label">Chain to search</span>
        <Segmented
          options={CHAINS}
          value={chain}
          onSelect={onChain}
          disabled={disabled}
          ariaLabel="Chain to search for"
        />
      </div>
      <label className="field">
        <span className="field-label">Your BIP-39 seed phrase</span>
        <textarea
          className="address-input mono"
          rows={3}
          value={mnemonic}
          disabled={disabled}
          placeholder="twelve (or more) words, space-separated"
          onChange={(e) => {
            setMnemonic(e.target.value);
            setDerived(null);
          }}
        />
      </label>
      <label className="field">
        <span className="field-label">Passphrase (optional — empty is the wallet default)</span>
        <input
          className="address-input mono"
          type="password"
          value={passphrase}
          disabled={disabled}
          onChange={(e) => {
            setPassphrase(e.target.value);
            setDerived(null);
          }}
        />
      </label>
      <label className="field">
        <span className="field-label">Cross-check address (optional — must match the derivation)</span>
        <input
          className="address-input mono"
          value={expectedAddress}
          disabled={disabled}
          placeholder="the address your wallet app shows, to cross-check"
          onChange={(e) => setExpectedAddress(e.target.value)}
        />
      </label>
      <div className="start-row">
        <button
          type="button"
          className="btn"
          disabled={disabled || deriving || mnemonic.trim() === ""}
          onClick={derive}
        >
          {deriving ? "Deriving…" : "Derive my addresses"}
        </button>
      </div>
      {error !== null && <p className="verdict bad">{error}</p>}
      {derived !== null && (
        <div className="derive-preview">
          <div className="kv">
            <DeriveRow
              label="derived Ethereum address"
              isTarget={chain === "ethereum"}
              address={derived.addresses.eth}
              path={derived.paths.eth}
            />
            <DeriveRow
              label="derived Bitcoin P2PKH address"
              isTarget={chain === "bitcoin"}
              address={derived.addresses.btc_p2pkh}
              path={derived.paths.btc_p2pkh}
            />
          </div>
          {derived.poolMembership.inSpace ? (
            <p className="verdict ok">
              ✓ This phrase is inside the bounded pooled demo keyspace — the run
              can genuinely recover it.
            </p>
          ) : (
            <p className="verdict bad">
              ⚠ This wallet's address is OUTSIDE the bounded pooled demo
              keyspace — the run will stay bounded and end exhausted without a
              match. That is the honest demonstration of keyspace scale, not a
              failure of your wallet.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
