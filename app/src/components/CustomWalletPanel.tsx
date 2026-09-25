import { useState } from "react";
import { ApiError, CHAINS, deriveAddresses } from "../api";
import { etaSeconds } from "../estimate";
import { formatCount, formatDuration, formatRate } from "../format";
import { templateSpace, varySlotError } from "../keyspace";
import type { Chain, DeriveResponse } from "../types";
import { Segmented } from "./Segmented";

/** Everything the panel reports up to App, which owns the /crack request. */
export interface CustomWalletSelection {
  mnemonic: string;
  passphrase: string;
  expectedAddress: string;
  derived: DeriveResponse | null;
  /** 0-based positions varied over the full BIP-39 list (classical mode). */
  varySlots: number[];
}

interface CustomWalletPanelProps {
  chain: Chain;
  /** Shares App's single chain state with the header toggle — one source of truth. */
  onChain: (chain: Chain) => void;
  disabled: boolean;
  /** Pre-run estimate for the current worker setting (app-wide). */
  estimatedRate: number | null;
  /** Lifted so App can build the /crack request. */
  onDerived: (selection: CustomWalletSelection) => void;
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
 *
 * The limited-keyspace extension lets the user mark words the run may vary
 * over the full 2,048-word BIP-39 list; her other words stay fixed, so the
 * disclosed space still contains the true phrase by construction.
 */
export function CustomWalletPanel({
  chain,
  onChain,
  disabled,
  estimatedRate,
  onDerived,
}: CustomWalletPanelProps) {
  const [mnemonic, setMnemonic] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [expectedAddress, setExpectedAddress] = useState("");
  const [derived, setDerived] = useState<DeriveResponse | null>(null);
  const [varySlots, setVarySlots] = useState<number[]>([]);
  const [deriving, setDeriving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slotError, setSlotError] = useState<string | null>(null);

  const derive = async (): Promise<void> => {
    setDeriving(true);
    setError(null);
    try {
      const result = await deriveAddresses(mnemonic.trim(), passphrase);
      setDerived(result);
      const nextSlots = varySlots.filter((slot) => slot < wordCountOf(result));
      setVarySlots(nextSlots);
      onDerived({
        mnemonic: mnemonic.trim(),
        passphrase,
        expectedAddress: expectedAddress.trim(),
        derived: result,
        varySlots: nextSlots,
      });
    } catch (err) {
      setDerived(null);
      setVarySlots([]);
      onDerived({
        mnemonic: mnemonic.trim(),
        passphrase,
        expectedAddress: expectedAddress.trim(),
        derived: null,
        varySlots: [],
      });
      setError(
        err instanceof ApiError
          ? err.message
          : `derivation failed: ${String(err)}`,
      );
    } finally {
      setDeriving(false);
    }
  };

  const toggleSlot = (index: number): void => {
    setSlotError(null);
    const count = wordCountOf(derived);
    const err = varySlotError(varySlots, index, count);
    if (err !== null && !varySlots.includes(index)) {
      setSlotError(err);
      return;
    }
    const next = varySlots.includes(index)
      ? varySlots.filter((slot) => slot !== index)
      : [...varySlots, index];
    setVarySlots(next);
    if (derived !== null) {
      onDerived({
        mnemonic: mnemonic.trim(),
        passphrase,
        expectedAddress: expectedAddress.trim(),
        derived,
        varySlots: next,
      });
    }
  };

  const words = derived === null ? [] : wordArrayOf(derived);
  const canVary = words.length === 12;
  const space = templateSpace(varySlots);
  const eta =
    varySlots.length > 0 && estimatedRate !== null
      ? etaSeconds(space.estimatedChecksumValid, 0, estimatedRate)
      : null;

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
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          value={mnemonic}
          disabled={disabled}
          placeholder="twelve (or more) words, space-separated"
          onChange={(e) => {
            setMnemonic(e.target.value);
            setDerived(null);
            setVarySlots([]);
          }}
        />
      </label>
      <label className="field">
        <span className="field-label">Passphrase (optional — empty is the wallet default)</span>
        <input
          className="address-input mono"
          type="password"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
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
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
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
          <p className="note">
            Both addresses come from the <strong>same phrase</strong> — one
            12-word phrase deterministically derives every chain (ETH at
            m/44'/60'/0'/0/0, BTC P2PKH at m/44'/0'/0'/0/0). The run targets
            the row marked “→ target”.
          </p>
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
          {canVary ? (
            <>
              <p className="note">
                Optional — mark words the run may <strong>vary over the full
                2,048-word BIP-39 list</strong> (below). Marking is the only
                configuration that can <strong>guarantee</strong> finding your
                own phrase: the sweep then contains it by construction, and
                every freed word shrinks the odds. With nothing marked, a run
                is the full-space lottery described underneath.
              </p>
              <div className="vary-chips" role="group" aria-label="Words the run may vary">
                {words.map((word, index) => {
                  const marked = varySlots.includes(index);
                  return (
                    <button
                      key={`${word}-${index}`}
                      type="button"
                      className={marked ? "vary-chip marked" : "vary-chip"}
                      aria-pressed={marked}
                      disabled={disabled}
                      title={
                        marked
                          ? `Position ${index + 1} varies over the full wordlist — click to keep it fixed`
                          : `Click to vary position ${index + 1} over the full wordlist`
                      }
                      onClick={() => toggleSlot(index)}
                    >
                      <span className="chip-index">{index + 1}</span> {word}
                    </button>
                  );
                })}
              </div>
              {slotError !== null && <p className="verdict bad">{slotError}</p>}
              {varySlots.length > 0 ? (
                <div className="keyspace-disclosure">
                  <p className="verdict ok">
                    ✓ Disclosed limited keyspace: {formatCount(space.rawAssemblies)}{" "}
                    raw assemblies (~{formatCount(space.estimatedChecksumValid)}{" "}
                    checksum-valid candidates). Your true phrase is inside this
                    space by construction — a genuine match is reachable, and a
                    full sweep visits every candidate exactly once in random
                    order.
                  </p>
                  <p className="note">
                    Estimated full sweep at the current worker setting:{" "}
                    {eta === null ? "—" : formatDuration(eta)}
                    {estimatedRate !== null ? ` (${formatRate(estimatedRate)})` : ""}.
                    The run response reports the same math before it starts.
                  </p>
                </div>
              ) : (
                <p className="note">
                  No words marked — pressing Start runs the full-space lottery
                  (odds below), not a bounded sweep.
                </p>
              )}
            </>
          ) : (
            <p className="note">
              Marked-slot sweeping supports 12-word phrases; this phrase has{" "}
              {words.length} words. The lottery below samples 12-word phrases,
              so it cannot genuinely derive this address — for it, a run is a
              demonstration of scale only.
            </p>
          )}
          {canVary && (
            <div className="keyspace-disclosure">
              <p className="verdict ok">
                ✓ Full-space lottery (the default run): every draw picks all 12
                words uniformly at random and keeps only checksum-valid
                phrases — 2^128 ≈ 3.4×10^38 valid phrases (2048^12 ≈
                5.4×10^39 raw assemblies before checksum filtering). At
                ~1,400 draws/s the odds of your exact phrase are about 1 in
                6.7×10^31 per hour — the expected wait is ~10^28 years, many
                times the age of the universe. That is the honest
                demonstration of why real wallets are safe.
              </p>
              <p className="note">
                Your phrase is pinned as the first candidate, labeled “pinned —
                not random”, before any sampling starts — a reproducible
                benchmark anchor. If it genuinely derives your address, the run
                reports a real match at candidate #1 and ends — that is correct
                behavior, not a bug.
              </p>
              <p className="note">
                Marking 1–2 slots (above) is the maximum-likelihood
                configuration and the only one that can guarantee finding your
                own phrase: 1 marked slot ≈ 2,048 candidates (seconds); 2 slots
                ≈ 4.2 million (~50 minutes at ~1,400 draws/s). Every freed word
                shrinks the per-hour odds.
              </p>
              <p className="note muted">
                Pool membership (informational):{" "}
                {derived.poolMembership.inSpace ? "inside" : "outside"} the
                bounded pooled demo keyspace — the lottery and marked-slot
                searches do not depend on it.
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function wordArrayOf(derived: DeriveResponse): string[] {
  return derived.mnemonic.trim().split(/\s+/);
}

function wordCountOf(derived: DeriveResponse | null): number {
  return derived === null ? 0 : wordArrayOf(derived).length;
}
