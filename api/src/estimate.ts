/**
 * Pre-run estimators for the worker slider. Rate scales approximately
 * linearly with workers up to the core count (the engine benchmark basis);
 * beyond the core count the estimate flattens — that is exactly the
 * diminishing-returns regime the slider warns about. Measured per-lane rates
 * replace these estimates the moment lanes stream progress.
 */
export function estimateAggregateRate(
  workers: number,
  cores: number,
  perCoreRate: number,
): number {
  const effective = Math.max(0, Math.min(workers, cores));
  return effective * perCoreRate;
}

/** Seconds to walk the remaining keyspace at `rate` (null while rate is 0). */
export function etaSeconds(
  total: number,
  done: number,
  rate: number,
): number | null {
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return Math.max(0, (total - done) / rate);
}
