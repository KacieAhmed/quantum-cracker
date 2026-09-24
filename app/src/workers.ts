/**
 * Worker-slider level logic (pure). Mirrors the API's guardrails:
 * safe-max = min(cores, floor(free RAM / 64 MiB per lane)) — above it the
 * API refuses /crack unless the client deliberately force-overrides.
 */

export type WorkerLevel = "normal" | "amber" | "red";

export function workerLevel(
  workers: number,
  cores: number,
  safeMaxWorkers: number,
): WorkerLevel {
  if (workers > safeMaxWorkers) return "red";
  if (workers > cores) return "amber";
  return "normal";
}

export function workerHint(
  level: WorkerLevel,
  workers: number,
  cores: number,
  safeMaxWorkers: number,
): string {
  switch (level) {
    case "red":
      return `${workers} workers exceed this machine's safe maximum (${safeMaxWorkers}) — at some point your computer crashes. Reduce workers, or force-override deliberately if you accept the risk.`;
    case "amber":
      return `More workers than cores (${workers} > ${cores}) — diminishing returns, your computer will crawl.`;
    case "normal":
      return `${workers} workers on ${cores} cores — comfortably parallel.`;
  }
}

/** Quick-preset values under the slider, computed from live system info. */
export function workerPresets(
  safeMaxWorkers: number,
): Array<{ label: string; value: number }> {
  const base = [4, 8, 16];
  const underMax = base
    .filter((v) => v < safeMaxWorkers)
    .map((v) => ({ label: String(v), value: v }));
  return [...underMax, { label: `MAX-safe (${safeMaxWorkers})`, value: safeMaxWorkers }];
}
