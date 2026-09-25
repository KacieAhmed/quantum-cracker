import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PER_CORE_DERIVATIONS_PER_SEC,
  PROGRESS_MS,
  QUANTUM_BITS_DEFAULT,
  QUANTUM_BITS_MAX,
  QUANTUM_NOTE,
  WORKERS_DEFAULT,
  WORKERS_HARD_MAX,
} from "./config.js";
import { estimateAggregateRate, etaSeconds } from "./estimate.js";
import { systemInfo } from "./system.js";
import { splitSpace } from "./ranges.js";
import {
  deriveMnemonic,
  listTargets,
  listWordlist,
  validateAddresses,
  MnemonicError,
  type CorpusDoc,
  type MnemonicDerivation,
  type TargetVerdict,
  type WordlistDoc,
} from "./cli.js";
import { RunManager } from "./runManager.js";
import { makeQuantumRunner } from "./quantum.js";
import type {
  Chain,
  CustomWalletProvenance,
  LimitedKeyspace,
  Mode,
  RunReport,
  ServerMessage,
} from "./types.js";
import type { WebSocket } from "ws";

export interface BuildAppOptions {
  cliPath: string;
  runsDir: string;
  groverSrcDir: string;
  pythonBin?: string;
  /** Inject a fixture corpus (tests); otherwise loaded from the engine. */
  corpus?: CorpusDoc;
  broadcastIntervalMs?: number;
  /** Injectable for tests: lane progress cadence (default config). */
  progressMs?: number;
  /** Injectable for tests: toy Grover runner. */
  runQuantumFn?: (params: { bits: number }) => Promise<unknown>;
  /** Injectable for tests: deterministic host capabilities. */
  systemInfoFn?: () => ReturnType<typeof systemInfo>;
  /**
   * When set, the API also serves this directory's built console over the
   * same port (single-port hosting). API routes keep precedence over the
   * static wildcard; unmatched page requests fall back to index.html.
   */
  staticDir?: string;
}

interface CustomWalletBody {
  /** A BIP-39 mnemonic the user OWNS; its derived address becomes the target. */
  mnemonic: string;
  /** Optional BIP-39 passphrase (default empty, the real-wallet default). */
  passphrase?: string;
  /**
   * Optional cross-check: must equal the address the mnemonic derives.
   * Never used as the search target — a freeform third-party address is
   * never accepted.
   */
  expectedAddress?: string;
  /**
   * Limited-keyspace mode: 0-based phrase positions to vary over the FULL
   * BIP-39 wordlist while every other position stays fixed. The target is
   * still derived from this same request's mnemonic; the disclosed keyspace
   * contains the true phrase by construction. Classical mode only.
   */
  varySlots?: number[];
}

interface CrackBody {
  chain: Chain;
  mode: Mode;
  /** Corpus-mode target. Required unless customWallet supplies the mnemonic. */
  address?: string;
  workers?: number;
  force?: boolean;
  quantumBits?: number;
  /** "Test with your own wallet": derive the target from this mnemonic. */
  customWallet?: CustomWalletBody;
}

const crackBodySchema = {
  type: "object",
  required: ["chain", "mode"],
  properties: {
    chain: { type: "string", enum: ["bitcoin", "ethereum"] },
    mode: { type: "string", enum: ["classic", "quantum"] },
    address: { type: "string", minLength: 1 },
    workers: { type: "integer", minimum: 1, maximum: 64 },
    force: { type: "boolean" },
    quantumBits: { type: "integer", minimum: 2, maximum: QUANTUM_BITS_MAX },
    customWallet: {
      type: "object",
      required: ["mnemonic"],
      properties: {
        mnemonic: { type: "string", minLength: 1 },
        passphrase: { type: "string" },
        expectedAddress: { type: "string", minLength: 1 },
        varySlots: {
          type: "array",
          // Coarse bound only (any BIP-39 phrase length); the handler's
          // varySlotsError returns the precise 422 for out-of-range slots.
          items: { type: "integer", minimum: 0, maximum: 23 },
          maxItems: 8,
        },
      },
    },
  },
} as const;

