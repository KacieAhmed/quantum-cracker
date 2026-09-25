#!/usr/bin/env node
// Test double for cracker-cli: same argument surface and event stream as the
// real binary, over a tiny canned space. Env knobs:
//   FAKE_SPACE (default 1000)      — prefix-ordinal space size
//   FAKE_MATCH (default 1)         — 1: the lane owning FAKE_MATCH_ORDINAL matches
//   FAKE_MATCH_ORDINAL (default 700)
//   FAKE_TICKS (default 4)         — progress ticks before match/exhaustion
//
// --derive-mnemonic validity rules (canned mirror of the real engine):
//   - word count must be 12 or 24 (real BIP-39: 12/15/18/21/24)
//   - every word must be in the real BIP-39 English wordlist
//   - a 12-word phrase ending in "abandon" fails the (fake) checksum
//   - in-space = phrase starts with "abandon ability able"
//
// --pool-json <path> makes the search space a limited-keyspace template:
// prefixes = pool_words.length ^ (varied positions among the first eleven),
// raw candidates = prefixes × pool_words.length — the real engine's math.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);

function flag(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}

// The engine's own embedded BIP-39 English wordlist — membership and the
// --list-wordlist output both come from it, so 'been'-style typos fail here
// exactly like they fail on the real engine.
const WORDLIST_PATH = new URL(
  "../../../crates/cracker-core/test-vectors/english.txt",
  import.meta.url,
);
const BIP39_WORDS = new Set(
  readFileSync(WORDLIST_PATH, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0),
);

// Deterministic 40-hex fake from a string (FNV-1a, zero-padded).
function fakeHex(seed, len) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let out = "";
  for (let i = 0; out.length < len; i++) {
    h = Math.imul(h ^ i, 0x01000193) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, len);
}

function deriveForTest(mnemonic) {
  const eth = "0x" + fakeHex("eth:" + mnemonic, 40);
  const btc_p2pkh = "1" + fakeHex("p2pkh:" + mnemonic, 26);
  const btc_bech32 = "bc1q" + fakeHex("bech32:" + mnemonic, 38);
  return { eth, btc_p2pkh, btc_bech32 };
}

function deriveErrorForTest(mnemonic) {
  const words = mnemonic.trim().split(/\s+/);
  if (!(words.length === 12 || words.length === 24)) {
    return `invalid mnemonic word count (${words.length}) — expected 12, 15, 18, 21 or 24`;
  }
  const unknown = words.findIndex((w) => !BIP39_WORDS.has(w));
  if (unknown >= 0) {
    return `invalid mnemonic: word at position ${unknown + 1} is not in the BIP-39 English wordlist`;
  }
  if (words.length === 12 && words[11] === "abandon") {
    return "invalid mnemonic: checksum failed";
  }
  return null;
}

function poolMembershipForTest(mnemonic) {
  const inSpace = mnemonic.trim().startsWith("abandon ability able");
  return { in_space: inSpace, total_prefixes: 1000, raw_candidates: 16000 };
}

if (args.includes("--derive-mnemonic")) {
  const mnemonic = flag("derive-mnemonic", "");
  const passphrase = flag("passphrase", "") ?? "";
  const err = deriveErrorForTest(mnemonic);
  if (err !== null) {
    console.log(JSON.stringify({ error: err }));
    process.exit(2);
  }
  const addresses = deriveForTest(mnemonic + "|" + passphrase);
  console.log(JSON.stringify({
    mnemonic,
    addresses,
    paths: {
      eth: "m/44'/60'/0'/0/0",
      btc_p2pkh: "m/44'/0'/0'/0/0",
      btc_bech32: "m/84'/0'/0'/0/0",
    },
    pool_membership: poolMembershipForTest(mnemonic),
  }));
  process.exit(0);
}

// --derive-privkey: canned mirror of the raw-key proof. The fixture-verse
// key is k=1 (same key material the preseed discovery payload uses), so
// every value below matches the fixture's frozen discovery numbers.
const K1_WIF_C = "KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn";
const K1_WIF_U = "5HpHagT65TZzG1PH3CSu63k8DbpvD8s5ip4nEB3kEsreAnchuDf";
const K1_HEX = "0000000000000000000000000000000000000000000000000000000000000001";
const K1_PROOF = {
  input_form: null,
  input_wif: null,
  wif_compressed: K1_WIF_C,
  wif_uncompressed: K1_WIF_U,
  private_key_hex: K1_HEX,
  pubkey_compressed_hex:
    "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  pubkey_uncompressed_hex:
    "0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8",
  address_p2pkh_compressed: "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
  address_p2pkh_uncompressed: "1EHNa6P4AAaDEoRCvJ4m1jWWtLxE5vCjyS",
  address_eth: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
  expected_address: null,
  matched_path: null,
};

