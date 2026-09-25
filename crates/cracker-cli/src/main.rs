//! Native CLI for the classical cracker engine.
//!
//! Enumerates the checksum-valid candidates of the pooled search space,
//! derives ETH/BTC addresses per the reference document, and reports any
//! exact match. JSON progress lines stream to stdout; exit codes are
//! 0 = match found, 1 = space exhausted without a match, 2 = error.
//!
//! Examples:
//! ```text
//! cracker-cli --target 0xb79f8aC312fF21AD16980a857f574A6e7e3ED9c5 --address-type eth
//! cracker-cli --target 16HxxyAQvA3AKThfcJGxSqKJ3Hs9RnTgHp --address-type btc
//! cracker-cli --target 0x... --start 524288 --count 4096 --workers 4
//! cracker-cli --target 0x... --random-draws 1000000 --workers 4
//! ```

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use clap::{Parser, ValueEnum};
use cracker_core::engine::{Match, SearchConfig, Searcher, Target};
use cracker_core::pool::{PoolConfigJson, PoolSearch, WalletsFileJson};
use cracker_core::preseed::{
    P2pkWatchlist, PreSeedConfig, PreSeedDiscovery, PreSeedSearcher, PRODUCTION_EXPECTATION,
};
use cracker_core::sampler::{LotteryConfig, LotterySearcher};
use cracker_core::validate::parse_target;
use cracker_core::{CrackerError, PathKind};

/// The canonical calibration phrase: every run tests it first (pinned, not
/// random) before any traversal or random sampling — a reproducible timing
/// anchor. Own-wallet runs pin the user's own phrase instead.
const CALIBRATION_PHRASE: &str =
    "permit bean gaze lawsuit expect exclude poet mercy enrich measure ocean since";

/// Label attached to the pinned first candidate's feed entry: the visible
/// randomization boundary in the tested-phrases display.
const PINNED_LABEL: &str = "pinned — not random";

#[derive(ValueEnum, Clone, Copy, Debug, PartialEq)]
enum AddressTypeArg {
    Eth,
    BtcP2pkh,
    BtcBech32,
    /// Both Bitcoin paths (P2PKH + bech32) per candidate.
    Btc,
}

impl AddressTypeArg {
    fn kinds(self) -> &'static [PathKind] {
        match self {
            AddressTypeArg::Eth => &[PathKind::Eth],
            AddressTypeArg::BtcP2pkh => &[PathKind::BtcP2pkh],
            AddressTypeArg::BtcBech32 => &[PathKind::BtcBech32],
            AddressTypeArg::Btc => &[PathKind::BtcP2pkh, PathKind::BtcBech32],
        }
    }

    fn label(self) -> String {
        self.kinds()
            .iter()
            .map(|k| k.label())
            .collect::<Vec<_>>()
            .join("+")
    }
}

/// Integrity expectation applied to the pre-seed watchlist at load.
#[derive(ValueEnum, Clone, Copy, Debug, PartialEq)]
enum PreseedExpectationArg {
    /// The vendored asset's pinned SHA-256 and unique-key count (production).
    Asset,
    /// Pins relaxed for deterministic tests; curve validation and dedupe
    /// still apply. Never used by the API.
    Fixture,
}

#[derive(Parser)]
#[command(
    name = "cracker-cli",
    about = "Classical BIP-39 seed-phrase search over the pooled demo space"
)]
struct Args {
    /// Target address (repeatable); each must match --address-type.
    /// Not required when --validate-only / --list-targets handle the call.
    #[arg(long = "target")]
    targets: Vec<String>,

    /// Derivation path(s) to run per candidate.
    #[arg(long, value_enum, default_value_t = AddressTypeArg::Eth)]
    address_type: AddressTypeArg,

    /// Pool config JSON: either a wallets.json-style file (its pooled wallet's
    /// pool_config is used) or a bare pool_config object. Defaults to the
    /// embedded demo-corpus pool.
    #[arg(long)]
    pool_json: Option<String>,

    /// BIP-39 passphrase (default empty, the real-wallet default).
    #[arg(long, default_value = "")]
    passphrase: String,

    /// First prefix ordinal to scan (resumable/splittable ranges).
    #[arg(long)]
    start: Option<u64>,

    /// Number of prefix ordinals to scan (default: to the end of the space).
    #[arg(long)]
    count: Option<u64>,

    /// Lottery mode: sample this many raw phrases uniformly at random over
    /// the FULL 2048^12 space (all 12 word slots randomized; a draw reaches
    /// the derivation only when checksum-valid). No coverage claim — the run
    /// ends at this budget or when stopped. Cannot be combined with
    /// --start/--count/--pool-json.
    #[arg(long)]
    random_draws: Option<u64>,

    /// Pre-seed lottery: draw this many random scalars uniformly in [1, n)
    /// (the secp256k1 group order, 2^256 ≈ 1.16×10^77), derive each public
    /// key, and test membership in the Satoshi-era P2PK watchlist. Bitcoin
    /// only, no user target: a watchlist hit is a labeled discovery that
    /// freezes the run. Cannot be combined with --target, --random-draws,
    /// --start, --count or --pool-json.
    #[arg(long)]
    preseed_draws: Option<u64>,

    /// P2PK watchlist for --preseed-draws: one 65-byte uncompressed hex
    /// public key per line. Loaded with the compiled-in integrity pins
    /// (SHA-256 + unique-key count) and curve-validated key by key; any
    /// mismatch fails the run LOUDLY before a single draw — a corrupted
    /// entry would silently skip recoverable keys.
    #[arg(long)]
    preseed_watchlist: Option<String>,

