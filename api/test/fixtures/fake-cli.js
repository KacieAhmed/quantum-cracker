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
//   - every word must be in FAKE_WORDS
//   - a 12-word phrase ending in "abandon" fails the (fake) checksum
//   - in-space = phrase starts with "abandon ability able"
const args = process.argv.slice(2);

function flag(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}

const FAKE_WORDS = new Set([
  "abandon", "ability", "able", "about", "above", "absent",
  "absorb", "abstract", "absurd", "abuse", "access", "accident",
]);

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
  const unknown = words.findIndex((w) => !FAKE_WORDS.has(w));
  if (unknown >= 0) {
    return `invalid mnemonic: unknown word at position ${unknown + 1}`;
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

const end = Math.min(start + count, SPACE);
console.log(JSON.stringify({ event: "start", total_prefixes: SPACE, raw_candidates: SPACE * 16, start, end, workers: Number(flag("workers", "1")), address_type: addressType, targets }));

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
    fraction_of_space: derived / SPACE,
    matches: willMatch ? 1 : 0,
    frontier_prefix: frontier,
    frontier_phrase: `phrase for ordinal ${frontier}`,
  }));
  if (willMatch) {
    const canonicalPath =
      addressType === "eth" ? "m/44'/60'/0'/0/0" : "m/84'/0'/0'/0/0";
    console.log(JSON.stringify({
      event: "match",
      derivation_path: canonicalPath,
      match: { mnemonic: MATCH_MNEMONIC, path: canonicalPath, address: target, all_addresses: MATCH_ADDRESSES },
    }));
    clearInterval(tick);
    process.exit(0);
  }
  if (done >= end) {
    console.log(JSON.stringify({ event: "done", prefixes_done: derived, derived, elapsed_ms: 5, derived_per_sec: 500, matches: 0, recovered: null }));
    clearInterval(tick);
    process.exit(1); // exhausted without a match
  }
}, progressMs);

process.on("SIGTERM", () => {
  clearInterval(tick);
  process.exit(143);
});
