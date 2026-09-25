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

/**
 * Quantum mode: the classical search leg runs the SAME full-space lottery as
 * the classic engine (uniform random draws over ALL checksum-valid 12-word
 * phrases — 2^128 ≈ 3.4×10^38; no toy keyspace). The quantum leg is the app's
 * closed-form Grover extrapolation panel — nothing runs, nothing spins. The
 * toy Grover module stays out-of-app (education/CLI only).
 */
export const QUANTUM_MODE_NOTE =
  "Quantum mode: the classical leg runs the full-space lottery — every draw " +
  "picks all 12 words uniformly at random over checksum-valid phrases " +
  "(2^128 ≈ 3.4×10^38). The quantum leg is honest math, not a run: Grover " +
  "would need (π/4)·2^66 ≈ 5.8×10^19 oracle calls, and each call is a " +
  "reversible PBKDF2→address circuit that no hardware executes coherently " +
  "even once at meaningful scale. The toy Grover simulator lives outside the " +
  "app (quantum/grover, education/CLI only).";
