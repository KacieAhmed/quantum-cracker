import { formatCount, formatDuration, formatRate } from "../format";
import { QUANTUM_NOTE } from "../constants";
import type { RunUiState } from "../reducer";
import type { Chain, MatchInfo, RunReport } from "../types";
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
          <span className="kv-value mono phrase">{match.mnemonic}</span>
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
        ~2^64 oracle calls.
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
  return (
    <section className="card result exhausted" aria-label="Draw budget reached">
      <h2>No match — the draw budget is spent</h2>
      <p>
        The lottery made {formatCount(agg?.derived ?? report.totalCandidates)} random draws at{" "}
        <strong>{agg === null ? "—" : formatRate(agg.derivedPerSec)}</strong> and stopped at its
        disclosed budget. None of them derived the target address.
      </p>
      <p>
        This is not an exhausted search: the space of checksum-valid 12-word
        phrases is 2^128 ≈ 3.4×10^38, so a budget-sized lottery cannot cover it —
        the run never claimed exhaustive coverage, before or after. At{" "}
        {agg === null ? "this" : formatRate(agg.derivedPerSec)}, sweeping 2^128 phrases would take
        far longer than the age of the universe, and Grover's quadratic speedup would still need
        ~2^64 oracle calls.
      </p>
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

function QuantumCard({ report, payload }: { report: RunReport; payload: unknown }) {
  return (
    <section className="card result quantum" aria-label="Quantum demo result">
      <div className="card-title-row">
        <h2>Quantum mode — toy Grover simulation</h2>
        <span className="level-badge amber">algorithm decision pending</span>
      </div>
      <p className="note">{QUANTUM_NOTE}</p>
      <p className="note">
        This is a simulation over a {formatCount(report.totalCandidates)}-item demo keyspace. It is
        not a wallet search and its output is not a recovered wallet.
      </p>
      {payload !== null && payload !== undefined && (
        <pre className="mono quantum-payload">{JSON.stringify(payload, null, 2)}</pre>
      )}
      <Infeasibility />
    </section>
  );
}

export function ResultPanel({ ui, chain }: ResultPanelProps) {
  const report = ui.report;
  if (report === null || report.status === "running") return null;

  switch (report.status) {
    case "matched":
      return report.match !== null ? (
        <MatchCard
          match={report.match}
          workerId={ui.match?.workerId ?? null}
          target={report.address}
          chain={chain}
          customWallet={report.customWallet ?? null}
        />
      ) : null;
    case "exhausted":
      return <ExhaustedCard report={report} />;
    case "budget-reached":
      return <BudgetReachedCard report={report} />;
    case "cancelled":
      return <CancelledCard report={report} />;
    case "error":
      return <ErrorCard report={report} />;
    case "quantum_demo":
      return <QuantumCard report={report} payload={ui.quantumPayload ?? report.quantum} />;
  }
}
