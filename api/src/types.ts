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
  /**
   * True when the candidate derives an address on the discovery watchlist
   * rather than the requested target: a real-world wallet found by chance,
   * labeled and surfaced differently from a requested-target recovery.
   */
  discovery: boolean;
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
  /**
   * Address-only lottery runs: no seed phrase is involved, the target may be
   * ANY valid address, and the run is a disclosed draw-budget lottery over
   * the checksum-valid phrase space.
   */
  targetSource: "addressOnly";
  /**
   * The space actually searched: ALL checksum-valid 12-word BIP-39 phrases
   * (2^128 ≈ 3.4×10^38) — the same full-space lottery own-wallet mode runs.
   */
  searchedSpace: "all-checksum-valid-12-word-bip39-phrases";
  /**
   * Raw pre-checksum assemblies of the searched space (2048^12 ≈ 5.4×10^39).
   * Exceeds exact integer range — the disclosure text carries the math;
   * null when not applicable.
   */
  searchedRawCandidates: number | null;
  /** Checksum-valid candidates of the searched space (2^128), or null. */
  searchedChecksumValid: number | null;
  /** The declared address's real space was NOT searched (nobody can be). */
  declaredSpaceSearched: false;
  /** Up-front honest framing: odds, budget, discovery watchlist. */
  disclosure: string;
}

export type RunStatus =
  | "running"
  | "matched"
  | "exhausted"
  | "budget-reached"
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
  /**
   * How the run traverses its space: bounded = shuffled exhaustive coverage
   * (finishable, ETA disclosed), lottery = uniform random sampling of the
   * full 2^128 checksum-valid phrase space (no finishability claim). A
   * report without this field is a bounded/classic run.
   */
  searchKind?: "bounded" | "lottery";
  /** Set when the run is an explicitly disclosed any-address feasibility probe. */
  probe: ProbeProvenance | null;
}

/** WS messages the API broadcasts. */
export type ServerMessage =
  | { type: "snapshot"; report: RunReport }
  | { type: "match"; runId: string; match: MatchInfo; workerId: number }
  | { type: "done"; runId: string; status: RunStatus; report: RunReport }
  | { type: "quantum_result"; runId: string; payload: unknown }
  | { type: "error"; runId: string | null; message: string }
  /**
   * The pinned first candidate was tested before any traversal/sampling
   * ("pinned — not random"). `tested` is false when the phrase failed
   * BIP-39 validation; it is then skipped, never silently remapped.
   */
  | { type: "pinned"; runId: string; phrase: string; label: string; tested: boolean };
