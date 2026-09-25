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
  /** Canonical BIP-32 path the engine walked for this match, when known. */
  derivationPath?: string;
}

/**
 * Provenance of a run whose search target was derived from a user-supplied
 * seed phrase ("test with your own wallet"). Mirrors api/src/types.ts.
 */
export interface CustomWalletProvenance {
  targetSource: "derived-from-mnemonic";
  derivedAddresses: AllAddresses;
  paths: { eth: string; btc_p2pkh: string; btc_bech32: string };
  crossCheckUsed: boolean;
  inPooledSpace: boolean;
  /**
   * Set when the run searched a limited keyspace built from the user's own
   * seed knowledge (their words fixed, declared slots varying over the full
   * BIP-39 list). Mirrors api/src/types.ts.
   */
  limitedKeyspace: LimitedKeyspace | null;
}

/**
 * The disclosed keyspace of a limited-keyspace run: varied positions sweep
 * the full BIP-39 wordlist, so the true phrase is inside by construction and
 * a genuine match is reachable. Mirrors api/src/types.ts.
 */
export interface LimitedKeyspace {
  /** 1-indexed phrase positions that vary over the full wordlist. */
  variedPositions1Indexed: number[];
  /** Distinct words each varied position ranges over (the full BIP-39 list). */
  poolWords: number;
  /** Raw assemblies: poolWords^prefixSlots × poolWords. */
  rawAssemblies: number;
  /** Checksum-valid candidates the enumeration is expected to derive. */
  estimatedChecksumValid: number;
  /** True by construction: the varied slots sweep the full wordlist. */
  containsPhraseByConstruction: true;
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
  /** Set when the run's target was derived from a user-supplied seed phrase. */
  customWallet?: CustomWalletProvenance | null;
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
  /** Corpus-mode target; required unless customWallet is supplied. */
  address?: string;
  workers?: number;
  force?: boolean;
  quantumBits?: number;
  /** "Test with your own wallet": the target is derived from this mnemonic. */
  customWallet?: {
    mnemonic: string;
    passphrase?: string;
    /** Optional cross-check — must equal the derived address. */
    expectedAddress?: string;
    /**
     * Limited-keyspace mode: 0-based phrase positions to vary over the FULL
     * BIP-39 wordlist while every other position stays fixed. Classical
     * mode only; the disclosed keyspace contains the phrase by construction.
     */
    varySlots?: number[];
  };
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
  customWallet?: CustomWalletProvenance;
  targetNote?: string;
}

export interface QuantumStart {
  runId: string;
  mode: "quantum";
  totalCandidates: number;
  note: string;
  customWallet?: CustomWalletProvenance;
  targetNote?: string;
}

export type CrackStart = ClassicStart | QuantumStart;

// ── POST /derive ────────────────────────────────────────────────────────────

export interface DeriveResponse {
  mnemonic: string;
  addresses: AllAddresses;
  paths: { eth: string; btc_p2pkh: string; btc_bech32: string };
  poolMembership: {
    inSpace: boolean;
    totalPrefixes: number;
    rawCandidates: number;
  };
}

export interface Cancelled {
  runId: string;
  cancelled: boolean;
}