if (args.includes("--derive-privkey")) {
  const key = (flag("derive-privkey", "") ?? "").trim();
  const expected = flag("expect-address", null);
  if (expected !== null && expected.trim() === "0xBAD") {
    // The fixture's malformed-address marker (same one --validate-only rejects).
    console.log(JSON.stringify({ error: "invalid expected address: malformed address" }));
    process.exit(2);
  }
  const body = key.toLowerCase().replace(/^0x/, "");
  if (/^[0-9a-f]+$/.test(body)) {
    if (body.length !== 64) {
      console.log(JSON.stringify({ error: `invalid private key: raw scalar must be exactly 64 hex characters (32 bytes, optional 0x prefix), found ${body.length} hex characters` }));
      process.exit(2);
    }
    if (body === K1_HEX) {
      K1_PROOF.input_form = "hex";
    } else if (BigInt("0x" + body) === 0n) {
      console.log(JSON.stringify({ error: "invalid private key: the zero scalar is not a usable secp256k1 key" }));
      process.exit(2);
    } else if (BigInt("0x" + body) >= BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141")) {
      console.log(JSON.stringify({ error: "invalid private key: scalar is out of range \u2014 secp256k1 keys must lie in [1, n)" }));
      process.exit(2);
    } else {
      // Any other in-range scalar is valid but has no fixture derivation:
      // reject with the checksum-style canned error only for the WIF path.
      K1_PROOF.input_form = "hex";
    }
  } else if (key === K1_WIF_C || key === K1_WIF_U) {
    K1_PROOF.input_form = "wif";
    K1_PROOF.input_wif = key;
  } else {
    console.log(JSON.stringify({ error: "invalid private key: WIF base-58 checksum mismatch \u2014 the string was mistyped or truncated" }));
    process.exit(2);
  }
  if (expected !== null) {
    K1_PROOF.expected_address = expected.trim();
    const e = expected.trim().toLowerCase();
    if (e === K1_PROOF.address_eth.toLowerCase()) {
      K1_PROOF.matched_path = "eth";
    } else if (e === K1_PROOF.address_p2pkh_compressed.toLowerCase()) {
      K1_PROOF.matched_path = "btc-p2pkh-compressed";
    } else if (e === K1_PROOF.address_p2pkh_uncompressed.toLowerCase()) {
      K1_PROOF.matched_path = "btc-p2pkh-uncompressed";
    }
  }
  console.log(JSON.stringify(K1_PROOF));
  process.exit(0);
}

const SPACE = Number(process.env.FAKE_SPACE ?? 1000);
const MATCH = (process.env.FAKE_MATCH ?? "1") === "1";
const MATCH_ORDINAL = Number(process.env.FAKE_MATCH_ORDINAL ?? 700);
const TICKS = Number(process.env.FAKE_TICKS ?? 4);
const MATCH_MNEMONIC = "ocean abstract raven accident hill absent winter abstract candy abuse mango able";
const MATCH_ADDRESSES = {
  eth: "0xb79f8aC312fF21AD16980a857f574A6e7e3ED9c5",
  btc_p2pkh: "16HxxyAQvA3AKThfcJGxSqKJ3Hs9RnTgHp",
  btc_bech32: "bc1qnm5mmckh08leuwsygfre0ls0vp7vstdju0wm57",
};

function kindOf(target) {
  if (target === "0xBAD") return null;
  if (target.startsWith("0x") || /^[0-9a-fA-F]{40}$/.test(target)) return "eth";
  if (target.toLowerCase().startsWith("bc1")) return "btc-bech32";
  return "btc-p2pkh";
}

if (args.includes("--list-wordlist")) {
  console.log(JSON.stringify({ words: [...BIP39_WORDS] }));
  process.exit(0);
}