    /// Integrity expectation for --preseed-watchlist: `asset` (default)
    /// enforces the vendored asset's pinned SHA-256 and key count; `fixture`
    /// relaxes the pins for deterministic tests (curve validation and dedupe
    /// still apply).
    #[arg(long, value_enum, default_value_t = PreseedExpectationArg::Asset)]
    preseed_expectation: PreseedExpectationArg,

    /// Randomness seed: the shuffle order for bounded sweeps, the draw
    /// stream for the lottery. Lanes of one run must share it. Default:
    /// entropy from the clock and pid.
    #[arg(long)]
    seed: Option<u64>,

    /// Phrase tested first, before any traversal or sampling — the pinned
    /// calibration candidate. Own-wallet runs pass the user's own phrase
    /// here; the default is the canonical calibration phrase. Pass "" to
    /// disable pinning entirely.
    #[arg(long, default_value = CALIBRATION_PHRASE)]
    pinned_first: String,

    /// Worker threads (default: available parallelism).
    #[arg(long)]
    workers: Option<usize>,

    /// Milliseconds between progress lines.
    #[arg(long, default_value_t = 250)]
    progress_ms: u64,

    /// Continue scanning after a match (default: stop on the first match).
    #[arg(long)]
    exhaustive: bool,

    /// Feasibility-probe permission: allows targets outside the embedded demo
    /// corpus. Required for non-corpus targets in any traversal (bounded pool
    /// or full-space lottery), and the same flag stamps every emitted event
    /// with "probe": true — the probe label is inseparable from the
    /// permission, on every report surface.
    #[arg(long)]
    probe: bool,

    /// Derived-target permission: the caller attests the target was derived
    /// from a mnemonic supplied in the same request (own-wallet flow), so a
    /// non-corpus target is self-referential verification, not a freeform
    /// address. Stamps every event with "derived_target": true. Mutually
    /// exclusive with --probe.
    #[arg(long)]
    derived_target: bool,

    /// Discovery watchlist file: one address per line (blank lines and
    /// #-comments skipped); the embedded demo-corpus addresses are unioned
    /// in. Any candidate that genuinely derives a listed address ends the
    /// run as a labeled discovery — a real-world wallet, never presented as
    /// the phrase for the user's requested target. Pins are exempt: the
    /// calibration anchor tests requested targets only.
    #[arg(long)]
    watchlist: Option<String>,

    /// Validate the targets against the engine rules (doc section 8) and exit
    /// without searching: one JSON verdict per target, exit 0 iff all valid.
    #[arg(long)]
    validate_only: bool,

    /// Print the engine's embedded BIP-39 English wordlist as JSON
    /// ({"words": [...]}) and exit. Single source of truth for callers that
    /// assemble their own limited-keyspace pool configs.
    #[arg(long)]
    list_wordlist: bool,

    /// Derive every supported address from this BIP-39 mnemonic (the same
    /// derive::derive_addresses path the search engine runs per candidate)
    /// and print one JSON object: addresses, BIP-32 paths, and whether the
    /// phrase lies inside the pooled demo search space. Errors print
    /// {"error": ...} and exit 2. No search is started.
    #[arg(long)]
    derive_mnemonic: Option<String>,

    /// Print the embedded demo-corpus targets as JSON and exit. `searchable`
    /// marks wallets inside the pooled search space; the four random corpus
    /// wallets are valid targets that a pooled-space search never matches.
    #[arg(long)]
    list_targets: bool,
}

fn main() {
    let args = Args::parse();
    if args.list_wordlist {
        let words: Vec<&str> = (0..cracker_core::bip39::word_count())
            .filter_map(cracker_core::bip39::word)
            .collect();
        println!("{}", serde_json::json!({ "words": words }));
        return;
    }
    if args.list_targets {
        match list_targets() {
            Ok(json) => println!("{json}"),
            Err(err) => {
                eprintln!("error: {err}");
                std::process::exit(2);
            }
        }
        return;
    }
    if args.validate_only {
        std::process::exit(if validate_targets(&args.targets) {
            0
        } else {
            2
        });
    }
    if let Some(mnemonic) = &args.derive_mnemonic {
        match derive_mnemonic_json(&args, mnemonic) {
            Ok(json) => println!("{json}"),
            Err(err) => {
                println!("{}", serde_json::json!({ "error": err.to_string() }));
                std::process::exit(2);
            }
        }
        return;
    }
    if args.preseed_draws.is_some() {
        // Pre-seed lottery: Bitcoin-only, targetless — the argument set must
        // reflect that before anything runs.
        if !args.targets.is_empty()
            || args.random_draws.is_some()
            || args.start.is_some()
            || args.count.is_some()
            || args.pool_json.is_some()
        {
            eprintln!(
                "error: --preseed-draws runs the targetless pre-seed lottery and cannot be \
                 combined with --target, --random-draws, --start, --count or --pool-json"
            );
            std::process::exit(2);
        }
        // Same consent discipline as the address-only lottery: no unlabeled
        // run exists — --probe is the permission and the disclosure label.
        if !args.probe {
            eprintln!(
                "error: pre-seed lottery runs are consent-gated: rerun with --probe to accept \
                 the disclosed odds (uniform random scalars over [1, n) — 2^256 ≈ 1.16×10^77 \
                 keys — tested against the watchlisted public keys)"
            );
            std::process::exit(2);
        }
    }
    if args.targets.is_empty() && args.preseed_draws.is_none() {
        eprintln!("error: --target <TARGETS> is required for a search");
        std::process::exit(2);
    }
    if args.random_draws.is_some()
        && (args.start.is_some() || args.count.is_some() || args.pool_json.is_some())
    {
        eprintln!(
            "error: --random-draws runs the full-space lottery and cannot be combined \
             with --start, --count or --pool-json"
        );
        std::process::exit(2);
    }
    match run(&args) {
        Ok(found) => std::process::exit(if found { 0 } else { 1 }),
        Err(err) => {
            eprintln!("error: {err}");
            std::process::exit(2);
        }
    }
}

