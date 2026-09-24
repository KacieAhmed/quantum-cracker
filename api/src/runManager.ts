import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  Aggregate,
  Chain,
  CustomWalletProvenance,
  LaneState,
  MatchInfo,
  Mode,
  RunReport,
  RunStatus,
  ServerMessage,
} from "./types.js";
import type { LaneRange } from "./types.js";
import { spawnLane, type CliEvent, type LaneProcess } from "./cli.js";

export interface StartClassicParams {
  runId: string;
  chain: Chain;
  address: string;
  addressType: string;
  ranges: LaneRange[];
  totalCandidates: number;
  rawCandidates: number;
  progressMs: number;
  customWallet?: CustomWalletProvenance | null;
}

export interface StartQuantumParams {
  runId: string;
  chain: Chain;
  address: string;
  bits: number;
  customWallet?: CustomWalletProvenance | null;
}

/** Broadcast sink (the server wires this to every connected WebSocket). */
export type Broadcast = (msg: ServerMessage) => void;

export interface RunManagerOptions {
  cliPath: string;
  runsDir: string;
  /** How often aggregate snapshots are broadcast. */
  broadcastIntervalMs?: number;
  /** Injectable for tests: spawns a lane subprocess. */
  spawnLaneFn?: typeof spawnLane;
  /** Injectable for tests: runs the toy Grover simulation. */
  runQuantumFn?: (params: { bits: number }) => Promise<unknown>;
}

interface ActiveRun {
  report: RunReport;
  startedAtMs: number;
  procs: Map<number, LaneProcess>;
  status: RunStatus;
  match: MatchInfo | null;
  firstMatchWorker: number | null;
  quantumPayload: unknown | null;
  errorMessage: string | null;
  broadcastTimer: NodeJS.Timeout | null;
  broadcast: Broadcast;
}

/**
 * Owns the single active demo run: spawns one cracker-cli lane per disjoint
 * range, merges their progress into aggregate snapshots, cancels all lanes on
 * the first match, and writes a run report when everything settles.
 */
export class RunManager {
  private readonly opts: Required<
    Pick<RunManagerOptions, "cliPath" | "runsDir" | "broadcastIntervalMs">
  >;
  private readonly spawnLaneFn: typeof spawnLane;
  private readonly runQuantumFn: (params: { bits: number }) => Promise<unknown>;
  private active: ActiveRun | null = null;

  constructor(options: RunManagerOptions) {
    this.opts = {
      cliPath: options.cliPath,
      runsDir: options.runsDir,
      broadcastIntervalMs: options.broadcastIntervalMs ?? 250,
    };
    this.spawnLaneFn = options.spawnLaneFn ?? spawnLane;
    this.runQuantumFn =
      options.runQuantumFn ??
      (async () => {
        throw new Error("quantum runner not configured");
      });
  }

  get activeRunId(): string | null {
    return this.active?.report.runId ?? null;
  }

  get activeReport(): RunReport | null {
    return this.active?.report ?? null;
  }

  startClassic(params: StartClassicParams, broadcast: Broadcast): RunReport {
    if (this.active) throw new Error("a run is already active");
    const report = newReport({
      runId: params.runId,
      chain: params.chain,
      mode: "classic",
      address: params.address,
      workersRequested: params.ranges.length,
      totalCandidates: params.totalCandidates,
      rawCandidates: params.rawCandidates,
      lanes: params.ranges.map((r, i) => emptyLane(i, r)),
      customWallet: params.customWallet ?? null,
    });
    const run: ActiveRun = {
      report,
      startedAtMs: Date.now(),
      procs: new Map(),
      status: "running",
      match: null,
      firstMatchWorker: null,
      quantumPayload: null,
      errorMessage: null,
      broadcastTimer: null,
      broadcast,
    };
    this.active = run;
    run.broadcastTimer = setInterval(
      () => this.broadcastSnapshot(),
      this.opts.broadcastIntervalMs,
    );
    for (const [id, range] of params.ranges.entries()) {
      const proc = this.spawnLaneFn(this.opts.cliPath, {
        id,
        start: range.start,
        count: range.count,
        address: params.address,
        addressType: params.addressType,
        progressMs: params.progressMs,
      });
      run.procs.set(id, proc);
      void this.consumeLane(run, proc);
    }
    this.broadcastSnapshot();
    return report;
  }

