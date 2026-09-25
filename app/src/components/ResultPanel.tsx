import { formatCount, formatDuration, formatRate } from "../format";
import type { RunUiState } from "../reducer";
import type { Chain, MatchInfo, PreSeedDiscoveryInfo, RunReport } from "../types";
import { isPreseedMatch } from "../types";
import { Infeasibility } from "./Infeasibility";

interface ResultPanelProps {
  ui: RunUiState;
  chain: Chain;
}

function featuredAddresses(match: MatchInfo, chain: Chain): Array<{ label: string; value: string }> {
  return chain === "ethereum"
    ? [{ label: "Ethereum", value: match.allAddresses.eth }]
    : [
        { label: "Bitcoin P2PKH", value: match.allAddresses.btc_p2pkh },
        { label: "Bitcoin bech32", value: match.allAddresses.btc_bech32 },
      ];
}

function FragmentRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="kv-key">{label}</span>
      <span className="kv-value mono">{value}</span>
    </>
  );
}

function MatchCard({
  match,
  workerId,
  target,
  chain,
  customWallet,
}: {
  match: MatchInfo;
  workerId: number | null;
  target: string;
  chain: Chain;
  customWallet: RunReport["customWallet"];
}) {
  const verified = featuredAddresses(match, chain).some(
    (a) => a.value.toLowerCase() === target.toLowerCase(),
  );
  const derivationPath = match.derivationPath ?? match.path;
  // A discovery derives a WATCHLIST address, not the requested target. It is
  // a genuine derivation (the run stops for it) but must never be presented
  // as recovery of the address the run was pointed at.
  const discovery = match.discovery === true && !verified;
  return (
    <section
      className="card result matched"
      aria-label={discovery ? "Discovery — watchlist address derived" : "Match found"}
    >
      {/* Freeze UX: the engine stopped drawing the moment this matched — the
          run is frozen, the live feed has gone quiet, and the phrase below is
          the one thing to read. Applies to requested-target matches and
          watchlist discoveries alike: the run stops for both. */}
      <div className="match-banner" role="status">
        <h2>❄ Run frozen — {discovery ? "stopped on a watchlist discovery" : "seed phrase recovered"}</h2>
        <span className="match-sub">
          engine stopped drawing · live feed quiet · phrase and proof below
        </span>
      </div>
      {discovery ? (
        <>
          <div className="card-title-row">
            <h2>◉ Discovery — a watchlist address, NOT your requested target</h2>
            <span className="level-badge amber">discovery — not a recovery</span>
          </div>
          <p className="note">
            This phrase genuinely derives an address on the run's discovery
            watchlist, so the run stopped to show it — but it does{" "}
            <strong>not</strong> derive the address you asked about. The
            requested target remains unrecovered; the honest odds disclosure
            still applies to it.
          </p>
        </>
      ) : (
        <>
          <h2>
            ✓ Match found — valid seed phrase
            {workerId !== null && <span className="result-sub"> (lane {workerId})</span>}
          </h2>
          <p className="note">
            This is the ONLY valid seed phrase in this run. Every phrase in the
            "Recently tested" list was tested and failed; this one is the proof.
          </p>
        </>
      )}
      <div className="proof-grid">
        <div className="proof-cell recovered">
          <span className="proof-label">
            {discovery ? "recovered phrase (derives the watchlist address)" : "recovered seed phrase"}
          </span>
          <span className="kv-value mono match-phrase">{match.mnemonic}</span>
        </div>
        <div className="proof-cell">
          <span className="proof-label">address derived from it (path {derivationPath})</span>
          <span className="kv-value mono">
            {chain === "ethereum" ? match.allAddresses.eth : match.allAddresses.btc_p2pkh}
          </span>
        </div>
        <div className="proof-cell">
          <span className="proof-label">
            {discovery ? "requested target (NOT derived by this phrase)" : "target address (what the run searched for)"}
          </span>
          <span className="kv-value mono">{target}</span>
        </div>
      </div>
      <div className="kv">
        <span className="kv-key">derivation path the engine walked</span>
        <span className="kv-value mono">{derivationPath}</span>
        {featuredAddresses(match, chain).map((a) => (
          <FragmentRow key={a.label} label={`${a.label} (all paths)`} value={a.value} />
        ))}
      </div>
      {discovery ? (
        <p className="verdict ok proof-verdict">
          ✓ Derivation equality holds against the WATCHLIST address shown above,
          not the requested target — a match is claimed exactly when a tested
          phrase derives an address, and this one is labeled accordingly.
        </p>
      ) : verified ? (
        <p className="verdict ok proof-verdict">
          ✓ PROVEN: the address derived from the recovered phrase at{" "}
          {derivationPath} equals the target address — that equality is the
          proof, not a heuristic.
        </p>
      ) : (
        <p className="verdict bad proof-verdict">
          ⚠ derived addresses recorded — target comparison inconclusive, inspect
          the run report.
        </p>
      )}
      {customWallet !== null && customWallet !== undefined && (
        <p className="verdict ok">
          Self-referential verification: this run's target was YOUR wallet — the
          address derived from the seed phrase you pasted (cross-check{" "}
          {customWallet.crossCheckUsed ? "supplied and matched" : "not supplied"}).
          You already hold that seed, so nothing was exposed by testing it.
        </p>
      )}
      <div className="verify-recipe">
        <h3>Verify externally (recommended)</h3>
        <ol>
          <li>
            Copy the recovered seed phrase above into any standard open-source
            BIP-39 derivation tool (e.g. the well-known iancoleman.io/bip39
            tool, run offline) — you can also do this with your own wallet
            software.
          </li>
          <li>
            Set the derivation path to exactly{" "}
            <code className="mono">{derivationPath}</code> — the path the engine
            actually used for this match
            {chain === "ethereum" ? "" : " (or m/44'/0'/0'/0/0 for the P2PKH address shown)"}.
          </li>
          <li>
            Confirm the tool's{" "}
            {chain === "ethereum" ? "Ethereum" : "Bitcoin P2PKH"} address equals
            the target address above. If it does, the match is real — the same
            derivation any wallet performs.
          </li>
        </ol>
      </div>
      <Infeasibility />
    </section>
  );
}

