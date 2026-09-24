import { workerHint, workerLevel, workerPresets } from "../workers";
import { formatCount, formatDuration, formatRate } from "../format";
import type { SystemInfo } from "../types";

interface WorkerSliderProps {
  workers: number;
  onWorkers: (workers: number) => void;
  system: SystemInfo | null;
  force: boolean;
  onForce: (force: boolean) => void;
  disabled: boolean;
  /** Pre-run aggregate estimate at the current slider value. */
  estimatedRate: number | null;
  estimatedEta: number | null;
  totalCandidates: number | null;
}

export function WorkerSlider({
  workers,
  onWorkers,
  system,
  force,
  onForce,
  disabled,
  estimatedRate,
  estimatedEta,
  totalCandidates,
}: WorkerSliderProps) {
  if (system === null) {
    return (
      <section className="card" aria-label="Workers">
        <h2>Workers</h2>
        <p className="note">loading machine capabilities…</p>
      </section>
    );
  }

  const level = workerLevel(workers, system.cores, system.safeMaxWorkers);
  const hint = workerHint(level, workers, system.cores, system.safeMaxWorkers);
  const hardMax = system.workersHardMax;

  return (
    <section className="card" aria-label="Workers">
      <div className="card-title-row">
        <h2>Workers</h2>
        <span className={`level-badge ${level}`}>{workers}</span>
      </div>
      <input
        className={`slider ${level}`}
        type="range"
        min={1}
        max={hardMax}
        step={1}
        value={workers}
        onChange={(e) => onWorkers(Number(e.target.value))}
        disabled={disabled}
        aria-label="Worker count"
      />
      <div className="slider-scale">
        <span>1</span>
        <span>cores: {system.cores}</span>
        <span>safe-max: {system.safeMaxWorkers}</span>
        <span>{hardMax}</span>
      </div>
      <p className={`hint ${level}`}>{hint}</p>
      <div className="presets" role="group" aria-label="Worker presets">
        {workerPresets(system.safeMaxWorkers).map((preset) => (
          <button
            key={preset.value}
            type="button"
            className="btn subtle"
            disabled={disabled || preset.value < 1}
            onClick={() => onWorkers(preset.value)}
          >
            {preset.label}
          </button>
        ))}
      </div>
      {level === "red" && (
        <label className="force-row">
          <input
            type="checkbox"
            checked={force}
            onChange={(e) => onForce(e.target.checked)}
            disabled={disabled}
          />
          Force override (the API refuses {workers} workers without this)
        </label>
      )}
      <div className="estimate-row">
        <span>
          est. rate <strong>{estimatedRate === null ? "—" : formatRate(estimatedRate)}</strong>
        </span>
        <span>
          est. full-space time <strong>{formatDuration(estimatedEta)}</strong>
        </span>
        <span>
          coverage{" "}
          <strong>
            {totalCandidates === null
              ? "—"
              : `${formatCount(totalCandidates)} prefixes (100% of the demo space)`}
          </strong>
        </span>
      </div>
      <p className="note bench-basis">{system.bench.basis}</p>
    </section>
  );
}
