import { useState } from "react";
import { ApiError, CHAINS, deriveAddresses } from "../api";
import { etaSeconds } from "../estimate";
import { formatCount, formatDuration, formatRate } from "../format";
import { templateSpace, varySlotError } from "../keyspace";
import type { Chain, DeriveResponse, Mode } from "../types";
import { Segmented } from "./Segmented";
import { LotteryDisclosure } from "./LotteryDisclosure";

/** Everything the panel reports up to App, which owns the /crack request. */
export interface CustomWalletSelection {
  /** Which entry the run sends: a seed phrase, or the raw key itself. */
  entryMode: "phrase" | "raw";
  mnemonic: string;
  /** Raw private key (64-hex scalar or mainnet WIF) — raw mode only. */
  privateKey: string;
  passphrase: string;
  expectedAddress: string;
  derived: DeriveResponse | null;
  /** 0-based positions varied over the full BIP-39 list (classical mode). */
  varySlots: number[];
}

/** Entry-mode options: seed-phrase entry, or raw private-key entry. */
const ENTRY_MODES: readonly ("phrase" | "raw")[] = [
  "phrase",
  "raw",
] as const;

interface CustomWalletPanelProps {
  chain: Chain;
  /** Shares App's single chain state with the header toggle — one source of truth. */
  onChain: (chain: Chain) => void;
  /** The search mode: quantum runs the lottery only (no marked-slot sweep). */
  mode: Mode;
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
 * Raw private-key entry (pre-BIP-39 wallets): paste a key YOU already hold —
 * a 64-hex scalar or a mainnet WIF. Nothing is derived client-side; the run
 * computes the full chain server-side and freezes the proof. A raw key IS
 * the derivation leaf, so this flow never searches — it proves.
 */
export function RawKeyEntry({
  privateKey,
  expectedAddress,
  disabled,
  onChange,
}: {
  privateKey: string;
  expectedAddress: string;
  disabled: boolean;
  onChange: (privateKey: string, expectedAddress: string) => void;
}) {
  return (
    <>
      <label className="field">
        <span className="field-label">
          Your private key (64-hex scalar or mainnet WIF)
        </span>
        <textarea
          className="address-input mono"
          rows={2}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          value={privateKey}
          disabled={disabled}
          placeholder="0x-prefixed 64-hex scalar, or a K/L (compressed) / 5 (uncompressed) WIF"
          onChange={(e) => onChange(e.target.value, expectedAddress)}
        />
      </label>
      <label className="field">
        <span className="field-label">
          Expected address (optional — compared by exact match)
        </span>
        <input
          className="address-input mono"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          value={expectedAddress}
          disabled={disabled}
          placeholder="the address your wallet app shows"
          onChange={(e) => onChange(privateKey, e.target.value)}
        />
      </label>
      <p className="note">
        A raw private key is the <strong>leaf of the derivation tree</strong> —
        no seed phrase and no BIP-32 path applies. The run derives this key's
        Bitcoin legacy P2PKH addresses (from both the compressed and
        uncompressed public keys) and its Ethereum address with the same
        engine code path the searches run per candidate, then freezes the
        proof. Nothing is searched and nothing is stored — and if you supply
        an expected address, a no-match is shown honestly, never rounded up.
        If your wallet displays an address this proof does not produce, the
        key you entered is not the key your wallet uses.
      </p>
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
  mode,
  disabled,
  estimatedRate,
  onDerived,
}: CustomWalletPanelProps) {
  const [entryMode, setEntryMode] = useState<"phrase" | "raw">("phrase");
  const [mnemonic, setMnemonic] = useState("");
  const [privateKey, setPrivateKey] = useState("");
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
        entryMode: "phrase",
        mnemonic: mnemonic.trim(),
        privateKey: "",
        passphrase,
        expectedAddress: expectedAddress.trim(),
        derived: result,
        varySlots: nextSlots,
      });
    } catch (err) {
      setDerived(null);
      setVarySlots([]);
      onDerived({
        entryMode: "phrase",
        mnemonic: mnemonic.trim(),
        privateKey: "",
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
        entryMode: "phrase",
        mnemonic: mnemonic.trim(),
        privateKey: "",
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
      <div className="field">
        <span className="field-label">Key entry</span>
        <Segmented
          options={ENTRY_MODES}
          value={entryMode}
          onSelect={(mode) => {
            setEntryMode(mode);
            setDerived(null);
            setVarySlots([]);
          }}
          disabled={disabled}
          ariaLabel="Own-wallet key entry mode"
        />
      </div>
      {entryMode === "raw" ? (
        <RawKeyEntry
          privateKey={privateKey}
          expectedAddress={expectedAddress}
          disabled={disabled}
          onChange={(key, expected) => {
            setPrivateKey(key);
            onDerived({
              entryMode: "raw",
              mnemonic: "",
              privateKey: key.trim(),
              passphrase: "",
              expectedAddress: expected.trim(),
              derived: null,
              varySlots: [],
            });
          }}
        />
      ) : (
      <>
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
          {canVary && mode === "classic" ? (
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
          ) : canVary && mode === "quantum" ? (
            <p className="note">
              Quantum mode runs the full-space lottery with every word random
              — the odds and the honest Grover math are in the quantum panel
              below. Marked-slot sweeping is classical-only: switch to Classic
              mode to vary slots over the full wordlist.
            </p>
          ) : (
            <p className="note">
              Marked-slot sweeping supports 12-word phrases; this phrase has{" "}
              {words.length} words. The lottery below samples 12-word phrases,
              so it cannot genuinely derive this address — for it, a run is a
              demonstration of scale only.
            </p>
          )}
          {canVary && mode === "classic" && (
            <LotteryDisclosure pinnedIsUserPhrase />
          )}
          {canVary && mode === "classic" && (
            <p className="note">
              Marking 1–2 slots (above) is the maximum-likelihood
              configuration and the only one that can guarantee finding
              your own phrase: 1 marked slot ≈ 2,048 candidates (seconds);
              2 slots ≈ 4.2 million (~50 minutes at ~1,400 draws/s). Every
              freed word shrinks the per-hour odds.
            </p>
          )}
          {derived !== null && (
            <p className="note muted">
              Pool membership (informational):{" "}
              {derived.poolMembership.inSpace ? "inside" : "outside"} the
              bounded pooled demo keyspace — the lottery and marked-slot
              searches do not depend on it.
            </p>
          )}
        </div>
      )}
      </>
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