  startQuantum(params: StartQuantumParams, broadcast: Broadcast): RunReport {
    if (this.active) throw new Error("a run is already active");
    const lane = emptyLane(0, { start: 0, count: 0 });
    lane.id = 0;
    const report = newReport({
      runId: params.runId,
      chain: params.chain,
      mode: "quantum",
      address: params.address,
      workersRequested: 1,
      totalCandidates: 2 ** params.bits,
      rawCandidates: 2 ** params.bits,
      lanes: [lane],
      customWallet: params.customWallet ?? null,
    });
    const run: ActiveRun = {
      report,
      startedAtMs: Date.now(),
      procs: new Map(),
      status: "running",
      match: null,
      firstMatchWorker: null,
      quantumPayload: null,
      errorMessage: null,
      broadcastTimer: null,
      broadcast,
    };
    this.active = run;
    run.broadcastTimer = setInterval(
      () => this.broadcastSnapshot(),
      this.opts.broadcastIntervalMs,
    );
    this.broadcastSnapshot();
    void this.consumeQuantum(run, params.bits);
    return report;
  }

  /** Halt the active run: kill every lane; settle() finalizes as cancelled. */
  cancel(): boolean {
    const run = this.active;
    if (!run || run.status !== "running") return false;
    run.status = "cancelled";
    for (const proc of run.procs.values()) proc.kill();
    return true;
  }

