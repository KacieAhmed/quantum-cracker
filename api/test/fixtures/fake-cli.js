#!/usr/bin/env node
// Test double for cracker-cli: same argument surface and event stream as the
// real binary, over a tiny canned space. Env knobs:
//   FAKE_SPACE (default 1000)      — prefix-ordinal space size
//   FAKE_MATCH (default 1)         — 1: the lane owning FAKE_MATCH_ORDINAL matches
//   FAKE_MATCH_ORDINAL (default 700)
//   FAKE_TICKS (default 4)         — progress ticks before match/exhaustion
const args = process.argv.slice(2);

function flag(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
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
    console.log(JSON.stringify({
      event: "match",
      match: { mnemonic: MATCH_MNEMONIC, path: addressType, address: target, all_addresses: MATCH_ADDRESSES },
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
