import type { MatchInfo, RunStatus, ServerMessage } from "./types";

/**
 * UI state folded from the WS event stream (pure — unit-testable). A `match`
 * event usually arrives shortly before its `done` event; folding both keeps
 * the result panel stable whichever ordering the socket delivers.
 */
export interface RunUiState {
  report: RunReportView | null;
  match: { runId: string; match: MatchInfo; workerId: number } | null;
  /** Last terminal `done` event (status + runId). */
  lastDone: { runId: string; status: RunStatus } | null;
  quantumPayload: unknown | null;
  socketError: string | null;
}

export type RunReportView = import("./types").RunReport;

export const emptyRunUiState: RunUiState = {
  report: null,
  match: null,
  lastDone: null,
  quantumPayload: null,
  socketError: null,
};

export function foldMessage(state: RunUiState, msg: ServerMessage): RunUiState {
  switch (msg.type) {
    case "snapshot":
      return { ...state, report: msg.report, socketError: null };
    case "match":
      return {
        ...state,
        match: { runId: msg.runId, match: msg.match, workerId: msg.workerId },
        // Stamp the match immediately so the panel never waits for `done`.
        report: state.report
          ? { ...state.report, status: "matched", match: msg.match }
          : state.report,
      };
    case "done":
      return {
        ...state,
        report: msg.report,
        lastDone: { runId: msg.runId, status: msg.status },
      };
    case "quantum_result":
      return { ...state, quantumPayload: msg.payload };
    case "error":
      return { ...state, socketError: msg.message };
  }
}