  private async consumeLane(run: ActiveRun, proc: LaneProcess): Promise<void> {
    const lane = run.report.lanes[proc.lane.id];
    if (!lane) throw new Error(`missing lane state ${proc.lane.id}`);
    lane.status = "running";
    try {
      for await (const { line } of proc.events) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        let event: CliEvent;
        try {
          event = JSON.parse(trimmed) as CliEvent;
        } catch {
          continue; // non-JSON noise on stdout: ignore, never crash the run
        }
        this.applyEvent(run, lane, proc.lane.id, event);
      }
      const { code, signal } = await proc.exited;
      if (signal !== null || code === null) {
        lane.status = run.status === "cancelled" ? "killed" : "error";
      } else {
        lane.status = code === 0 ? "done" : code === 1 ? "done" : "error";
      }
    } catch (err) {
      lane.status = "error";
      run.errorMessage =
        run.errorMessage ?? `lane ${proc.lane.id}: ${String(err)}`;
    }
    this.settleIfComplete(run);
  }

  private applyEvent(
    run: ActiveRun,
    lane: LaneState & { start: number; end: number },
    workerId: number,
    event: CliEvent,
  ): void {
    switch (event.event) {
      case "start": {
        lane.end = lane.start + (event.end ?? event.total_prefixes ?? 0);
        break;
      }
      case "progress": {
        lane.prefixesDone = event.prefixes_done ?? lane.prefixesDone;
        lane.derived = event.derived ?? lane.derived;
        lane.rate = event.derived_per_sec ?? lane.rate;
        lane.frontierPrefix = event.frontier_prefix ?? lane.frontierPrefix;
        lane.frontierPhrase = event.frontier_phrase ?? null;
        const span = lane.end - lane.start;
        lane.fraction = span > 0 ? lane.prefixesDone / span : 1;
        break;
      }
      case "match": {
        const m = event.match;
        if (!m) break;
        const info: MatchInfo = {
          mnemonic: m.mnemonic,
          path: m.path,
          address: m.address,
          allAddresses: m.all_addresses,
          derivationPath: event.derivation_path,
        };
        if (run.status === "running") {
          run.status = "matched";
          run.match = info;
          run.firstMatchWorker = workerId;
          // Cancel-on-match: the matched lane exits by itself; every other
          // lane is killed immediately so the demo stops burning CPU.
          for (const [id, other] of run.procs) {
            if (id !== workerId) other.kill();
          }
          run.broadcast({
            type: "match",
            runId: run.report.runId,
            match: info,
            workerId,
          });
        }
        break;
      }
      case "done":
        break; // final tallies arrive via the close event
    }
  }

  private async consumeQuantum(run: ActiveRun, bits: number): Promise<void> {
    const lane = run.report.lanes[0];
    if (lane) lane.status = "running";
    try {
      const payload = await this.runQuantumFn({ bits });
      run.quantumPayload = payload;
      run.status = "quantum_demo";
      run.broadcast({
        type: "quantum_result",
        runId: run.report.runId,
        payload,
      });
    } catch (err) {
      run.status = "error";
      run.errorMessage =
        run.errorMessage ?? `toy Grover simulation: ${String(err)}`;
    }
    this.settleIfComplete(run);
  }

  private settleIfComplete(run: ActiveRun): void {
    const allSettled = [...run.procs.values()].every((p) => {
      const lane = run.report.lanes[p.lane.id];
      return lane && lane.status !== "starting" && lane.status !== "running";
    });
    // Classic runs settle once every lane subprocess has exited; quantum runs
    // have no subprocesses and settle only when consumeQuantum calls this.
    if (!allSettled) return;
    this.finalize(run);
  }

  private finalize(run: ActiveRun): void {
    if (run.broadcastTimer) clearInterval(run.broadcastTimer);
    run.broadcastTimer = null;
    if (run.status === "running") {
      const anyError = run.report.lanes.some((l) => l.status === "error");
      run.status = anyError ? "error" : "exhausted";
    }
    run.report.status = run.status;
    run.report.match = run.match;
    run.report.quantum = run.quantumPayload;
    run.report.finishedAt = new Date().toISOString();
    run.report.elapsedMs = Date.now() - run.startedAtMs;
    run.report.aggregate = this.aggregateOf(run);
    this.active = null;
    void this.writeReport(run.report);
    run.broadcast({
      type: "done",
      runId: run.report.runId,
      status: run.status,
      report: run.report,
    });
  }

  private aggregateOf(run: ActiveRun): Aggregate {
    let derived = 0;
    let rate = 0;
    for (const lane of run.report.lanes) {
      derived += lane.derived;
      rate += lane.rate;
    }
    const total = run.report.totalCandidates;
    const fraction = total > 0 ? derived / total : 0;
    const etaSeconds = rate > 0 ? (total - derived) / rate : null;
    return {
      derived,
      derivedPerSec: rate,
      fractionOfKeyspace: fraction,
      etaSeconds,
      matches: run.match ? 1 : 0,
    };
  }

  private broadcastSnapshot(): void {
    const run = this.active;
    if (!run) return;
    run.report.aggregate = this.aggregateOf(run);
    run.report.status = run.status;
    run.report.elapsedMs = Date.now() - run.startedAtMs;
    run.report.match = run.match;
    run.broadcast({ type: "snapshot", report: run.report });
  }

  private async writeReport(report: RunReport): Promise<void> {
    await mkdir(this.opts.runsDir, { recursive: true });
    const file = path.join(this.opts.runsDir, `${report.runId}.json`);
    await writeFile(file, JSON.stringify(report, null, 2), "utf8");
  }
}

function newReport(args: {
  runId: string;
  chain: Chain;
  mode: Mode;
  address: string;
  workersRequested: number;
  totalCandidates: number;
  rawCandidates: number;
  lanes: Array<LaneState & { start: number; end: number }>;
  customWallet: CustomWalletProvenance | null;
}): RunReport {
  return {
    runId: args.runId,
    status: "running",
    chain: args.chain,
    mode: args.mode,
    address: args.address,
    workersRequested: args.workersRequested,
    lanes: args.lanes,
    totalCandidates: args.totalCandidates,
    rawCandidates: args.rawCandidates,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    elapsedMs: null,
    aggregate: null,
    match: null,
    quantum: null,
    customWallet: args.customWallet,
  };
}

function emptyLane(
  id: number,
  range: LaneRange,
): LaneState & { start: number; end: number } {
  return {
    id,
    start: range.start,
    end: range.start + range.count,
    prefixesDone: 0,
    derived: 0,
    rate: 0,
    fraction: 0,
    frontierPrefix: null,
    frontierPhrase: null,
    status: "starting",
  };
}