/** Engine kind labels per chain, shared by the corpus and custom flows. */
const KIND_FOR_CHAIN: Record<Chain, string[]> = {
  ethereum: ["eth"],
  bitcoin: ["btc-p2pkh", "btc-bech32"],
};

/** Which engine-derived address field serves each chain. */
function derivedAddressForChain(
  derivation: MnemonicDerivation,
  chain: Chain,
): string {
  return chain === "ethereum"
    ? derivation.addresses.eth
    : derivation.addresses.btc_p2pkh;
}

/**
 * Honest-scaling note for custom-wallet runs: the bundled pooled demo
 * keyspaces (the default varied-slot space and the legacy fixed-slot one)
 * are bounded, so a wallet outside them can only ever end exhausted. Stated
 * up front, not discovered at "exhausted".
 */
function boundedKeyspaceNote(wallet: CustomWalletProvenance): string {
  return wallet.inPooledSpace
    ? "This seed phrase lies inside the bounded pooled demo keyspace — the run can genuinely match it."
    : "Your wallet's address lies OUTSIDE the bounded pooled demo keyspace — the run stays bounded and will end exhausted without a match. That is the honest demonstration of keyspace scale, not a failure of your wallet.";
}

/** Max simultaneously-varied phrase slots the limited-keyspace mode allows. */
const VARY_SLOTS_MAX = 4;

/**
 * Validation for user-declared varying slots (0-based positions). Returns an
 * error message, or null when the slots are usable. Only 12-word phrases are
 * supported: the engine's template space is a 12-slot structure.
 */
function varySlotsError(slots: number[], wordCount: number): string | null {
  if (wordCount !== 12) {
    return "the limited-keyspace mode supports 12-word seed phrases";
  }
  if (slots.length > VARY_SLOTS_MAX) {
    return `at most ${VARY_SLOTS_MAX} phrase slots can vary at once — beyond that the disclosed keyspace grows past an honest demo runtime`;
  }
  const seen = new Set<number>();
  for (const slot of slots) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= wordCount) {
      return `vary slots must be phrase positions between 0 and ${wordCount - 1}`;
    }
    if (seen.has(slot)) {
      return `phrase position ${slot} is repeated — each slot can vary only once`;
    }
    seen.add(slot);
  }
  return null;
}

/**
 * The disclosed space for vary slots over a full wordlist. The engine folds
 * the twelfth slot into the checksum sweep, so only varied slots among the
 * first eleven widen the prefix space; each prefix ordinal then yields
 * poolSize/16 checksum-valid candidates (every prefix nibble has that many
 * completions in the full list).
 */
function templateKeyspace(
  varySlots: number[],
  poolSize: number,
): LimitedKeyspace & { prefixes: number } {
  const variedFirst11 = varySlots.filter((slot) => slot < 11).length;
  const prefixes = poolSize ** variedFirst11;
  return {
    variedPositions1Indexed: [...varySlots]
      .sort((a, b) => a - b)
      .map((slot) => slot + 1),
    poolWords: poolSize,
    rawAssemblies: prefixes * poolSize,
    estimatedChecksumValid: prefixes * (poolSize / 16),
    containsPhraseByConstruction: true,
    prefixes,
  };
}

/** Up-front disclosure for a limited-keyspace run: space, containment, ETA. */
function limitedKeyspaceNote(
  keyspace: LimitedKeyspace,
  etaSecondsValue: number | null,
): string {
  const positions = keyspace.variedPositions1Indexed.join(", ");
  const eta =
    etaSecondsValue === null
      ? "an estimate shown once the run starts"
      : etaSecondsValue < 90
        ? `about ${Math.max(1, Math.round(etaSecondsValue))} seconds`
        : etaSecondsValue < 5400
          ? `about ${Math.round(etaSecondsValue / 60)} minutes`
          : `about ${(etaSecondsValue / 3600).toFixed(1)} hours`;
  const singular = keyspace.variedPositions1Indexed.length === 1;
  return (
    `Limited-keyspace search: phrase position${singular ? "" : "s"} ${positions} ` +
    `var${singular ? "ies" : "y"} over the full ` +
    `${keyspace.poolWords.toLocaleString("en-US")}-word BIP-39 list while your other words stay fixed. ` +
    `The disclosed space is ${keyspace.rawAssemblies.toLocaleString("en-US")} raw assemblies ` +
    `(~${keyspace.estimatedChecksumValid.toLocaleString("en-US")} checksum-valid candidates). ` +
    `Your true phrase is inside this space by construction, so a genuine match is reachable — ` +
    `a full sweep takes ${eta} at the estimated rate.`
  );
}