if (args.includes("--list-targets")) {
  console.log(
    JSON.stringify({
      wallets: [
        {
          id: "wallet-1",
          label: "demo-wallet-1",
          searchable: false,
          addresses: { eth: "0x262B24744833FF3c28e174A1b7A5094C3428008b", btc_p2pkh: "1D9fQWfwJftkkUWdQpeW36KFwsRxPkTiPh", btc_bech32: "bc1qm0es3luvytx7uy2jjr56g72s0ksfd74xz4ljky" },
        },
        {
          id: "pooled-demo-wallet",
          label: "pooled-demo-wallet",
          searchable: true,
          addresses: MATCH_ADDRESSES,
        },
      ],
      space: { total_prefixes: SPACE, raw_candidates: SPACE * 16 },
    }),
  );
  process.exit(0);
}

if (args.includes("--validate-only")) {
  const targets = args.flatMap((a, i) => (a === "--target" ? [args[i + 1]] : []));
  let allValid = true;
  for (const target of targets) {
    const kind = kindOf(target);
    if (kind === null) {
      allValid = false;
      console.log(JSON.stringify({ target, valid: false, error: "malformed address: EIP-55 checksum mismatch" }));
    } else {
      console.log(JSON.stringify({ target, valid: true, kind, normalized: target }));
    }
  }
  process.exit(allValid ? 0 : 2);
}

// Search mode (bounded pool sweeps AND full-space lotteries).
const targets = args.flatMap((a, i) => (a === "--target" ? [args[i + 1]] : []));
const addressType = flag("address-type", "eth");
const start = Number(flag("start", "0"));
const count = Number(flag("count", "0")) || SPACE;
const progressMs = Number(flag("progress-ms", "100"));
const target = targets[0];
const randomDraws = flag("random-draws", null);
const isLottery = randomDraws !== null;
const drawBudget = isLottery ? Number(randomDraws) : 0;
// Pre-seed P2PK lottery: targetless — draws random scalars against the
// --preseed-watchlist (the target set). FAKE_PRESEED_DISCOVERY=1 plants a
// deterministic discovery at the last tick.
const preseedDraws = flag("preseed-draws", null);
const isPreseed = preseedDraws !== null;

// Probe permission gate: mirrors the real engine — one boundary for BOTH
// traversal styles. A target outside the embedded demo corpus requires
// --probe (address-only lottery) or --derived-target (own-wallet); the
// flags stamp every emitted event.
const probe = args.includes("--probe");
const poolJsonPathGate = flag("pool-json", null);
const derivedTarget = args.includes("--derived-target");
if (probe && derivedTarget) {
  console.error(
    "error: --probe and --derived-target are mutually exclusive permissions",
  );
  process.exit(2);
}
if (poolJsonPathGate === null && !probe && !derivedTarget) {
  const corpus = [
    "0x262b24744833ff3c28e174a1b7a5094c3428008b",
    "1d9fqwfwjftkkuwdqpew36kfwsrxpktiph",
    "bc1qm0es3luvytx7uy2jjr56g72s0ksfd74xz4ljky",
    MATCH_ADDRESSES.eth.toLowerCase(),
    MATCH_ADDRESSES.btc_p2pkh.toLowerCase(),
    MATCH_ADDRESSES.btc_bech32.toLowerCase(),
  ];
  const normalized = (target ?? "").toLowerCase();
  if (!corpus.includes(normalized)) {
    console.error(
      `error: target ${target} is outside the embedded demo corpus — rerun with --probe (address-only lottery) or --derived-target (own-wallet)`,
    );
    process.exit(2);
  }
}

// --watchlist: one address per line, comments/blanks skipped (the real
// loader's rules). FAKE_DISCOVERY=1 arms a deterministic discovery: a draw
// genuinely deriving the FIRST watchlist address ends the run labeled as a
// discovery — never as a requested-target match.
const watchlistPath = flag("watchlist", null);
const DISCOVERY_ETH = "0x00000000000000000000000000000000d15c0dea";
const DISCOVERY_MNEMONIC =
  "ocean abstract raven accident hill absent winter abstract candy abuse mango absurd";
