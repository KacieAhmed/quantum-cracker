//! Full-space lottery sampler: uniform random draws over ALL 2048^12 raw
//! 12-word assemblies. This is the "true lottery" — every one of the 12 word
//! slots is drawn uniformly at random from the complete BIP-39 wordlist, so
//! no ordering, prefix structure, or finishability claim exists. A run ends
//! when the user stops it or its draw budget (a safety cap) is spent, never
//! with "space exhausted": the budget is always a vanishing fraction of the
//! 2^132-assembly space, and the odds are disclosed before starting
//! (2048^12 ≈ 5.4×10^39; at ~1,400 draws/s the expected wait for one exact
//! phrase is ~10^29 years).
//!
//! Match rule (unchanged, load-bearing): a match is claimed only when a
//! tested phrase genuinely derives the target address — the sampler uses the
//! identical checksum -> PBKDF2 -> compare pipeline as the pooled engine.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::bip39;
use crate::derive::{self, PathKind};
use crate::engine::{build_match, Match, Target};
use crate::traversal::{mix_u64, SplitMix64};

/// The full 12-word space: 2048^12 = 2^132 raw assemblies, of which 2^128
/// pass the BIP-39 checksum (every checksum-valid phrase is exactly one raw
/// assembly, so uniform draws over the raw space are uniform over wallets).
/// Raw word-combination count 2048^12 ≈ 5.4e39 (raw assemblies, before the
/// checksum filters ~15/16 out). Exceeds u128, so it lives as a display
/// value — integer math never touches it. UI copy must label this figure as
/// RAW assemblies, never as the reachable space.
pub const FULL_SPACE_RAW_ASSEMBLIES_F: f64 = 5.444_517_870_735_016e39; // 2^132
/// Checksum-valid 12-word phrases: 2^128 ≈ 3.4e38 — the space the sampler
/// actually draws from (1/16 of the raw assemblies). Odds copy is computed
/// against THIS number.
pub const FULL_SPACE_CHECKSUM_VALID_F: f64 = 3.402_823_669_209_385e38; // 2^128

/// Word slots per drawn phrase; each slot draws uniformly from 2048 words.
pub const WORD_SLOTS: usize = 12;

/// The phrase for draw index `draw`: 12 independent uniform draws from the
/// full 2,048-word list. Pure in `(seed, draw)`, so parallel sampling is
/// deterministic and replayable regardless of thread scheduling.
pub fn draw_indices(seed: u64, draw: u64) -> [u16; WORD_SLOTS] {
    let mut rng = SplitMix64::new(seed ^ mix_u64(draw.wrapping_mul(0x9E37_79B9_7F4A_7C15)));
    let mut indices = [0u16; WORD_SLOTS];
    for slot in &mut indices {
        *slot = rng.next_word_index();
    }
    indices
}

/// Lock-free progress counters (the engine's [`crate::engine::Progress`]
/// shape, plus the draw-only counters a lottery needs to be honest about).
#[derive(Debug, Default)]
pub struct LotteryProgress {
    /// Raw assemblies sampled — every draw, checksum-valid or not.
    pub draws: AtomicU64,
    /// Draws that passed the BIP-39 checksum (derivable wallets): only these
    /// reach the expensive full derivation + compare. ~1 in 16 by design
    /// (4 checksum bits), the draw-side truth behind the odds disclosure.
    pub checksum_valid: AtomicU64,
    /// Checksum-valid draws fully derived and compared.
    pub derived: AtomicU64,
    pub matches: AtomicU64,
    /// Most recent tested phrase, for sampled "what is being tried right
    /// now" displays (guarded by a short-held mutex; checksum-valid only).
    pub last_phrase: Mutex<Option<String>>,
}

pub struct LotteryConfig {
    pub targets: Vec<Target>,
    pub passphrase: String,
    /// Phrase always tested first, before any random sampling — the user's
    /// own phrase on own-wallet runs, else the calibration phrase (a
    /// reproducible timing anchor). Tested via
    /// [`LotterySearcher::test_pinned_first`] exactly once per run.
    pub pinned_first: Option<String>,
}

