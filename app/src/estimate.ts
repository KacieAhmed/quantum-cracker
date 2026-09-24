/**
 * Client mirror of api/src/estimate.ts — the SAME pre-run model the server
 * uses, so the slider's live re-estimation agrees with the /crack response.
 *
 * Rate scales approximately linearly with workers up to the core count (the
 * engine benchmark basis: 5,479 full derivations/sec on a fully subscribed
 * 8-core worker); beyond the core count the estimate flattens — exactly the
 * diminishing-returns regime the slider warns about. Measured per-lane rates
 * from the WebSocket snapshots replace these estimates during a run.
 */

export const FALLBACK_PER_CORE_RATE = 5479 / 8;

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