fn run(args: &Args) -> cracker_core::Result<bool> {
    if args.preseed_draws.is_some() {
        run_preseed(args)
    } else if args.random_draws.is_some() {
        run_lottery(args)
    } else {
        run_pool(args)
    }
}

/// The run's randomness seed: explicit, or clock+pid entropy. Every lane of
/// a run shares it — the same shuffled space, the same draw-stream base.
fn run_seed(args: &Args) -> u64 {
    args.seed.unwrap_or_else(|| {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        nanos ^ (u64::from(std::process::id()) << 32)
    })
}

/// The pinned first candidate for this run: an explicit phrase, or the
/// calibration phrase by default; an empty string disables pinning.
fn pinned_candidate(args: &Args) -> Option<String> {
    match args.pinned_first.as_str() {
        "" => None,
        s => Some(s.to_string()),
    }
}

/// Emit the pinned-candidate event (the tested-phrases feed renders the
/// label). `tested` is false when the pin fails BIP-39 validation — it is
/// never silently remapped to a recomputed phrase.
fn emit_pinned_event(
    pin: &str,
    tested: bool,
    probe: bool,
    derived_target: bool,
) -> cracker_core::Result<()> {
    let mut out = std::io::stdout().lock();
    let e = serde_json::json!({
        "event": "pinned",
        "phrase": pin,
        "label": PINNED_LABEL,
        "tested": tested,
        "matched": false,
        "probe": probe,
        "derived_target": derived_target,
    });
    writeln!(out, "{e}")?;
    out.flush()?;
    Ok(())
}

fn load_pool(args: &Args) -> cracker_core::Result<PoolSearch> {
    match &args.pool_json {
        Some(path) => {
            let text = std::fs::read_to_string(path)?;
            let value: serde_json::Value = serde_json::from_str(&text)?;
            let pool_cfg: PoolConfigJson = if value.get("pool_config").is_some() {
                serde_json::from_value(value["pool_config"].clone())?
            } else {
                serde_json::from_value(value)?
            };
            PoolSearch::from_config(&pool_cfg, &args.passphrase)
        }
        None => {
            let doc: WalletsFileJson = serde_json::from_str(cracker_core::WALLETS_JSON)?;
            PoolSearch::from_config(&doc.pooled.pool_config, &args.passphrase)
        }
    }
}

fn match_event(m: &Match, probe: bool, derived_target: bool) -> serde_json::Value {
    serde_json::json!({ "event": "match", "match": m, "derivation_path": m.path.bip32_path(), "probe": probe, "derived_target": derived_target, "discovery": m.discovery })
}

/// Load the discovery watchlist: one address per line (blank lines and
/// #-comments skipped); the embedded demo-corpus addresses are unioned in —
/// a candidate deriving a corpus wallet is a real-world hit. Parsing is
/// strict: one malformed line fails the run rather than silently shrinking
/// the watchlist.
fn discovery_watchlist(args: &Args) -> cracker_core::Result<Vec<Target>> {
    let Some(path) = &args.watchlist else {
        return Ok(Vec::new());
    };
    let text = std::fs::read_to_string(path)
        .map_err(|e| CrackerError::Other(format!("--watchlist {path}: {e}")))?;
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (n, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let t = parse_target(line)
            .map_err(|e| CrackerError::Other(format!("--watchlist {path}:{}: {e}", n + 1)))?;
        let t = Target {
            kind: t.kind(),
            bytes: t.bytes(),
        };
        if seen.insert(t) {
            out.push(t);
        }
    }
    for addr in embedded_corpus_addresses_raw()? {
        let t = parse_target(&addr)
            .map_err(|e| CrackerError::Other(format!("embedded corpus address {addr}: {e}")))?;
        let t = Target {
            kind: t.kind(),
            bytes: t.bytes(),
        };
        if seen.insert(t) {
            out.push(t);
        }
    }
    Ok(out)
}

/// One JSON object for `--derive-mnemonic`: every supported address of the
/// phrase, the BIP-32 path behind each, and pooled-space membership. Uses the
/// identical derivation call the search engine runs per candidate, so what a
/// user sees here is exactly what a match is compared against.
fn derive_mnemonic_json(args: &Args, mnemonic: &str) -> cracker_core::Result<serde_json::Value> {
    // Single spaces, lowercase (the English wordlist is pure ASCII lowercase).
    let normalized = mnemonic
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    cracker_core::bip39::validate(&normalized)?;
    let derived = cracker_core::derive::derive_addresses(
        &normalized,
        &args.passphrase,
        &[PathKind::Eth, PathKind::BtcP2pkh, PathKind::BtcBech32],
    )?;
    let address = |bytes: Option<[u8; 20]>, kind: PathKind| -> cracker_core::Result<String> {
        let bytes = bytes.ok_or_else(|| {
            CrackerError::Other(format!("engine did not derive a {} address", kind.label()))
        })?;
        Ok(kind.format_address(&bytes))
    };
    let pool = load_pool(args)?;
    Ok(serde_json::json!({
        "mnemonic": normalized,
        "addresses": {
            "eth": address(derived.eth, PathKind::Eth)?,
            "btc_p2pkh": address(derived.btc_p2pkh, PathKind::BtcP2pkh)?,
            "btc_bech32": address(derived.btc_bech32, PathKind::BtcBech32)?,
        },
        "paths": {
            "eth": PathKind::Eth.bip32_path(),
            "btc_p2pkh": PathKind::BtcP2pkh.bip32_path(),
            "btc_bech32": PathKind::BtcBech32.bip32_path(),
        },
        "pool_membership": {
            "in_space": pool.contains_mnemonic(&normalized),
            "total_prefixes": pool.total_prefixes(),
            "raw_candidates": pool.raw_candidates(),
        },
    }))
}

