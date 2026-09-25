import { spawn } from "node:child_process";
import readline from "node:readline";
import type { LaneRange } from "./types.js";

/** Raw JSON events cracker-cli streams on stdout (one per line). */
export interface CliEvent {
  event: "start" | "progress" | "match" | "done" | "pinned";
  total_prefixes?: number;
  raw_candidates?: number;
  start?: number;
  end?: number;
  workers?: number | null;
  /** Pool mode vs full-space lottery mode (done/start events). */
  mode?: string;
  /** Lottery-only counters: consumed draw budget + checksum-valid draws. */
  draw_budget?: number;
  draws_done?: number;
  checksum_valid?: number;
  /** Shuffle/draw-stream seed the lane is running under. */
  seed?: string;
  prefixes_done?: number;
  derived?: number;
  derived_per_sec?: number;
  fraction_of_space?: number;
  matches?: number;
  frontier_prefix?: number;
  frontier_phrase?: string | null;
  /** The BIP-32 path the engine actually walked for this match. */
  derivation_path?: string;
  match?: {
    mnemonic: string;
    path: string;
    address: string;
    all_addresses: { eth: string; btc_p2pkh: string; btc_bech32: string };
  };
  recovered?: string | null;
  /** Pinned-event fields: the tested-first candidate and its label. */
  phrase?: string;
  label?: string;
  tested?: boolean;
  matched?: boolean;
}

/** Output of cracker-cli --derive-mnemonic (one JSON object). */
export interface MnemonicDerivation {
  mnemonic: string;
  addresses: { eth: string; btc_p2pkh: string; btc_bech32: string };
  paths: { eth: string; btc_p2pkh: string; btc_bech32: string };
  pool_membership: {
    in_space: boolean;
    total_prefixes: number;
    raw_candidates: number;
  };
}

/** The engine rejected the mnemonic (bad word count, unknown word, checksum). */
export class MnemonicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MnemonicError";
  }
}

export interface TargetVerdict {
  target: string;
  valid: boolean;
  kind?: string;
  normalized?: string;
  error?: string;
}

export interface CorpusTarget {
  id: string;
  label: string;
  searchable: boolean;
  addresses: { eth: string; btc_p2pkh: string; btc_bech32: string };
}

export interface CorpusDoc {
  wallets: CorpusTarget[];
  space: { total_prefixes: number; raw_candidates: number };
}

/** Options for one classic lane subprocess. */
export interface LaneSpec extends LaneRange {
  id: number;
  address: string;
  /** Engine address kind: eth | btc-p2pkh | btc-bech32 (also btc). */
  addressType: string;
  progressMs: number;
  /**
   * Limited-keyspace pool config (pool words, fixed words, varied positions)
   * for template runs; null/undefined scans the bundled pooled corpus.
   */
  poolJsonPath?: string | null;
  /**
   * Lottery mode: sample this many raw phrases over the FULL 2^128
   * checksum-valid space instead of scanning prefix ranges.
   */
  randomDraws?: number | null;
  /** Shuffle/draw-stream seed — every lane of a run shares one. */
  seed?: string | null;
  /**
   * Pinned first candidate, tested before any traversal/sampling. Passed to
   * lane 0 only; other lanes get "" (pinning disabled) so the pin is tested
   * exactly once per run.
   */
  pinnedFirst?: string | null;
}

export interface LaneProcess {
  lane: LaneSpec;
  events: AsyncIterable<{ source: "out"; line: string }>;
  stderr: Promise<string>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(signal?: NodeJS.Signals): void;
}

