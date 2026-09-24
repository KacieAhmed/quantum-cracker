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
}: {
  match: MatchInfo;
  workerId: number | null;
  target: string;
  chain: Chain;
}) {
  const verified = featuredAddresses(match, chain).some(
    (a) => a.value.toLowerCase() === target.toLowerCase(),
  );
  return (
    <section className="card result matched" aria-label="Match found">
      <h2>
        ✓ Match found
        {workerId !== null && <span className="result-sub"> (lane {workerId})</span>}
      </h2>
      <div className="kv">
        <span className="kv-key">recovered seed phrase</span>
        <span className="kv-value mono phrase">{match.mnemonic}</span>
        <span className="kv-key">derivation path</span>
        <span className="kv-value mono">{match.path}</span>
        {featuredAddresses(match, chain).map((a) => (
          <FragmentRow key={a.label} label={a.label} value={a.value} />
        ))}
      </div>
      <p className="verdict ok">
        {verified
          ? "✓ engine-verified: the derived address equals the target"
          : "⚠ derived addresses recorded — target comparison inconclusive, inspect the run report"}
      </p>
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
  return (
    <section className="card result cancelled" aria-label="Run cancelled">
      <h2>Run cancelled</h2>
      <p>
        Partial scan: {formatCount(agg?.derived ?? 0)} candidates derived (
        {agg === null ? "—" : `${(agg.fractionOfKeyspace * 100).toFixed(1)}%`} of the demo
        keyspace) at {agg === null ? "—" : formatRate(agg.derivedPerSec)} before cancellation.
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
        />
      ) : null;
    case "exhausted":
      return <ExhaustedCard report={report} />;
    case "cancelled":
      return <CancelledCard report={report} />;
    case "error":
      return <ErrorCard report={report} />;
    case "quantum_demo":
      return <QuantumCard report={report} payload={ui.quantumPayload ?? report.quantum} />;
  }
}
