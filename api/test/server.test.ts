import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import type { WebSocket as WebSocketType } from "ws";
import { buildApp, type BuildAppOptions } from "../src/server.js";
import { PER_CORE_DERIVATIONS_PER_SEC } from "../src/config.js";
import type { FastifyInstance } from "fastify";
import type { ServerMessage } from "../src/types.js";

const fakeCli = fileURLToPath(
  new URL("./fixtures/fake-cli.js", import.meta.url),
);

const POOLED_ETH = "0xb79f8aC312fF21AD16980a857f574A6e7e3ED9c5";
const POOLED_BTC = "16HxxyAQvA3AKThfcJGxSqKJ3Hs9RnTgHp";

async function makeApp(
  overrides?: Partial<BuildAppOptions>,
): Promise<{ app: FastifyInstance; port: number }> {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), "qcracker-api-"));
  const app = await buildApp({
    cliPath: fakeCli,
    runsDir,
    groverSrcDir: ".",
    broadcastIntervalMs: 30,
    progressMs: 40,
    // Roomy host by default; tests that exercise the safe-max refusal
    // override this with a constrained profile.
    systemInfoFn: () => ({
      cores: 8,
      totalMemBytes: 8 * 1024 * 1024 * 1024,
      freeMemBytes: 64 * 1024 * 1024 * 1024,
      safeMaxWorkers: 8,
      perWorkerFootprintBytes: 64 * 1024 * 1024,
    }),
    ...overrides,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return { app, port };
}

function connect(port: number): Promise<WebSocketType> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function collect(ws: WebSocketType): {
  messages: ServerMessage[];
  nextMatching: (
    pred: (m: ServerMessage) => boolean,
  ) => Promise<ServerMessage>;
} {
  const messages: ServerMessage[] = [];
  ws.on("message", (data: Buffer) => {
    messages.push(JSON.parse(data.toString()) as ServerMessage);
  });
  return {
    messages,
    nextMatching(pred) {
      return new Promise((resolve, reject) => {
        const deadline = Date.now() + 15000;
        const poll = setInterval(() => {
          const found = messages.find(pred);
          if (found) {
            clearInterval(poll);
            resolve(found);
          } else if (Date.now() > deadline) {
            clearInterval(poll);
            reject(new Error(`timed out; got ${messages.length} messages`));
          }
        }, 25);
      });
    },
  };
}

describe("api server", () => {
  it("serves /system and /corpus", async () => {
    const { app } = await makeApp();
    try {
      const sys = await app.inject({ method: "GET", url: "/system" });
      expect(sys.statusCode).toBe(200);
      expect(sys.json()).toMatchObject({
        cores: 8,
        safeMaxWorkers: 8,
        workersHardMax: 64,
      });
      const corpus = await app.inject({ method: "GET", url: "/corpus" });
      expect(corpus.statusCode).toBe(200);
      const body = corpus.json();
      expect(body.space.total_prefixes).toBe(1000);
      expect(
        body.wallets.some((w: { searchable: boolean }) => w.searchable),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("validates addresses via the engine and rejects malformed targets", async () => {
    const { app } = await makeApp();
    try {
      const good = await app.inject({
        method: "POST",
        url: "/validate",
        payload: { address: POOLED_ETH },
      });
      expect(good.json()).toMatchObject({ valid: true, kind: "eth" });

      const bad = await app.inject({
        method: "POST",
        url: "/crack",
        payload: { chain: "ethereum", mode: "classic", address: "0xBAD" },
      });
      expect(bad.statusCode).toBe(422);
      expect(bad.json().error).toContain("malformed");
    } finally {
      await app.close();
    }
  });

  it("refuses a chain/kind mismatch with a switch hint", async () => {
    const { app } = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/crack",
        payload: { chain: "ethereum", mode: "classic", address: POOLED_BTC },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toContain("switch the chain toggle");
    } finally {
      await app.close();
    }
  });

  it("refuses workers above safe-max without force, accepts with force", async () => {
    // Constrained host: 2 cores, safe-max 2 — 8 workers is over the line.
    const { app } = await makeApp({
      systemInfoFn: () => ({
        cores: 2,
        totalMemBytes: 8 * 1024 * 1024 * 1024,
        freeMemBytes: 64 * 1024 * 1024 * 1024,
        safeMaxWorkers: 2,
        perWorkerFootprintBytes: 64 * 1024 * 1024,
      }),
    });
    try {
      const refused = await app.inject({
        method: "POST",
        url: "/crack",
        payload: {
          chain: "ethereum",
          mode: "classic",
          address: POOLED_ETH,
          workers: 8,
        },
      });
      expect(refused.statusCode).toBe(422);
      expect(refused.json().error).toContain(
        "at some point your computer crashes",
      );
      expect(refused.json().safeMaxWorkers).toBe(2);

      const forced = await app.inject({
        method: "POST",
        url: "/crack",
        payload: {
          chain: "ethereum",
          mode: "classic",
          address: POOLED_ETH,
          workers: 8,
          force: true,
        },
      });
      expect(forced.statusCode).toBe(201);
      expect(forced.json().forced).toBe(true);
      // 8 lanes over a 1000-prefix space: every lane non-empty.
      expect(forced.json().lanes).toHaveLength(8);

      // Cancel so the test app can close cleanly.
      await app.inject({
        method: "POST",
        url: `/crack/${forced.json().runId}/cancel`,
      });
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      await app.close();
    }
  }, 20000);

  it("streams lane progress and the match over websocket, then cancels on match", async () => {
    const { app, port } = await makeApp();
    try {
      const ws = await connect(port);
      const { messages, nextMatching } = collect(ws);

      const started = await app.inject({
        method: "POST",
        url: "/crack",
        payload: {
          chain: "ethereum",
          mode: "classic",
          address: POOLED_ETH,
          workers: 4,
        },
      });
      expect(started.statusCode).toBe(201);
      const { runId, totalCandidates, estimatedRatePerSec } = started.json();
      expect(totalCandidates).toBe(1000);
      // 4 workers on an 8-core test host: linear scaling, no cap yet.
      expect(estimatedRatePerSec).toBe(4 * PER_CORE_DERIVATIONS_PER_SEC);

      const matchMsg = await nextMatching((m) => m.type === "match");
      if (matchMsg.type !== "match") throw new Error("unreachable");
      expect(matchMsg.match.mnemonic).toContain("ocean abstract");

      const doneMsg = await nextMatching((m) => m.type === "done");
      if (doneMsg.type !== "done") throw new Error("unreachable");
      expect(doneMsg.report.status).toBe("matched");
      expect(doneMsg.report.runId).toBe(runId);

      // Lanes streamed live progress before settling.
      const snapshots = messages.filter((m) => m.type === "snapshot");
      expect(snapshots.length).toBeGreaterThan(0);
      const firstSnapshot = snapshots[0];
      if (firstSnapshot.type !== "snapshot") throw new Error("unreachable");
      expect(Object.keys(firstSnapshot.report.lanes)).toHaveLength(4);

      const report = await app.inject({
        method: "GET",
        url: `/runs/${runId}`,
      });
      expect(report.statusCode).toBe(200);
      expect(report.json().match.mnemonic).toContain("ocean abstract");

      ws.close();
    } finally {
      await app.close();
    }
  }, 20000);

  it("runs quantum mode as the honest toy simulation", async () => {
    const { app, port } = await makeApp({
      runQuantumFn: async ({ bits }) => ({
        toy: true as const,
        result: {
          mode: "run",
          n_bits: bits,
          success: true,
          found_state: "0110",
          target: "0110",
          n_iterations: 2,
          measurements: { "0110": 1024 },
          counts: { total: 1024 },
          seconds: 0.1,
          simulator: "statevector",
        },
      }),
    });
    try {
      const ws = await connect(port);
      const { nextMatching } = collect(ws);

      const res = await app.inject({
        method: "POST",
        url: "/crack",
        payload: {
          chain: "ethereum",
          mode: "quantum",
          address: POOLED_ETH,
          quantumBits: 4,
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().note).toContain("algorithm decision pending");

      const doneMsg = await nextMatching((m) => m.type === "done");
      if (doneMsg.type !== "done") throw new Error("unreachable");
      expect(doneMsg.report.status).toBe("quantum_demo");
      expect(doneMsg.report.quantum?.toy).toBe(true);
      ws.close();
    } finally {
      await app.close();
    }
  }, 20000);

  it("returns 409 while a run is active", async () => {
    const { app } = await makeApp({ progressMs: 200 });
    try {
      const first = await app.inject({
        method: "POST",
        url: "/crack",
        payload: {
          chain: "ethereum",
          mode: "classic",
          address: POOLED_ETH,
          workers: 1,
        },
      });
      expect(first.statusCode).toBe(201);
      const second = await app.inject({
        method: "POST",
        url: "/crack",
        payload: {
          chain: "ethereum",
          mode: "classic",
          address: POOLED_ETH,
          workers: 1,
        },
      });
      expect(second.statusCode).toBe(409);
      await app.inject({
        method: "POST",
        url: `/crack/${first.json().runId}/cancel`,
      });
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      await app.close();
    }
  }, 20000);
});