/** Spawn one cracker-cli lane: a bounded range scan or a lottery sampler. */
export function spawnLane(cliPath: string, spec: LaneSpec): LaneProcess {
  const args = [
    "--target",
    spec.address,
    "--address-type",
    spec.addressType,
  ];
  if (spec.randomDraws !== undefined && spec.randomDraws !== null) {
    // Full-space lottery: the CLI parallelizes internally and ends at the
    // draw budget or when stopped.
    args.push(
      "--random-draws",
      String(spec.randomDraws),
      "--workers",
      "1",
      "--progress-ms",
      String(spec.progressMs),
    );
  } else {
    args.push(
      "--start",
      String(spec.start),
      "--count",
      String(spec.count),
      "--workers",
      "1",
      "--progress-ms",
      String(spec.progressMs),
    );
  }
  // Shared seed + explicit pin control on every lane: "" disables pinning
  // (the API pins lane 0 only, so the calibration/own phrase is tested once).
  if (spec.seed !== undefined && spec.seed !== null) {
    args.push("--seed", spec.seed);
  }
  args.push("--pinned-first", spec.pinnedFirst ?? "");
  if (spec.poolJsonPath !== undefined && spec.poolJsonPath !== null) {
    args.push("--pool-json", spec.poolJsonPath);
  }
  const child = spawn(cliPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  return {
    lane: spec,
    events: readLines(child),
    stderr: drain(child.stderr),
    exited: new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    }),
    kill: (signal = "SIGTERM") => {
      if (!child.killed && child.exitCode === null) child.kill(signal);
    },
  };
}

function readLines(
  child: ReturnType<typeof spawn>,
): AsyncIterable<{ source: "out"; line: string }> {
  const stream = child.stdout;
  async function* gen() {
    if (!stream) return;
    const rl = readline.createInterface({ input: stream });
    for await (const line of rl) {
      yield { source: "out" as const, line };
    }
  }
  return gen();
}

function drain(stream: NodeJS.ReadableStream | null): Promise<string> {
  return new Promise((resolve) => {
    if (!stream) return resolve("");
    let out = "";
    stream.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    stream.on("end", () => resolve(out));
    stream.on("error", () => resolve(out));
  });
}

function runCapture(
  cliPath: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

/** Validate address strings with the engine (cracker-cli --validate-only). */
export async function validateAddresses(
  cliPath: string,
  targets: string[],
  timeoutMs = 10_000,
): Promise<TargetVerdict[]> {
  const { stdout, code } = await runCapture(
    cliPath,
    ["--validate-only", ...targets.flatMap((t) => ["--target", t])],
    timeoutMs,
  );
  const verdicts = stdout
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as TargetVerdict);
  // The CLI exits 2 when any target is invalid; trust the per-target verdicts.
  void code;
  return verdicts;
}

/**
 * Derive every engine-supported address from a BIP-39 mnemonic — the same
 * derive::derive_addresses call the search engine runs per candidate, so the
 * derived address is exactly what a search match is compared against.
 * Throws MnemonicError (422 material) when the engine rejects the phrase.
 */
export async function deriveMnemonic(
  cliPath: string,
  mnemonic: string,
  passphrase: string,
  timeoutMs = 15_000,
): Promise<MnemonicDerivation> {
  const { stdout } = await runCapture(
    cliPath,
    ["--derive-mnemonic", mnemonic, "--passphrase", passphrase],
    timeoutMs,
  );
  const line = stdout.split("\n").find((l) => l.trim().length > 0);
  if (line === undefined) {
    throw new Error("engine returned no derivation output");
  }
  const parsed = JSON.parse(line) as MnemonicDerivation & { error?: string };
  if (typeof parsed.error === "string" && parsed.error.length > 0) {
    throw new MnemonicError(parsed.error);
  }
  return parsed;
}

/** Cached-at-boot corpus + space info from the engine's embedded wallets.json. */
export async function listTargets(
  cliPath: string,
  timeoutMs = 10_000,
): Promise<CorpusDoc> {
  const { stdout } = await runCapture(cliPath, ["--list-targets"], timeoutMs);
  return JSON.parse(stdout) as CorpusDoc;
}

export interface WordlistDoc {
  words: string[];
}

/**
 * The engine's embedded BIP-39 English wordlist (--list-wordlist): the single
 * source of truth for building limited-keyspace pool configs.
 */
export async function listWordlist(
  cliPath: string,
  timeoutMs = 10_000,
): Promise<WordlistDoc> {
  const { stdout } = await runCapture(cliPath, ["--list-wordlist"], timeoutMs);
  return JSON.parse(stdout) as WordlistDoc;
}
