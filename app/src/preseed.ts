/**
 * Client-side mirror of the pre-seed disclosure math (api/src/preseed.ts).
 * The API echoes the authoritative note in the /crack response; this module
 * exists so the pre-START consent disclosure is computed from the same
 * figures instead of drifting into marketing. Pure functions and pinned
 * constants — the panel renders, this module reckons.
 */

import { sci } from "./grover";
import { formatRate } from "./format";
import { LOTTERY_DRAWS_PER_SEC, lotteryOddsOneInPerHour } from "./keyspace";

/** secp256k1 group order n (log10 ≈ 77.0637 — kept as a log to dodge 2^256 float damage). */
export const PRESEED_ORDER_LOG10 = 77.0637;

/** Satoshi-era P2PK watchlist entries (the 2009–2010 extracted set). */
export const PRESEED_TARGET_COUNT = 102_813;
/** How many of those are Patoshi-attributed per the findings report. */
export const PRESEED_PATOSHI_COUNT = 21_953;

/** Draws/sec the disclosure math assumes — measured on this engine (full watchlist, 1M-draw run), rounded DOWN. */
export const PRESEED_DRAWS_PER_SEC = 110_000;

/**
 * Odds of hitting the watchlist in one hour, expressed as the "1 in X"
 * denominator: rate·3600·targets / n. Below 1 it is not a one-in figure —
 * callers keep the raw probability phrasing, matching the API copy.
 */
export function preseedOddsOneInPerHour(
  drawsPerSec = PRESEED_DRAWS_PER_SEC,
): number {
  const log10Denom = Math.log10(drawsPerSec * 3_600 * PRESEED_TARGET_COUNT);
  return 10 ** (PRESEED_ORDER_LOG10 - log10Denom);
}

/**
 * The standing pre-start disclosure for pre-seed runs — mirrors the API's
 * preseedNote (api/src/preseed.ts) with the figures this module computes.
 * Shown BEFORE the run starts so consent to `probe` is informed consent.
 * The comparison ratio is COMPUTED (pre-seed odds ÷ phrase-lottery odds at
 * each mode's disclosed rate), never asserted as a round power of ten.
 */
export const PRESEED_ODDS_NOTE = (() => {
  const preseedOneIn = sci(preseedOddsOneInPerHour());
  const phraseOneIn = sci(lotteryOddsOneInPerHour());
  const ratio = preseedOddsOneInPerHour() / lotteryOddsOneInPerHour();
  return (
    "Pre-seed era lottery — every draw picks a uniformly random secp256k1 private key " +
    "(scalar in [1, n), n ≈ 1.16×10^77), derives its public key, and checks membership in " +
    `the Satoshi-era P2PK watchlist of ${PRESEED_TARGET_COUNT.toLocaleString("en-US")} known ` +
    `on-chain public keys (${PRESEED_PATOSHI_COUNT.toLocaleString("en-US")} of them ` +
    `Patoshi-attributed per the dataset findings). At the measured ~${formatRate(PRESEED_DRAWS_PER_SEC)} ` +
    `draws/s the odds of hitting the watchlist are about 1 in ${preseedOneIn} per hour. ` +
    `For comparison, the seed-phrase lottery (2^128 valid phrases, ~${formatRate(LOTTERY_DRAWS_PER_SEC)} draws/s) ` +
    `sits at about 1 in ${phraseOneIn} per hour — even with draws ~${sci(PRESEED_DRAWS_PER_SEC / LOTTERY_DRAWS_PER_SEC)}× ` +
    `cheaper, this mode is roughly ${sci(ratio)} times more remote per hour, because the ` +
    "keyspace is 2^256 ≈ 1.16×10^77 against 2^128. " +
    "The run is a bounded budget of random draws and ends at the budget or when you stop it — " +
    "it never claims exhaustive coverage, and no coverage figure is shown. There is no user " +
    "target in this mode: a hit is a watchlist DISCOVERY — a key that was already public on the " +
    "chain — never the recovery of an address anyone asked about."
  );
})();
