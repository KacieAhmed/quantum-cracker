/** Shared constants: benchmark basis, capacity caps, demo defaults. */

/**
 * Engine benchmark (cracker-core): full candidate derivations per second on a
 * fully subscribed 8-core worker. Per-core rate drives pre-run estimates;
 * measured rates replace them as soon as lanes stream progress.
 */
export const BENCH_FULL_DERIVATIONS_PER_SEC_PER_8_CORES = 5479;
export const PER_CORE_DERIVATIONS_PER_SEC =
  BENCH_FULL_DERIVATIONS_PER_SEC_PER_8_CORES / 8;

/**
 * Conservative RAM one cracker-cli lane may reserve. The API refuses worker
 * counts above safe-max (= min(cores, floor(availableMem / footprint))) so a
 * demo cannot OOM the host; a client can still force-override deliberately.
 */
export const PER_WORKER_FOOTPRINT_BYTES = 64 * 1024 * 1024;

/** The UI slider spans 1..64 workers; the API enforces the same hard cap. */
export const WORKERS_HARD_MAX = 64;

/** Default lane count for a classic run. */
export const WORKERS_DEFAULT = 8;

/** How often cracker-cli lanes emit progress lines, and how often the run
 * manager broadcasts aggregate snapshots over the WebSocket. */
export const PROGRESS_MS = 250;

/** Toy Grover demo defaults (quantum mode): the toy keyspace is 2^n_bits. */
export const QUANTUM_BITS_DEFAULT = 8;
export const QUANTUM_BITS_MAX = 16;
export const QUANTUM_TIMEOUT_MS = 120_000;

/** Bounds the toy simulation honors — the toy oracle is NOT BIP-39 and must
 * never be presented as wallet recovery (honest-scaling rule). */
export const QUANTUM_NOTE =
  "Quantum mode: algorithm decision pending - toy Grover simulation over a tiny demo keyspace only. " +
  "A real 12-word wallet spans 2^128 phrases (2^132 with checksum bits); Grover's quadratic speedup " +
  "would still need ~2^64 oracle calls, each costing an impractical reversible BIP-39 circuit.";
