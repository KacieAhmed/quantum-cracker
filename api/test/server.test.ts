import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
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

describe("custom wallet mode (own mnemonic, derived target)", () => {
  // Fake-CLI-valid phrases: 12 words, all known, last word ≠ "abandon".
  // In-space rule (fixture): phrase starts with "abandon ability able".
  const IN_SPACE =
    "abandon ability able about above absent absorb abstract absurd abuse access accident";
  const OUT_OF_SPACE =
    "about ability able about above absent absorb abstract absurd abuse access accident";
  const CHECKSUM_INVALID =
    "abandon ability able about above absent absorb abstract absurd abuse access abandon";

  async function waitForFinal(
    app: FastifyInstance,
    runId: string,
    timeoutMs = 15000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await app.inject({ method: "GET", url: `/runs/${runId}` });
      const report = res.json() as Record<string, unknown>;
      if (report.status !== "running") return report;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("run did not finish in time");
  }

  it("derives addresses, paths, and pool membership on /derive", async () => {
    const { app } = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/derive",
        payload: { mnemonic: IN_SPACE },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.paths.eth).toBe("m/44'/60'/0'/0/0");
      expect(body.paths.btc_bech32).toBe("m/84'/0'/0'/0/0");
      expect(body.addresses.eth).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(body.poolMembership.inSpace).toBe(true);

      const out = await app.inject({
        method: "POST",
        url: "/derive",
        payload: { mnemonic: OUT_OF_SPACE },
      });
      expect(out.statusCode).toBe(200);
      expect(out.json().poolMembership.inSpace).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("rejects checksum-invalid and unknown-word mnemonics with 422", async () => {
    const { app } = await makeApp();
    try {
      for (const mnemonic of [CHECKSUM_INVALID, `${IN_SPACE} zebra`]) {
        const derive = await app.inject({
          method: "POST",
          url: "/derive",
          payload: { mnemonic },
        });
        expect(derive.statusCode).toBe(422);
        expect(derive.json().error).toContain("invalid seed phrase");

        const crack = await app.inject({
          method: "POST",
          url: "/crack",
          payload: {
            chain: "ethereum",
            mode: "classic",
            customWallet: { mnemonic },
          },
        });
        expect(crack.statusCode).toBe(422);
        expect(crack.json().error).toContain("invalid seed phrase");
      }
    } finally {
      await app.close();
    }
  });

  it("pins the derived address as the classic target — never a typed address", async () => {
    // FAKE_MATCH=0: the fixture always matches its canned ordinal otherwise.
    process.env.FAKE_MATCH = "0";
    const { app } = await makeApp();
    try {
      // A typed address must not become the target even when present.
      const started = await app.inject({
        method: "POST",
        url: "/crack",
        payload: {
          chain: "ethereum",
          mode: "classic",
          address: POOLED_ETH,
          workers: 1,
          customWallet: { mnemonic: OUT_OF_SPACE },
        },
      });
      expect(started.statusCode).toBe(201);
      const { runId, customWallet, note, poolMembershipNote: membershipNote, searchKind } = started.json();
      expect(customWallet.targetSource).toBe("derived-from-mnemonic");
      expect(customWallet.crossCheckUsed).toBe(false);
      expect(customWallet.inPooledSpace).toBe(false);
      // No marked slots → the own-wallet default is the full-space lottery,
      // with the honest odds disclosed in the response (not a dead end).
      expect(searchKind).toBe("lottery");
      expect(note).toContain("Full-space lottery");
      expect(note).toContain("2^128 ≈ 3.4×10^38 valid phrases");
      expect(note).toContain("pinned — not random");
      // Pool membership is neutral info now, never a guaranteed-dead-end verdict.
      expect(membershipNote).toContain("informational");
      expect(membershipNote).not.toContain("OUTSIDE the bounded pooled demo keyspace");

      const report = await waitForFinal(app, runId);
      // The run chased the DERIVED address, not POOLED_ETH, and exhausted.
      expect(report.address).toBe(customWallet.derivedAddresses.eth);
      expect(report.status).toBe("exhausted");
      expect(report.match).toBeNull();
      expect(report.customWallet.inPooledSpace).toBe(false);
    } finally {
      delete process.env.FAKE_MATCH;
      await app.close();
    }
  }, 20000);

  it("delivers a full match proof for an in-space custom wallet", async () => {
    const { app, port } = await makeApp();
    try {
      const ws = await connect(port);
      const { nextMatching } = collect(ws);

      const derive = await app.inject({
        method: "POST",
        url: "/derive",
        payload: { mnemonic: IN_SPACE },
      });
      const derivedEth = derive.json().addresses.eth as string;

      const started = await app.inject({
        method: "POST",
        url: "/crack",
        payload: {
          chain: "ethereum",
          mode: "classic",
          workers: 1,
          customWallet: {
            mnemonic: IN_SPACE,
            expectedAddress: derivedEth,
          },
        },
      });
      expect(started.statusCode).toBe(201);
      expect(started.json().customWallet.crossCheckUsed).toBe(true);
      // In-space or not, an unmarked own-wallet run is the full-space lottery
      // (the bounded copy only appears on marked-slot sweeps).
      expect(started.json().searchKind).toBe("lottery");
      expect(started.json().note).toContain("Full-space lottery");

      const doneMsg = await nextMatching((m) => m.type === "done");
      if (doneMsg.type !== "done") throw new Error("unreachable");
      ws.close();

      const report = doneMsg.report;
      expect(report.status).toBe("matched");
      // Side-by-side proof: recovered phrase's derivation equals the target.
      expect(report.match.derivationPath).toBe("m/44'/60'/0'/0/0");
      expect(report.match.address).toBe(derivedEth);
      expect(report.address).toBe(derivedEth);
      expect(report.customWallet.targetSource).toBe("derived-from-mnemonic");
      expect(report.customWallet.paths.eth).toBe("m/44'/60'/0'/0/0");
    } finally {
      await app.close();
    }
  }, 20000);

  it("rejects a cross-check address that the mnemonic does not derive", async () => {
    const { app } = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/crack",
        payload: {
          chain: "ethereum",
          mode: "classic",
          customWallet: {
            mnemonic: IN_SPACE,
            expectedAddress: "0x1111111111111111111111111111111111111111",
          },
        },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toContain("cross-check failed");
      expect(res.json().derivedAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(res.json().typedAddress).toBe(
        "0x1111111111111111111111111111111111111111",
      );
    } finally {
      await app.close();
    }
  });

  it("supports custom wallets in quantum mode", async () => {
    const { app } = await makeApp({
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
      const res = await app.inject({
        method: "POST",
        url: "/crack",
        payload: {
          chain: "ethereum",
          mode: "quantum",
          quantumBits: 4,
          customWallet: { mnemonic: IN_SPACE },
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().customWallet.targetSource).toBe(
        "derived-from-mnemonic",
      );
    } finally {
      await app.close();
    }
  }, 20000);

  it("keeps corpus mode requiring an address when no customWallet", async () => {
    const { app } = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/crack",
        payload: { chain: "ethereum", mode: "classic" },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toContain("customWallet");
    } finally {
      await app.close();
    }
  });
});

describe("limited-keyspace mode (vary slots over the full wordlist)", () => {
  // Fake-CLI-valid 12-word phrase; slot 11 (the twelfth word) is "accident".
  const PHRASE =
    "abandon ability able about above absent absorb abstract absurd abuse access accident";

  async function waitForFinal(
    app: FastifyInstance,
    runId: string,
    timeoutMs = 15000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await app.inject({ method: "GET", url: `/runs/${runId}` });
      const report = res.json() as Record<string, unknown>;
      if (report.status !== "running") return report;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("run did not finish in time");
  }

  it("starts a template run and discloses the space, containment, and ETA", async () => {
    const { app } = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/crack",
        payload: {
          chain: "ethereum",
          mode: "classic",
          workers: 2,
          customWallet: { mnemonic: PHRASE, varySlots: [1, 11] },
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      // Vary slots [1, 11]: one prefix slot (position 2) + the folded twelfth
      // → 2048^1 prefixes, 2048^2 raw assemblies, 2048×128 checksum-valid.
      expect(body.totalCandidates).toBe(2_048 * 128);
      expect(body.rawCandidates).toBe(2_048 * 2_048);
      expect(body.customWallet.limitedKeyspace).toMatchObject({
        variedPositions1Indexed: [2, 12],
        poolWords: 2_048,
        rawAssemblies: 2_048 * 2_048,
        estimatedChecksumValid: 2_048 * 128,
        containsPhraseByConstruction: true,
      });
      expect(body.targetNote).toContain("Limited-keyspace search");
      expect(body.targetNote).toContain("by construction");
      expect(body.estimatedRatePerSec).toBeGreaterThan(0);
      expect(body.etaSeconds).toBeGreaterThan(0);

      const report = await waitForFinal(app, body.runId);
      expect(report.status).toBe("matched");
      const reportKeyspace = (
        report.customWallet as Record<string, unknown>
      ).limitedKeyspace as Record<string, unknown>;
      expect(reportKeyspace).toMatchObject({
        variedPositions1Indexed: [2, 12],
        containsPhraseByConstruction: true,
      });
    } finally {
      await app.close();
    }
  }, 20000);

  it("rejects more than four varying slots, repeats, out-of-range slots, and non-12-word phrases", async () => {
    const { app } = await makeApp();
    try {
      const crack = async (varySlots: number[], mnemonic = PHRASE) =>
        app.inject({
          method: "POST",
          url: "/crack",
          payload: {
            chain: "ethereum",
            mode: "classic",
            customWallet: { mnemonic, varySlots },
          },
        });

      const tooMany = await crack([0, 1, 2, 3, 4]);
      expect(tooMany.statusCode).toBe(422);
      expect(tooMany.json().error).toContain("at most 4");

      const repeated = await crack([3, 3]);
      expect(repeated.statusCode).toBe(422);
      expect(repeated.json().error).toContain("repeated");

      const outOfRange = await crack([12]);
      expect(outOfRange.statusCode).toBe(422);
      expect(outOfRange.json().error).toContain("between 0 and 11");

      const longPhrase = await crack([0], `${PHRASE} ${PHRASE}`);
      // Engine-valid 24-word phrase; the template space itself is 12-slot.
      expect(longPhrase.statusCode).toBe(422);
      expect(longPhrase.json().error).toContain("12-word");
    } finally {
      await app.close();
    }
  });

  it("rejects vary slots in quantum mode — the toy sim has no phrase to contain", async () => {
    const { app } = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/crack",
        payload: {
          chain: "ethereum",
          mode: "quantum",
          quantumBits: 4,
          customWallet: { mnemonic: PHRASE, varySlots: [1] },
        },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toContain("classical-only");
    } finally {
      await app.close();
    }
  });

  it("rejects a mistyped word that is not in the BIP-39 wordlist", async () => {
    const { app } = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/crack",
        payload: {
          chain: "ethereum",
          mode: "classic",
          customWallet: {
            mnemonic: PHRASE.replace("about", "been"),
            varySlots: [1],
          },
        },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toContain("invalid seed phrase");
      expect(res.json().error).toContain("not in the BIP-39 English wordlist");
    } finally {
      await app.close();
    }
  });
});

describe("static serving (single-port hosting)", () => {
  it("serves the console, keeps API routes first, and SPA-falls-back", async () => {
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "qcracker-static-"));
    await writeFile(
      path.join(staticDir, "index.html"),
      "<!doctype html><title>cracker console</title>",
    );
    const { app } = await makeApp({ staticDir });
    try {
      // The exact API routes beat the static wildcard.
      const system = await app.inject({ method: "GET", url: "/system" });
      expect(system.statusCode).toBe(200);
      expect(system.json()).toHaveProperty("safeMaxWorkers");

      // The console is served at / and via the SPA fallback.
      const home = await app.inject({
        method: "GET",
        url: "/",
        headers: { accept: "text/html" },
      });
      expect(home.statusCode).toBe(200);
      expect(home.body).toContain("cracker console");
      const spa = await app.inject({
        method: "GET",
        url: "/unknown/page",
        headers: { accept: "text/html" },
      });
      expect(spa.statusCode).toBe(200);
      expect(spa.body).toContain("cracker console");

      // Non-page misses stay JSON 404s.
      const apiMiss = await app.inject({ method: "GET", url: "/nope" });
      expect(apiMiss.statusCode).toBe(404);
      expect(apiMiss.json()).toEqual({ error: "not found" });
    } finally {
      await app.close();
    }
  });
});

