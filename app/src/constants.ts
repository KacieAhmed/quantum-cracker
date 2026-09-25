/**
 * Client-side constants. QUANTUM_MODE_NOTE mirrors api/src/config.ts — keep
 * the two in sync (the API also echoes it in the /crack quantum response).
 */
export const QUANTUM_MODE_NOTE =
  "Quantum mode: the classical leg runs the full-space lottery — every draw " +
  "picks all 12 words uniformly at random over checksum-valid phrases " +
  "(2^128 ≈ 3.4×10^38). The quantum leg is honest math, not a run: Grover " +
  "would need (π/4)·2^66 ≈ 5.8×10^19 oracle calls, and each call is a " +
  "reversible PBKDF2→address circuit that no hardware executes coherently " +
  "even once at meaningful scale. The toy Grover simulator lives outside the " +
  "app (quantum/grover, education/CLI only).";

/** The standing honesty note shown wherever results or estimates appear. */
export const SCOPE_NOTE =
  "Demo scope: corpus searches in Classic mode cover only the bundled demo corpora — a pooled " +
  "16^6 = 2^24-phrase space (1,048,576 checksum-valid candidates). Address-only, own-wallet, and " +
  "quantum runs are consented, budget-limited lotteries over ALL checksum-valid 12-word BIP-39 " +
  "phrases — 2^128 ≈ 3.4×10^38 of them (2^132 including checksum bits), with raw pre-checksum " +
  "assemblies at 2048^12 ≈ 5.4×10^39. Unreachable classically, and Grover's quadratic speedup " +
  "would still need (π/4)·2^66 ≈ 5.8×10^19 oracle calls on an impractical reversible BIP-39 " +
  "circuit. Only limited-keyspace own-wallet runs search a finishable space (built from the " +
  "user's own seed knowledge). Outside the demo corpora a match happens only by lottery odds or " +
  "because the phrase was supplied directly — no real wallet whose seed the user does not " +
  "already hold can be recovered with this tool.";

/**
 * Pre-start odds disclosure for address-only lottery runs — mirrors the API's
 * lotteryNote (api/src/server.ts). Shown BEFORE the run starts so consent to
 * `probe` is informed consent; the run report repeats it verbatim.
 */
export const LOTTERY_ODDS_NOTE =
  "Feasibility lottery — every draw picks all 12 words at random over ALL checksum-valid " +
  "12-word BIP-39 phrases (2^128 ≈ 3.4×10^38 valid; the raw 2048^12 ≈ 5.4×10^39 figure is " +
  "pre-checksum). At ~1,400 draws/s the odds of deriving a specific address are about " +
  "1 in 6.7×10^31 per hour — the expected wait is ~10^28 years, so this address will not " +
  "be found. The run is a bounded budget of random draws and ends at the budget or when " +
  "you stop it — it never claims exhaustive coverage. The pinned calibration phrase is " +
  "tested first (labeled \u201Cpinned — not random\u201D), then random sampling begins. A match is " +
  "claimed only if a tested phrase genuinely derives the target address.";

/** How many recent candidate phrases the ticker keeps visible. */
export const TICKER_LIMIT = 24;

/** Debounce for engine-backed address validation while typing (ms). */
export const VALIDATE_DEBOUNCE_MS = 400;
