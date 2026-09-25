import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  Aggregate,
  AnyMatchInfo,
  Chain,
  CustomWalletProvenance,
  LaneState,
  MatchInfo,
  Mode,
  PreSeedDiscoveryInfo,
  ProbeProvenance,
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
  /** Limited-keyspace pool config passed to every lane (--pool-json). */
  poolJsonPath?: string | null;
  /**
   * Shuffle seed for the randomized traversal — ALL lanes share it, so
   * their claimed ranges stay disjoint under the same permutation.
   */
  seed?: string | null;
  /**
   * Pinned first candidate (own-wallet runs: the user's phrase; corpus
   * runs: the calibration phrase). Tested before any traversal, once —
   * lane 0 only.
   */
  pinnedFirst?: string | null;
  /** Any-address feasibility probe: passes --probe to lanes, stamps the report. */
  probe?: ProbeProvenance | null;
  /** Discovery watchlist file handed to every lane (--watchlist). */
  watchlistPath?: string | null;
  /** Called once when the run settles; the pool file's owner cleans it up. */
  onSettled?: () => void;
}

export interface StartLotteryParams {
  runId: string;
  chain: Chain;
  address: string;
  addressType: string;
  /** Safety cap on raw draws — the run never claims to finish the space. */
  drawBudget: number;
  progressMs: number;
  customWallet?: CustomWalletProvenance | null;
  /** Shuffle/draw-stream seed (one lane; kept for parity with runs). */
  seed?: string | null;
  /** Pinned first candidate — the user's own phrase on own-wallet runs. */
  pinnedFirst?: string | null;
  /**
   * Probe permission + provenance for ADDRESS-ONLY lottery runs: the same
   * full-space lottery as own-wallet mode, but the target is any valid
   * address with no seed in the request, so the run carries the probe label.
   */
  probe?: ProbeProvenance | null;
  /**
   * Own-wallet lottery attestation: the target was derived from the mnemonic
   * in this request, so the engine's derived-target permission applies.
   */
  derivedTarget?: boolean;
  /** Discovery watchlist file passed to the lane (--watchlist). */
  watchlistPath?: string | null;
  /**
   * The report's mode label: "classic" for classic runs, "quantum" when the
   * lottery is the classical leg of quantum mode. Traversal is identical —
   * only the UI framing differs.
   */
  mode?: Mode;
}

/** Pre-seed P2PK lottery params: targetless — the watchlist IS the target set. */
export interface StartPreSeedParams {
  runId: string;
  /** Safety cap on raw scalar draws — never a coverage claim. */
  drawBudget: number;
  progressMs: number;
  /** Draw-stream seed (kept for parity with lottery runs). */
  seed?: string | null;
  /** The pre-seed consent gate: the API resolved it (probe: true) and stamps
   * the disclosure here; the lane runs with --probe so events carry the label. */
  probe: ProbeProvenance;
  /** The Satoshi-era P2PK watchlist asset (--preseed-watchlist). Integrity
   * is verified by BOTH sides: the API pins its SHA-256, the engine re-checks
   * per spawn — belt and suspenders on the load-bearing list. */
  preseedWatchlistPath: string;
  /** Rich-address watchlist: labels a discovery, never ends the run. */
  watchlistPath?: string | null;
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
}

interface ActiveRun {
  report: RunReport;
  startedAtMs: number;
  procs: Map<number, LaneProcess>;
  status: RunStatus;
  match: AnyMatchInfo | null;
  firstMatchWorker: number | null;
  errorMessage: string | null;
  broadcastTimer: NodeJS.Timeout | null;
  broadcast: Broadcast;
  onSettled: (() => void) | null;
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
  private active: ActiveRun | null = null;