describe("cancel across run states", () => {
  it("cancels an active run even when the request declares a JSON content-type with no body", async () => {
    const { app } = await makeApp({ progressMs: 200 });
    try {
      const started = await app.inject({
        method: "POST",
        url: "/crack",
        payload: {
          chain: "ethereum",
          mode: "classic",
          address: POOLED_ETH,
          workers: 1,
        },
      });
      expect(started.statusCode).toBe(201);
      const { runId } = started.json();

      // Regression: the console once sent exactly this shape and got a 400
      // (FST_ERR_CTP_EMPTY_JSON_BODY) before the handler ever ran.
      const res = await app.inject({
        method: "POST",
        url: `/crack/${runId}/cancel`,
        headers: { "content-type": "application/json" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ runId, cancelled: true });
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      await app.close();
    }
  });

  it("returns a structured 404 when there is no active run", async () => {
    const { app } = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/crack/run_absent/cancel",
        headers: { "content-type": "application/json" },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "no such active run" });
    } finally {
      await app.close();
    }
  });

  it("returns 404 when cancelling a run that already finished", async () => {
    const { app } = await makeApp({
      runQuantumFn: async ({ bits }) => ({ toy: true as const, n_bits: bits }),
    });
    try {
      const started = await app.inject({
        method: "POST",
        url: "/crack",
        payload: {
          chain: "ethereum",
          mode: "quantum",
          address: POOLED_ETH,
          quantumBits: 4,
        },
      });
      expect(started.statusCode).toBe(201);
      const { runId } = started.json();

      // Let the toy simulation settle and finalize the run.
      await new Promise((r) => setTimeout(r, 300));

      const res = await app.inject({
        method: "POST",
        url: `/crack/${runId}/cancel`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "no such active run" });
    } finally {
      await app.close();
    }
  });

  it("still rejects an empty body on routes that require one", async () => {
    const { app } = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/crack",
        headers: { "content-type": "application/json" },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
