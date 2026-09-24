import type { LaneRange } from "./types.js";

/**
 * Split `total` prefix ordinals into at most `lanes` disjoint ranges that
 * cover [0, total) exactly once; the last lane absorbs the remainder. The
 * cracker CLI rejects --start >= space, so when `lanes` exceeds `total` the
 * result is capped at `total` single-ordinal ranges — callers must spawn one
 * lane per returned range.
 */
export function splitSpace(total: number, lanes: number): LaneRange[] {
  if (!Number.isInteger(total) || total <= 0) {
    throw new RangeError(`total must be a positive integer, got ${total}`);
  }
  if (!Number.isInteger(lanes) || lanes <= 0) {
    throw new RangeError(`lanes must be a positive integer, got ${lanes}`);
  }
  const laneCount = Math.min(lanes, total);
  const base = Math.floor(total / laneCount);
  const remainder = total % laneCount;
  const ranges: LaneRange[] = [];
  let start = 0;
  for (let i = 0; i < laneCount; i++) {
    const count = base + (i < remainder ? 1 : 0);
    ranges.push({ start, count });
    start += count;
  }
  return ranges;
}
