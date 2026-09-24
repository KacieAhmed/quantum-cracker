import { formatCount, formatDuration, formatPercent, formatRate } from "../format";

interface StatsBarProps {
  derived: number;
  /** Derivations/sec — measured during a run, estimated before it starts. */
  rate: number | null;
  /** Fraction of the demo keyspace covered so far. */
  fraction: number;
  eta: number | null;
  measured: boolean;
}

export function StatsBar({ derived, rate, fraction, eta, measured }: StatsBarProps) {
  return (
    <div className="stats-bar" role="status" aria-label="Run statistics">
      <div className="stat">
        <span className="stat-label">candidates derived</span>
        <span className="stat-value">{formatCount(derived)}</span>
      </div>
      <div className="stat">
        <span className="stat-label">
          derivations/sec {measured ? "(measured)" : "(estimated)"}
        </span>
        <span className="stat-value">{rate === null ? "—" : formatRate(rate)}</span>
      </div>
      <div className="stat">
        <span className="stat-label">of demo keyspace</span>
        <span className="stat-value">{formatPercent(fraction)}</span>
      </div>
      <div className="stat">
        <span className="stat-label">ETA (full space)</span>
        <span className="stat-value">{formatDuration(eta)}</span>
      </div>
    </div>
  );
}
