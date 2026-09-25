/**
 * Client-side mirror of the API's limited-keyspace math (api/src/server.ts):
 * declared phrase slots vary over the full BIP-39 wordlist, every other
 * position stays fixed, and the disclosed space contains the true phrase by
 * construction. Pure functions — the panel renders, this module reckons.
 */

/** Max simultaneously-varied phrase slots (mirrors the API's cap). */
export const VARY_SLOTS_MAX = 4;

/** The BIP-39 English wordlist size the engine embeds. */
export const BIP39_WORDLIST_SIZE = 2048;

export interface TemplateSpace {
  /** Prefix ordinals the run's lanes split (lane ranges are prefix-based). */
  prefixes: number;
  /** Raw assemblies: prefixes × pool words. */
  rawAssemblies: number;
  /** Checksum-valid candidates the enumeration is expected to derive. */
  estimatedChecksumValid: number;
}

/**
 * The template space for vary slots over the full wordlist. Mirrors the
 * engine: only varied slots among the first eleven widen the prefix space
 * (the twelfth folds into the checksum sweep), and each prefix ordinal yields
 * poolSize/16 checksum-valid candidates — every prefix nibble has that many
 * completions in the full list.
 */
export function templateSpace(varySlots: number[]): TemplateSpace {
  const variedFirst11 = varySlots.filter((slot) => slot < 11).length;
  const prefixes = BIP39_WORDLIST_SIZE ** variedFirst11;
  return {
    prefixes,
    rawAssemblies: prefixes * BIP39_WORDLIST_SIZE,
    estimatedChecksumValid: prefixes * (BIP39_WORDLIST_SIZE / 16),
  };
}

/**
 * Why a slot cannot be marked to vary (null = allowed). Toggling an already
 * marked slot off is always allowed; the cap and the 12-word restriction
 * mirror the API's validation so the UI never offers a request that 422s.
 */
export function varySlotError(
  marked: number[],
  slot: number,
  wordCount: number,
): string | null {
  if (wordCount !== 12) {
    return "the limited-keyspace mode supports 12-word seed phrases";
  }
  if (marked.includes(slot)) return null;
  if (marked.length >= VARY_SLOTS_MAX) {
    return `at most ${VARY_SLOTS_MAX} words can vary at once — beyond that the disclosed keyspace grows past an honest demo runtime`;
  }
  return null;
}

/**
 * Full-space lottery math (mirrors the engine's disclosure constants): raw
 * 12-word assemblies are 2048^12 ≈ 5.4×10^39, but only 2^128 ≈ 3.4×10^38 of
 * those are checksum-valid — and the engine samples valid phrases only, so
 * every disclosed ODDS figure is over the valid space. The raw figure is
 * always labeled as raw. Never softened: the expected wait is the point.
 */
export const FULL_SPACE_RAW_ASSEMBLIES = 2048 ** 12; // ≈ 5.44e39 (labeled raw)
export const FULL_SPACE_VALID_PHRASES = 2 ** 128; // ≈ 3.40e38 checksum-valid
/** Demo draws-per-second the odds copy assumes (one ~1,400/s worker). */
export const LOTTERY_DRAWS_PER_SEC = 1_400;

/** Chance of one specific valid phrase per hour at the demo draw rate. */
export function lotteryOddsOneInPerHour(
  rate = LOTTERY_DRAWS_PER_SEC,
): number {
  return FULL_SPACE_VALID_PHRASES / (rate * 3_600);
}

/** Expected wait for one specific phrase, in years, at the demo draw rate. */
export function lotteryExpectedWaitYears(rate = LOTTERY_DRAWS_PER_SEC): number {
  return lotteryOddsOneInPerHour(rate) / (365.25 * 24);
}

/** Per-marked-slot bounded sweep space (1 slot = 2,048 candidates). */
export function markedSlotSpace(marked: number[]): TemplateSpace {
  return templateSpace(marked);
}