/// Validate each target against the engine's decode rules (malformed fails
/// decode; well-formed-but-wrong decodes fine and only fails compare, so this
/// mode can never reject a valid-but-foreign address). One JSON verdict per
/// target; the process exits 0 iff every target validated.
fn validate_targets(targets: &[String]) -> bool {
    let mut all_valid = true;
    for t in targets {
        let verdict = match cracker_core::validate::parse_target(t) {
            Ok(parsed) => serde_json::json!({
                "target": t,
                "valid": true,
                "kind": parsed.kind().label(),
                "normalized": parsed.kind().format_address(&parsed.bytes()),
            }),
            Err(err) => {
                all_valid = false;
                serde_json::json!({ "target": t, "valid": false, "error": err.to_string() })
            }
        };
        println!("{verdict}");
    }
    all_valid
}

/// The embedded demo-corpus targets, straight from the engine's wallets.json
/// (single source of truth: no addresses are duplicated in the API or UI).
fn list_targets() -> cracker_core::Result<serde_json::Value> {
    let doc: serde_json::Value = serde_json::from_str(cracker_core::WALLETS_JSON)
        .map_err(|e| CrackerError::Other(format!("embedded wallets.json: {e}")))?;
    let wallets = doc["wallets"].as_array().ok_or_else(|| {
        CrackerError::Other("embedded wallets.json: missing wallets array".to_string())
    })?;
    let mut out = Vec::with_capacity(wallets.len() + 1);
    for (i, w) in wallets.iter().enumerate() {
        out.push(serde_json::json!({
            "id": format!("wallet-{}", i + 1),
            "label": w["label"],
            "searchable": false,
            "addresses": {
                "eth": w["eth"]["address"],
                "btc_p2pkh": w["btc_p2pkh"]["address"],
                "btc_bech32": w["btc_bech32"]["address"],
            },
        }));
    }
    let pooled = &doc["pooled_demo_wallet"];
    out.push(serde_json::json!({
        "id": "pooled-demo-wallet",
        "label": "pooled-demo-wallet",
        "searchable": true,
        "addresses": {
            "eth": pooled["eth"]["address"],
            "btc_p2pkh": pooled["btc_p2pkh"]["address"],
            "btc_bech32": pooled["btc_bech32"]["address"],
        },
    }));
    // Keyspace dimensions of the pooled search space: the API splits these
    // prefix ordinals into disjoint worker ranges before spawning lanes.
    let pool_cfg: PoolConfigJson = serde_json::from_value(pooled["pool_config"].clone())
        .map_err(|e| CrackerError::Other(format!("embedded pool_config: {e}")))?;
    let pool = PoolSearch::from_config(&pool_cfg, "")?;
    Ok(serde_json::json!({
        "wallets": out,
        "space": {
            "total_prefixes": pool.total_prefixes(),
            "raw_candidates": pool.raw_candidates(),
        },
    }))
}

/// Raw (case-preserving) addresses of the embedded demo corpus. Base58 is
/// case-sensitive, so callers parsing BTC P2PKH entries must keep the original
/// form; only hex/ETH and bech32 are safe to lowercase.
fn embedded_corpus_addresses_raw() -> cracker_core::Result<Vec<String>> {
    let doc: serde_json::Value = serde_json::from_str(cracker_core::WALLETS_JSON)
        .map_err(|e| CrackerError::Other(format!("embedded wallets.json: {e}")))?;
    let mut out = Vec::new();
    fn push_addresses(
        v: &serde_json::Value,
        ctx: &str,
        out: &mut Vec<String>,
    ) -> cracker_core::Result<()> {
        for key in ["eth", "btc_p2pkh", "btc_bech32"] {
            let addr = v[key]["address"].as_str().ok_or_else(|| {
                CrackerError::Other(format!(
                    "embedded wallets.json: {ctx} missing {key}.address"
                ))
            })?;
            out.push(addr.to_string());
        }
        Ok(())
    }
    let wallets = doc["wallets"].as_array().ok_or_else(|| {
        CrackerError::Other("embedded wallets.json: missing wallets array".to_string())
    })?;
    for (i, w) in wallets.iter().enumerate() {
        push_addresses(w, &format!("wallet {}", i + 1), &mut out)?;
    }
    push_addresses(&doc["pooled_demo_wallet"], "pooled_demo_wallet", &mut out)?;
    Ok(out)
}

/// Lowercased normalized addresses of the embedded demo corpus (the cross-check
/// wallets plus the pooled demo wallet), straight from the engine's
/// wallets.json — the permission boundary for non-probe searches.
fn embedded_corpus_addresses() -> cracker_core::Result<std::collections::HashSet<String>> {
    Ok(embedded_corpus_addresses_raw()?
        .into_iter()
        .map(|a| a.to_lowercase())
        .collect())
}

