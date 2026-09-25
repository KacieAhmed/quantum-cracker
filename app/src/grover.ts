/**
 * Closed-form Grover extrapolation math for quantum mode's analytic panel —
 * no simulation, no run. Every figure traces to the pinned research note
 * (artifact art_MRbA2s2H, §1.4/§3) and the approach decision doc's mode-3
 * table (art_wq6bquwk §3); derivations are marked [derived] the same way the
 * note marks its own arithmetic. Pure functions — the panel renders, this
 * module reckons.
 */

/** Raw 12-word phrase assemblies: 2048^12 = 2^132 (pre-checksum). */
export const RAW_PHRASE_SPACE_BITS = 132;

/** Checksum-valid 12-word phrases: 2^128 (what the lottery samples). */
export const VALID_PHRASE_SPACE_BITS = 128;

/** π/4 · 2^(bits/2) — the Grover oracle-call count (Amy et al., arXiv:1603.09383). */
export function groverOracleCalls(puzzleBits: number): number {
  return (Math.PI / 4) * 2 ** (puzzleBits / 2);
}

/**
 * Wall-clock for the Grover call count at a fixed per-call duration, in
 * years. (2^66 calls × 1 ns = 7.38×10^10 s ≈ 2,340 years — note §3's table.)
 */
export function wallClockYears(oracleCalls: number, secondsPerCall: number): number {
  return (oracleCalls * secondsPerCall) / 31_557_600; // 3.156×10^7 s/yr
}

/** The full 12-word figure set the panel prints (note §3 + decision doc §3). */
export interface GroverExtrapolation {
  /** Raw 2048^12 = 2^132 assemblies, labeled pre-checksum wherever shown. */
  rawPhrases: number;
  /** Checksum-valid phrases the classical lottery actually samples: 2^128. */
  validPhrases: number;
  /** Grover oracle calls at the 12-word keyspace: (π/4)·2^66 ≈ 5.8×10^19. */
  oracleCalls: number;
  /** Effective post-Grover security in bits: 132/2 = 66. */
  effectiveSecurityBits: number;
  /** Wall-clock at the fantastical 1 ns/oracle-call: ≈ 2,340 years. */
  yearsAtOneNs: number;
}

export function groverExtrapolation12Words(): GroverExtrapolation {
  const oracleCalls = groverOracleCalls(RAW_PHRASE_SPACE_BITS);
  return {
    rawPhrases: 2 ** RAW_PHRASE_SPACE_BITS,
    validPhrases: 2 ** VALID_PHRASE_SPACE_BITS,
    oracleCalls,
    effectiveSecurityBits: RAW_PHRASE_SPACE_BITS / 2,
    yearsAtOneNs: wallClockYears(2 ** (RAW_PHRASE_SPACE_BITS / 2), 1e-9),
  };
}

/**
 * Compact scientific notation for panel figures: 5.795…×10^19 → "5.8×10^19".
 * Exponents ≥ 4 and ≤ -4 go scientific; anything else stays plain.
 */
export function sci(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "—";
  const exponent = Math.floor(Math.log10(Math.abs(value)));
  if (exponent >= 4 || exponent <= -4) {
    const mantissa = value / 10 ** exponent;
    return `${mantissa.toFixed(digits)}×10^${exponent}`;
  }
  return value.toLocaleString("en-US", { maximumFractionDigits: digits });
}

/** Year figures for the panel: nearest decade, grouped (2,337.8 → "2,340"). */
export function formatYears(value: number): string {
  return (Math.round(value / 10) * 10).toLocaleString("en-US");
}
