import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RunManager } from "../src/runManager.js";
import { splitSpace } from "../src/ranges.js";
import type { RunReport, ServerMessage } from "../src/types.js";

const fakeCli = fileURLToPath(
  new URL("./fixtures/fake-cli.js", import.meta.url),
);

function makeManager(runsDir: string, opts?: { broadcastMs?: number }) {
  const messages: ServerMessage[] = [];
  const manager = new RunManager({
    cliPath: fakeCli,
    runsDir,
    broadcastIntervalMs: opts?.broadcastMs ?? 50,
  });
  return { manager, messages };
}

async function makeRunsDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "qcracker-runs-"));
}

function startClassic(
  manager: RunManager,
  messages: ServerMessage[],
  overrides?: { workers?: number; space?: number; progressMs?: number },
): RunReport {
  const space = overrides?.space ?? 1000;
  const workers = overrides?.workers ?? 4;
  return manager.startClassic(
    {
      runId: `run_${Math.random().toString(36).slice(2, 8)}`,
      chain: "ethereum",
      address: "0xb79f8aC312fF21AD16980a857f574A6e7e3ED9c5",
      addressType: "eth",
      ranges: splitSpace(space, workers),
      totalCandidates: space,
      rawCandidates: space * 16,
      progressMs: overrides?.progressMs ?? 40,
    },
    (m) => messages.push(m),
  );
}

function awaitSettled(manager: RunManager): Promise<void> {
  return new Promise((resolve) => {
    const poll = setInterval(() => {
      if (manager.activeReport === null) {
        clearInterval(poll);
        resolve();
      }
    }, 20);
  });
}

/** The report write is fire-and-forget after the run settles; poll for it. */
function waitForFile(file: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (existsSync(file)) {
        clearInterval(poll);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(poll);
        reject(new Error(`report not written: ${file}`));
      }
    }, 20);
  });
}

describe("RunManager (fake cli)", () => {
  it("streams lanes and settles a match with cancel-on-match", async () => {
    const runsDir = await makeRunsDir();
    const { manager, messages } = makeManager(runsDir);
    const report = startClassic(manager, messages);
    await awaitSettled(manager);

    expect(report.status).toBe("matched");
    expect(report.match?.mnemonic).toBe(
      "ocean abstract raven accident hill absent winter abstract candy abuse mango able",
    );
    expect(report.aggregate.derived).toBeGreaterThan(0);

    // The matching lane ran; lanes were mid-flight when the match cancelled them.
    const statuses = Object.values(report.lanes).map((l) => l.status);
    expect(statuses).toContain("done");
    expect(statuses).not.toContain("starting");

    // A "done" message was broadcast, and the report landed on disk.
    expect(messages.some((m) => m.type === "done")).toBe(true);
    await waitForFile(path.join(runsDir, `${report.runId}.json`));
    expect(manager.cancel()).toBe(false); // nothing left to cancel
  }, 15000);

  it("refuses a second run while one is active", async () => {
    const runsDir = await makeRunsDir();
    const { manager } = makeManager(runsDir);
    startClassic(manager, [], { progressMs: 150 });
    expect(() =>
      manager.startClassic(
        {
          runId: "run_second",
          chain: "ethereum",
          address: "0xb79f8aC312fF21AD16980a857f574A6e7e3ED9c5",
          addressType: "eth",
          ranges: splitSpace(100, 2),
          totalCandidates: 100,
          rawCandidates: 1600,
          progressMs: 50,
        },
        () => {},
      ),
    ).toThrowError(/already active/);
    manager.cancel();
    await awaitSettled(manager);
  }, 15000);

  it("marks a cancelled run", async () => {
    const runsDir = await makeRunsDir();
    const { manager, messages } = makeManager(runsDir);
    const report = startClassic(manager, messages, { progressMs: 500 });
    await new Promise((r) => setTimeout(r, 120)); // let lanes start
    expect(manager.cancel()).toBe(true);
    await awaitSettled(manager);

    expect(report.status).toBe("cancelled");
    expect(
      Object.values(report.lanes).every((l) => l.status !== "running"),
    ).toBe(true);
  }, 15000);
});

describe("RunManager exhausted path (FAKE_MATCH=0)", () => {
  it("exhausts the space honestly when nothing matches", async () => {
    process.env.FAKE_MATCH = "0";
    try {
      const runsDir = await makeRunsDir();
      const { manager, messages } = makeManager(runsDir);
      const report = startClassic(manager, messages, {
        space: 100,
        workers: 2,
      });
      await awaitSettled(manager);

      expect(report.status).toBe("exhausted");
      expect(report.match).toBeNull();
      // Full coverage: both lanes' full ranges were walked.
      expect(report.aggregate.derived).toBe(100);
      expect(report.etaSeconds).toBeUndefined();
      const doneMsg = messages.find((m) => m.type === "done");
      expect(
        doneMsg && "report" in doneMsg && doneMsg.report.status,
      ).toBe("exhausted");
    } finally {
      process.env.FAKE_MATCH = "1";
    }
  }, 15000);
});
