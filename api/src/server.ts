import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash, randomInt } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PER_CORE_DERIVATIONS_PER_SEC,
  PROGRESS_MS,
  QUANTUM_MODE_NOTE,
  WORKERS_DEFAULT,
  WORKERS_HARD_MAX,
} from "./config.js";
import { estimateAggregateRate, etaSeconds } from "./estimate.js";
import { systemInfo } from "./system.js";
import { splitSpace } from "./ranges.js";
import {
  PRESEED_ASSET_SHA256,
  PRESEED_CONSENT_MESSAGE,
  PRESEED_WATCHLIST_KEYS,
  preseedNote,
} from "./preseed.js";
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
import type {
  Chain,
  CustomWalletProvenance,
  LimitedKeyspace,
  Mode,
  ProbeProvenance,
  RunReport,
  ServerMessage,
} from "./types.js";
import type { WebSocket } from "ws";

export interface BuildAppOptions {
  cliPath: string;
  runsDir: string;
  /** Inject a fixture corpus (tests); otherwise loaded from the engine. */
  corpus?: CorpusDoc;
  broadcastIntervalMs?: number;
  /** Injectable for tests: lane progress cadence (default config). */
  progressMs?: number;
  /** Injectable for tests: deterministic host capabilities. */
  systemInfoFn?: () => ReturnType<typeof systemInfo>;
  /**
   * Discovery watchlist: one address per line; a candidate deriving any of
   * them ends the run as a labeled discovery. Default: the bundled asset.
   * Set to null to run without one (disclosed in the response).
   */
  watchlistPath?: string | null;
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
   * contains the true phrase by construction. Classical mode only. When
   * empty/absent, the run is a full-space lottery (the own-wallet default).
   */
  varySlots?: number[];
  /**
   * Lottery draw budget (safety cap on raw draws). Ignored for marked-slot
   * runs; the run still ends early on a genuine match or a cancel.
   */
  drawBudget?: number;
}

interface CrackBody {
  chain: Chain;
  mode: Mode;
  /** Address-only lottery target: ANY valid address, no seed supplied. */
  address?: string;
  workers?: number;
  force?: boolean;
  /** "Test with your own wallet": derive the target from this mnemonic. */
  customWallet?: CustomWalletBody;
  /**
   * Address-only full-space lottery: the run is a disclosed draw-budget
   * lottery over ALL checksum-valid phrases (2^128 ≈ 3.4×10^38). The flag is
   * the user's consent to those odds — address-only requests are refused
   * without it. Mutually exclusive with customWallet (separate permissions).
   * Also the pre-seed consent flag (2^256 draws against the era P2PK list).
   */
  probe?: boolean;
  /** Address-only / pre-seed lottery draw budget (safety cap on raw draws). */
  drawBudget?: number;
}

/**
 * The BIP-39 mnemonic every run tests FIRST (Kacie's calibration anchor),
 * address-only runs included, so timing is reproducible across runs.
 */
const CALIBRATION_PHRASE =
  "permit bean gaze lawsuit expect exclude poet mercy enrich measure ocean since";

/** Lottery draw budget defaults and cap (raw draws, ~1,400/s at one worker). */
const LOTTERY_DRAWS_DEFAULT = 5_000_000;
const LOTTERY_DRAWS_MAX = 500_000_000;

