/**
 * Pre-seed P2PK lottery disclosure math — every number in the note is either
 * a constant of the vendored watchlist or the MEASURED engine rate, never a
 * hoped-for one. The same math lives in the app (src/preseed.ts); keep the
 * two in step (both are covered by tests).
 *
 * Per hour, the chance of drawing ANY watchlisted key is:
 *   draws/s × 3600 × targets / n   (n = the secp256k1 group order ≈ 2^256)
 */

/** The secp256k1 group order n at f64 display precision (~1.16×10^77). Draws
 * are uniform over [1, n); n differs from 2^256 by less than any digit this
 * value shows, so the disclosure quotes the 2^256 ≈ 1.16×10^77 field width. */
export const PRESEED_SPACE_F = 1.157920892373162e77;

/**
 * Measured engine draw rate (scalars/s with default workers) — the disclosure
 * basis for every pre-seed odds claim. Measured on the repo sandbox (8 cores)
 * with the release build over the full watchlist: 121,132 draws/s (1M draws,
 * 8.26 s, seed 1234567890) and 111,194 draws/s (500k draws, 4.50 s, seed
 * 987654321). The constant is the conservative floor of the band: a slower
 * machine only makes the odds worse, never the disclosure dishonest.
 */
export const PRESEED_DRAWS_PER_SEC = 110_000;

/** Satoshi-era P2PK watchlist entries (the vendored, integrity-pinned asset). */
export const PRESEED_WATCHLIST_KEYS = 102_813;

/** Watchlist entries attributed to the Patoshi-pattern miner (findings
 * report) — quoted in the disclosure for context. */
export const PRESEED_PATOSHI_KEYS = 21_953;

/** The phrase-lottery per-hour basis, for the honest side-by-side line: the
 * existing lottery disclosure's own figures (~1,400 draws/s over 2^128 ≈
 * 3.4×10^38 checksum-valid phrases, one specific address) work out to about
 * 1 in 6.7×10^31 per hour — same number the lottery note quotes. */
export const PHRASE_LOTTERY_ODDS_ONE_IN_PER_HOUR = 6.7e31;

/** The vendored asset's pinned SHA-256 over its canonical byte content:
 * 102,813 LF-separated 130-char uncompressed keys with no trailing newline.
 * Must equal cracker_core::preseed::ASSET_SHA256_HEX. */
export const PRESEED_ASSET_SHA256 =
  "2eb2157d7170af470dade8bf5814e916990f7e88f7b29689084de884374058f8";

/** Odds of drawing any watchlisted key in one hour at the given draw rate. */
export function preseedOddsOneInPerHour(drawsPerSec: number): number {
  return PRESEED_SPACE_F / (drawsPerSec * 3600 * PRESEED_WATCHLIST_KEYS);
}

/** How many times more remote the pre-seed hourly odds are than the phrase
 * lottery's (order of magnitude, rounded). */
export function preseedVsPhraseFactorExp(): number {
  return Math.round(
    Math.log10(
      preseedOddsOneInPerHour(PRESEED_DRAWS_PER_SEC) /
        PHRASE_LOTTERY_ODDS_ONE_IN_PER_HOUR,
    ),
  );
}

/** The consent-gate refusal message (mirrors the address-only pattern). */
export const PRESEED_CONSENT_MESSAGE =
  'pre-seed lottery runs draw random private keys uniformly across [1, n) — 2^256 ≈ 1.16×10^77 keys — ' +
  `and test each derived public key against ${PRESEED_WATCHLIST_KEYS.toLocaleString("en-US")} Satoshi-era watchlisted public keys (${PRESEED_PATOSHI_KEYS.toLocaleString("en-US")} Patoshi-attributed). ` +
  "The odds, computed from the engine's measured draw rate, are astronomically remote. " +
  'Resend with "probe": true to accept the disclosed odds.';

/** The full odds disclosure — the note the /crack response returns and the
 * UI renders verbatim before a run can be started. */
export function preseedNote(): string {
  const perHour = preseedOddsOneInPerHour(PRESEED_DRAWS_PER_SEC);
  return (
    "Pre-seed lottery: every draw picks a random private key uniformly from [1, n) — the secp256k1 " +
    "group order, 2^256 ≈ 1.16×10^77 keys — derives its public key, and tests membership in the watchlist of " +
    `${PRESEED_WATCHLIST_KEYS.toLocaleString("en-US")} Satoshi-era P2PK public keys (${PRESEED_PATOSHI_KEYS.toLocaleString("en-US")} of them Patoshi-attributed), the era's spendable-key set. ` +
    `At the engine's measured ~${PRESEED_DRAWS_PER_SEC.toLocaleString("en-US")} draws/s, the odds of drawing any watchlisted key are about 1 in ${perHour.toExponential(2)} per hour — roughly 10^${preseedVsPhraseFactorExp()} times more remote per hour than the phrase lottery, despite the cheaper draws. ` +
    "If a drawn key genuinely matches a watchlisted public key, the run stops immediately and reports it as a labeled discovery with the full key material (private key, WIF, both public-key encodings, and the legacy P2PKH addresses each encoding derives). " +
    "There is no user-supplied target in this mode: a watchlist hit is a discovery, never a recovery. " +
    "The run stops at its draw budget or when you stop it — it never claims exhaustive coverage, and no budget makes a dent in 2^256."
  );
}
