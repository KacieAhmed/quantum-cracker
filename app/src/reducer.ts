import type { AnyMatchInfo, RunStatus, ServerMessage } from "./types";

/**
 * UI state folded from the WS event stream (pure — unit-testable). A `match`
 * event usually arrives shortly before its `done` event; folding both keeps
 * the result panel stable whichever ordering the socket delivers.
 */
export interface RunUiState {
  report: RunReportView | null;
  match: { runId: string; match: AnyMatchInfo; workerId: number } | null;
  /** Last terminal `done` event (status + runId). */
  lastDone: { runId: string; status: RunStatus } | null;
  socketError: string | null;
  /**
   * The pinned first candidate (tested before any random sampling), for the
   * feed's labeled row. Cleared when a new run's first snapshot arrives.
   */
  pinnedEntry: { runId: string; phrase: string; label: string; tested: boolean } | null;
}

export type RunReportView = import("./types").RunReport;

export const emptyRunUiState: RunUiState = {
  report: null,
  match: null,
  lastDone: null,
  socketError: null,
  pinnedEntry: null,
};

export function foldMessage(state: RunUiState, msg: ServerMessage): RunUiState {
  switch (msg.type) {
    case "snapshot":
      return {
        ...state,
        report: msg.report,
        socketError: null,
        // New run: the pinned entry belongs to the previous one.
        pinnedEntry:
          state.report !== null && state.report.runId !== msg.report.runId
            ? null
            : state.pinnedEntry,
      };
    case "pinned":
      // Arrives before the first snapshot on purpose: the pin is tested
      // FIRST — the randomization boundary the feed labels.
      return {
        ...state,
        pinnedEntry: {
          runId: msg.runId,
          phrase: msg.phrase,
          label: msg.label,
          tested: msg.tested,
        },
      };
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
    case "error":
      return { ...state, socketError: msg.message };
  }
}