const crackBodySchema = {
  type: "object",
  required: ["chain", "mode"],
  properties: {
    chain: { type: "string", enum: ["bitcoin", "ethereum"] },
    mode: { type: "string", enum: ["classic", "quantum", "preseed"] },
    address: { type: "string", minLength: 1 },
    workers: { type: "integer", minimum: 1, maximum: 64 },
    force: { type: "boolean" },
    probe: { type: "boolean" },
    drawBudget: {
      type: "integer",
      minimum: 1_000,
      maximum: LOTTERY_DRAWS_MAX,
    },
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
        drawBudget: {
          type: "integer",
          minimum: 1_000,
          maximum: LOTTERY_DRAWS_MAX,
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
 * Neutral pool-membership note (informational only): the lottery and
 * marked-slot searches never depend on it, so it must not read as a verdict
 * on whether the run can succeed.
 */
function poolMembershipNote(wallet: CustomWalletProvenance): string {
  return wallet.inPooledSpace
    ? "Pool membership (informational): this phrase also lies inside the bounded pooled demo keyspace, so the pooled corpus mode can reach it too."
    : "Pool membership (informational): this phrase lies outside the bounded pooled demo keyspace — irrelevant for the lottery and marked-slot searches below, which do not depend on it.";
}

/**
 * Up-front disclosure for a full-space lottery run. The odds are over the
 * CHECKSUM-VALID space (2^128 ≈ 3.4×10^38 phrases — the engine samples valid
 * phrases only); the raw 2048^12 ≈ 5.4×10^39 assembly count is labeled as
 * raw. Never softened: the expected wait is the teaching point.
 */
function lotteryNote(
  pinnedIsUserPhrase: boolean,
  watchlistSize: number | null,
): string {
  const pin = pinnedIsUserPhrase
    ? "Your own phrase is pinned as the first candidate (labeled “pinned — not random”) for a reproducible benchmark; if it genuinely derives your address the run reports a real match at candidate #1 and ends — that is correct behavior, not a bug."
    : `The calibration phrase (“${CALIBRATION_PHRASE}”) is pinned as the first candidate (labeled “pinned — not random”) for a reproducible benchmark; it is not the target — the run continues into random sampling unless a candidate genuinely derives the address.`;
  const watchlist =
    watchlistSize === null
      ? ""
      : ` Discovery watchlist: ${watchlistSize.toLocaleString("en-US")} real-world addresses are armed — if any tested phrase genuinely derives one, the run stops immediately and reports it as a labeled discovery (a chance hit on someone's actual wallet, never presented as recovery of the address you asked about; per-draw odds ${watchlistSize.toLocaleString("en-US")} in 3.4×10^38).`;
  return (
    "Full-space lottery: every draw picks all 12 words uniformly at random and " +
    "keeps only checksum-valid phrases — 2^128 ≈ 3.4×10^38 valid phrases " +
    "(2048^12 ≈ 5.4×10^39 raw assemblies before checksum filtering). " +
    "At ~1,400 draws/s the odds of one specific phrase are about 1 in 6.7×10^31 " +
    "per hour — the expected wait is ~10^28 years, many times the age of the " +
    "universe. That is the honest demonstration of why real wallets are safe, " +
    "and a genuine-but-astronomically-unlikely lottery. " +
    pin +
    watchlist +
    " The run stops at its draw budget or when you stop it — it never claims exhaustive coverage."
  );
}

/** One shared u64 shuffle/draw seed per run, as a decimal string for the CLI. */
function newSeed(): string {
  // randomInt's range cap is 2^48 − 1 (exclusive max), plenty of entropy for
  // a demo shuffle seed.
  return randomInt(0, 2 ** 48 - 1).toString();
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

/**
 * Up-front disclosure for an address-only full-space lottery: the honest math
 * stated before the run starts. No seed phrase is involved; the declared
 * address may be any valid address; a match is claimed exactly when a tested
 * phrase derives it — derivation equality, nothing else.
 */
function addressOnlyDisclosure(
  drawBudget: number,
  watchlistSize: number | null,
): string {
  return (
    "Feasibility lottery — every draw picks all 12 words at random over ALL checksum-valid " +
    "12-word BIP-39 phrases (2^128 ≈ 3.4×10^38 valid; 2048^12 ≈ 5.4×10^39 raw assemblies before " +
    "checksum filtering). At ~1,400 draws/s the odds of deriving this specific address are about " +
    "1 in 6.7×10^31 per hour — the expected wait is ~10^28 years, so this address will not be found; " +
    `the run is a bounded budget of ${drawBudget.toLocaleString("en-US")} draws ` +
    "and ends at the budget or when you stop it, never claiming exhaustive coverage. " +
    (watchlistSize === null
      ? "No discovery watchlist is loaded. "
      : `A discovery watchlist of ${watchlistSize.toLocaleString("en-US")} real-world addresses is armed: if any tested phrase genuinely derives one of them, the run stops and reports a labeled discovery — never presented as recovery of the address you asked about. `) +
    "A match is claimed only if a tested phrase genuinely derives the target address — derivation equality, nothing else."
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

  /**
   * Discovery watchlist (cached): the asset's absolute path — handed to lanes
   * as --watchlist — and its address count for the disclosures. Missing or
   * unreadable asset → path null (runs proceed without discovery stops) and
   * the size null; the disclosures say so rather than pretending.
   */
  let watchlist: { path: string | null; size: number | null } | null = null;
  async function ensureWatchlist(): Promise<{
    path: string | null;
    size: number | null;
  }> {
    if (watchlist !== null) return watchlist;
    if (options.watchlistPath === null) {
      watchlist = { path: null, size: null };
      return watchlist;
    }
    const resolved =
      options.watchlistPath ??
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../assets/discovery-watchlist.txt",
      );
    try {
      const text = await readFile(resolved, "utf8");
      const size = text
        .split("\n")
        .filter((line) => {
          const t = line.trim();
          return t.length > 0 && !t.startsWith("#");
        }).length;
      watchlist = { path: resolved, size };
    } catch (err) {
      console.error(`discovery watchlist unavailable (${resolved}):`, err);
      watchlist = { path: null, size: null };
    }
    return watchlist;
  }

  /**
   * The pre-seed P2PK watchlist asset: verified once, then handed to lanes
   * by path (the engine re-verifies per spawn — belt and suspenders). BOTH
   * sides pin the same SHA-256 and key count; any mismatch fails LOUDLY and
   * refuses to run, because a corrupted watchlist entry would silently skip
   * a recoverable key — the exact failure mode the dataset research bans
   * spreadsheet exports for.
   */
  let p2pkWatchlistPath: string | null = null;
  function ensureP2pkWatchlist(): string {
    if (p2pkWatchlistPath !== null) return p2pkWatchlistPath;
    const resolved = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../assets/p2pk-watchlist.txt",
    );
    const raw = readFileSync(resolved);
    // Hash the canonical bytes: same normalization as the engine loader —
    // strip one trailing LF (and a CR that LF may leave behind).
    let end = raw.length;
    if (end > 0 && raw[end - 1] === 0x0a) end -= 1;
    if (end > 0 && raw[end - 1] === 0x0d) end -= 1;
    const actual = createHash("sha256")
      .update(raw.subarray(0, end))
      .digest("hex");
    if (actual !== PRESEED_ASSET_SHA256) {
      throw new Error(
        `SHA-256 mismatch: expected ${PRESEED_ASSET_SHA256}, got ${actual} — asset corrupted or swapped`,
      );
    }
    const keys = raw
      .toString("utf8")
      .split("\n")
      .filter((line) => {
        const t = line.trim();
        return t.length > 0 && !t.startsWith("#");
      });
    if (keys.length !== PRESEED_WATCHLIST_KEYS) {
      throw new Error(
        `expected ${PRESEED_WATCHLIST_KEYS} watchlist keys, found ${keys.length}`,
      );
    }
    p2pkWatchlistPath = resolved;
    return resolved;
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

      // Pre-seed lottery: targetless by construction — the Satoshi-era P2PK
      // watchlist IS the target set. Bitcoin only; consent-gated like the
      // address-only lottery; anything that smuggles a user target in is a
      // contract error, not a degraded run. (Checked before the address-only
      // probe/customWallet conflict guard: that guard speaks for the
      // address-only flow; pre-seed has its own contract.)
      if (body.mode === "preseed") {
        if (body.chain !== "bitcoin") {
          return reply.code(422).send({
            error:
              "pre-seed mode is Bitcoin-only: era P2PK outputs are a Bitcoin construction — switch the chain toggle to bitcoin",
          });
        }
        if (
          body.address !== undefined ||
          body.customWallet !== undefined ||
          body.workers !== undefined
        ) {
          return reply.code(422).send({
            error:
              'pre-seed mode has no user-supplied target and no lanes: send { chain: "bitcoin", mode: "preseed", probe: true, drawBudget? } — the Satoshi-era P2PK watchlist is the target set',
          });
        }
        if (body.probe !== true) {
          return reply.code(422).send({ error: PRESEED_CONSENT_MESSAGE });
        }
        // Integrity first: a corrupted watchlist must refuse to run at all.
        let preseedWatchlistPath: string;
        try {
          preseedWatchlistPath = ensureP2pkWatchlist();
        } catch (err) {
          return reply.code(503).send({
            error: `pre-seed watchlist failed integrity checks — refusing to run: ${String(
              err,
            )}`,
          });
        }
        const runId = newRunId();
        const drawBudget = Math.min(
          body.drawBudget ?? LOTTERY_DRAWS_DEFAULT,
          LOTTERY_DRAWS_MAX,
        );
        const seed = newSeed();
        const richWl = await ensureWatchlist();
        const probe: ProbeProvenance = {
          targetSource: "preseed",
          searchedSpace: "all-secp256k1-private-keys",
          searchedRawCandidates: null,
          searchedChecksumValid: null,
          declaredSpaceSearched: false,
          disclosure: preseedNote(),
        };
        const report = runManager.startPreSeed(
          {
            runId,
            drawBudget,
            progressMs: options.progressMs ?? PROGRESS_MS,
            seed,
            probe,
            preseedWatchlistPath,
            // The rich-address list only LABELS a discovery (richWatchlistHit);
            // it never ends a pre-seed run.
            watchlistPath: richWl.path,
          },
          broadcast,
        );
        return reply.code(201).send({
          runId: report.runId,
          mode: "preseed",
          searchKind: "lottery",
          drawBudget,
          seed,
          totalCandidates: report.totalCandidates,
          note: preseedNote(),
          probe,
          targetNote: probe.disclosure,
        });
      }

      // The feasibility probe is address-only: no seed phrase is involved, so
      // it cannot be combined with the custom-wallet derivation flow.
      if (body.probe === true && body.customWallet !== undefined) {
        return reply.code(422).send({
          error:
            "address-only lottery runs take only an address — no seed phrase is involved; drop customWallet to run the disclosed lottery against an arbitrary address",
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
      let probe: ProbeProvenance | null = null;
      let limitedKeyspace: (LimitedKeyspace & { prefixes: number }) | null =
        null;
      let poolJsonPath: string | null = null;
      let addressOnlyBudget: number | null = null;
      let addressOnlySeed: string | null = null;
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
        // contains the true phrase by construction. Classical only — quantum
        // mode's search leg is the full-space lottery, not a marked-slot sweep.
        const varySlots = body.customWallet.varySlots ?? [];
        if (varySlots.length > 0 && body.mode === "quantum") {
          return reply.code(422).send({
            error:
              "the limited-keyspace sweep is classical-only — quantum mode runs the full-space lottery (all 12 words random) beside the Grover extrapolation panel, so there are no fixed words to vary",
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

        // Address-only runs are the full-space lottery — the SAME behavior
        // as own-wallet mode, no bounded corpus sweep exists on this path.
        // The probe flag is the user's consent to the disclosed odds; any
        // valid address is a legitimate lottery target (rich-list quick
        // picks included), corpus member or not. Quantum mode runs the same
        // lottery as its classical leg, so the same consent applies.
        if (body.probe !== true) {
          return reply.code(422).send({
            error:
              'address-only runs are a full-space lottery over every checksum-valid 12-word phrase (2^128 ≈ 3.4×10^38) — resend with "probe": true to accept the disclosed odds, or supply customWallet to derive the target from your own seed phrase',
          });
        }
        addressOnlyBudget = Math.min(
          body.drawBudget ?? LOTTERY_DRAWS_DEFAULT,
          LOTTERY_DRAWS_MAX,
        );
        addressOnlySeed = newSeed();
        const wl = await ensureWatchlist();
        probe = {
          targetSource: "addressOnly",
          searchedSpace: "all-checksum-valid-12-word-bip39-phrases",
          searchedRawCandidates: null,
          searchedChecksumValid: null,
          declaredSpaceSearched: false,
          disclosure: addressOnlyDisclosure(addressOnlyBudget, wl.size),
        };
      }

      // Address-only lotteries (classic or quantum — the classical legs are
      // the same lottery class): ANY valid address, consented odds, the
      // calibration phrase pinned first, discovery watchlist armed. This is
      // the only address-only path — no bounded corpus sweep exists here.
      if (probe !== null) {
        const wl = await ensureWatchlist();
        const report = runManager.startLottery(
          {
            runId,
            chain: body.chain,
            address: targetAddress,
            addressType: targetKind,
            drawBudget: addressOnlyBudget ?? LOTTERY_DRAWS_DEFAULT,
            progressMs: options.progressMs ?? PROGRESS_MS,
            seed: addressOnlySeed,
            pinnedFirst: CALIBRATION_PHRASE,
            probe,
            watchlistPath: wl.path,
            ...(body.mode === "quantum" ? { mode: "quantum" } : {}),
          },
          broadcast,
        );
        return reply.code(201).send({
          runId: report.runId,
          mode: body.mode,
          searchKind: "lottery",
          drawBudget: addressOnlyBudget ?? LOTTERY_DRAWS_DEFAULT,
          seed: addressOnlySeed,
          totalCandidates: report.totalCandidates,
          note:
            body.mode === "quantum"
              ? `${lotteryNote(false, wl.size)} ${QUANTUM_MODE_NOTE}`
              : lotteryNote(false, wl.size),
          probe,
          targetNote: probe.disclosure,
        });
      }

      // ONE lottery class, two labels: quantum mode's classical search leg
      // and the own-wallet default are the SAME full-space lottery — uniform
      // random draws over ALL checksum-valid 12-word phrases (2^128), odds
      // disclosed in the response, pinned first candidate, ends at budget or
      // cancel with no coverage claim. The quantum leg itself is the app's
      // closed-form Grover extrapolation panel — nothing runs server-side.
      // The classic bounded path below is for marked-slot own-wallet sweeps
      // and corpus searches.
      if (body.mode === "quantum" || (customWallet !== null && limitedKeyspace === null)) {
        const pinnedIsUserPhrase = customWallet !== null;
        const drawBudget = Math.min(
          body.customWallet?.drawBudget ?? LOTTERY_DRAWS_DEFAULT,
          LOTTERY_DRAWS_MAX,
        );
        const seed = newSeed();
        const wl = await ensureWatchlist();
        const note =
          body.mode === "quantum"
            ? `${lotteryNote(pinnedIsUserPhrase, wl.size)} ${QUANTUM_MODE_NOTE}`
            : lotteryNote(pinnedIsUserPhrase, wl.size);
        const report = runManager.startLottery(
          {
            runId,
            chain: body.chain,
            address: targetAddress,
            addressType: targetKind,
            drawBudget,
            progressMs: options.progressMs ?? PROGRESS_MS,
            customWallet,
            seed,
            // Own-wallet runs pin the user's phrase; corpus/quantum runs pin
            // the calibration phrase for Kacie's benchmark anchor.
            pinnedFirst: pinnedIsUserPhrase
              ? (body.customWallet?.mnemonic ?? null)
              : CALIBRATION_PHRASE,
            // In-request derivation attests the target: the engine's
            // derived-target permission applies, not the probe label. Quantum
            // runs without a wallet have no in-request derivation.
            ...(customWallet !== null ? { derivedTarget: true } : {}),
            watchlistPath: wl.path,
            ...(body.mode === "quantum" ? { mode: "quantum" } : {}),
          },
          broadcast,
        );
        return reply.code(201).send({
          runId: report.runId,
          mode: body.mode,
          searchKind: "lottery",
          drawBudget,
          seed,
          totalCandidates: report.totalCandidates,
          note,
          ...(customWallet !== null
            ? {
                customWallet,
                poolMembershipNote: poolMembershipNote(customWallet),
              }
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

      // Reaching this block means a limited-keyspace own-wallet sweep: both
      // lottery paths above returned, so the bundled corpus fallback below
      // is gone — bounded corpus search is retired as a user-reachable path.
      if (limitedKeyspace === null || poolJsonPath === null) {
        return reply.code(422).send({
          error: "no searchable space resolved for this request",
        });
      }
      const total = limitedKeyspace.estimatedChecksumValid;
      const rawCandidates = limitedKeyspace.rawAssemblies;
      const ranges = splitSpace(limitedKeyspace.prefixes, workers);

      const wl = await ensureWatchlist();
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
          probe: null,
          poolJsonPath,
          watchlistPath: wl.path,
          seed: newSeed(),
          // Bounded own-wallet sweeps pin the user's phrase first; the run
          // manager tests it exactly once (lane 0).
          pinnedFirst: body.customWallet?.mnemonic ?? null,
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
              // limitedKeyspace is non-null in this branch (guarded above).
              targetNote: `${limitedKeyspaceNote(
                limitedKeyspace,
                etaSeconds(total, 0, estimatedRate),
              )} ${poolMembershipNote(customWallet)}`,
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
