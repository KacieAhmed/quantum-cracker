//! Search driver: pooled enumeration -> derivation -> exact-match compare
//! (reference doc section 9). Shared atomics expose progress; an atomic stop
//! flag makes searches cooperative and resumable.

use std::ops::Range;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::bip39;
use crate::derive::{self, PathKind};
use crate::pool::PoolSearch;

/// All derived addresses of a matched candidate, rendered canonically.
#[derive(Debug, Clone, Default, Serialize)]
pub struct AddressSet {
    pub eth: String,
    pub btc_p2pkh: String,
    pub btc_bech32: String,
}

/// A hit: the recovered phrase, the path that matched, and every address of
/// the wallet (so callers can cross-confirm the other chains).
#[derive(Debug, Clone, Serialize)]
pub struct Match {
    pub mnemonic: String,
    pub path: PathKind,
    pub address: String,
    pub all_addresses: AddressSet,
}

/// One comparison target, normalized to its 20 address bytes (doc section
/// 9.2: compare canonical forms by exact equality).
#[derive(Debug, Clone, Copy)]
pub struct Target {
    pub kind: PathKind,
    pub bytes: [u8; 20],
}

pub struct SearchConfig {
    pub pool: PoolSearch,
    pub targets: Vec<Target>,
}

/// Shared atomic progress counters (lock-free; callers poll freely).
#[derive(Debug, Default)]
pub struct Progress {
    /// Prefix ordinals walked (each includes up to pool.len() checksum tests).
    pub prefixes_done: AtomicU64,
    /// Candidates that passed the checksum and were fully derived + compared.
    pub derived: AtomicU64,
    pub matches: AtomicU64,
    /// Highest prefix ordinal claimed so far (monotone under parallel chunks):
    /// a real candidate from the live frontier, for sampled "what is being
    /// tried right now" displays.
    pub current_prefix: AtomicU64,
}

/// One searcher over one compiled pool config. `stop` is shared, so any
/// worker (or the owner via [`Searcher::request_stop`]) halts the whole scan;
/// with `stop_on_match` the first hit stops all workers.
pub struct Searcher {
    pub config: Arc<SearchConfig>,
    pub progress: Arc<Progress>,
    pub stop: Arc<AtomicBool>,
    stop_on_match: bool,
    kinds: Vec<PathKind>,
    matches: Mutex<Vec<Match>>,
}

impl Searcher {
    pub fn new(config: SearchConfig, stop_on_match: bool) -> Self {
        let mut kinds = config.targets.iter().map(|t| t.kind).collect::<Vec<_>>();
        kinds.sort();
        kinds.dedup();
        Self {
            config: Arc::new(config),
            progress: Arc::default(),
            stop: Arc::default(),
            stop_on_match,
            kinds,
            matches: Mutex::new(Vec::new()),
        }
    }

    /// Number of prefix ordinals in the space (each is <= pool.len()
    /// checksum tests, ~1 address derivation).
    pub fn total_prefixes(&self) -> u64 {
        self.config.pool.total_prefixes()
    }

    /// Scan prefix ordinals `range`; returns matches found by this call.
    /// With the `parallel` feature the range is split into fixed-size chunks
    /// across the rayon pool; otherwise it runs sequentially on this thread.
    pub fn run_range(&self, range: Range<u64>) -> Vec<Match> {
        let total = self.total_prefixes();
        let start = range.start.min(total);
        let end = range.end.min(total);
        if start >= end {
            return Vec::new();
        }
        #[cfg(feature = "parallel")]
        {
            const CHUNK: u64 = 512;
            let chunks: Vec<(u64, u64)> = (start..end)
                .step_by(CHUNK as usize)
                .map(|s| (s, (s + CHUNK).min(end)))
                .collect();
            use rayon::prelude::*;
            chunks
                .par_iter()
                .for_each(|&(s, e)| self.run_sequential(s, e));
            self.take_matches()
        }
        #[cfg(not(feature = "parallel"))]
        {
            self.run_sequential(start, end);
            self.take_matches()
        }
    }

    fn run_sequential(&self, start: u64, end: u64) {
        let mut candidates = Vec::new();
        for ordinal in start..end {
            if self.stop.load(Ordering::Relaxed) {
                return;
            }
            self.test_ordinal(ordinal, &mut candidates);
        }
    }

    fn test_ordinal(&self, ordinal: u64, candidates: &mut Vec<[u16; 12]>) {
        self.progress.prefixes_done.fetch_add(1, Ordering::Relaxed);
        self.progress
            .current_prefix
            .fetch_max(ordinal, Ordering::Relaxed);
        let prefix = self.config.pool.assemble_prefix(ordinal);
        self.config.pool.candidates_for_prefix(&prefix, candidates);
        for indices in candidates.drain(..) {
            self.test_candidate(&indices);
        }
    }