let watchlist = [];
if (watchlistPath !== null) {
  watchlist = readFileSync(watchlistPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}
const discoveryArmed =
  process.env.FAKE_DISCOVERY === "1" &&
  watchlist.map((a) => a.toLowerCase()).includes(DISCOVERY_ETH);

// Limited-keyspace template: the space is the pool's prefix count, not the
// bundled corpus space. Same math as the real engine's PoolSearch.
const poolJsonPath = flag("pool-json", null);
let space = SPACE;
let rawCandidates = SPACE * 16;
if (poolJsonPath !== null) {
  const pool = JSON.parse(readFileSync(poolJsonPath, "utf8"));
  const variedFirst11 = pool.variable_positions_1_indexed.filter(
    (p) => p <= 11,
  ).length;
  space = pool.pool_words.length ** variedFirst11;
  rawCandidates = space * pool.pool_words.length;
}

function emitMatch(mnemonic, matchedAddress, discovery) {
  const canonicalPath =
    addressType === "eth" ? "m/44'/60'/0'/0/0" : "m/84'/0'/0'/0/0";
  console.log(
    JSON.stringify({
      event: "match",
      derivation_path: canonicalPath,
      discovery,
      match: {
        mnemonic,
        path: canonicalPath,
        address: matchedAddress,
        all_addresses: MATCH_ADDRESSES,
      },
      probe,
      derived_target: derivedTarget,
    }),
  );
}

if (isPreseed) {
  const preseedPath = flag("preseed-watchlist", "");
  const preseedWatchlist = readFileSync(preseedPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  const budget = Number(preseedDraws);
  console.log(
    JSON.stringify({
      event: "start",
      mode: "preseed",
      draw_budget: budget,
      watchlist_keys: preseedWatchlist.length,
      seed: flag("seed", ""),
      probe,
    }),
  );

  const discoveryArmedPreseed =
    process.env.FAKE_PRESEED_DISCOVERY === "1" && preseedWatchlist.length > 0;
  const totalTicks = Math.max(2, TICKS);
  const step = Math.max(1, Math.ceil(budget / totalTicks));
  let drawsDone = 0;
  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    drawsDone = Math.min(drawsDone + step, budget);
    // Deterministic discovery: the fixture-verse k=1 key material, frozen.
    // There is no user target — the payload carries the matched watchlist
    // entry and the derived encodings/addresses, nothing phrase-shaped.
    if (discoveryArmedPreseed && tick === totalTicks - 1) {
      // The rich-address watchlist (--watchlist) only LABELS the discovery:
      // the fixture checks whether the derived legacy address is listed.
      const richHit = watchlist
        .map((a) => a.toLowerCase())
        .includes("1bggz9tcn4rm9kbzdn7kprqz87sz26samh");
      console.log(
        JSON.stringify({
          event: "match",
          probe,
          match: {
            preseed: {
              private_key_hex:
                "0000000000000000000000000000000000000000000000000000000000000001",
              wif: "KwDiBf89QgGbjEhKnhXJuH7LrciVNoZ8q1vDk3GXKVuPMd1ZbVxd",
              pubkey_compressed_hex:
                "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
              pubkey_uncompressed_hex:
                "0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8",
              matched_watchlist_key: preseedWatchlist[0],
              address_p2pkh_compressed: "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
              address_p2pkh_uncompressed: "1EHNa6P4AAaDEoRCvJ4m1jWWtLxE5vCjyS",
              rich_watchlist_hit: richHit,
            },
          },
        }),
      );
      clearInterval(timer);
      process.exit(0);
    }
    console.log(
      JSON.stringify({
        event: "progress",
        mode: "preseed",
        draw_budget: budget,
        draws_done: drawsDone,
        draws_per_sec: 110000,
        matches: 0,
        frontier_prefix: null,
        frontier_pubkey: `02fixture${String(drawsDone).padStart(8, "0")}`,
        probe,
      }),
    );
    if (drawsDone >= budget) {
      console.log(
        JSON.stringify({
          event: "done",
          mode: "preseed",
          draw_budget: budget,
          draws_done: drawsDone,
          elapsed_ms: 5,
          draws_per_sec: 110000,
          matches: 0,
          recovered: null,
          probe,
        }),
      );
      clearInterval(timer);
      process.exit(1); // budget spent without a discovery (not an error)
    }
  }, progressMs);
  process.on("SIGTERM", () => {
    clearInterval(timer);
    process.exit(143);
  });
}