fn run_pool(args: &Args) -> cracker_core::Result<bool> {
    let probe = args.probe;
    let derived_target = args.derived_target;
    let discovery = discovery_watchlist(args)?;
    if args.probe && args.derived_target {
        return Err(CrackerError::Other(
            "--probe and --derived-target are mutually exclusive permissions".to_string(),
        ));
    }
    let shuffle_seed = run_seed(args);
    let pool = load_pool(args)?;
    // Embedded-corpus targeting needs no permission; the moment a target falls
    // outside it, --probe is required. Permission and disclosure live in the
    // same flag, so a non-corpus search cannot emit a single unlabeled event.
    // Custom pools (--pool-json, e.g. limited-keyspace runs) are explicitly
    // configured spaces and skip the corpus gate.
    let corpus: Option<std::collections::HashSet<String>> =
        if probe || args.derived_target || args.pool_json.is_some() {
            None
        } else {
            Some(embedded_corpus_addresses()?)
        };
    let mut targets = Vec::new();
    for t in &args.targets {
        let parsed = parse_target(t)?;
        if !args.address_type.kinds().contains(&parsed.kind()) {
            return Err(CrackerError::Other(format!(
                "target {t} is not a {} address",
                args.address_type.label()
            )));
        }
        if let Some(corpus) = &corpus {
            let normalized = parsed.kind().format_address(&parsed.bytes()).to_lowercase();
            if !corpus.contains(&normalized) {
                return Err(CrackerError::Other(format!(
                    "target {t} is outside the embedded demo corpus — rerun with --probe to disclose a bounded feasibility probe (it scans the pooled demo space, not the declared address's real space)"
                )));
            }
        }
        targets.push(Target {
            kind: parsed.kind(),
            bytes: parsed.bytes(),
        });
    }

    if let Some(n) = args.workers {
        rayon::ThreadPoolBuilder::new()
            .num_threads(n)
            .build_global()
            .map_err(|e| CrackerError::Other(e.to_string()))?;
    }

    let start = args.start.unwrap_or(0);
    let count = args.count.unwrap_or(0);
    let pin = pinned_candidate(args);
    let searcher = Arc::new(Searcher::new(
        SearchConfig {
            pool,
            targets,
            traversal_seed: shuffle_seed,
            pinned_first: pin.clone(),
            discovery,
        },
        !args.exhaustive,
    ));
    let total = searcher.total_prefixes();
    let end = if count == 0 {
        total
    } else {
        start.saturating_add(count).min(total)
    };
    if start >= total {
        return Err(CrackerError::Other(format!(
            "--start {start} is beyond the {total}-prefix space"
        )));
    }

    {
        let mut out = std::io::stdout().lock();
        let start_event = serde_json::json!({
            "event": "start",
            "mode": "pool",
            "seed": shuffle_seed,
            "total_prefixes": total,
            "raw_candidates": searcher.config.pool.raw_candidates(),
            "start": start,
            "end": end,
            "workers": args.workers,
            "address_type": args.address_type.label(),
            "targets": args.targets,
            "probe": probe,
            "derived_target": args.derived_target,
        });
        writeln!(out, "{start_event}")?;
        out.flush()?;
    }

    // Pinned first candidate: tested before any traversal work, labeled so
    // the randomization boundary is visible in the tested-phrases feed. A
    // genuine match at candidate #1 ends the run — correct for own-wallet
    // runs, not a bug.
    if let Some(pin) = &pin {
        let pin_valid = cracker_core::bip39::validate(pin).is_ok();
        emit_pinned_event(pin, pin_valid, probe, derived_target)?;
        if pin_valid {
            let pin_started = Instant::now();
            if let Some(m) = searcher.test_pinned_first() {
                let mut out = std::io::stdout().lock();
                writeln!(out, "{}", match_event(&m, probe, derived_target))?;
                let done_event = serde_json::json!({
                    "event": "done",
                    "mode": "pool",
                    "probe": probe,
                    "derived_target": derived_target,
                    "prefixes_done": 0u64,
                    "derived": searcher.progress.derived.load(Ordering::Relaxed),
                    "elapsed_ms": pin_started.elapsed().as_millis() as u64,
                    "matches": 1u64,
                    "recovered": m.mnemonic.clone(),
                });
                writeln!(out, "{done_event}")?;
                out.flush()?;
                return Ok(true);
            }
        }
    }

    // Ticker thread: emits progress lines and drains matches as they appear.
    // Each tick takes a short-lived stdout lock (StdoutLock is !Send, and a
    // lock held across the scan would deadlock this thread); it returns the
    // matches it drained so the final tally loses nothing.
    let done = Arc::new(AtomicBool::new(false));
    let ticker = {
        let searcher = Arc::clone(&searcher);
        let done = Arc::clone(&done);
        let interval = Duration::from_millis(args.progress_ms);
        let derived_target = args.derived_target; // Copy into the 'static ticker thread
        let mut last_derived = 0u64;
        let mut last_tick = Instant::now();
        std::thread::spawn(move || {
            let mut drained: Vec<Match> = Vec::new();
            while !done.load(Ordering::Relaxed) {
                std::thread::sleep(interval);
                let newly = searcher.take_matches();
                let derived = searcher.progress.derived.load(Ordering::Relaxed);
                // Under the shuffled traversal `current_prefix` already holds
                // the image ordinal a worker is actually testing: claimed
                // ranges scatter across the whole space, so the only clamp
                // needed is into the (always-valid) ordinal domain.
                let raw_frontier = searcher.progress.current_prefix.load(Ordering::Relaxed);
                let frontier = raw_frontier.min(total.saturating_sub(1));
                let dt = last_tick.elapsed().as_secs_f64();
                let rate = if dt > 0.0 {
                    (derived - last_derived) as f64 / dt
                } else {
                    0.0
                };
                last_derived = derived;
                last_tick = Instant::now();
                let mut ok = true;
                {
                    let mut out = std::io::stdout().lock();
                    for m in &newly {
                        if writeln!(out, "{}", match_event(m, probe, derived_target)).is_err() {
                            ok = false;
                            break;
                        }
                    }
                    if ok {
                        let line = serde_json::json!({
                            "event": "progress",
                            "prefixes_done": searcher
                                .progress
                                .prefixes_done
                                .load(Ordering::Relaxed),
                            "derived": derived,
                            "derived_per_sec": rate,
                            "fraction_of_space": if total > 0 {
                                derived as f64 / total as f64
                            } else {
                                0.0
                            },
                            "matches": searcher.matches_found(),
                            "frontier_prefix": frontier,
                            "frontier_phrase": searcher
                                .config
                                .pool
                                .candidate_at(frontier),
                            "probe": probe,
                            "derived_target": derived_target,
                        });
                        if writeln!(out, "{line}").is_err() || out.flush().is_err() {
                            ok = false;
                        }
                    }
                }
                drained.extend(newly);
                if !ok {
                    return drained; // stdout closed; tally kept for the exit code
                }
            }
            drained
        })
    };

    let scan_started = Instant::now();
    let run_matches = searcher.run_range(start..end);
    let elapsed = scan_started.elapsed();
    done.store(true, Ordering::Relaxed);
    let ticker_matches = ticker.join().unwrap_or_default();
    let final_matches = searcher.take_matches();

    let all_matches = run_matches
        .into_iter()
        .chain(ticker_matches)
        .chain(final_matches)
        .collect::<Vec<_>>();
    let total_secs = elapsed.as_secs_f64();
    {
        let mut out = std::io::stdout().lock();
        for m in &all_matches {
            writeln!(out, "{}", match_event(m, probe, args.derived_target))?;
        }
        let derived = searcher.progress.derived.load(Ordering::Relaxed);
        let done_event = serde_json::json!({
            "event": "done",
            "mode": "pool",
            "probe": probe,
            "derived_target": args.derived_target,
            "prefixes_done": searcher.progress.prefixes_done.load(Ordering::Relaxed),
            "derived": derived,
            "elapsed_ms": elapsed.as_millis() as u64,
            "derived_per_sec": if total_secs > 0.0 {
                derived as f64 / total_secs
            } else {
                0.0
            },
            "matches": all_matches.len(),
            "recovered": all_matches.first().map(|m| m.mnemonic.clone()),
        });
        writeln!(out, "{done_event}")?;
        out.flush()?;
    }

    Ok(!all_matches.is_empty())
}

