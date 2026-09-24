/** Number/duration formatting for stats labels. */

/** Grouped integer: 1048576 → "1,048,576". */
export function formatCount(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/**
 * Rate label: full precision below 10k/s ("5,479/s"), compact above
 * ("1.20M/s") so the stats bar stays scannable.
 */
export function formatRate(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 10_000) return `${formatCount(n)}/s`;
  return `${formatCompact(n)}/s`;
}

function formatCompact(n: number): string {
  const units = [
    { limit: 1e9, suffix: "B" },
    { limit: 1e6, suffix: "M" },
    { limit: 1e3, suffix: "k" },
  ] as const;
  for (const { limit, suffix } of units) {
    if (n >= limit) {
      const scaled = n / limit;
      const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
      return `${scaled.toFixed(digits)}${suffix}`;
    }
  }
  return formatCount(n);
}

/** Duration: null → "—", 65 → "1m 05s", 3661 → "1h 01m". */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** Fraction 0..1 → "12.3%" (clamped, one decimal). */
export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return "—";
  return `${(Math.min(Math.max(fraction, 0), 1) * 100).toFixed(1)}%`;
}
