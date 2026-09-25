import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import type { WebSocket as WebSocketType } from "ws";
import { buildApp, type BuildAppOptions } from "../src/server.js";
import type { FastifyInstance } from "fastify";
import type { ServerMessage } from "../src/types.js";

const fakeCli = fileURLToPath(
  new URL("./fixtures/fake-cli.js", import.meta.url),
);

const POOLED_ETH = "0xb79f8aC312fF21AD16980a857f574A6e7e3ED9c5";
const POOLED_BTC = "16HxxyAQvA3AKThfcJGxSqKJ3Hs9RnTgHp";
// Fixture-valid 12-word phrase used by the bounded limited-keyspace tests.
const OWN_PHRASE =
  "abandon ability able about above absent absorb abstract absurd abuse access accident";

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
          // Bounded limited-keyspace run: worker caps apply here. Address-only
          // runs are lotteries (single lane, no workers knob), so they no
          // longer exercise this validation.
          customWallet: { mnemonic: OWN_PHRASE, varySlots: [1, 11] },
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
          customWallet: { mnemonic: OWN_PHRASE, varySlots: [1, 11] },
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
          // Address-only runs are full-space lotteries now: consent to the
          // disclosed odds, then a bounded draw budget instead of lanes.
          probe: true,
          drawBudget: 5000,
        },
      });
      expect(started.statusCode).toBe(201);
      const { runId, totalCandidates, searchKind } = started.json();
      expect(searchKind).toBe("lottery");
      expect(totalCandidates).toBe(5000);

      const matchMsg = await nextMatching((m) => m.type === "match");
      if (matchMsg.type !== "match") throw new Error("unreachable");
      expect(matchMsg.match.mnemonic).toContain("ocean abstract");

      const doneMsg = await nextMatching((m) => m.type === "done");
      if (doneMsg.type !== "done") throw new Error("unreachable");
      expect(doneMsg.report.status).toBe("matched");
      expect(doneMsg.report.runId).toBe(runId);

      // The lottery lane streamed live progress before settling.
      const snapshots = messages.filter((m) => m.type === "snapshot");
      expect(snapshots.length).toBeGreaterThan(0);
      const firstSnapshot = snapshots[0];
      if (firstSnapshot.type !== "snapshot") throw new Error("unreachable");
      expect(Object.keys(firstSnapshot.report.lanes)).toHaveLength(1);

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

  it("runs quantum mode as the full-space lottery with the honest quantum disclosure", async () => {
    // FAKE_MATCH=0: the fixture always matches its canned ordinal otherwise.
    process.env.FAKE_MATCH = "0";
    const { app, port } = await makeApp();
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
          workers: 1,
        },
      });
      expect(res.statusCode).toBe(201);
      const start = res.json();
      // The classical leg is the SAME lottery the own-wallet default runs:
      // full space, budgeted, seeded — odds disclosed BEFORE the start.
      expect(start.searchKind).toBe("lottery");
      expect(typeof start.drawBudget).toBe("number");
      expect(start.drawBudget).toBeGreaterThan(0);
      // A lottery run's candidate count is its budget cap — the run never
      // pretends it could sweep the space (2^128 lives in the note).
      expect(start.totalCandidates).toBe(start.drawBudget);
      expect(start.note).toContain("Full-space lottery");
      expect(start.note).toContain("2^128 ≈ 3.4×10^38 valid phrases");
      // Corpus run: the calibration phrase is pinned, labeled not random.
      expect(start.note).toContain("The calibration phrase");
      expect(start.note).toContain("pinned — not random");
      // The quantum leg's honest math rides along in the note.
      expect(start.note).toContain("(π/4)·2^66 ≈ 5.8×10^19 oracle calls");

      const doneMsg = await nextMatching((m) => m.type === "done");
      if (doneMsg.type !== "done") throw new Error("unreachable");
      // Budget end — a coverage-bounded end state, never an exhaustion claim.
      expect(doneMsg.report.status).toBe("budget_spent");
      expect(doneMsg.report.mode).toBe("quantum");
      expect(doneMsg.report.match).toBeNull();
      ws.close();
    } finally {
      delete process.env.FAKE_MATCH;
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
          probe: true,
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
          probe: true,
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
      // The run chased the DERIVED address, not POOLED_ETH — and the pinned
      // own phrase genuinely derives it, so the lottery matches at candidate
      // #1 and ends. Correct behavior by design: the user's phrase is the
      // pinned benchmark, and the feed freezes with the match proof.
      expect(report.address).toBe(customWallet.derivedAddresses.eth);
      expect(report.status).toBe("matched");
      expect(report.match?.mnemonic).toBe(OUT_OF_SPACE);
      expect(report.match?.address).toBe(customWallet.derivedAddresses.eth);
      expect(report.match?.discovery).toBe(false);
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

  it("supports custom wallets in quantum mode — own-phrase pin, lottery leg", async () => {
    const { app } = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/crack",
        payload: {
          chain: "ethereum",
          mode: "quantum",
          customWallet: { mnemonic: IN_SPACE },
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().customWallet.targetSource).toBe(
        "derived-from-mnemonic",
      );
      // The quantum start discloses the lottery leg with the user's phrase
      // pinned first (labeled not random).
      expect(res.json().searchKind).toBe("lottery");
      expect(res.json().note).toContain("Your own phrase is pinned");
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

  it("rejects vary slots in quantum mode — the lottery draws all 12 words", async () => {
    const { app } = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/crack",
        payload: {
          chain: "ethereum",
          mode: "quantum",
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

describe("address-only full-space lottery", () => {
  const FOREIGN_ETH = "0x1111111111111111111111111111111111111111";
  // Fixture-valid phrase — only used to prove probe + customWallet is refused
  // before any derivation happens.
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

  it("refuses a foreign address without the probe flag", async () => {
    const { app } = await makeApp();
    try {
      const started = await app.inject({
        method: "POST",
        url: "/crack",
        payload: {
          chain: "ethereum",
          mode: "classic",
          address: FOREIGN_ETH,
          workers: 1,
        },
      });
      expect(started.statusCode).toBe(422);
      // No membership gate exists anymore — the refusal is a consent gate:
      // the same full-space lottery every address-only run gets.
      expect(started.json().error).toContain("full-space lottery");
      expect(started.json().error).toContain("probe");
    } finally {
      await app.close();
    }
  });

  it("refuses probe combined with customWallet — no seed is involved", async () => {
    const { app } = await makeApp();
    try {
      const started = await app.inject({
        method: "POST",
        url: "/crack",
        payload: {
          chain: "ethereum",
          mode: "classic",
          address: FOREIGN_ETH,
          workers: 1,
          probe: true,
          customWallet: { mnemonic: PHRASE },
        },
      });
      expect(started.statusCode).toBe(422);
      expect(started.json().error).toContain("no seed phrase is involved");
    } finally {
      await app.close();
    }
  });

  it("refuses probe in quantum mode — the toy sim is a separate demo", async () => {
    const { app } = await makeApp();
    try {
      const started = await app.inject({
        method: "POST",
        url: "/crack",
        payload: {
          chain: "ethereum",
          mode: "quantum",
          address: FOREIGN_ETH,
          workers: 1,
          probe: true,
        },
      });
      expect(started.statusCode).toBe(422);
      expect(started.json().error).toContain("classical full-space search");
    } finally {
      await app.close();
    }
  });

  it("pins the calibration phrase first, labeled 'pinned — not random', then draws randomly", async () => {
    // FAKE_MATCH=0: no canned match anywhere — the run must survive the
    // non-matching pin, draw randomly, and end at its budget.
    process.env.FAKE_MATCH = "0";
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
          address: FOREIGN_ETH,
          probe: true,
          drawBudget: 20000,
        },
      });
      expect(started.statusCode).toBe(201);

      // The pinned event precedes any random draw and carries the label.
      const pinnedMsg = await nextMatching((m) => m.type === "pinned");
      if (pinnedMsg.type !== "pinned") throw new Error("unreachable");
      expect(pinnedMsg.phrase).toContain("permit bean gaze");
      expect(pinnedMsg.label).toBe("pinned — not random");
      expect(pinnedMsg.tested).toBe(true);

      // Random draws after the pin: every frontier phrase is a random draw
      // (all 12 slots vary), never a prefix-ordinal walk.
      const drewRandom = await nextMatching(
        (m) =>
          m.type === "snapshot" &&
          m.report.lanes.some((l) => l.frontierPhrase !== null),
      );
      if (drewRandom.type !== "snapshot") throw new Error("unreachable");
      expect(drewRandom.report.lanes[0]?.frontierPhrase).toMatch(
        /^random draw \d+$/,
      );
      expect(messages.indexOf(pinnedMsg)).toBeLessThan(
        messages.indexOf(drewRandom),
      );

      // The pin did not end the run — it does not derive the target; the
      // lottery continues into random sampling and ends at its budget.
      const { runId } = started.json();
      const report = await waitForFinal(app, runId);
      expect(report.status).toBe("budget-reached");
      ws.close();
    } finally {
      delete process.env.FAKE_MATCH;
      await app.close();
    }
  }, 20000);

  it("stops on a watchlist discovery — labeled a discovery, never the requested target's phrase", async () => {
    // The fixture arms a deterministic discovery when FAKE_DISCOVERY=1 and
    // the armed watchlist contains its discovery address.
    const DISCOVERY_ETH = "0x00000000000000000000000000000000d15c0dea";
    process.env.FAKE_DISCOVERY = "1";
    process.env.FAKE_MATCH = "0";
    const watchDir = await mkdtemp(path.join(os.tmpdir(), "qcracker-watch-"));
    const watchlistPath = path.join(watchDir, "watchlist.txt");
    await writeFile(
      watchlistPath,
      "# one real-world address the fixture can reach\n" +
        `${DISCOVERY_ETH}\n`,
    );
    const { app } = await makeApp({ watchlistPath });
    try {
      const started = await app.inject({
        method: "POST",
        url: "/crack",
        payload: {
          chain: "ethereum",
          mode: "classic",
          address: FOREIGN_ETH,
          probe: true,
          drawBudget: 20000,
        },
      });
      expect(started.statusCode).toBe(201);
      // The disclosure announces the armed watchlist up front.
      expect(started.json().probe.disclosure).toContain("discovery watchlist");

      const report = await waitForFinal(app, started.json().runId);
      // The discovery settles the run like a match (freeze-and-display) but
      // the payload says what happened: a random draw derived a watchlist
      // address — the requested target's phrase was NOT found.
      expect(report.status).toBe("matched");
      expect(report.match).not.toBeNull();
      expect(report.match?.discovery).toBe(true);
      expect(report.match?.address).toBe(DISCOVERY_ETH);
      expect(report.address).toBe(FOREIGN_ETH);
    } finally {
      delete process.env.FAKE_DISCOVERY;
      delete process.env.FAKE_MATCH;
      await app.close();
    }
  }, 20000);

  it("starts the disclosed lottery for any address and ends budget-reached — no coverage claim", async () => {
    process.env.FAKE_MATCH = "0";
    const { app } = await makeApp();
    try {
      const started = await app.inject({
        method: "POST",
        url: "/crack",
        payload: {
          chain: "ethereum",
          mode: "classic",
          address: FOREIGN_ETH,
          workers: 1,
          probe: true,
          drawBudget: 20000,
        },
      });
      expect(started.statusCode).toBe(201);
      const { runId, probe, targetNote, searchKind } = started.json();
      expect(searchKind).toBe("lottery");
      expect(probe.targetSource).toBe("addressOnly");
      expect(probe.searchedSpace).toBe(
        "all-checksum-valid-12-word-bip39-phrases",
      );
      expect(probe.declaredSpaceSearched).toBe(false);
      // The searched space is never stamped as a countable candidate total —
      // the disclosure prose carries the math instead.
      expect(probe.searchedRawCandidates).toBeNull();
      expect(probe.searchedChecksumValid).toBeNull();
      expect(targetNote).toBe(probe.disclosure);
      expect(probe.disclosure).toContain("will not be found");
      expect(probe.disclosure).toContain("2^128");
      expect(probe.disclosure).toContain("1 in 6.7×10^31");
      expect(probe.disclosure).toContain("never claiming exhaustive coverage");

      const report = await waitForFinal(app, runId);
      // Honest lottery outcome: the draw budget is spent without a match —
      // budget-reached, never "exhausted" (the space is not finishable).
      expect(report.status).toBe("budget-reached");
      expect(report.match).toBeNull();
      expect(report.address).toBe(FOREIGN_ETH);
      expect(report.probe).toEqual(probe);
    } finally {
      delete process.env.FAKE_MATCH;
      await app.close();
    }
  }, 20000);

  it("claims a match during a probe — no provenance filtering", async () => {
    const { app, port } = await makeApp();
    try {
      const ws = await connect(port);
      const { nextMatching } = collect(ws);

      const started = await app.inject({
        method: "POST",
        url: "/crack",
        payload: {
          chain: "ethereum",
          mode: "classic",
          address: FOREIGN_ETH,
          workers: 1,
          probe: true,
        },
      });
      expect(started.statusCode).toBe(201);
      const { runId, probe } = started.json();

      const report = await waitForFinal(app, runId);
      expect(report.status).toBe("matched");
      expect(report.match).not.toBeNull();
      // A match is claimed exactly when a tested phrase derives the target —
      // probe provenance rides along but never suppresses it.
      expect(report.address).toBe(FOREIGN_ETH);
      expect(report.probe).toEqual(probe);
      await nextMatching((m: ServerMessage) => m.type === "match");
      ws.close();
    } finally {
      await app.close();
    }
  }, 20000);

  it("applies the same consent gate to corpus targets — no membership exception", async () => {
    process.env.FAKE_MATCH = "0";
    const { app } = await makeApp();
    try {
      // Even a bundled-corpus address is refused without the probe flag:
      // the bounded corpus sweep is retired, membership changes nothing.
      const refused = await app.inject({
        method: "POST",
        url: "/crack",
        payload: {
          chain: "ethereum",
          mode: "classic",
          address: POOLED_ETH,
          workers: 1,
        },
      });
      expect(refused.statusCode).toBe(422);
      expect(refused.json().error).toContain("full-space lottery");
      expect(refused.json().error).toContain("probe");

      // With consent, a corpus address is an ordinary lottery target.
      const started = await app.inject({
        method: "POST",
        url: "/crack",
        payload: {
          chain: "ethereum",
          mode: "classic",
          address: POOLED_ETH,
          workers: 1,
          probe: true,
          drawBudget: 20000,
        },
      });
      expect(started.statusCode).toBe(201);
      expect(started.json().searchKind).toBe("lottery");
      const report = await waitForFinal(app, started.json().runId);
      expect(report.status).toBe("budget-reached");
      // The probe label always rides address-only lotteries; no seed is
      // involved, so customWallet stays null.
      expect(report.probe).not.toBeNull();
      expect(report.customWallet).toBeNull();
    } finally {
      delete process.env.FAKE_MATCH;
      await app.close();
    }
  }, 20000);
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
          // Address-only runs are lotteries now: the consent flag is required
          // even for a run we cancel immediately, and the default draw budget
          // keeps the lane alive until the cancel below lands.
          probe: true,
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
    const { app } = await makeApp();
    try {
      const started = await app.inject({
        method: "POST",
        url: "/crack",
        payload: {
          chain: "ethereum",
          mode: "quantum",
          address: POOLED_ETH,
          workers: 1,
        },
      });
      expect(started.statusCode).toBe(201);
      const { runId } = started.json();

      // Let the lottery spend its draw budget and finalize the run.
      const deadline = Date.now() + 15000;
      for (;;) {
        const poll = await app.inject({ method: "GET", url: `/runs/${runId}` });
        const report = poll.json() as Record<string, unknown>;
        if (report.status !== "running") break;
        if (Date.now() > deadline) throw new Error("run did not finish in time");
        await new Promise((r) => setTimeout(r, 100));
      }

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

  it("returns 404 when cancelling a matched run that already settled", async () => {
    const { app, port } = await makeApp();
    try {
      const ws = await connect(port);
      const { nextMatching } = collect(ws);

      const started = await app.inject({
        method: "POST",
        url: "/crack",
        payload: {
          chain: "ethereum",
          mode: "classic",
          address: POOLED_ETH,
          probe: true,
          drawBudget: 20000,
        },
      });
      expect(started.statusCode).toBe(201);
      const { runId } = started.json();

      // Finalization is complete when the done event broadcasts — after it
      // the run is no longer active and cancel must 404.
      await nextMatching((m) => m.type === "done" && m.runId === runId);
      ws.close();

      const res = await app.inject({
        method: "POST",
        url: `/crack/${runId}/cancel`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "no such active run" });
    } finally {
      await app.close();
    }
  }, 20000);

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
