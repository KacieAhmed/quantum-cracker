import { describe, expect, it } from "vitest";
import { emptyRunUiState, foldMessage } from "./reducer";
import type { MatchInfo, RunReport, ServerMessage } from "./types";

function fakeReport(overrides: Partial<RunReport> = {}): RunReport {
  return {
    runId: "run_test_1",
    status: "running",
    chain: "bitcoin",
    mode: "classic",
    address: "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
    workersRequested: 4,
    lanes: [],
    totalCandidates: 1_048_576,
    rawCandidates: 16_777_216,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    elapsedMs: null,
    aggregate: null,
    match: null,
    quantum: null,
    ...overrides,
  };
}

const fakeMatch: MatchInfo = {
  mnemonic: "ocean abstract raven accident hill absent winter abstract candy abuse mango able",
  path: "m/44'/0'/0'/0/0",
  address: "16HxxyAQvA3AKThfcJGxSqKJ3Hs9RnTgHp",
  allAddresses: {
    eth: "0xb79f8aC312fF21AD16980a857f574A6e7e3ED9c5",
    btc_p2pkh: "16HxxyAQvA3AKThfcJGxSqKJ3Hs9RnTgHp",
    btc_bech32: "bc1qnm5mmckh08leuwsygfre0ls0vp7vstdju0wm57",
  },
};

describe("foldMessage", () => {
  it("starts empty", () => {
    expect(emptyRunUiState.report).toBeNull();
    expect(emptyRunUiState.match).toBeNull();
  });

  it("snapshot replaces the report and clears socket errors", () => {
    const withError = { ...emptyRunUiState, socketError: "stale" };
    const state = foldMessage(withError, { type: "snapshot", report: fakeReport() });
    expect(state.report?.runId).toBe("run_test_1");
    expect(state.socketError).toBeNull();
  });

  it("match stamps the match and flips the report to matched immediately", () => {
    let state = foldMessage(emptyRunUiState, { type: "snapshot", report: fakeReport() });
    state = foldMessage(state, {
      type: "match",
      runId: "run_test_1",
      match: fakeMatch,
      workerId: 3,
    });
    expect(state.match?.workerId).toBe(3);
    expect(state.report?.status).toBe("matched");
    expect(state.report?.match?.mnemonic).toContain("ocean abstract");
  });

  it("match survives arriving before any snapshot", () => {
    const state = foldMessage(emptyRunUiState, {
      type: "match",
      runId: "run_test_1",
      match: fakeMatch,
      workerId: 0,
    });
    expect(state.match).not.toBeNull();
    expect(state.report).toBeNull();
  });

  it("done replaces the report and records the terminal status", () => {
    let state = foldMessage(emptyRunUiState, { type: "snapshot", report: fakeReport() });
    state = foldMessage(state, {
      type: "done",
      runId: "run_test_1",
      status: "matched",
      report: fakeReport({ status: "matched", match: fakeMatch }),
    });
    expect(state.lastDone).toEqual({ runId: "run_test_1", status: "matched" });
    expect(state.report?.status).toBe("matched");
  });

  it("quantum_result stores the payload", () => {
    const msg: ServerMessage = {
      type: "quantum_result",
      runId: "run_q1",
      payload: { grover_iterations: 12, measured: "101" },
    };
    const state = foldMessage(emptyRunUiState, msg);
    expect(state.quantumPayload).toEqual({ grover_iterations: 12, measured: "101" });
  });

  it("error records the message", () => {
    const state = foldMessage(emptyRunUiState, {
      type: "error",
      runId: null,
      message: "engine unavailable",
    });
    expect(state.socketError).toBe("engine unavailable");
  });

  it("pinned stores the tested-first candidate with its label", () => {
    const state = foldMessage(emptyRunUiState, {
      type: "pinned",
      runId: "run_p1",
      phrase: "permit bean gaze lawsuit expect exclude poet mercy enrich measure ocean since",
      label: "pinned — not random",
      tested: true,
    });
    expect(state.pinnedEntry).toMatchObject({ runId: "run_p1", tested: true });
    expect(state.pinnedEntry?.label).toBe("pinned — not random");
  });

  it("a new run's first snapshot clears a stale pinned entry", () => {
    const pinned = foldMessage(emptyRunUiState, {
      type: "pinned",
      runId: "run_p1",
      phrase: "alpha beta",
      label: "pinned — not random",
      tested: true,
    });
    const withReport = foldMessage(pinned, {
      type: "snapshot",
      report: { runId: "run_p1" } as RunReport,
    });
    expect(withReport.pinnedEntry).not.toBeNull();
    const nextRun = foldMessage(withReport, {
      type: "snapshot",
      report: { runId: "run_p2" } as RunReport,
    });
    expect(nextRun.pinnedEntry).toBeNull();
  });
});