    fn test_candidate(&self, indices: &[u16; 12]) {
        self.progress.derived.fetch_add(1, Ordering::Relaxed);
        let mnemonic = match bip39::mnemonic_from_indices(indices) {
            Ok(m) => m,
            Err(_) => return, // unreachable: candidates are checksum-valid by construction
        };
        let derived =
            match derive::derive_addresses(&mnemonic, self.config.pool.passphrase(), &self.kinds) {
                Ok(d) => d,
                // Invalid child key along the path (probability < 2^-127 per BIP-32):
                // this candidate cannot match any real wallet's address.
                Err(_) => return,
            };
        for target in &self.config.targets {
            let bytes = match target.kind {
                PathKind::Eth => derived.eth,
                PathKind::BtcP2pkh => derived.btc_p2pkh,
                PathKind::BtcBech32 => derived.btc_bech32,
            };
            if bytes == Some(target.bytes) {
                self.record_match(&mnemonic, target.kind, &target.bytes);
                if self.stop_on_match {
                    self.stop.store(true, Ordering::Relaxed);
                }
            }
        }
    }

    fn record_match(&self, mnemonic: &str, kind: PathKind, bytes: &[u8; 20]) {
        self.progress.matches.fetch_add(1, Ordering::Relaxed);
        let all = derive::derive_addresses(
            mnemonic,
            self.config.pool.passphrase(),
            &[PathKind::Eth, PathKind::BtcP2pkh, PathKind::BtcBech32],
        )
        .map(|d| AddressSet {
            eth: d
                .eth
                .map(|b| PathKind::Eth.format_address(&b))
                .unwrap_or_default(),
            btc_p2pkh: d
                .btc_p2pkh
                .map(|b| PathKind::BtcP2pkh.format_address(&b))
                .unwrap_or_default(),
            btc_bech32: d
                .btc_bech32
                .map(|b| PathKind::BtcBech32.format_address(&b))
                .unwrap_or_default(),
        })
        .unwrap_or_default();
        self.matches
            .lock()
            .expect("matches mutex poisoned")
            .push(Match {
                mnemonic: mnemonic.to_string(),
                path: kind,
                address: kind.format_address(bytes),
                all_addresses: all,
            });
    }

    pub fn take_matches(&self) -> Vec<Match> {
        std::mem::take(&mut self.matches.lock().expect("matches mutex poisoned"))
    }

    pub fn matches_found(&self) -> u64 {
        self.progress.matches.load(Ordering::Relaxed)
    }

    pub fn request_stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pool::{PoolSearch, WalletsFileJson};
    use crate::validate::parse_target;

    fn corpus_searcher(target_address: &str) -> Searcher {
        let doc: WalletsFileJson = serde_json::from_str(crate::WALLETS_JSON).unwrap();
        let pool = PoolSearch::from_config(&doc.pooled.pool_config, "").unwrap();
        let target = parse_target(target_address).unwrap();
        Searcher::new(
            SearchConfig {
                pool,
                targets: vec![Target {
                    kind: target.kind(),
                    bytes: target.bytes(),
                }],
            },
            true,
        )
    }

    const TARGET_ETH: &str = "0xb79f8aC312fF21AD16980a857f574A6e7e3ED9c5";
    const TARGET_PREFIX_ORDINAL: u64 = (((7u64 * 16 + 11) * 16 + 5) * 16 + 7) * 16 + 9;

    #[test]
    fn engine_recovers_the_target_in_a_one_prefix_range() {
        let searcher = corpus_searcher(TARGET_ETH);
        let matches = searcher.run_range(TARGET_PREFIX_ORDINAL..TARGET_PREFIX_ORDINAL + 1);
        assert_eq!(matches.len(), 1);
        assert_eq!(
            matches[0].mnemonic,
            "ocean abstract raven accident hill absent winter abstract candy abuse mango able"
        );
        assert_eq!(matches[0].address, TARGET_ETH);
        // The hit's BTC addresses cross-confirm the corpus values.
        assert_eq!(
            matches[0].all_addresses.btc_p2pkh,
            "16HxxyAQvA3AKThfcJGxSqKJ3Hs9RnTgHp"
        );
        assert_eq!(
            matches[0].all_addresses.btc_bech32,
            "bc1qnm5mmckh08leuwsygfre0ls0vp7vstdju0wm57"
        );
    }

    #[test]
    fn engine_finds_nothing_in_an_early_range() {
        let searcher = corpus_searcher(TARGET_ETH);
        let matches = searcher.run_range(0..64);
        assert!(matches.is_empty());
        assert_eq!(searcher.progress.prefixes_done.load(Ordering::Relaxed), 64);
    }

    #[test]
    fn stop_flag_halts_the_scan() {
        let searcher = corpus_searcher(TARGET_ETH);
        searcher.request_stop();
        let matches = searcher.run_range(0..1024);
        assert!(matches.is_empty());
        assert_eq!(searcher.progress.prefixes_done.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn ranges_outside_the_space_are_empty() {
        let searcher = corpus_searcher(TARGET_ETH);
        assert!(searcher.run_range(9_999_999..10_000_000).is_empty());
    }
}