/**
 * Pre-seed discovery: the run stopped on a private key whose public key is on
 * the bundled Satoshi-era watchlist. There is NO user target — this is a
 * discovery of already-public chain data, never a recovery. The full key
 * material is frozen and shown so the derivation can be verified externally.
 */
function PreSeedDiscoveryCard({ discovery }: { discovery: PreSeedDiscoveryInfo }) {
  return (
    <section className="card result matched" aria-label="Discovery — watchlisted key found">
      {/* Freeze UX: the engine stopped drawing the moment the derived pubkey
          hit the watchlist — the run is frozen and the key material below is
          the one thing to read. Same treatment as a seed-phrase match. */}
      <div className="match-banner" role="status">
        <h2>❄ Run frozen — stopped on a watchlist discovery</h2>
        <span className="match-sub">
          engine stopped drawing · live feed quiet · key material and proof below
        </span>
      </div>
      <div className="card-title-row">
        <h2>◉ Discovery — a Satoshi-era watchlisted key, NOT a user target</h2>
        <span className="level-badge amber">discovery — not a recovery</span>
      </div>
      <p className="note">
        This randomly drawn private key genuinely derives a public key on the
        run's Satoshi-era P2PK watchlist, so the run stopped to show it. That
        key was already public on the chain — it appears in a 2009–2010
        pay-to-public-key output — and no address was ever "recovered": the
        pre-seed lottery has no user target at all.
      </p>
      <div className="proof-grid">
        <div className="proof-cell recovered">
          <span className="proof-label">discovered private key (64-hex)</span>
          <span className="kv-value mono match-phrase">{discovery.privateKeyHex}</span>
        </div>
        <div className="proof-cell">
          <span className="proof-label">same key, wallet-import format (WIF)</span>
          <span className="kv-value mono">{discovery.wif}</span>
        </div>
        <div className="proof-cell">
          <span className="proof-label">derived public key (compressed, 33-byte)</span>
          <span className="kv-value mono">{discovery.pubkeyCompressedHex}</span>
        </div>
        <div className="proof-cell">
          <span className="proof-label">derived public key (uncompressed, 65-byte)</span>
          <span className="kv-value mono">{discovery.pubkeyUncompressedHex}</span>
        </div>
        <div className="proof-cell">
          <span className="proof-label">matched watchlist entry</span>
          <span className="kv-value mono">{discovery.matchedWatchlistKey}</span>
        </div>
        <div className="proof-cell">
          <span className="proof-label">legacy P2PKH address (from compressed key)</span>
          <span className="kv-value mono">{discovery.p2pkhCompressed}</span>
        </div>
        <div className="proof-cell">
          <span className="proof-label">legacy P2PKH address (from uncompressed key)</span>
          <span className="kv-value mono">{discovery.p2pkhUncompressed}</span>
        </div>
      </div>
      {discovery.richWatchlistHit && (
        <p className="verdict ok proof-verdict">
          ✦ Upgraded label: the derived address is ALSO on the rich-address
          watchlist — this discovery is one of the well-funded era addresses.
        </p>
      )}
      <p className="verdict ok proof-verdict">
        ✓ PROVEN: the private key shown above derives the public key that
        equals the matched watchlist entry — scalar multiplication and the
        membership check are the whole proof, not a heuristic.
      </p>
      <div className="verify-recipe">
        <h3>Verify externally (recommended)</h3>
        <ol>
          <li>
            Import the WIF (or paste the 64-hex private key) above into any
            standard open-source key-to-address tool (e.g. the well-known
            iancoleman.io toolchain, run offline).
          </li>
          <li>
            Confirm the tool's public key equals the compressed and
            uncompressed forms shown, and the legacy P2PKH addresses match.
          </li>
          <li>
            Confirm the matched watchlist entry equals the uncompressed public
            key — that equality is why the run stopped.
          </li>
        </ol>
      </div>
      <Infeasibility />
    </section>
  );}

