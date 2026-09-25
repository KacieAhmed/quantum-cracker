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

// Search mode.
const targets = args.flatMap((a, i) => (a === "--target" ? [args[i + 1]] : []));
const addressType = flag("address-type", "eth");
const start = Number(flag("start", "0"));
const count = Number(flag("count", "0")) || SPACE;
const progressMs = Number(flag("progress-ms", "100"));
const target = targets[0];

// Probe permission gate: mirrors the real engine. A target outside the
// embedded demo corpus requires --probe over the bundled pool; the same flag
// stamps every emitted event with "probe": true.
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
      `error: target ${target} is outside the embedded demo corpus — rerun with --probe to disclose a bounded feasibility probe`,
    );
    process.exit(2);
  }
}

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

const end = Math.min(start + count, space);
console.log(JSON.stringify({ event: "start", total_prefixes: space, raw_candidates: rawCandidates, start, end, workers: Number(flag("workers", "1")), address_type: addressType, targets, probe, derived_target: derivedTarget }));

const step = Math.max(1, Math.ceil((end - start) / TICKS));
let done = start;
const tick = setInterval(() => {
  done = Math.min(done + step, end);
  const derived = done - start;
  const willMatch = MATCH && start <= MATCH_ORDINAL && MATCH_ORDINAL < end && done > MATCH_ORDINAL;
  const frontier = willMatch ? MATCH_ORDINAL : Math.min(done, end - 1);
  console.log(JSON.stringify({
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
  }));
  if (willMatch) {
    const canonicalPath =
      addressType === "eth" ? "m/44'/60'/0'/0/0" : "m/84'/0'/0'/0/0";
    console.log(JSON.stringify({
      event: "match",
      derivation_path: canonicalPath,
      match: { mnemonic: MATCH_MNEMONIC, path: canonicalPath, address: target, all_addresses: MATCH_ADDRESSES },
      probe,
      derived_target: derivedTarget,
    }));
    clearInterval(tick);
    process.exit(0);
  }
  if (done >= end) {
    console.log(JSON.stringify({ event: "done", prefixes_done: derived, derived, elapsed_ms: 5, derived_per_sec: 500, matches: 0, recovered: null, probe, derived_target: derivedTarget }));
    clearInterval(tick);
    process.exit(1); // exhausted without a match
  }
}, progressMs);

process.on("SIGTERM", () => {
  clearInterval(tick);
  process.exit(143);
});
