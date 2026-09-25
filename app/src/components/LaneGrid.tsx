import { formatCount, formatRate } from "../format";
import type { LaneState } from "../types";

interface LaneGridProps {
  lanes: LaneState[];
}

export function LaneGrid({ lanes }: LaneGridProps) {
  return (
    <section aria-label="Worker lanes">
      <h2 className="section-title">Worker lanes ({lanes.length})</h2>
      <div className="lane-grid">
        {lanes.map((lane) => (
          <div key={lane.id} className={`lane lane-${lane.status}`}>
            <div className="lane-head">
              <span className="lane-id">lane {lane.id}</span>
              <span className={`lane-status status-${lane.status}`}>{lane.status}</span>
            </div>
            <div
              className="lane-progress"
              role="progressbar"
              aria-valuenow={Math.round(lane.fraction * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="lane-progress-fill" style={{ width: `${lane.fraction * 100}%` }} />
            </div>
            <div className="lane-stats">
              <span>{formatCount(lane.prefixesDone)} candidates</span>
              <span>{formatRate(lane.rate)}</span>
              <span>{formatCount(lane.derived)} derived</span>
            </div>
            <div className="lane-phrase" title={lane.frontierPhrase ?? undefined}>
              {lane.frontierPhrase ?? "…"}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
