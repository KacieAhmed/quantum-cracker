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
}

/** WS messages the API broadcasts. */
export type ServerMessage =
  | { type: "snapshot"; report: RunReport }
  | { type: "match"; runId: string; match: MatchInfo; workerId: number }
  | { type: "done"; runId: string; status: RunStatus; report: RunReport }
  | { type: "quantum_result"; runId: string; payload: unknown }
  | { type: "error"; runId: string | null; message: string };