/// One lottery searcher over the full space. `stop` is shared; with
/// `stop_on_match` the first genuine hit halts sampling.
pub struct LotterySearcher {
    pub config: Arc<LotteryConfig>,
    pub progress: Arc<LotteryProgress>,
    pub stop: Arc<AtomicBool>,
    stop_on_match: bool,
    kinds: Vec<PathKind>,
    matches: Mutex<Vec<Match>>,
}

impl LotterySearcher {
    pub fn new(config: LotteryConfig, stop_on_match: bool) -> Self {
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

    /// Sample exactly `budget` raw draws (the run's safety cap); returns
    /// matches found by this call. `stop` ends early. There is deliberately
    /// no "exhausted" outcome: `budget` is a vanishing fraction of 2048^12.
    pub fn run(&self, budget: u64, seed: u64) -> Vec<Match> {
        let counter = AtomicU64::new(0);
        #[cfg(feature = "parallel")]
        {
            const CHUNK: u64 = 2048;
            use rayon::prelude::*;
            (0..budget.div_ceil(CHUNK))
                .into_par_iter()
                .for_each(|chunk| {
                    let start = chunk * CHUNK;
                    let end = (start + CHUNK).min(budget);
                    self.run_sequential(start, end, seed, &counter);
                });
            self.take_matches()
        }
        #[cfg(not(feature = "parallel"))]
        {
            self.run_sequential(0, budget, seed, &counter);
            self.take_matches()
        }
    }

    fn run_sequential(&self, start: u64, end: u64, seed: u64, counter: &AtomicU64) {
        for _ in start..end {
            if self.stop.load(Ordering::Relaxed) {
                return;
            }
            let draw = counter.fetch_add(1, Ordering::Relaxed);
            self.test_draw(draw_indices(seed, draw));
        }
    }

    fn test_draw(&self, indices: [u16; WORD_SLOTS]) {
        self.progress.draws.fetch_add(1, Ordering::Relaxed);
        if !bip39::validate_indices(&indices) {
            // ~15/16 of the raw space: not a derivable wallet. Discarded
            // without the expensive derivation (counted in `draws` only).
            return;
        }
        self.progress.checksum_valid.fetch_add(1, Ordering::Relaxed);
        let mnemonic = match bip39::mnemonic_from_indices(&indices) {
            Ok(m) => m,
            Err(_) => return, // unreachable: checksum just passed
        };
        *self
            .progress
            .last_phrase
            .lock()
            .expect("last_phrase mutex poisoned") = Some(mnemonic.clone());
        let derived =
            match derive::derive_addresses(&mnemonic, &self.config.passphrase, &self.kinds) {
                Ok(d) => d,
                // Invalid child key along the path (probability < 2^-127 per
                // BIP-32): this candidate cannot match any real wallet.
                Err(_) => return,
            };
        self.progress.derived.fetch_add(1, Ordering::Relaxed);
        for target in &self.config.targets {
            let bytes = match target.kind {
                PathKind::Eth => derived.eth,
                PathKind::BtcP2pkh => derived.btc_p2pkh,
                PathKind::BtcBech32 => derived.btc_bech32,
            };
            if bytes == Some(target.bytes) {
                let m = build_match(
                    &mnemonic,
                    &self.config.passphrase,
                    target.kind,
                    &target.bytes,
                );
                self.matches.lock().expect("matches mutex poisoned").push(m);
                self.progress.matches.fetch_add(1, Ordering::Relaxed);
                if self.stop_on_match {
                    self.stop.store(true, Ordering::Relaxed);
                }
            }
        }
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

    /// Test the pinned first candidate exactly once, before any random
    /// sampling: the caller (CLI/API) invokes this once per run, before the
    /// draw budget starts. Genuine-match rules apply — `Some` only on a real
    /// derivation. Counts as `derived` (a real checksum-valid derivation
    /// attempt) but never as a random `draw`: the pin is not part of the
    /// lottery, it precedes it.
    pub fn test_pinned_first(&self) -> Option<Match> {
        let pinned = self.config.pinned_first.as_ref()?;
        // A phrase that fails the checksum must NOT be tested as a remapped
        // phrase (mnemonic_from_indices recomputes the final word) — that
        // would test something the user never supplied.
        bip39::validate(pinned).ok()?;
        let indices: [u16; WORD_SLOTS] =
            bip39::indices_from_mnemonic(pinned).ok()?.try_into().ok()?;
        let mnemonic = bip39::mnemonic_from_indices(&indices).ok()?;
        *self
            .progress
            .last_phrase
            .lock()
            .expect("last_phrase mutex poisoned") = Some(mnemonic.clone());
        let derived =
            match derive::derive_addresses(&mnemonic, &self.config.passphrase, &self.kinds) {
                Ok(d) => d,
                Err(_) => return None,
            };
        self.progress.derived.fetch_add(1, Ordering::Relaxed);
        for target in &self.config.targets {
            let bytes = match target.kind {
                PathKind::Eth => derived.eth,
                PathKind::BtcP2pkh => derived.btc_p2pkh,
                PathKind::BtcBech32 => derived.btc_bech32,
            };
            if bytes == Some(target.bytes) {
                let m = build_match(
                    &mnemonic,
                    &self.config.passphrase,
                    target.kind,
                    &target.bytes,
                );
                self.matches.lock().expect("matches mutex poisoned").push(m);
                self.progress.matches.fetch_add(1, Ordering::Relaxed);
                return self.take_matches().into_iter().next();
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::validate::parse_target;

    /// Kacie's own-wallet benchmark anchor: the calibration phrase is her
    /// real phrase, and it genuinely derives this address — the pin-at-#1
    /// match in own-wallet runs is a real derivation, not a display.
    const KACIE_ETH: &str = "0x55aD88B854f6fE563DD59c1E56Abb821aA55F495";
    const CALIBRATION: &str =
        "permit bean gaze lawsuit expect exclude poet mercy enrich measure ocean since";

    fn sampler_for_address(address: &str) -> LotterySearcher {
        sampler_for_address_pinned(address, None)
    }

    fn sampler_for_address_pinned(address: &str, pinned: Option<&str>) -> LotterySearcher {
        let target = parse_target(address).unwrap();
        LotterySearcher::new(
            LotteryConfig {
                targets: vec![Target {
                    kind: target.kind(),
                    bytes: target.bytes(),
                }],
                passphrase: String::new(),
                pinned_first: pinned.map(str::to_string),
            },
            true,
        )
    }

    fn phrase_for(seed: u64, draw: u64) -> Option<String> {
        let indices = draw_indices(seed, draw);
        if bip39::validate_indices(&indices) {
            bip39::mnemonic_from_indices(&indices).ok()
        } else {
            None
        }
    }

    #[test]
    fn draw_sequence_is_deterministic_and_seed_separated() {
        let a: Vec<Option<String>> = (0..64).map(|d| phrase_for(0xC0FFEE, d)).collect();
        let b: Vec<Option<String>> = (0..64).map(|d| phrase_for(0xC0FFEE, d)).collect();
        assert_eq!(a, b, "same seed must replay the same draw sequence");

        let c: Vec<Option<String>> = (0..64).map(|d| phrase_for(0xBAD_F00D, d)).collect();
        assert_ne!(a, c, "different seeds must not reproduce the same draws");
    }

    #[test]
    fn word_draws_are_uniform_across_every_slot() {
        // 24,000 draws x 12 slots = 288,000 samples over [0, 2048):
        // 64 buckets of 32 indices, 4,500 expected per bucket.
        let draws = 24_000u64;
        let mut buckets = [0u64; 64];
        for draw in 0..draws {
            for index in draw_indices(0x5EED, draw) {
                buckets[(index >> 5) as usize] += 1;
            }
        }
        let expected = (draws * WORD_SLOTS as u64) as f64 / 64.0;
        let chi2: f64 = buckets
            .iter()
            .map(|&b| {
                let d = b as f64 - expected;
                d * d / expected
            })
            .sum();
        assert!(
            chi2 < 120.0,
            "all-slot word draws failed the uniformity check (chi2 = {chi2})"
        );
    }

    #[test]
    fn checksum_valid_share_matches_one_in_sixteen() {
        // 4 checksum bits -> 1/16 of uniform draws are derivable wallets.
        let draws = 30_000u64;
        let valid = (0..draws)
            .filter(|&d| bip39::validate_indices(&draw_indices(0xD00D, d)))
            .count() as f64;
        let share = valid / draws as f64;
        assert!(
            (0.045..=0.080).contains(&share),
            "checksum-valid share {share} far from the honest 1-in-16 disclosure"
        );
    }

    #[test]
    fn budget_is_respected_and_stop_is_honored() {
        // A target no random phrase plausibly derives: one non-zero byte.
        let searcher = sampler_for_address("0x0000000000000000000000000000000000000001");
        searcher.run(5_000, 0xB16B00B5);
        assert_eq!(
            searcher.progress.draws.load(Ordering::Relaxed),
            5_000,
            "the sampler must account for exactly the budgeted draws"
        );
        // No coverage claim is possible at this scale: 5,000 draws is a
        // ~10^-35 fraction of the 2^132-assembly space.

        searcher.request_stop();
        searcher.run(5_000, 0xB16B00B5);
        assert_eq!(
            searcher.progress.draws.load(Ordering::Relaxed),
            5_000,
            "stop must halt sampling immediately"
        );
    }

    #[test]
    fn pinned_candidate_is_tested_before_any_random_draw() {
        // The calibration phrase pins Kacie's own wallet: it genuinely
        // derives her ETH target, so an own-wallet lottery run legitimately
        // matches at candidate #1 (pinned — not random) and ends.
        let searcher = sampler_for_address_pinned(KACIE_ETH, Some(CALIBRATION));
        let m = searcher
            .test_pinned_first()
            .expect("the calibration phrase must genuinely derive Kacie's ETH target");
        assert_eq!(m.mnemonic, CALIBRATION);
        assert_eq!(m.path, PathKind::Eth);
        assert_eq!(m.address, KACIE_ETH);
        // The pin precedes the lottery: it is a real derivation attempt
        // (derived) but never a random draw.
        assert_eq!(searcher.progress.draws.load(Ordering::Relaxed), 0);
        assert_eq!(searcher.progress.derived.load(Ordering::Relaxed), 1);

        // A pinned phrase with no derivation path to the target is tested,
        // then sampling continues normally — no false match.
        let stranger = sampler_for_address_pinned(
            "0x0000000000000000000000000000000000000001",
            Some(CALIBRATION),
        );
        assert!(stranger.test_pinned_first().is_none());
        assert_eq!(stranger.progress.draws.load(Ordering::Relaxed), 0);
        assert_eq!(stranger.progress.derived.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn pinned_candidate_with_bad_checksum_is_never_retested_recomputed() {
        // A checksum-invalid pin must be skipped, NOT silently remapped to a
        // recomputed-checksum phrase and tested as if it were the user's
        // words. (A single wrong final word is often STILL valid — only 4
        // checksum bits — so pick a genuinely invalid variant.)
        let words: Vec<&str> = CALIBRATION.split_whitespace().collect();
        let bad = (0..2048)
            .map(|i| {
                let mut w = words.clone();
                w[11] = bip39::word(i).unwrap();
                w.join(" ")
            })
            .find(|m| bip39::validate(m).is_err())
            .expect("most final words fail the checksum");
        let searcher =
            sampler_for_address_pinned("0x0000000000000000000000000000000000000001", Some(&bad));
        assert!(searcher.test_pinned_first().is_none());
        assert_eq!(searcher.progress.derived.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn planted_target_matches_only_via_genuine_derivation() {
        // Plant the target of a specific seeded draw, then check both sides
        // of the match rule: a sweep covering that draw claims the match;
        // the same budget stopping one draw short claims nothing.
        let seed = 0x501A;
        let planted_draw = (0..100u64)
            .find(|&d| phrase_for(seed, d).is_some())
            .expect("a checksum-valid draw exists within 100 draws");
        let planted_phrase = phrase_for(seed, planted_draw).unwrap();
        let derived = crate::derive_addresses(&planted_phrase, "", &[PathKind::Eth]).unwrap();
        let address = PathKind::Eth.format_address(&derived.eth.expect("eth derivation succeeded"));
        let parsed = parse_target(&address).unwrap();

        let short = sampler_for_address(&address);
        assert!(short.run(planted_draw, seed).is_empty());

        let covering = sampler_for_address(&address);
        let matches = covering.run(planted_draw + 1, seed);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].mnemonic, planted_phrase);
        assert_eq!(matches[0].address, address);
        assert_eq!(matches[0].path, parsed.kind());
    }
}
