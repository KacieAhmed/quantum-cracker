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

use std::io::{BufWriter, Write};
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
    #[arg(long = "target", required = true)]
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
}

fn main() {
    let args = Args::parse();
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
    serde_json::json!({ "event": "match", "match": m })
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

    let stdout = std::io::stdout();
    let mut out = BufWriter::new(stdout.lock());
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

    // Ticker thread: emits progress lines and drains matches as they appear.
    // It returns any matches it drained so the final tally loses nothing.
    let done = Arc::new(AtomicBool::new(false));
    let ticker = {
        let searcher = Arc::clone(&searcher);
        let done = Arc::clone(&done);
        let interval = Duration::from_millis(args.progress_ms);
        let mut out = BufWriter::new(stdout.lock());
        let mut last_derived = 0u64;
        let mut last_tick = Instant::now();
        std::thread::spawn(move || {
            let mut drained: Vec<Match> = Vec::new();
            while !done.load(Ordering::Relaxed) {
                std::thread::sleep(interval);
                let newly = searcher.take_matches();
                for m in &newly {
                    if writeln!(out, "{}", match_event(m)).is_err() {
                        break; // stdout closed; keep tallying for the exit code
                    }
                }
                drained.extend(newly);
                let derived = searcher.progress.derived.load(Ordering::Relaxed);
                let dt = last_tick.elapsed().as_secs_f64();
                let rate = if dt > 0.0 {
                    (derived - last_derived) as f64 / dt
                } else {
                    0.0
                };
                last_derived = derived;
                last_tick = Instant::now();
                let line = serde_json::json!({
                    "event": "progress",
                    "prefixes_done": searcher.progress.prefixes_done.load(Ordering::Relaxed),
                    "derived": derived,
                    "derived_per_sec": rate,
                    "fraction_of_space": if total > 0 { derived as f64 / total as f64 } else { 0.0 },
                    "matches": searcher.matches_found(),
                });
                if writeln!(out, "{line}").is_err() || out.flush().is_err() {
                    return drained;
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

    for m in run_matches.iter().chain(final_matches.iter()) {
        writeln!(out, "{}", match_event(m))?;
    }
    let all_matches = run_matches
        .into_iter()
        .chain(ticker_matches)
        .chain(final_matches)
        .collect::<Vec<_>>();
    let total_secs = elapsed.as_secs_f64();
    let done_event = serde_json::json!({
        "event": "done",
        "prefixes_done": searcher.progress.prefixes_done.load(Ordering::Relaxed),
        "derived": searcher.progress.derived.load(Ordering::Relaxed),
        "elapsed_ms": elapsed.as_millis() as u64,
        "derived_per_sec": if total_secs > 0.0 {
            searcher.progress.derived.load(Ordering::Relaxed) as f64 / total_secs
        } else {
            0.0
        },
        "matches": all_matches.len(),
        "recovered": all_matches.first().map(|m| m.mnemonic.clone()),
    });
    writeln!(out, "{done_event}")?;
    out.flush()?;

    Ok(!all_matches.is_empty())
}
