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
//! ```

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use clap::{Parser, ValueEnum};
use cracker_core::engine::{Match, SearchConfig, Searcher, Target};
use cracker_core::pool::{PoolConfigJson, PoolSearch, WalletsFileJson};
use cracker_core::validate::parse_target;
use cracker_core::{CrackerError, PathKind};

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
    #[arg(long, default_value_t = 0)]
    start: u64,

    /// Number of prefix ordinals to scan (default: to the end of the space).
    #[arg(long, default_value_t = 0)]
    count: u64,

    /// Worker threads (default: available parallelism).
    #[arg(long)]
    workers: Option<usize>,

    /// Milliseconds between progress lines.
    #[arg(long, default_value_t = 250)]
    progress_ms: u64,

    /// Continue scanning after a match (default: stop on the first match).
    #[arg(long)]
    exhaustive: bool,

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
    if args.targets.is_empty() {
        eprintln!("error: --target <TARGETS> is required for a search");
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

fn match_event(m: &Match) -> serde_json::Value {
    serde_json::json!({ "event": "match", "match": m, "derivation_path": m.path.bip32_path() })
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

fn run(args: &Args) -> cracker_core::Result<bool> {
    let pool = load_pool(args)?;
    let mut targets = Vec::new();
    for t in &args.targets {
        let parsed = parse_target(t)?;
        if !args.address_type.kinds().contains(&parsed.kind()) {
            return Err(CrackerError::Other(format!(
                "target {t} is not a {} address",
                args.address_type.label()
            )));
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

    let searcher = Arc::new(Searcher::new(
        SearchConfig { pool, targets },
        !args.exhaustive,
    ));
    let total = searcher.total_prefixes();
    let end = if args.count == 0 {
        total
    } else {
        args.start.saturating_add(args.count).min(total)
    };
    if args.start >= total {
        return Err(CrackerError::Other(format!(
            "--start {} is beyond the {total}-prefix space",
            args.start
        )));
    }

    {
        let mut out = std::io::stdout().lock();
        let start_event = serde_json::json!({
            "event": "start",
            "total_prefixes": total,
            "raw_candidates": searcher.config.pool.raw_candidates(),
            "start": args.start,
            "end": end,
            "workers": args.workers,
            "address_type": args.address_type.label(),
            "targets": args.targets,
        });
        writeln!(out, "{start_event}")?;
        out.flush()?;
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
        let range_start = args.start; // Copy into the 'static ticker thread
        let mut last_derived = 0u64;
        let mut last_tick = Instant::now();
        std::thread::spawn(move || {
            let mut drained: Vec<Match> = Vec::new();
            while !done.load(Ordering::Relaxed) {
                std::thread::sleep(interval);
                let newly = searcher.take_matches();
                let derived = searcher.progress.derived.load(Ordering::Relaxed);
                // The frontier is the highest ordinal some worker has claimed;
                // clamped into this lane's range it names a candidate the
                // engine is actually walking (or the lane's first ordinal
                // before any work has started).
                let raw_frontier = searcher.progress.current_prefix.load(Ordering::Relaxed);
                let frontier = raw_frontier.clamp(range_start, end.saturating_sub(1));
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
                        if writeln!(out, "{}", match_event(m)).is_err() {
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
    let run_matches = searcher.run_range(args.start..end);
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
            writeln!(out, "{}", match_event(m))?;
        }
        let derived = searcher.progress.derived.load(Ordering::Relaxed);
        let done_event = serde_json::json!({
            "event": "done",
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
