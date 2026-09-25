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