if (isLottery) {
  // Full-space lottery: no coverage claim anywhere — the run's bounded
  // resource is the draw budget, and progress reports consumed draws.
  console.log(
    JSON.stringify({
      event: "start",
      mode: "lottery",
      draw_budget: drawBudget,
      seed: flag("seed", ""),
      workers: Number(flag("workers", "1")),
      address_type: addressType,
      targets,
      probe,
      derived_target: derivedTarget,
    }),
  );

  // Pinned first candidate, labeled "pinned — not random". It matches only
  // when it genuinely derives the REQUESTED target in the fixture-verse —
  // and pins are exempt from discovery stops, mirroring the engine.
  const pinned = flag("pinned-first", "");
  if (pinned !== "") {
    const pinMatches =
      deriveForTest(pinned + "|").eth.toLowerCase() ===
      (target ?? "").toLowerCase();
    console.log(
      JSON.stringify({
        event: "pinned",
        phrase: pinned,
        label: "pinned — not random",
        tested: true,
        matched: pinMatches,
      }),
    );
    if (pinMatches) {
      emitMatch(pinned, target, false);
      process.exit(0);
    }
  }

  const totalTicks = Math.max(2, TICKS);
  const step = Math.max(1, Math.ceil(drawBudget / totalTicks));
  let drawsDone = 0;
  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    drawsDone = Math.min(drawsDone + step, drawBudget);
    // Discovery: ends the run as a labeled watchlist hit (requested-target
    // precedence is preserved — FAKE_MATCH still fires first below).
    if (discoveryArmed && tick === totalTicks - 1) {
      emitMatch(DISCOVERY_MNEMONIC, DISCOVERY_ETH, true);
      clearInterval(timer);
      process.exit(0);
    }
    if (MATCH && tick >= totalTicks - 1) {
      // A draw genuinely derived the requested target — claimed regardless
      // of provenance, never suppressed by the label.
      emitMatch(MATCH_MNEMONIC, target, false);
      clearInterval(timer);
      process.exit(0);
    }
    console.log(
      JSON.stringify({
        event: "progress",
        mode: "lottery",
        draw_budget: drawBudget,
        draws_done: drawsDone,
        checksum_valid: Math.floor(drawsDone / 16),
        derived: Math.floor(drawsDone / 16),
        derived_per_sec: 1400,
        fraction_of_space: 0,
        matches: 0,
        frontier_prefix: null,
        frontier_phrase: `random draw ${drawsDone}`,
        probe,
        derived_target: derivedTarget,
      }),
    );
    if (drawsDone >= drawBudget) {
      console.log(
        JSON.stringify({
          event: "done",
          mode: "lottery",
          draw_budget: drawBudget,
          draws_done: drawsDone,
          checksum_valid: Math.floor(drawsDone / 16),
          elapsed_ms: 5,
          derived_per_sec: 1400,
          matches: 0,
          recovered: null,
          probe,
          derived_target: derivedTarget,
        }),
      );
      clearInterval(timer);
      process.exit(1); // budget spent without a match (not an error)
    }
  }, progressMs);
  process.on("SIGTERM", () => {
    clearInterval(timer);
    process.exit(143);
  });
}

// Bounded sweep (limited-keyspace templates): unchanged semantics.
if (!isLottery && !isPreseed) {
  const end = Math.min(start + count, space);
  console.log(
    JSON.stringify({
      event: "start",
      total_prefixes: space,
      raw_candidates: rawCandidates,
      start,
      end,
      workers: Number(flag("workers", "1")),
      address_type: addressType,
      targets,
      probe,
      derived_target: derivedTarget,
    }),
  );

  const step = Math.max(1, Math.ceil((end - start) / TICKS));
  let done = start;
  const tick = setInterval(() => {
    done = Math.min(done + step, end);
    const derived = done - start;
    const willMatch =
      MATCH && start <= MATCH_ORDINAL && MATCH_ORDINAL < end && done > MATCH_ORDINAL;
    const frontier = willMatch ? MATCH_ORDINAL : Math.min(done, end - 1);
    console.log(
      JSON.stringify({
        event: "progress",
        prefixes_done: derived,
        derived,
        derived_per_sec: 500,
        fraction_of_space: derived / space,
        matches: willMatch ? 1 : 0,
        frontier_prefix: frontier,
        frontier_phrase: `phrase for ordinal ${frontier}`,
        probe,
        derived_target: derivedTarget,
      }),
    );
    if (willMatch) {
      emitMatch(MATCH_MNEMONIC, target, false);
      clearInterval(tick);
      process.exit(0);
    }
    if (done >= end) {
      console.log(
        JSON.stringify({
          event: "done",
          prefixes_done: derived,
          derived,
          elapsed_ms: 5,
          derived_per_sec: 500,
          matches: 0,
          recovered: null,
          probe,
          derived_target: derivedTarget,
        }),
      );
      clearInterval(tick);
      process.exit(1); // exhausted without a match
    }
  }, progressMs);

  process.on("SIGTERM", () => {
    clearInterval(tick);
    process.exit(143);
  });
}

