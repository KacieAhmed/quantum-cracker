import { spawn } from "node:child_process";
import { QUANTUM_TIMEOUT_MS } from "./config.js";

export interface QuantumRunnerOptions {
  pythonBin: string;
  /** quantum/grover/src — the qcracker_grover package root. */
  groverSrcDir: string;
  timeoutMs?: number;
}

export interface QuantumRunParams {
  bits: number;
}

export interface QuantumResult {
  toy: true;
  nBits: number;
  /** The qcracker-grover CLI `run` payload, verbatim. */
  result: unknown;
}

/**
 * Toy Grover runner: spawns `python -m qcracker_grover run --n-bits <bits>`
 * with the package resolved from the repo checkout (no install required).
 * The toy oracle is a bit-mixer, NOT BIP-39 — results are educational
 * simulations and must be presented as such (see QUANTUM_NOTE).
 */
export function makeQuantumRunner(options: QuantumRunnerOptions) {
  const timeoutMs = options.timeoutMs ?? QUANTUM_TIMEOUT_MS;
  return async ({ bits }: QuantumRunParams): Promise<QuantumResult> => {
    const result = await runToyGrover({
      pythonBin: options.pythonBin,
      groverSrcDir: options.groverSrcDir,
      bits,
      timeoutMs,
    });
    return { toy: true, nBits: bits, result };
  };
}

function runToyGrover(args: {
  pythonBin: string;
  groverSrcDir: string;
  bits: number;
  timeoutMs: number;
}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      args.pythonBin,
      ["-m", "qcracker_grover", "run", "--n-bits", String(args.bits)],
      {
        env: { ...process.env, PYTHONPATH: args.groverSrcDir },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), args.timeoutMs);
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`python spawn failed: ${err.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        try {
          resolve(JSON.parse(stdout));
          return;
        } catch {
          reject(
            new Error(
              `unparsable toy Grover output: ${stdout.trim().slice(0, 200)}`,
            ),
          );
          return;
        }
      }
      const tail = stderr.trim().split("\n").slice(-3).join(" | ");
      reject(new Error(`toy Grover exited ${code}: ${tail}`));
    });
  });
}
