/**
 * Client-side constants. QUANTUM_NOTE mirrors api/src/config.ts — keep the
 * two in sync (the API also echoes it in the /crack quantum response).
 */
export const QUANTUM_NOTE =
  "Quantum mode: algorithm decision pending - toy Grover simulation over a tiny demo keyspace only. " +
  "A real 12-word wallet spans 2^128 phrases (2^132 with checksum bits); Grover's quadratic speedup " +
  "would still need ~2^64 oracle calls, each costing an impractical reversible BIP-39 circuit.";

/** The standing honesty note shown wherever results or estimates appear. */
export const SCOPE_NOTE =
  "Demo scope: this tool searches only the bundled demo corpora — a pooled 16^6 = 2^24-phrase space " +
  "(1,048,576 checksum-valid candidates). A real 12-word BIP-39 wallet spans 2^128 phrases (2^132 " +
  "including checksum bits): unreachable classically, and Grover's quadratic speedup would still " +
  "need ~2^64 oracle calls on an impractical reversible BIP-39 circuit. An address outside the demo " +
  "corpora can never match, and no real wallet can be recovered with this tool.";

/** How many recent candidate phrases the ticker keeps visible. */
export const TICKER_LIMIT = 24;

/** Debounce for engine-backed address validation while typing (ms). */
export const VALIDATE_DEBOUNCE_MS = 400;