/// Full-space lottery: uniform random sampling over ALL 2048^12 raw
/// assemblies — every one of the 12 word slots is randomized, the true
/// lottery. The run ends at its draw budget or when stopped; it never
/// reports "exhausted" because no budget makes a dent in 2048^12 — the odds
/// are disclosed to the user before they start. Exit 0 on a genuine match,
/// 1 when the budget is spent without one (same convention as the pool
/// modes; the `done` event's `mode` tells them apart).
fn run_lottery(args: &Args) -> cracker_core::Result<bool> {
    let probe = args.probe;
    let derived_target = args.derived_target;
    let budget = args
        .random_draws
        .expect("dispatcher checked --random-draws");
    let seed = run_seed(args);
    let pin = pinned_candidate(args);
    // Same permission boundary as the bounded pool: a non-corpus lottery
    // target needs an explicit permission — --probe (address-only) or
    // --derived-target (own-wallet) — so no unlabeled full-space run exists.
    let corpus: Option<std::collections::HashSet<String>> = if probe || derived_target {
        None
    } else {
        Some(embedded_corpus_addresses()?)
    };
    let mut targets = Vec::new();
    for t in &args.targets {
        let parsed = parse_target(t)?;
        if !args.address_type.kinds().contains(&parsed.kind()) {
            return Err(CrackerError::Other(format!(
                "target {t} is not a {} address",
                args.address_type.label()
            )));
        }
        if let Some(corpus) = &corpus {
            let normalized = parsed.kind().format_address(&parsed.bytes()).to_lowercase();
            if !corpus.contains(&normalized) {
                return Err(CrackerError::Other(format!(
                    "target {t} is outside the embedded demo corpus — rerun with --probe (address-only feasibility lottery) or --derived-target (own-wallet run)"
                )));
            }
        }
        targets.push(Target {
            kind: parsed.kind(),
            bytes: parsed.bytes(),
        });
    }

    if let Some(n) = args.workers {
        rayon::ThreadPoolBuilder::new()
            .num_threads(n)
            .build_global()
            .map_err(|e| CrackerError::Other(e.to_string()))?;
    }

    let searcher = Arc::new(LotterySearcher::new(
        LotteryConfig {
            targets,
            passphrase: args.passphrase.clone(),
            pinned_first: pin.clone(),
            discovery: discovery_watchlist(args)?,
        },
        !args.exhaustive,
    ));
    {
        let mut out = std::io::stdout().lock();
        let start_event = serde_json::json!({
            "event": "start",
            "mode": "lottery",
            "probe": probe,
            "derived_target": derived_target,
            "draw_budget": budget,
            "seed": seed,
            "workers": args.workers,
            "address_type": args.address_type.label(),
            "targets": args.targets,
        });
        writeln!(out, "{start_event}")?;
        out.flush()?;
    }

    // Pinned first candidate: tested before any random sampling, labeled so
    // the randomization boundary is visible in the tested-phrases feed. A
    // genuine match at candidate #1 ends the run — correct for own-wallet
    // runs, not a bug.
    if let Some(pin) = &pin {
        let pin_valid = cracker_core::bip39::validate(pin).is_ok();
        emit_pinned_event(pin, pin_valid, probe, derived_target)?;
        if pin_valid {
            let pin_started = Instant::now();
            if let Some(m) = searcher.test_pinned_first() {
                let mut out = std::io::stdout().lock();
                writeln!(out, "{}", match_event(&m, probe, derived_target))?;
                let done_event = serde_json::json!({
                    "event": "done",
                    "mode": "lottery",
                    "probe": probe,
                    "derived_target": derived_target,
                    "draws_done": 0u64,
                    "checksum_valid": 0u64,
                    "derived": searcher.progress.derived.load(Ordering::Relaxed),
                    "elapsed_ms": pin_started.elapsed().as_millis() as u64,
                    "matches": 1u64,
                    "recovered": m.mnemonic.clone(),
                });
                writeln!(out, "{done_event}")?;
                out.flush()?;
                return Ok(true);
            }
        }
    }

    // Ticker thread: same contract as the pool ticker, draw-centric fields.
    let done = Arc::new(AtomicBool::new(false));
    let ticker = {
        let searcher = Arc::clone(&searcher);
        let done = Arc::clone(&done);
        let interval = Duration::from_millis(args.progress_ms);
        let derived_target = args.derived_target; // Copy into the 'static ticker thread
        let mut last_draws = 0u64;
        let mut last_derived = 0u64;
        let mut last_tick = Instant::now();
        std::thread::spawn(move || {
            let mut drained: Vec<Match> = Vec::new();
            while !done.load(Ordering::Relaxed) {
                std::thread::sleep(interval);
                let newly = searcher.take_matches();
                let draws = searcher.progress.draws.load(Ordering::Relaxed);
                let derived = searcher.progress.derived.load(Ordering::Relaxed);
                let dt = last_tick.elapsed().as_secs_f64();
                let (draw_rate, derived_rate) = if dt > 0.0 {
                    (
                        (draws - last_draws) as f64 / dt,
                        (derived - last_derived) as f64 / dt,
                    )
                } else {
                    (0.0, 0.0)
                };
                last_draws = draws;
                last_derived = derived;
                last_tick = Instant::now();
                let mut ok = true;
                {
                    let mut out = std::io::stdout().lock();
                    for m in &newly {
                        if writeln!(out, "{}", match_event(m, probe, derived_target)).is_err() {
                            ok = false;
                            break;
                        }
                    }
                    if ok {
                        let frontier_phrase = searcher
                            .progress
                            .last_phrase
                            .lock()
                            .expect("last_phrase mutex poisoned")
                            .clone();
                        // `fraction_of_space` is consumed draw budget here —
                        // there is no space-fraction claim in lottery mode.
                        let line = serde_json::json!({
                            "event": "progress",
                            "mode": "lottery",
                            "probe": probe,
                            "derived_target": derived_target,
                            "draws_done": draws,
                            "checksum_valid": searcher
                                .progress
                                .checksum_valid
                                .load(Ordering::Relaxed),
                            "derived": derived,
                            "derived_per_sec": derived_rate,
                            "draws_per_sec": draw_rate,
                            "fraction_of_space": if budget > 0 {
                                draws as f64 / budget as f64
                            } else {
                                0.0
                            },
                            "matches": searcher.matches_found(),
                            "frontier_phrase": frontier_phrase,
                        });
                        if writeln!(out, "{line}").is_err() || out.flush().is_err() {
                            ok = false;
                        }
                    }
                }
                drained.extend(newly);
                if !ok {
                    return drained; // stdout closed; tally kept for the exit code
                }
            }
            drained
        })
    };

    let scan_started = Instant::now();
    let run_matches = searcher.run(budget, seed);
    let elapsed = scan_started.elapsed();
    done.store(true, Ordering::Relaxed);
    let ticker_matches = ticker.join().unwrap_or_default();
    let final_matches = searcher.take_matches();

    let all_matches = run_matches
        .into_iter()
        .chain(ticker_matches)
        .chain(final_matches)
        .collect::<Vec<_>>();
    let total_secs = elapsed.as_secs_f64();
    {
        let mut out = std::io::stdout().lock();
        for m in &all_matches {
            writeln!(out, "{}", match_event(m, probe, derived_target))?;
        }
        let draws = searcher.progress.draws.load(Ordering::Relaxed);
        let derived = searcher.progress.derived.load(Ordering::Relaxed);
        let done_event = serde_json::json!({
            "event": "done",
            "mode": "lottery",
            "probe": probe,
            "derived_target": derived_target,
            "draws_done": draws,
            "checksum_valid": searcher.progress.checksum_valid.load(Ordering::Relaxed),
            "derived": derived,
            "elapsed_ms": elapsed.as_millis() as u64,
            "derived_per_sec": if total_secs > 0.0 {
                derived as f64 / total_secs
            } else {
                0.0
            },
            "draws_per_sec": if total_secs > 0.0 {
                draws as f64 / total_secs
            } else {
                0.0
            },
            "matches": all_matches.len(),
            "recovered": all_matches.first().map(|m| m.mnemonic.clone()),
        });
        writeln!(out, "{done_event}")?;
        out.flush()?;
    }

    Ok(!all_matches.is_empty())
}