  constructor(options: RunManagerOptions) {
    this.opts = {
      cliPath: options.cliPath,
      runsDir: options.runsDir,
      broadcastIntervalMs: options.broadcastIntervalMs ?? 250,
    };
    this.spawnLaneFn = options.spawnLaneFn ?? spawnLane;
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
      probe: params.probe ?? null,
    });
    const run: ActiveRun = {
      report,
      startedAtMs: Date.now(),
      procs: new Map(),
      status: "running",
      match: null,
      firstMatchWorker: null,
      errorMessage: null,
      broadcastTimer: null,
      broadcast,
      onSettled: params.onSettled ?? null,
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
        poolJsonPath: params.poolJsonPath ?? null,
        seed: params.seed ?? null,
        pinnedFirst: id === 0 ? (params.pinnedFirst ?? null) : "",
        watchlistPath: params.watchlistPath ?? null,
        // Custom-wallet runs attest in-request derivation: the target came
        // from the mnemonic in this request, so the engine's derived-target
        // permission (not the probe label) applies.
        ...(params.customWallet != null && params.probe == null
          ? { derivedTarget: true }
          : {}),
        ...(params.probe === null || params.probe === undefined
          ? {}
          : { probe: true }),
      });
      run.procs.set(id, proc);
      void this.consumeLane(run, proc);
    }
    this.broadcastSnapshot();
    return report;
  }

  /**
   * Full-space lottery: one lane samples raw phrases uniformly at random
   * over ALL checksum-valid 12-word assemblies (2^128 ≈ 3.4×10^38 of them)
   * until the draw budget is spent or the run is stopped. No coverage
   * claim — the caller's disclosure copy states the odds up front. Also
   * the classical search leg of quantum mode (mode label "quantum").
   */
  startLottery(params: StartLotteryParams, broadcast: Broadcast): RunReport {
    if (this.active) throw new Error("a run is already active");
    const report = newReport({
      runId: params.runId,
      chain: params.chain,
      mode: params.mode ?? "classic",
      address: params.address,
      workersRequested: 1,
      // The run's bounded resource is the draw budget, not the space.
      totalCandidates: params.drawBudget,
      rawCandidates: params.drawBudget,
      lanes: [emptyLane(0, { start: 0, count: 0 })],
      customWallet: params.customWallet ?? null,
      probe: params.probe ?? null,
    });
    report.searchKind = "lottery";
    const run: ActiveRun = {
      report,
      startedAtMs: Date.now(),
      procs: new Map(),
      status: "running",
      match: null,
      firstMatchWorker: null,
      errorMessage: null,
      broadcastTimer: null,
      broadcast,
      onSettled: null,
    };
    this.active = run;
    run.broadcastTimer = setInterval(
      () => this.broadcastSnapshot(),
      this.opts.broadcastIntervalMs,
    );
    const proc = this.spawnLaneFn(this.opts.cliPath, {
      id: 0,
      start: 0,
      // The lane's span is the draw budget, so fraction = draws/budget.
      count: params.drawBudget,
      address: params.address,
      addressType: params.addressType,
      progressMs: params.progressMs,
      poolJsonPath: null,
      randomDraws: params.drawBudget,
      seed: params.seed ?? null,
      pinnedFirst: params.pinnedFirst ?? null,
      watchlistPath: params.watchlistPath ?? null,
      // Address-only lotteries carry the probe label; own-wallet lotteries
      // attest in-request derivation instead (mutually exclusive).
      ...(params.derivedTarget === true ? { derivedTarget: true } : {}),
      ...(params.probe === null || params.probe === undefined
        ? {}
        : { probe: true }),
    });
    run.procs.set(0, proc);
    void this.consumeLane(run, proc);
    this.broadcastSnapshot();
    return report;
  }

  /**
   * Pre-seed P2PK lottery: one lane draws random secp256k1 scalars in [1, n),
   * derives each public key, and tests membership in the Satoshi-era P2PK
   * watchlist until the draw budget is spent, the run is stopped, or a
   * watchlisted key is found (an immediate, frozen DISCOVERY — there is no
   * user target in this mode). Bitcoin only; the caller owns the consent gate.
   */
  startPreSeed(params: StartPreSeedParams, broadcast: Broadcast): RunReport {
    if (this.active) throw new Error("a run is already active");
    const report = newReport({
      runId: params.runId,
      chain: "bitcoin",
      mode: "preseed",
      // No user target exists in this mode; the discovery payload carries
      // the matched watchlist key and its derived addresses.
      address: "",
      workersRequested: 1,
      // The run's bounded resource is the draw budget, not the space.
      totalCandidates: params.drawBudget,
      rawCandidates: params.drawBudget,
      lanes: [emptyLane(0, { start: 0, count: 0 })],
      customWallet: null,
      probe: params.probe,
    });
    report.searchKind = "lottery";
    const run: ActiveRun = {
      report,
      startedAtMs: Date.now(),
      procs: new Map(),
      status: "running",
      match: null,
      firstMatchWorker: null,
      errorMessage: null,
      broadcastTimer: null,
      broadcast,
      onSettled: null,
    };
    this.active = run;
    run.broadcastTimer = setInterval(
      () => this.broadcastSnapshot(),
      this.opts.broadcastIntervalMs,
    );
    const proc = this.spawnLaneFn(this.opts.cliPath, {
      id: 0,
      start: 0,
      // The lane's span is the draw budget, so fraction = draws/budget.
      count: params.drawBudget,
      progressMs: params.progressMs,
      preseedDraws: params.drawBudget,
      preseedWatchlistPath: params.preseedWatchlistPath,
      watchlistPath: params.watchlistPath ?? null,
      seed: params.seed ?? null,
      // The lane runs with the probe label inseparable from the consent.
      probe: true,
    });
    run.procs.set(0, proc);
    void this.consumeLane(run, proc);
    this.broadcastSnapshot();
    return report;
  }
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
      const cancelled = run.status === "cancelled";
      if (signal !== null || code === null) {
        // Killed lanes: the run manager stopped them (cancel, or cancel-on-
        // match), which is not a lane error. Anything else is real.
        lane.status =
          run.status === "cancelled" || run.status === "matched"
            ? "killed"
            : "error";
      } else {
        lane.status = code === 0 || code === 1 ? "done" : "error";
      }
      if (lane.status === "error" && !cancelled) {
        // A lane that died on its own must say why — the engine's stderr is
        // the only diagnostic for usage errors and panics. Swallowing it
        // turns a diagnosable failure into a silent "error" status.
        const stderr = (await proc.stderr).trim();
        run.errorMessage =
          run.errorMessage ??
          `lane ${proc.lane.id} exited with ${signal ?? `code ${code}`}${
            stderr.length > 0 ? `: ${stderr}` : " (no stderr output)"
          }`;
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
        // Lottery/pre-seed lanes span their draw budget (the only bounded
        // resource); bounded lanes span prefix ordinals. Reading draw_budget
        // first keeps the span units aligned regardless of what else the
        // event carries.
        lane.end =
          lane.start +
          (event.mode === "lottery" || event.mode === "preseed"
            ? (event.draw_budget ?? 0)
            : (event.end ?? event.total_prefixes ?? 0));
        break;
      }
      case "pinned": {
        // Tested first, labeled "pinned — not random": the randomization
        // boundary in the UI feed. `tested: false` means the phrase failed
        // BIP-39 validation and was skipped, never silently remapped.
        if (event.phrase !== undefined) {
          run.broadcast({
            type: "pinned",
            runId: run.report.runId,
            phrase: event.phrase,
            label: event.label ?? "pinned — not random",
            tested: event.tested ?? false,
          });
        }
        break;
      }
      case "progress": {
        // Lottery lanes report consumed draw budget instead of prefix ordinals.
        lane.prefixesDone =
          event.prefixes_done ?? event.draws_done ?? lane.prefixesDone;
        lane.derived = event.derived ?? lane.derived;
        // Pre-seed progress has no derivations — its honest rate is raw
        // scalar draws/s, the figure the disclosure odds are computed from.
        lane.rate =
          event.mode === "preseed"
            ? (event.draws_per_sec ?? lane.rate)
            : (event.derived_per_sec ?? lane.rate);
        lane.frontierPrefix = event.frontier_prefix ?? lane.frontierPrefix;
        // Pre-seed's live feed shows the most recently tested PUBLIC KEY —
        // the same slot the phrase feed uses, honestly relabeled in the UI.
        lane.frontierPhrase =
          event.frontier_pubkey !== undefined
            ? event.frontier_pubkey
            : (event.frontier_phrase ?? null);
        const span = lane.end - lane.start;
        lane.fraction = span > 0 ? lane.prefixesDone / span : 1;
        break;
      }
      case "match": {
        const m = event.match;
        if (!m) break;
        let info: MatchInfo | PreSeedDiscoveryInfo;
        if ("preseed" in m) {
          const p = m.preseed;
          info = {
            privateKeyHex: p.private_key_hex,
            wif: p.wif,
            pubkeyCompressedHex: p.pubkey_compressed_hex,
            pubkeyUncompressedHex: p.pubkey_uncompressed_hex,
            matchedWatchlistKey: p.matched_watchlist_key,
            addressP2pkhCompressed: p.address_p2pkh_compressed,
            addressP2pkhUncompressed: p.address_p2pkh_uncompressed,
            richWatchlistHit: p.rich_watchlist_hit,
          };
          // A pre-seed discovery is ALWAYS a discovery — there is no user
          // target. Stamp it on the report immediately (not just at settle)
          // so snapshots and the match broadcast carry it.
          run.report.preseedDiscovery = info;
        } else {
          info = {
            mnemonic: m.mnemonic,
            path: m.path,
            address: m.address,
            allAddresses: m.all_addresses,
            derivationPath: event.derivation_path,
            discovery: event.discovery ?? false,
          };
        }
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

  private settleIfComplete(run: ActiveRun): void {
    const allSettled = [...run.procs.values()].every((p) => {
      const lane = run.report.lanes[p.lane.id];
      return lane && lane.status !== "starting" && lane.status !== "running";
    });
    if (!allSettled) return;
    this.finalize(run);
  }

  private finalize(run: ActiveRun): void {
    if (run.broadcastTimer) clearInterval(run.broadcastTimer);
    run.broadcastTimer = null;
    if (run.status === "running") {
      const anyError = run.report.lanes.some((l) => l.status === "error");
      // A lottery that spends its budget without a match did NOT exhaust a
      // finishable space — the honest end state is budget-reached, never a
      // coverage claim. Bounded spaces (pools) genuinely exhaust.
      run.status =
        anyError
          ? "error"
          : run.report.searchKind === "lottery"
            ? "budget-reached"
            : "exhausted";
    }
    run.report.status = run.status;
    run.report.match = run.match;
    run.report.preseedDiscovery = isPreseed(run.match) ? run.match : null;
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
    // Owner-supplied cleanup (limited-keyspace pool file); failures surface
    // but never fail an already-settled run.
    if (run.onSettled !== null) {
      try {
        run.onSettled();
      } catch (err) {
        console.error(`run ${run.report.runId} cleanup failed:`, err);
      }
    }
  }

  private aggregateOf(run: ActiveRun): Aggregate {
    let derived = 0;
    let consumed = 0;
    let rate = 0;
    for (const lane of run.report.lanes) {
      derived += lane.derived;
      // Lottery lanes report consumed raw draws (including checksum-rejected
      // assemblies) in prefixesDone; bounded lanes derive once per ordinal,
      // so max() is the honest consumed-work figure for both.
      consumed += Math.max(lane.derived, lane.prefixesDone);
      rate += lane.rate;
    }
    const total = run.report.totalCandidates;
    const fraction = total > 0 ? consumed / total : 0;
    const etaSeconds = rate > 0 ? (total - consumed) / rate : null;
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

/** Pre-seed discoveries and phrase matches share one slot; narrow here. */
function isPreseed(
  match: MatchInfo | PreSeedDiscoveryInfo | null,
): match is PreSeedDiscoveryInfo {
  return match !== null && "privateKeyHex" in match;
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
  probe: ProbeProvenance | null;
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
    preseedDiscovery: null,
    customWallet: args.customWallet,
    probe: args.probe,
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