function ExhaustedCard({ report }: { report: RunReport }) {
  const agg = report.aggregate;
  return (
    <section className="card result exhausted" aria-label="Run exhausted">
      <h2>No match — the demo keyspace is exhausted</h2>
      <p>
        The worker fleet walked the entire bundled demo keyspace for{" "}
        <strong>{formatDuration(report.elapsedMs === null ? null : report.elapsedMs / 1000)}</strong>{" "}
        and this address is not in it. Measured rate:{" "}
        <strong>{agg === null ? "—" : formatRate(agg.derivedPerSec)}</strong> over{" "}
        <strong>{formatCount(agg?.derived ?? report.totalCandidates)}</strong> derived candidates
        (space: {formatCount(report.totalCandidates)} checksum-valid,{" "}
        {formatCount(report.rawCandidates)} raw assemblies).
      </p>
      <p>
        An address outside the bundled demo corpora <strong>can never match</strong> — this tool
        cannot recover real wallets. The measured rate makes the real-space scale concrete: at{" "}
        {agg === null ? "this" : formatRate(agg.derivedPerSec)}, sweeping 2^128 phrases would take
        far longer than the age of the universe, and Grover's quadratic speedup would still need
        (π/4)·2^66 ≈ 5.8×10^19 oracle calls on an impractical reversible BIP-39 circuit.
      </p>
      <Infeasibility />
    </section>
  );
}