/// The pre-seed match event: a DISCOVERY, always — there is no user target in
/// this mode, so the full frozen key material rides in `match.preseed`.
fn preseed_match_event(d: &PreSeedDiscovery, probe: bool) -> serde_json::Value {
    serde_json::json!({
        "event": "match",
        "mode": "preseed",
        "probe": probe,
        "discovery": true,
        "match": { "preseed": d },
    })
}

/// Pre-seed P2PK lottery: uniform random draws over [1, n), each derived
/// public key membership-tested against the Satoshi-era watchlist. Exit 0 on
/// a discovery, 1 when the draw budget is spent without one; the `done`
/// event's `mode: "preseed"` tells it apart from the phrase lottery.
fn run_preseed(args: &Args) -> cracker_core::Result<bool> {
    let probe = args.probe;
    let budget = args
        .preseed_draws
        .expect("dispatcher checked --preseed-draws");
    let watchlist_path = args.preseed_watchlist.as_ref().ok_or_else(|| {
        CrackerError::Other(
            "--preseed-draws requires --preseed-watchlist <p2pk-keys-file>".to_string(),
        )
    })?;
    let raw = std::fs::read(watchlist_path)
        .map_err(|e| CrackerError::Other(format!("--preseed-watchlist {watchlist_path}: {e}")))?;
    let expectation = match args.preseed_expectation {
        PreseedExpectationArg::Asset => PRODUCTION_EXPECTATION,
        PreseedExpectationArg::Fixture => cracker_core::preseed::WatchlistExpectation {
            sha256_hex: None,
            unique_count: None,
        },
    };
    // Integrity gates first: pinned hash, per-key curve validation, dedupe,
    // unique-count pin. Any mismatch fails the run before a single draw —
    // watchlist integrity is load-bearing (a corrupted entry would silently
    // skip recoverable keys).
    let watchlist = P2pkWatchlist::load_bytes(&raw, &expectation)
        .map_err(|e| CrackerError::Other(format!("--preseed-watchlist {watchlist_path}: {e}")))?;

    // The rich-address watchlist doubles as the discovery label upgrade:
    // a discovered key whose derived P2PKH address is listed there is noted
    // in the payload. Same strict parsing and corpus union as the other
    // discovery surfaces.
    let rich_addresses = discovery_watchlist(args)?
        .into_iter()
        .map(|t| t.bytes)
        .collect::<std::collections::HashSet<_>>();

    if let Some(n) = args.workers {
        rayon::ThreadPoolBuilder::new()
            .num_threads(n)
            .build_global()
            .map_err(|e| CrackerError::Other(e.to_string()))?;
    }

    let seed = run_seed(args);
    let searcher = Arc::new(PreSeedSearcher::new(
        PreSeedConfig {
            watchlist,
            rich_addresses,
        },
        !args.exhaustive,
    ));
    {
        let mut out = std::io::stdout().lock();
        let start_event = serde_json::json!({
            "event": "start",
            "mode": "preseed",
            "probe": probe,
            "draw_budget": budget,
            "seed": seed,
            "workers": args.workers,
            "watchlist_keys": searcher.config.watchlist.len(),
            "expectation": match args.preseed_expectation {
                PreseedExpectationArg::Asset => "asset",
                PreseedExpectationArg::Fixture => "fixture",
            },
        });
        writeln!(out, "{start_event}")?;
        out.flush()?;
    }

    // Ticker thread: same contract as the lottery ticker, pubkey feed —
    // sampled derived pubkeys are what this mode "tries" live.
    let done = Arc::new(AtomicBool::new(false));
    let ticker = {
        let searcher = Arc::clone(&searcher);
        let done = Arc::clone(&done);
        let interval = Duration::from_millis(args.progress_ms);
        let mut last_draws = 0u64;
        let mut last_tick = Instant::now();
        std::thread::spawn(move || {
            let mut drained: Vec<PreSeedDiscovery> = Vec::new();
            while !done.load(Ordering::Relaxed) {
                std::thread::sleep(interval);
                let newly = searcher.take_matches();
                let draws = searcher.progress.draws.load(Ordering::Relaxed);
                let dt = last_tick.elapsed().as_secs_f64();
                let rate = if dt > 0.0 {
                    (draws - last_draws) as f64 / dt
                } else {
                    0.0
                };
                last_draws = draws;
                last_tick = Instant::now();
                let mut ok = true;
                {
                    let mut out = std::io::stdout().lock();
                    for d in &newly {
                        if writeln!(out, "{}", preseed_match_event(d, probe)).is_err() {
                            ok = false;
                            break;
                        }
                    }
                    if ok {
                        let frontier_pubkey = searcher
                            .progress
                            .last_pubkey
                            .lock()
                            .expect("last_pubkey mutex poisoned")
                            .clone();
                        // `fraction_of_space` is consumed draw budget — no
                        // space-fraction claim exists in this mode.
                        let line = serde_json::json!({
                            "event": "progress",
                            "mode": "preseed",
                            "probe": probe,
                            "draws_done": draws,
                            "draws_per_sec": rate,
                            "fraction_of_space": if budget > 0 {
                                draws as f64 / budget as f64
                            } else {
                                0.0
                            },
                            "matches": searcher.matches_found(),
                            "frontier_pubkey": frontier_pubkey,
                        });
                        if writeln!(out, "{line}").is_err() || out.flush().is_err() {
                            ok = false;
                        }
                    }
                }
                drained.extend(newly);
                if !ok {
                    return drained; // stdout closed; tally kept for the exit code
                }
            }
            drained
        })
    };

    let scan_started = Instant::now();
    let run_discoveries = searcher.run(budget, seed);
    let elapsed = scan_started.elapsed();
    done.store(true, Ordering::Relaxed);
    let ticker_discoveries = ticker.join().unwrap_or_default();
    let final_discoveries = searcher.take_matches();

    let all = run_discoveries
        .into_iter()
        .chain(ticker_discoveries)
        .chain(final_discoveries)
        .collect::<Vec<_>>();
    let total_secs = elapsed.as_secs_f64();
    {
        let mut out = std::io::stdout().lock();
        for d in &all {
            writeln!(out, "{}", preseed_match_event(d, probe))?;
        }
        let draws = searcher.progress.draws.load(Ordering::Relaxed);
        let done_event = serde_json::json!({
            "event": "done",
            "mode": "preseed",
            "probe": probe,
            "draws_done": draws,
            "elapsed_ms": elapsed.as_millis() as u64,
            "draws_per_sec": if total_secs > 0.0 {
                draws as f64 / total_secs
            } else {
                0.0
            },
            "matches": all.len(),
            "discovered": all.first().map(serde_json::to_value).transpose()?,
        });
        writeln!(out, "{done_event}")?;
        out.flush()?;
    }

    Ok(!all.is_empty())
}
