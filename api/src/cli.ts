import { spawn } from "node:child_process";
import readline from "node:readline";
import type { LaneRange } from "./types.js";

/** Raw JSON events cracker-cli streams on stdout (one per line). */
export interface CliEvent {
  event: "start" | "progress" | "match" | "done";
  total_prefixes?: number;
  raw_candidates?: number;
  start?: number;
  end?: number;
  workers?: number | null;
  prefixes_done?: number;
  derived?: number;
  derived_per_sec?: number;
  fraction_of_space?: number;
  matches?: number;
  frontier_prefix?: number;
  frontier_phrase?: string | null;
  match?: {
    mnemonic: string;
    path: string;
    address: string;
    all_addresses: { eth: string; btc_p2pkh: string; btc_bech32: string };
  };
  recovered?: string | null;
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
}

export interface LaneProcess {
  lane: LaneSpec;
  events: AsyncIterable<{ source: "out"; line: string }>;
  stderr: Promise<string>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(signal?: NodeJS.Signals): void;
}

/** Spawn one cracker-cli lane scanning [start, start+count) single-threaded. */
export function spawnLane(cliPath: string, spec: LaneSpec): LaneProcess {
  const args = [
    "--target",
    spec.address,
    "--address-type",
    spec.addressType,
    "--start",
    String(spec.start),
    "--count",
    String(spec.count),
    "--workers",
    "1",
    "--progress-ms",
    String(spec.progressMs),
  ];
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

/** Cached-at-boot corpus + space info from the engine's embedded wallets.json. */
export async function listTargets(
  cliPath: string,
  timeoutMs = 10_000,
): Promise<CorpusDoc> {
  const { stdout } = await runCapture(cliPath, ["--list-targets"], timeoutMs);
  return JSON.parse(stdout) as CorpusDoc;
}