function CancelledCard({ report }: { report: RunReport }) {
  const agg = report.aggregate;
  const lottery = report.searchKind === "lottery";
  return (
    <section className="card result cancelled" aria-label="Run cancelled">
      <h2>Run cancelled</h2>
      {lottery ? (
        <p>
          Stopped after {formatCount(agg?.derived ?? 0)} draws at{" "}
          {agg === null ? "—" : formatRate(agg.derivedPerSec)}. A lottery has no
          finishable space — nothing was “partially covered”; the honest odds
          disclosure applied from the start and still holds.
        </p>
      ) : (
        <p>
          Partial scan: {formatCount(agg?.derived ?? 0)} candidates derived (
          {agg === null ? "—" : `${(agg.fractionOfKeyspace * 100).toFixed(1)}%`} of the demo
          keyspace) at {agg === null ? "—" : formatRate(agg.derivedPerSec)} before cancellation.
        </p>
      )}
      <Infeasibility />
    </section>
  );
}

function BudgetReachedCard({ report }: { report: RunReport }) {
  const agg = report.aggregate;
  const preseed = report.mode === "preseed";
  return (
    <section className="card result exhausted" aria-label="Draw budget reached">
      <h2>No match — the draw budget is spent</h2>
      {preseed ? (
        <p>
          The lottery made {formatCount(agg?.derived ?? report.totalCandidates)} random draws at{" "}
          <strong>{agg === null ? "—" : formatRate(agg.derivedPerSec)}</strong> and stopped at its
          disclosed budget. None of them derived a key on the Satoshi-era watchlist.
        </p>
      ) : (
        <p>
          The lottery made {formatCount(agg?.derived ?? report.totalCandidates)} random draws at{" "}
          <strong>{agg === null ? "—" : formatRate(agg.derivedPerSec)}</strong> and stopped at its
          disclosed budget. None of them derived the target address.
        </p>
      )}
      {preseed ? (
        <p>
          This is not an exhausted search: the space of secp256k1 private keys is
          2^256 ≈ 1.16×10^77, so a budget-sized lottery cannot cover it — the run
          never claimed exhaustive coverage, before or after. At{" "}
          {agg === null ? "this" : formatRate(agg.derivedPerSec)}, sweeping the full scalar space
          would take far longer than the age of the universe, and Grover's quadratic speedup
          would still leave an unimplementable number of oracle calls on a huge reversible
          circuit.
        </p>
      ) : (
        <p>
          This is not an exhausted search: the space of checksum-valid 12-word
          phrases is 2^128 ≈ 3.4×10^38, so a budget-sized lottery cannot cover it —
          the run never claimed exhaustive coverage, before or after. At{" "}
          {agg === null ? "this" : formatRate(agg.derivedPerSec)}, sweeping 2^128 phrases would take
          far longer than the age of the universe, and Grover's quadratic speedup would still need
          (π/4)·2^66 ≈ 5.8×10^19 oracle calls.
        </p>
      )}
      <Infeasibility />
    </section>
  );
}

function ErrorCard({ report }: { report: RunReport }) {
  return (
    <section className="card result errored" aria-label="Run error">
      <h2>Run failed</h2>
      <p>
        The run ended in an error state. Check the API process output; the per-run report under{" "}
        <code>api/runs/{report.runId}.json</code> has the lane details.
      </p>
      <Infeasibility />
    </section>
  );
}

export function ResultPanel({ ui, chain }: ResultPanelProps) {
  const report = ui.report;
  if (report === null || report.status === "running") return null;

  switch (report.status) {
    case "matched":
      if (report.match === null) return null;
      // Pre-seed payloads are a DIFFERENT match shape — a targetless
      // discovery with key material, never a seed-phrase match card.
      if (isPreseedMatch(report.match)) {
        return <PreSeedDiscoveryCard discovery={report.match} />;
      }
      return (
        <MatchCard
          match={report.match}
          workerId={ui.match?.workerId ?? null}
          target={report.address}
          chain={chain}
          customWallet={report.customWallet ?? null}
        />
      );
    case "exhausted":
      return <ExhaustedCard report={report} />;
    case "budget-reached":
      return <BudgetReachedCard report={report} />;
    case "cancelled":
      return <CancelledCard report={report} />;
    case "error":
      return <ErrorCard report={report} />;
  }
}
