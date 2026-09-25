/** Shared run/lane/event types for the orchestrator. */

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

export interface MatchInfo {
  mnemonic: string;
  path: string;
  address: string;
  allAddresses: { eth: string; btc_p2pkh: string; btc_bech32: string };
  /** Canonical BIP-32 path the engine walked for this match, when known. */
  derivationPath?: string;
}

/**
 * Provenance of a run whose search target was derived from a user-supplied
 * seed phrase ("test with your own wallet"). The target is always the
 * engine-derived address — a freeform third-party address is never accepted —
 * and an optional typed address is only a cross-check. The phrase itself is
 * deliberately not stored here: it appears in `match` only if the run matches.
 */
export interface CustomWalletProvenance {
  targetSource: "derived-from-mnemonic";
  derivedAddresses: { eth: string; btc_p2pkh: string; btc_bech32: string };
  paths: { eth: string; btc_p2pkh: string; btc_bech32: string };
  /** Whether a typed cross-check address was supplied and matched. */
  crossCheckUsed: boolean;
  /** Whether the phrase lies inside the bounded pooled demo keyspace. */
  inPooledSpace: boolean;
  /**
   * Set when the run searched a limited keyspace built from the user's own
   * seed knowledge (their words fixed, declared slots varying over the full
   * BIP-39 list). The target is still derived from the same request's
   * mnemonic; the disclosed space contains the true phrase by construction.
   */
  limitedKeyspace: LimitedKeyspace | null;
}

/**
 * The disclosed keyspace of a limited-keyspace run: varied positions sweep
 * the full BIP-39 wordlist, so the true phrase is inside by construction and
 * a genuine match is reachable — stated up front, not discovered at exhaustion.
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

/**
 * Provenance of an any-address feasibility-probe run: the user typed a
 * well-formed address with NO seed supplied. The run is a disclosed bounded
 * probe of the bundled pooled demo space — never the declared address's real
 * space — and a match is claimed exactly when a tested phrase derives the
 * target (derivation equality, nothing else counts).
 */
export interface ProbeProvenance {
  targetSource: "any-address-probe";
  /** The bounded space actually searched: the bundled pooled demo space. */
  searchedSpace: "bundled-pooled-demo-space";
  /** Raw assemblies of the space that was searched. */
  searchedRawCandidates: number;
  /** Checksum-valid candidates of the space that was searched. */
  searchedChecksumValid: number;
  /** The declared address's real space was NOT searched. */
  declaredSpaceSearched: false;
  /** Up-front honest framing: this address will not be found; here's the math. */
  disclosure: string;
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
  lanes: Array<LaneState & { start: number; end: number }>;
  totalCandidates: number;
  rawCandidates: number;
  startedAt: string;
  finishedAt: string | null;
  elapsedMs: number | null;
  aggregate: Aggregate | null;
  match: MatchInfo | null;
  quantum: unknown | null;
  /** Set when the run's target was derived from a user-supplied seed phrase. */
  customWallet: CustomWalletProvenance | null;
  /** Set when the run is an explicitly disclosed any-address feasibility probe. */
  probe: ProbeProvenance | null;
}

/** WS messages the API broadcasts. */
export type ServerMessage =
  | { type: "snapshot"; report: RunReport }
  | { type: "match"; runId: string; match: MatchInfo; workerId: number }
  | { type: "done"; runId: string; status: RunStatus; report: RunReport }
  | { type: "quantum_result"; runId: string; payload: unknown }
  | { type: "error"; runId: string | null; message: string };
