/**
 * Client-side mirror of the API's wire types (api/src/types.ts, cli.ts,
 * system.ts). Kept structurally identical on purpose: the app is the only
 * consumer of these messages, and a mismatch is a bug we want surfaced in
 * code review rather than hidden behind a hand-rolled variant.
 */

export type Chain = "bitcoin" | "ethereum";
export type Mode = "classic" | "quantum";

export interface LaneRange {
  /** First prefix ordinal of this lane (inclusive). */
  start: number;
  /** Number of prefix ordinals this lane scans. */
  count: number;
}

export type LaneStatus = "starting" | "running" | "done" | "killed" | "error";

export interface LaneState {
  id: number;
  start: number;
  end: number;
  prefixesDone: number;
  derived: number;
  /** Instantaneous derivations/sec from the lane's own last progress tick. */
  rate: number;
  /** Fraction of the lane's range walked so far. */
  fraction: number;
  frontierPrefix: number | null;
  frontierPhrase: string | null;
  status: LaneStatus;
}

export interface AllAddresses {
  eth: string;
  btc_p2pkh: string;
  btc_bech32: string;
}

export interface MatchInfo {
  mnemonic: string;
  path: string;
  address: string;
  allAddresses: AllAddresses;
}

export type RunStatus =
  | "running"
  | "matched"
  | "exhausted"
  | "cancelled"
  | "error"
  | "quantum_demo";

export interface Aggregate {
  derived: number;
  derivedPerSec: number;
  fractionOfKeyspace: number;
  etaSeconds: number | null;
  matches: number;
}

export interface RunReport {
  runId: string;
  status: RunStatus;
  chain: Chain;
  mode: Mode;
  address: string;
  workersRequested: number;
  lanes: LaneState[];
  totalCandidates: number;
  rawCandidates: number;
  startedAt: string;
  finishedAt: string | null;
  elapsedMs: number | null;
  aggregate: Aggregate | null;
  match: MatchInfo | null;
  quantum: unknown | null;
}

/** WS messages the API broadcasts (GET /ws). */
export type ServerMessage =
  | { type: "snapshot"; report: RunReport }
  | { type: "match"; runId: string; match: MatchInfo; workerId: number }
  | { type: "done"; runId: string; status: RunStatus; report: RunReport }
  | { type: "quantum_result"; runId: string; payload: unknown }
  | { type: "error"; runId: string | null; message: string };

// ── GET /system ─────────────────────────────────────────────────────────────

export interface SystemInfo {
  cores: number;
  totalMemBytes: number;
  freeMemBytes: number;
  perWorkerFootprintBytes: number;
  safeMaxWorkers: number;
  bench: {
    perCoreDerivationsPerSec: number;
    basis: string;
  };
  workersHardMax: number;
  workersDefault: number;
}

// ── GET /corpus ─────────────────────────────────────────────────────────────

export interface CorpusTarget {
  id: string;
  label: string;
  searchable: boolean;
  addresses: AllAddresses;
}

export interface CorpusDoc {
  wallets: CorpusTarget[];
  space: { total_prefixes: number; raw_candidates: number };
}

// ── POST /validate ──────────────────────────────────────────────────────────

export interface TargetVerdict {
  target: string;
  valid: boolean;
  kind?: string;
  normalized?: string;
  error?: string;
}

// ── POST /crack ─────────────────────────────────────────────────────────────

export interface CrackRequest {
  chain: Chain;
  mode: Mode;
  address: string;
  workers?: number;
  force?: boolean;
  quantumBits?: number;
}

export interface ClassicStart {
  runId: string;
  mode: "classic";
  lanes: Array<{ id: number } & LaneRange>;
  totalCandidates: number;
  rawCandidates: number;
  estimatedRatePerSec: number;
  etaSeconds: number | null;
  safeMaxWorkers: number;
  cores: number;
  forced: boolean;
}

export interface QuantumStart {
  runId: string;
  mode: "quantum";
  totalCandidates: number;
  note: string;
}

export type CrackStart = ClassicStart | QuantumStart;

export interface Cancelled {
  runId: string;
  cancelled: boolean;
}
