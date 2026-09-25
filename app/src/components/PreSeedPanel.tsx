/**
 * The pre-seed mode's config panel: no target inputs exist in this mode —
 * the Satoshi-era watchlist IS the target set. This panel explains the run
 * shape, shows the odds disclosure BEFORE start (consent to `probe` is
 * informed consent), and annotates the Bitcoin-only restriction when another
 * chain is selected.
 */

import { PRESEED_ODDS_NOTE } from "../preseed";
import type { Chain } from "../types";

export function PreSeedPanel({ chain, disabled }: { chain: Chain; disabled: boolean }) {
  const wrongChain = chain !== "bitcoin";
  return (
    <section className="card" aria-label="Pre-seed era lottery run shape">
      <div className="card-title-row">
        <h2>Pre-seed era lottery — how this run works</h2>
        <span className="level-badge amber">Bitcoin only</span>
      </div>
      <p className="note">
        One random-sampling lane draws raw secp256k1 private keys (scalars in
        [1, n)) uniformly at random, derives each key's public key, and checks
        membership in the bundled Satoshi-era P2PK watchlist — 102,813 public
        keys that were published on-chain in 2009–2010 pay-to-public-key
        outputs. There is no target address: nothing you type is searched
        for. The run draws at a disclosed budget and ends at the budget or
        when you stop it; a hit — a watchlist DISCOVERY, a key that was
        already public — freezes the run and shows the full key material.
      </p>
      <p className="note lottery-disclosure" role="note">
        {PRESEED_ODDS_NOTE}
      </p>
      {wrongChain && (
        <p className="note bad-note" role="alert">
          Pre-seed mode is Bitcoin-only — the Satoshi-era P2PK watchlist is
          Bitcoin chain data. Switch the chain toggle to Bitcoin to start.
        </p>
      )}
      {disabled && <p className="note muted">A run is active — controls are locked.</p>}
    </section>
  );
}