export async function buildApp(
  options: BuildAppOptions,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  // A bodyless POST (cancel) may still declare a JSON content-type; the
  // default parser rejects that with a 400 (FST_ERR_CTP_EMPTY_JSON_BODY)
  // before the route handler runs. Treat an empty payload as no body
  // instead — malformed JSON still fails validation with a 400.
  app.addContentTypeParser<string>(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      if (body.trim().length === 0) return done(null, undefined);
      try {
        done(null, JSON.parse(body));
      } catch (err) {
        (err as Error & { statusCode?: number }).statusCode = 400;
        done(err as Error, undefined);
      }
    },
  );

  let corpus: CorpusDoc | null = options.corpus ?? null;
  const sysInfo = options.systemInfoFn ?? systemInfo;
  const clients = new Set<WebSocket>();

  // The engine's own BIP-39 list, fetched once: the single source of truth
  // for limited-keyspace pool configs.
  let wordlistCache: WordlistDoc | null = null;
  const engineWordlist = async (): Promise<WordlistDoc> => {
    if (wordlistCache === null) {
      wordlistCache = await listWordlist(options.cliPath);
    }
    return wordlistCache;
  };

  const runManager = new RunManager({
    cliPath: options.cliPath,
    runsDir: options.runsDir,
    broadcastIntervalMs: options.broadcastIntervalMs,
    runQuantumFn:
      options.runQuantumFn ??
      makeQuantumRunner({
        pythonBin: options.pythonBin ?? "python3",
        groverSrcDir: options.groverSrcDir,
      }),
  });

  const broadcast = (msg: ServerMessage): void => {
    const text = JSON.stringify(msg);
    for (const socket of clients) {
      if (socket.readyState === socket.OPEN) socket.send(text);
    }
  };

  async function ensureCorpus(): Promise<CorpusDoc> {
    if (corpus) return corpus;
    corpus = await listTargets(options.cliPath);
    return corpus;
  }

  app.get("/system", async () => {
    return {
      ...sysInfo(),
      bench: {
        perCoreDerivationsPerSec: PER_CORE_DERIVATIONS_PER_SEC,
        basis:
          "cracker-core benchmark: 5,479 full derivations/sec on a fully subscribed 8-core worker",
      },
      workersHardMax: WORKERS_HARD_MAX,
      workersDefault: WORKERS_DEFAULT,
    };
  });

  app.get("/corpus", async (_req, reply) => {
    try {
      return await ensureCorpus();
    } catch (err) {
      return reply.code(503).send({
        error: `engine corpus unavailable: ${String(err)}`,
        hint: "build cracker-cli (cargo build --release -p cracker-cli) or set CRACKER_CLI_PATH",
      });
    }
  });

  app.post(
    "/validate",
    {
      schema: {
        body: {
          type: "object",
          required: ["address"],
          properties: { address: { type: "string" } },
        },
      },
    },
    async (req, reply) => {
      const { address } = req.body as { address: string };
      try {
        const verdicts = await validateAddresses(options.cliPath, [address]);
        return verdicts[0] ?? { target: address, valid: false, error: "no verdict" };
      } catch (err) {
        return reply
          .code(503)
          .send({ error: `engine unavailable: ${String(err)}` });
      }
    },
  );

  /**
   * Derive every engine-supported address from a BIP-39 mnemonic the user
   * owns ("test with your own wallet"). Same derivation code path the search
   * engine runs per candidate; nothing is exposed — the caller already holds
   * the seed. The response is the ONLY supported way to obtain a target for
   * custom runs; /crack re-derives from the mnemonic in the same request.
   */
  app.post(
    "/derive",
    {
      schema: {
        body: {
          type: "object",
          required: ["mnemonic"],
          properties: {
            mnemonic: { type: "string", minLength: 1 },
            passphrase: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      const { mnemonic, passphrase } = req.body as {
        mnemonic: string;
        passphrase?: string;
      };
      try {
        const derivation = await deriveMnemonic(
          options.cliPath,
          mnemonic,
          passphrase ?? "",
        );
        return {
          mnemonic: derivation.mnemonic,
          addresses: derivation.addresses,
          paths: derivation.paths,
          poolMembership: {
            inSpace: derivation.pool_membership.in_space,
            totalPrefixes: derivation.pool_membership.total_prefixes,
            rawCandidates: derivation.pool_membership.raw_candidates,
          },
        };
      } catch (err) {
        if (err instanceof MnemonicError) {
          return reply
            .code(422)
            .send({ error: `invalid seed phrase: ${err.message}` });
        }
        return reply
          .code(503)
          .send({ error: `engine unavailable: ${String(err)}` });
      }
    },
  );

  app.get("/ws", { websocket: true }, (socket) => {
    clients.add(socket);
    // Late subscribers (page refresh) get the current state immediately.
    const report = runManager.activeReport;
    if (report) socket.send(JSON.stringify({ type: "snapshot", report }));
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });

  app.post(
    "/crack",
    { schema: { body: crackBodySchema } },
    async (req, reply) => {
      const body = req.body as CrackBody;
      const sys = sysInfo();

      if (runManager.activeRunId) {
        return reply.code(409).send({
          error: "a run is already active — cancel it first",
          activeRunId: runManager.activeRunId,
        });
      }

      // Resolve the search target. Custom-wallet mode: the target is ALWAYS
      // derived from the mnemonic supplied in this same request — a freeform
      // third-party address is never accepted, and a typed address is only a
      // cross-check that must match the derivation. Corpus mode: an explicit
      // bundled-corpus address, engine-validated.
      const runId = newRunId();
      let targetAddress: string;
      let targetKind: string;
      let customWallet: CustomWalletProvenance | null = null;
      let limitedKeyspace: (LimitedKeyspace & { prefixes: number }) | null =
        null;
      let poolJsonPath: string | null = null;
      let poolFileCleanup: (() => void) | null = null;

      if (body.customWallet !== undefined) {
        let derivation: MnemonicDerivation;
        try {
          derivation = await deriveMnemonic(
            options.cliPath,
            body.customWallet.mnemonic,
            body.customWallet.passphrase ?? "",
          );
        } catch (err) {
          if (err instanceof MnemonicError) {
            return reply.code(422).send({
              error: `invalid seed phrase: ${err.message}`,
            });
          }
          return reply
            .code(503)
            .send({ error: `engine unavailable: ${String(err)}` });
        }
        targetAddress = derivedAddressForChain(derivation, body.chain);
        targetKind = body.chain === "ethereum" ? "eth" : "btc-p2pkh";

        // Optional cross-check: well-formed, then must equal the derivation.
        const expected = body.customWallet.expectedAddress?.trim();
        if (expected !== undefined && expected.length > 0) {
          let checkVerdict: TargetVerdict;
          try {
            checkVerdict =
              (await validateAddresses(options.cliPath, [expected]))[0] ?? {
                target: expected,
                valid: false,
                error: "engine returned no verdict",
              };
          } catch (err) {
            return reply
              .code(503)
              .send({ error: `engine unavailable: ${String(err)}` });
          }
          if (!checkVerdict.valid) {
            return reply.code(422).send({
              error: `cross-check address is not a valid address: ${
                checkVerdict.error ?? "malformed"
              }`,
              verdict: checkVerdict,
            });
          }
          const typed = checkVerdict.normalized ?? expected;
          if (typed.toLowerCase() !== targetAddress.toLowerCase()) {
            return reply.code(422).send({
              error:
                "cross-check failed: the address you typed is not the one this seed phrase derives — the engine-derived address is always the target, a freeform third-party address is never used",
              derivedAddress: targetAddress,
              typedAddress: typed,
            });
          }
        }
        // Limited-keyspace mode: declared slots vary over the full BIP-39
        // list, every other position stays fixed, and the disclosed keyspace
        // contains the true phrase by construction. Classical only — the
        // toy Grover simulation has no user phrase to contain.
        const varySlots = body.customWallet.varySlots ?? [];
        if (varySlots.length > 0 && body.mode === "quantum") {
          return reply.code(422).send({
            error:
              "the limited-keyspace search is classical-only — quantum mode is a toy Grover simulation over the bundled tiny keyspace, not your phrase",
          });
        }
        const phraseWords = derivation.mnemonic.trim().split(/\s+/);
        if (varySlots.length > 0) {
          const slotError = varySlotsError(varySlots, phraseWords.length);
          if (slotError !== null) {
            return reply.code(422).send({ error: slotError });
          }
          let wordlist: string[];
          try {
            wordlist = (await engineWordlist()).words;
          } catch (err) {
            return reply
              .code(503)
              .send({ error: `engine unavailable: ${String(err)}` });
          }
          if (wordlist.length % 16 !== 0) {
            return reply.code(503).send({
              error: `unexpected BIP-39 wordlist size ${wordlist.length} — expected a multiple of 16 checksum values`,
            });
          }
          limitedKeyspace = templateKeyspace(varySlots, wordlist.length);
          const poolDir = path.join(options.runsDir, "pools");
          await mkdir(poolDir, { recursive: true });
          const poolPath = path.join(poolDir, `${runId}.json`);
          // Her words stay fixed; the declared slots sweep the full list.
          const poolConfig = {
            pool_words: wordlist,
            variable_positions_1_indexed:
              limitedKeyspace.variedPositions1Indexed,
            fixed_words_1_indexed: Object.fromEntries(
              phraseWords
                .map((word, index) => [index, word] as const)
                .filter(([index]) => !varySlots.includes(index))
                .map(([index, word]) => [String(index + 1), word]),
            ),
          };
          // 0600: until the run settles this file holds most of the user's
          // phrase; only the varied slots are meant to be enumerable.
          await writeFile(poolPath, JSON.stringify(poolConfig), {
            mode: 0o600,
          });
          poolJsonPath = poolPath;
          poolFileCleanup = () => {
            unlink(poolPath).catch((err: unknown) => {
              console.error(`pool file cleanup failed for ${runId}:`, err);
            });
          };
        }
        customWallet = {
          targetSource: "derived-from-mnemonic",
          derivedAddresses: derivation.addresses,
          paths: derivation.paths,
          crossCheckUsed: expected !== undefined && expected.length > 0,
          inPooledSpace: derivation.pool_membership.in_space,
          limitedKeyspace,
        };
      } else {
        const address = body.address?.trim() ?? "";
        if (address === "") {
          return reply.code(422).send({
            error:
              "address is required — or supply customWallet to derive the target from your own seed phrase",
          });
        }

        // Engine-backed validation: malformed fails decode here.
        let verdict: TargetVerdict;
        try {
          verdict =
            (await validateAddresses(options.cliPath, [address]))[0] ?? {
              target: address,
              valid: false,
              error: "engine returned no verdict",
            };
        } catch (err) {
          return reply
            .code(503)
            .send({ error: `engine unavailable: ${String(err)}` });
        }
        if (!verdict.valid) {
          return reply.code(422).send({
            error: verdict.error ?? "invalid address",
            verdict,
          });
        }

        // The requested chain must agree with the address's decoded kind.
        const kind = verdict.kind ?? "";
        if (!KIND_FOR_CHAIN[body.chain].includes(kind)) {
          return reply.code(422).send({
            error: `address is a ${kind} address — switch the chain toggle or use a ${body.chain} address`,
            verdict,
          });
        }
        targetAddress = verdict.normalized ?? address;
        targetKind = kind;
      }

      if (body.mode === "quantum") {
        const bits = Math.min(
          body.quantumBits ?? QUANTUM_BITS_DEFAULT,
          QUANTUM_BITS_MAX,
        );
        const report = runManager.startQuantum(
          { runId, chain: body.chain, address: targetAddress, bits, customWallet },
          broadcast,
        );
        return reply.code(201).send({
          runId: report.runId,
          mode: "quantum",
          totalCandidates: report.totalCandidates,
          note: QUANTUM_NOTE,
          ...(customWallet !== null
            ? { customWallet, targetNote: boundedKeyspaceNote(customWallet) }
            : {}),
        });
      }

      const workers = body.workers ?? WORKERS_DEFAULT;
      if (workers > WORKERS_HARD_MAX) {
        return reply.code(422).send({
          error: `workers is capped at ${WORKERS_HARD_MAX}`,
        });
      }
      if (workers > sys.safeMaxWorkers && !body.force) {
        return reply.code(422).send({
          error:
            "at some point your computer crashes - reduce workers or force override",
          safeMaxWorkers: sys.safeMaxWorkers,
          cores: sys.cores,
        });
      }

      const doc = await ensureCorpus();
      // Limited-keyspace runs derive their own space: lane ranges split the
      // template's prefix ordinals; totals use its checksum-valid estimate.
      const total =
        limitedKeyspace === null
          ? doc.space.total_prefixes
          : limitedKeyspace.estimatedChecksumValid;
      const rawCandidates =
        limitedKeyspace === null
          ? doc.space.raw_candidates
          : limitedKeyspace.rawAssemblies;
      const ranges = splitSpace(
        limitedKeyspace === null
          ? doc.space.total_prefixes
          : limitedKeyspace.prefixes,
        workers,
      );

      const report = runManager.startClassic(
        {
          runId,
          chain: body.chain,
          address: targetAddress,
          addressType: targetKind,
          ranges,
          totalCandidates: total,
          rawCandidates,
          progressMs: options.progressMs ?? PROGRESS_MS,
          customWallet,
          poolJsonPath,
          ...(poolFileCleanup === null ? {} : { onSettled: poolFileCleanup }),
        },
        broadcast,
      );

      const estimatedRate = estimateAggregateRate(
        ranges.length,
        sys.cores,
        PER_CORE_DERIVATIONS_PER_SEC,
      );
      return reply.code(201).send({
        runId: report.runId,
        mode: "classic",
        lanes: ranges.map((r, i) => ({ id: i, ...r })),
        totalCandidates: total,
        rawCandidates,
        estimatedRatePerSec: estimatedRate,
        etaSeconds: etaSeconds(total, 0, estimatedRate),
        safeMaxWorkers: sys.safeMaxWorkers,
        cores: sys.cores,
        forced: workers > sys.safeMaxWorkers,
        ...(customWallet !== null
          ? {
              customWallet,
              targetNote:
                limitedKeyspace === null
                  ? boundedKeyspaceNote(customWallet)
                  : limitedKeyspaceNote(
                      limitedKeyspace,
                      etaSeconds(total, 0, estimatedRate),
                    ),
            }
          : {}),
      });
    },
  );

  app.post("/crack/:runId/cancel", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    if (runManager.activeRunId !== runId) {
      return reply.code(404).send({ error: "no such active run" });
    }
    const cancelled = runManager.cancel();
    return cancelled
      ? { runId, cancelled: true }
      : reply.code(409).send({ error: "run is not running" });
  });

  app.get("/runs/:runId", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    if (runManager.activeReport?.runId === runId) {
      return runManager.activeReport;
    }
    try {
      const raw = await readFile(
        path.join(options.runsDir, `${runId}.json`),
        "utf8",
      );
      return JSON.parse(raw) as RunReport;
    } catch {
      return reply.code(404).send({ error: "run report not found" });
    }
  });

  app.addHook("onClose", async () => {
    runManager.cancel();
  });

  if (options.staticDir) {
    await app.register(fastifyStatic, { root: options.staticDir });
    // SPA fallback: a page load for an unknown path gets the console;
    // everything else (bad API paths, bad methods) stays a JSON 404.
    app.setNotFoundHandler((req, reply) => {
      const accept = req.headers.accept ?? "";
      if (req.method === "GET" && accept.includes("text/html")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "not found" });
    });
  }

  return app;
}

function newRunId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `run_${Date.now().toString(36)}_${rand}`;
}
