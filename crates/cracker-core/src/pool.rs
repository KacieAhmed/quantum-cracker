//! Pooled candidate enumeration (Demo Wallet Corpus / wallets.json).
//!
//! Two pool shapes are supported. The legacy corpus pool varies six word
//! positions over one shared 16-word slice of the official wordlist (16^6 =
//! 2^24 raw assemblies, 16^5 = 2^20 checksum-valid candidates). The
//! varied-slot pool gives EVERY slot its own pool: slots 1-11 over small
//! pools (one 2-word slot, ten 4-word slots), slot 12 over a 16-word aligned
//! block (2^25 raw assemblies, 2^21 checksum-valid candidates).
//!
//! In both shapes the slot-12 pool covers each 4-bit checksum nibble exactly
//! once, so every first-11-word prefix has exactly one checksum-valid pool
//! completion and prefix ordinals map one-to-one onto checksum-valid
//! candidates. The varied space additionally walks display ordinals through
//! a fixed-key bijection (shuffled traversal), so the tested stream does not
//! follow the enumeration order.

use std::collections::BTreeMap;

use serde::Deserialize;

use crate::bip39;
use crate::error::{CrackerError, Result};

/// Subset of `wallets.json` this engine consumes (serde ignores the rest).
/// `pooled` is the legacy fixed-slot space; `pooled_varied` (the default
/// classic demo target) varies every slot over its own pool.
#[derive(Deserialize, Debug)]
pub struct WalletsFileJson {
    #[serde(rename = "pooled_demo_wallet")]
    pub pooled: PooledWalletJson,
    #[serde(rename = "pooled_demo_wallet_varied", default)]
    pub pooled_varied: Option<PooledWalletJson>,
}

#[derive(Deserialize, Debug)]
pub struct PooledWalletJson {
    pub mnemonic: String,
    pub passphrase: String,
    pub eth: ChainAddressJson,
    pub btc_p2pkh: ChainAddressJson,
    pub btc_bech32: ChainAddressJson,
    pub pool_config: PoolConfigJson,
}

#[derive(Deserialize, Debug)]
pub struct ChainAddressJson {
    #[allow(dead_code)]
    pub path: String,
    pub address: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub private_key_hex: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub wif: String,
}

/// The machine-readable `pool_config` block from the corpus document. Two
/// shapes: the legacy shared-pool config (`pool_words`, `variable_positions`,
/// `fixed_words`) and the varied-slot config (`slot_pools_1_indexed`, one
/// pool per slot, plus an optional `traversal`).
#[derive(Deserialize, Debug, Clone)]
pub struct PoolConfigJson {
    #[serde(default)]
    pub pool_words: Option<Vec<String>>,
    #[serde(default, rename = "variable_positions_1_indexed")]
    pub variable_positions: Option<Vec<u8>>,
    #[serde(default, rename = "fixed_words_1_indexed")]
    pub fixed_words: Option<BTreeMap<String, String>>,
    #[serde(default, rename = "slot_pools_1_indexed")]
    pub slot_pools: Option<BTreeMap<String, Vec<String>>>,
    #[serde(default)]
    pub traversal: Option<String>,
}

/// Compiled pool search: one word pool per slot (singleton for fixed slots)
/// and the passphrase. Enumeration is deterministic: mixed-radix over the
/// varying prefix positions (ascending position order, last varying position
/// cycling fastest), then the checksum filter over the 12th word. When
/// `shuffled`, the ordinals a run walks are display ordinals; the engine
/// maps each through [`PoolSearch::native_ordinal`] before assembling.
#[derive(Debug, Clone)]
pub struct PoolSearch {
    /// Wordlist indices each slot may take; singleton for fixed slots.
    slot_pools: [Vec<u16>; 12],
    shuffled: bool,
    passphrase: String,
}

fn bad_pool(msg: &'static str) -> CrackerError {
    CrackerError::BadPoolConfig(msg)
}

/// Fixed traversal key for the shuffled walk. Every worker lane must walk
/// the SAME permutation for disjoint-range coverage to stay exact, and a
/// reproducible order makes a stopped/resumed scan honest. The key is public
/// by design — this is a disclosure property, not a secret.
const TRAVERSAL_SEED: u64 = 0x5EED_CAFE_2026_0925;

/// splitmix64 finalizer, seeded per round: a Feistel round function needs
/// good mixing, not cryptographic strength.
fn mix_round(word: u64, round: u32) -> u64 {
    let mut z = word
        ^ TRAVERSAL_SEED.wrapping_add((u64::from(round) + 1).wrapping_mul(0x9E37_79B9_7F4A_7C15));
    z = z.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z ^= z >> 30;
    z = z.wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^= z >> 31;
    z
}

/// One 4-round balanced Feistel pass: a bijection on [0, 2^(2*half_bits)).
fn feistel_pass(v: u64, half_bits: u32) -> u64 {
    let mask = (1u64 << half_bits) - 1;
    let (mut left, mut right) = ((v >> half_bits) & mask, v & mask);
    for round in 0..4 {
        let f = mix_round(right, round) & mask;
        let new_right = (left ^ f) & mask;
        left = right;
        right = new_right;
    }
    (left << half_bits) | right
}

/// Inverse of [`feistel_pass`]: apply the four round functions in reverse.
fn feistel_pass_inverse(v: u64, half_bits: u32) -> u64 {
    let mask = (1u64 << half_bits) - 1;
    let (mut left, mut right) = ((v >> half_bits) & mask, v & mask);
    for round in (0..4).rev() {
        let prev_left = (right ^ (mix_round(left, round) & mask)) & mask;
        right = left;
        left = prev_left;
    }
    (left << half_bits) | right
}

/// The shuffled walk: a bijection on the half-open range `0..domain` for
/// power-of-two domains. The Feistel pass runs over the next power of four
/// (2 * half_bits >= bits) and cycle-walks into the domain. The walk stays
/// injective since each output is a deterministic function of the value
/// alone.
fn shuffle_permute(v: u64, domain: u64) -> u64 {
    let half_bits = (63 - domain.leading_zeros()).div_ceil(2).max(1);
    let mut out = feistel_pass(v, half_bits);
    while out >= domain {
        out = feistel_pass(out, half_bits);
    }
    out
}

/// Inverse of [`shuffle_permute`].
fn shuffle_unpermute(out: u64, domain: u64) -> u64 {
    let half_bits = (63 - domain.leading_zeros()).div_ceil(2).max(1);
    let mut v = feistel_pass_inverse(out, half_bits);
    while v >= domain {
        v = feistel_pass_inverse(v, half_bits);
    }
    v
}

impl PoolSearch {
    pub fn from_config(config: &PoolConfigJson, passphrase: &str) -> Result<Self> {
        let slot_pools = if let Some(slot_pools) = &config.slot_pools {
            Self::parse_slot_pools(slot_pools)?
        } else {
            Self::parse_legacy(config)?
        };
        let shuffled = match config.traversal.as_deref() {
            None | Some("") | Some("sequential") => false,
            Some("shuffled") => true,
            Some(other) => {
                return Err(CrackerError::Other(format!(
                    "unknown pool traversal {other:?} (expected \"sequential\" or \"shuffled\")"
                )));
            }
        };
        let compiled = Self {
            slot_pools,
            shuffled,
            passphrase: passphrase.to_string(),
        };
        // Reject spaces whose ordinal arithmetic cannot be represented: a
        // saturating count would silently under-report the keyspace a run
        // promises to cover.
        let prefixes = compiled.total_prefixes();
        let completion = compiled.slot_pools[11].len() as u64;
        if completion == 0 || prefixes == 0 || prefixes > u64::MAX / completion {
            return Err(bad_pool(
                "keyspace too large: prefix × pool-word count overflows u64",
            ));
        }
        // The cycle-walking shuffle needs headroom to terminate promptly and
        // a power-of-two domain to stay a bijection; the demo spaces are
        // 2^20-2^21 prefixes, so this floor is generous.
        if shuffled && (prefixes < 65_536 || !prefixes.is_power_of_two()) {
            return Err(CrackerError::Other(
                "shuffled traversal requires a power-of-two space of at least 2^16 prefixes"
                    .to_string(),
            ));
        }
        Ok(compiled)
    }

    /// Varied-slot config: `slot_pools_1_indexed` must cover all 12 slots,
    /// every word must be in the BIP-39 list, and no pool may repeat a word
    /// (a repeat would skew the mixed-radix radices).
    fn parse_slot_pools(map: &BTreeMap<String, Vec<String>>) -> Result<[Vec<u16>; 12]> {
        let mut slot_pools: [Vec<u16>; 12] = Default::default();
        for (pos_str, words) in map {
            let pos: usize = pos_str
                .parse()
                .map_err(|_| bad_pool("slot pool key is not a number"))?;
            if !(1..=12).contains(&pos) {
                return Err(bad_pool("slot pool position outside 1..=12"));
            }
            if words.is_empty() {
                return Err(bad_pool("slot pool is empty"));
            }
            let mut pool = Vec::with_capacity(words.len());
            for word in words {
                let idx = bip39::word_index(word)
                    .ok_or_else(|| bad_pool("pool word not in BIP-39 wordlist"))?
                    as u16;
                pool.push(idx);
            }
            pool.sort_unstable();
            let unique = pool.len();
            pool.dedup();
            if pool.len() != unique {
                return Err(bad_pool("slot pool repeats a word"));
            }
            slot_pools[pos - 1] = pool;
        }
        if slot_pools.iter().any(Vec::is_empty) {
            return Err(bad_pool("pool config is missing a slot (1..=12)"));
        }
        Ok(slot_pools)
    }

    /// Legacy config: fixed words at chosen positions, one shared pool
    /// elsewhere (including, for the corpus pool, the 12th word).
    fn parse_legacy(config: &PoolConfigJson) -> Result<[Vec<u16>; 12]> {
        let pool_words = config
            .pool_words
            .as_ref()
            .ok_or_else(|| bad_pool("pool config is missing pool_words"))?;
        let variable = config
            .variable_positions
            .as_ref()
            .ok_or_else(|| bad_pool("pool config is missing variable_positions_1_indexed"))?;
        let fixed = config
            .fixed_words
            .as_ref()
            .ok_or_else(|| bad_pool("pool config is missing fixed_words_1_indexed"))?;
        if pool_words.is_empty() {
            return Err(bad_pool("empty word pool"));
        }
        let mut slots: [Option<u16>; 12] = [None; 12];
        for (pos_str, word) in fixed {
            let pos: usize = pos_str
                .parse()
                .map_err(|_| bad_pool("fixed word position is not a number"))?;
            if !(1..=12).contains(&pos) {
                return Err(bad_pool("fixed word position outside 1..=12"));
            }
            let idx = bip39::word_index(word)
                .ok_or_else(|| bad_pool("fixed word not in BIP-39 wordlist"))?
                as u16;
            slots[pos - 1] = Some(idx);
        }
        for &p in variable {
            if !(1..=12).contains(&p) {
                return Err(bad_pool("variable position outside 1..=12"));
            }
            if slots[usize::from(p) - 1].is_some() {
                return Err(bad_pool("position marked both fixed and variable"));
            }
        }
        let fixed_count = slots.iter().filter(|s| s.is_some()).count();
        if fixed_count + variable.len() != 12 {
            return Err(bad_pool(
                "fixed and variable positions must cover all 12 slots exactly once",
            ));
        }
        let mut pool = Vec::with_capacity(pool_words.len());
        for word in pool_words {
            let idx = bip39::word_index(word)
                .ok_or_else(|| bad_pool("pool word not in BIP-39 wordlist"))?
                as u16;
            pool.push(idx);
        }
        pool.sort_unstable();
        pool.dedup();
        let mut slot_pools: [Vec<u16>; 12] = Default::default();
        for (i, slot) in slots.into_iter().enumerate() {
            slot_pools[i] = match slot {
                Some(idx) => vec![idx],
                None => pool.clone(),
            };
        }
        Ok(slot_pools)
    }

    /// Positions (0-indexed) among the first 11 words that draw from a pool
    /// of more than one word. The 12th word slot is the checksum-filtered
    /// completion pool.
    pub fn prefix_positions(&self) -> Vec<usize> {
        (0..11).filter(|&p| self.slot_pools[p].len() > 1).collect()
    }

    /// Pool size behind each slot (1-indexed): 1 = fixed slot.
    pub fn slot_pool_lens(&self) -> [usize; 12] {
        let mut lens = [0usize; 12];
        for (i, pool) in self.slot_pools.iter().enumerate() {
            lens[i] = pool.len();
        }
        lens
    }

    /// Distinct first-11-word prefixes: the product of the pool size over
    /// each varying prefix position (16^5 = 2^20 for the legacy corpus pool,
    /// 2^21 for the varied-slot pool).
    pub fn total_prefixes(&self) -> u64 {
        self.prefix_positions()
            .iter()
            .map(|&p| self.slot_pools[p].len() as u64)
            .product()
    }

    /// Raw assemblies the corpus counts: every prefix x every 12th-slot pool
    /// word (16^6 = 2^24 for the legacy corpus pool, 2^25 for the varied
    /// pool), before checksum filtering.
    pub fn raw_candidates(&self) -> u64 {
        self.total_prefixes()
            .saturating_mul(self.slot_pools[11].len() as u64)
    }

    /// Whether this space walks display ordinals through the shuffled
    /// traversal (the default classic demo space does; the legacy pool does
    /// not).
    pub fn shuffled(&self) -> bool {
        self.shuffled
    }

    /// Maps a display (walk) ordinal to the native enumeration ordinal.
    /// Identity unless the space opted into the shuffled traversal.
    pub fn native_ordinal(&self, display_ordinal: u64) -> u64 {
        if !self.shuffled {
            return display_ordinal;
        }
        let domain = self.total_prefixes();
        if domain < 2 {
            return display_ordinal;
        }
        shuffle_unpermute(display_ordinal, domain)
    }

    /// Maps a native enumeration ordinal to the display (walk) ordinal the
    /// shuffled traversal tests it at. Identity when sequential.
    pub fn display_ordinal(&self, native_ordinal: u64) -> u64 {
        if !self.shuffled {
            return native_ordinal;
        }
        let domain = self.total_prefixes();
        if domain < 2 {
            return native_ordinal;
        }
        shuffle_permute(native_ordinal, domain)
    }

    /// Assemble the first 11 word indices for a NATIVE prefix ordinal.
    pub fn assemble_prefix(&self, ordinal: u64) -> [u16; 11] {
        let mut digits = [0u16; 11];
        for (p, pool) in self.slot_pools.iter().take(11).enumerate() {
            if pool.len() == 1 {
                digits[p] = pool[0];
            }
        }
        let mut rem = ordinal;
        for &pos in self.prefix_positions().iter().rev() {
            let pool = &self.slot_pools[pos];
            digits[pos] = pool[(rem % pool.len() as u64) as usize];
            rem /= pool.len() as u64;
        }
        debug_assert_eq!(rem, 0, "prefix ordinal out of range");
        digits
    }

    /// Checksum-valid 12-word candidates for one prefix: the 12th word drawn
    /// from the slot-12 pool, kept iff the BIP-39 checksum passes. Appends to
    /// the caller-reused buffer so hot loops do not allocate (doc section
    /// 9.3: the filter spares PBKDF2 for the 1-in-16 survivors).
    pub fn candidates_for_prefix(&self, prefix: &[u16; 11], out: &mut Vec<[u16; 12]>) {
        out.clear();
        for &twelfth in &self.slot_pools[11] {
            let mut indices = [0u16; 12];
            indices[..11].copy_from_slice(prefix);
            indices[11] = twelfth;
            if bip39::validate_indices(&indices) {
                out.push(indices);
            }
        }
    }

    pub fn passphrase(&self) -> &str {
        &self.passphrase
    }

    /// Whether a mnemonic lies inside this pooled space: it must be
    /// checksum-valid and draw every slot's word (including the 12th) from
    /// that slot's pool. If all of that holds, enumeration provably reaches
    /// the phrase — otherwise no search over this pool can ever match it.
    pub fn contains_mnemonic(&self, mnemonic: &str) -> bool {
        if bip39::validate(mnemonic).is_err() {
            return false;
        }
        let Some(indices) = bip39::indices_from_mnemonic(mnemonic).ok() else {
            return false;
        };
        indices
            .iter()
            .enumerate()
            .all(|(p, idx)| self.slot_pools[p].contains(idx))
    }

    /// The display (walk) ordinal a phrase occupies in this space, or `None`
    /// when the phrase is outside the space. The native ordinal follows the
    /// mixed-radix enumeration (last varying position cycles fastest); the
    /// display ordinal applies the shuffled traversal when enabled.
    pub fn ordinal_of(&self, mnemonic: &str) -> Option<u64> {
        if !self.contains_mnemonic(mnemonic) {
            return None;
        }
        let indices = bip39::indices_from_mnemonic(mnemonic).ok()?;
        let mut native = 0u64;
        for &pos in self.prefix_positions().iter() {
            let pool = &self.slot_pools[pos];
            let digit = pool.iter().position(|&w| w == indices[pos])? as u64;
            native = native * pool.len() as u64 + digit;
        }
        Some(self.display_ordinal(native))
    }

    /// The checksum-valid candidate for a display (walk) ordinal, as a
    /// phrase string. Every prefix has exactly one pool completion that
    /// passes the checksum (the slot-12 pool covers each checksum nibble
    /// exactly once), so this is the deterministic candidate the engine
    /// tests at that ordinal — used for sampled live-view displays. `None`
    /// iff `ordinal >= total_prefixes()` or the (sub-2^-127) completion
    /// round-trips badly.
    pub fn candidate_at(&self, display_ordinal: u64) -> Option<String> {
        if display_ordinal >= self.total_prefixes() {
            return None;
        }
        let prefix = self.assemble_prefix(self.native_ordinal(display_ordinal));
        let mut out = Vec::new();
        self.candidates_for_prefix(&prefix, &mut out);
        out.first()
            .and_then(|indices| bip39::mnemonic_from_indices(indices).ok())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn corpus_pool() -> PoolSearch {
        let doc: WalletsFileJson = serde_json::from_str(crate::WALLETS_JSON).unwrap();
        PoolSearch::from_config(&doc.pooled.pool_config, "").unwrap()
    }

    fn varied_pool() -> PoolSearch {
        let doc: WalletsFileJson = serde_json::from_str(crate::WALLETS_JSON).unwrap();
        let varied = doc
            .pooled_varied
            .as_ref()
            .expect("varied pooled wallet in the embedded corpus");
        PoolSearch::from_config(&varied.pool_config, "").unwrap()
    }

    const VARIED_TARGET: &str =
        "ocean raven hill winter candy mango harbor echo orbit marble velvet abuse";
    /// Native mixed-radix ordinal of the varied target prefix (generated and
    /// cross-checked in the Demo Wallet Corpus rebuild).
    const VARIED_TARGET_NATIVE_ORDINAL: u64 = 378_186;

    #[test]
    fn corpus_space_dimensions_match_the_documented_contract() {
        let pool = corpus_pool();
        assert_eq!(pool.total_prefixes(), 1_048_576); // 16^5
        assert_eq!(pool.raw_candidates(), 16_777_216); // 16^6 = 2^24
        assert_eq!(pool.prefix_positions(), vec![1, 3, 5, 7, 9]);
        assert_eq!(pool.slot_pool_lens()[0], 1); // fixed slot
        assert_eq!(pool.slot_pool_lens()[1], 16); // varying slot
        assert!(!pool.shuffled());
        assert_eq!(pool.passphrase(), "");
    }

    #[test]
    fn varied_space_dimensions_match_the_generated_corpus() {
        let pool = varied_pool();
        assert_eq!(pool.total_prefixes(), 2_097_152); // 2^21
        assert_eq!(pool.raw_candidates(), 33_554_432); // 2^21 x 16 = 2^25
        assert_eq!(pool.prefix_positions(), (0..11).collect::<Vec<_>>());
        assert!(pool.shuffled());
        assert_eq!(pool.passphrase(), "");
    }

    #[test]
    fn every_slot_varies_in_the_varied_space() {
        // The whole point of the varied space: no slot is pinned. Legacy
        // pools pin their fixed slots (pool len 1); the varied pool gives
        // every slot at least two words.
        let varied = varied_pool();
        for (slot_1_indexed, len) in varied.slot_pool_lens().iter().enumerate() {
            assert!(
                *len >= 2,
                "slot {} pool has only {len} words",
                slot_1_indexed + 1
            );
        }
        let legacy = corpus_pool();
        assert_eq!(legacy.slot_pool_lens()[0], 1, "legacy slot 1 is fixed");
        assert_eq!(legacy.slot_pool_lens()[11], 16, "legacy slot 12 varies");
    }

    #[test]
    fn varied_target_is_reachable_and_round_trips_through_the_walk_order() {
        let pool = varied_pool();
        let display = pool
            .ordinal_of(VARIED_TARGET)
            .expect("target phrase lies inside the varied space");
        // The native ordinal must match the generated corpus value exactly.
        assert_eq!(pool.native_ordinal(display), VARIED_TARGET_NATIVE_ORDINAL);
        // ...and the walk order must test the target phrase at that display
        // ordinal (permutation is a bijection, and this is its fixed point
        // for the target's own native position under the traversal mapping).
        assert_eq!(pool.candidate_at(display).as_deref(), Some(VARIED_TARGET));
    }

    #[test]
    fn shuffled_traversal_is_a_bijection_on_the_display_space() {
        // Exhaustive at the smallest configured domain (2^16): every display
        // ordinal is hit exactly once.
        let domain = 65_536u64;
        let mut seen = vec![false; domain as usize];
        for native in 0..domain {
            let display = shuffle_permute(native, domain);
            assert!(display < domain, "permute left the domain");
            assert!(!seen[display as usize], "permute collided at {display}");
            seen[display as usize] = true;
            assert_eq!(shuffle_unpermute(display, domain), native);
        }
        // Sampled round-trips at the real demo domain (2^21).
        let demo_domain = 2_097_152u64;
        for i in 0..10_000u64 {
            let native = (i * 209_719) % demo_domain; // strided spread
            let display = shuffle_permute(native, demo_domain);
            assert!(display < demo_domain);
            assert_eq!(shuffle_unpermute(display, demo_domain), native);
        }
    }

    #[test]
    fn shuffled_walk_does_not_follow_the_enumeration_order() {
        // The shuffled space must not test the first native prefixes first —
        // a sequential stream is exactly what the varied space replaces.
        let pool = varied_pool();
        let moved = (0..64u64)
            .filter(|&display| pool.native_ordinal(display) != display)
            .count();
        assert!(moved > 0, "shuffle degenerated to the identity walk");
        // ...and the legacy pool stays sequential for backwards compatibility.
        let legacy = corpus_pool();
        for display in 0..64u64 {
            assert_eq!(legacy.native_ordinal(display), display);
        }
    }

    #[test]
    fn rejects_broken_configs() {
        let doc: WalletsFileJson = serde_json::from_str(crate::WALLETS_JSON).unwrap();
        let mut cfg = doc.pooled.pool_config.clone();
        cfg.variable_positions
            .as_mut()
            .expect("legacy config")
            .push(2); // collides with fixed position 2
        assert!(PoolSearch::from_config(&cfg, "").is_err());

        let mut cfg = doc.pooled.pool_config.clone();
        cfg.pool_words
            .as_mut()
            .expect("legacy config")
            .push("notaword".into());
        assert!(PoolSearch::from_config(&cfg, "").is_err());

        let mut cfg = doc.pooled.pool_config.clone();
        cfg.variable_positions
            .as_mut()
            .expect("legacy config")
            .clear(); // under-covers the 12 slots
        assert!(PoolSearch::from_config(&cfg, "").is_err());

        // A varied config missing a slot is rejected outright.
        let varied = doc.pooled_varied.as_ref().unwrap();
        let mut cfg = varied.pool_config.clone();
        cfg.slot_pools.as_mut().unwrap().remove("7");
        assert!(PoolSearch::from_config(&cfg, "").is_err());

        // A pool word outside the wordlist is rejected.
        let mut cfg = varied.pool_config.clone();
        cfg.slot_pools
            .as_mut()
            .unwrap()
            .get_mut("1")
            .unwrap()
            .push("notaword".into());
        assert!(PoolSearch::from_config(&cfg, "").is_err());

        // An unknown traversal name is rejected.
        let mut cfg = varied.pool_config.clone();
        cfg.traversal = Some("bogosort".into());
        assert!(PoolSearch::from_config(&cfg, "").is_err());
    }

    #[test]
    fn legacy_prefix_ordinal_maps_to_documented_target_indices() {
        // wallets.json: target pool indices at positions 2,4,6,8,10,12
        // (1-indexed) are 7,11,5,7,9,2. Positions 2,4,6,8,10 form the prefix
        // (last varying position cycles fastest), position 12 is filtered.
        let pool = corpus_pool();
        let ordinal = (((7u64 * 16 + 11) * 16 + 5) * 16 + 7) * 16 + 9;
        assert_eq!(ordinal, 505_209);
        let prefix = pool.assemble_prefix(ordinal);
        let expected: [u16; 11] = [
            bip39::word_index("ocean").unwrap() as u16,
            bip39::word_index("abstract").unwrap() as u16, // position 2
            bip39::word_index("raven").unwrap() as u16,
            bip39::word_index("accident").unwrap() as u16, // position 4
            bip39::word_index("hill").unwrap() as u16,
            bip39::word_index("absent").unwrap() as u16, // position 6
            bip39::word_index("winter").unwrap() as u16,
            bip39::word_index("abstract").unwrap() as u16, // position 8
            bip39::word_index("candy").unwrap() as u16,
            bip39::word_index("abuse").unwrap() as u16, // position 10
            bip39::word_index("mango").unwrap() as u16,
        ];
        assert_eq!(prefix, expected);
    }

    #[test]
    fn candidate_at_returns_the_documented_target_phrase_at_its_ordinal() {
        // The pooled wallet's prefix ordinal (505_209) must round-trip through
        // candidate_at to exactly the documented target phrase.
        let pool = corpus_pool();
        let phrase = pool
            .candidate_at(505_209)
            .expect("target ordinal has one checksum-valid completion");
        assert_eq!(
            phrase,
            "ocean abstract raven accident hill absent winter abstract candy abuse mango able"
        );
        assert_eq!(pool.candidate_at(pool.total_prefixes()), None);
    }

    #[test]
    fn every_target_prefix_has_exactly_one_checksum_valid_completion() {
        // The corpus documents this invariant via 10,000 sampled prefixes; for
        // the target prefixes we can assert it exactly.
        for pool in [corpus_pool(), varied_pool()] {
            let native = if pool.shuffled() {
                VARIED_TARGET_NATIVE_ORDINAL
            } else {
                505_209
            };
            let prefix = pool.assemble_prefix(native);
            let mut candidates = Vec::new();
            pool.candidates_for_prefix(&prefix, &mut candidates);
            assert_eq!(candidates.len(), 1);
        }
        // ...and for the varied pool the completion IS the generated target.
        let pool = varied_pool();
        let prefix = pool.assemble_prefix(VARIED_TARGET_NATIVE_ORDINAL);
        let mut candidates = Vec::new();
        pool.candidates_for_prefix(&prefix, &mut candidates);
        assert_eq!(
            bip39::mnemonic_from_indices(&candidates[0]).unwrap(),
            VARIED_TARGET
        );
    }

    #[test]
    fn membership_says_which_phrases_the_pool_can_reach() {
        let pool = corpus_pool();
        // The pooled demo phrase is provably reachable.
        assert!(pool.contains_mnemonic(
            "ocean abstract raven accident hill absent winter abstract candy abuse mango able"
        ));

        // Another checksum-valid completion of a different pool prefix is
        // inside too: build it by finding the pool's unique checksum-valid
        // 12th word for a fresh prefix (fixed words + pool words at even
        // positions 2,4,6,8,10).
        const POOL_WORDS: [&str; 16] = [
            "abandon", "ability", "able", "about", "above", "absent", "absorb", "abstract",
            "absurd", "abuse", "access", "accident", "account", "accuse", "achieve", "acid",
        ];
        let mut variant = [0u16; 12];
        for (i, w) in [
            "ocean", "abandon", "raven", "ability", "hill", "absent", "winter", "abstract",
            "candy", "abuse", "mango",
        ]
        .iter()
        .enumerate()
        {
            variant[i] = u16::try_from(bip39::word_index(w).unwrap()).unwrap();
        }
        let mut found_checksum_completion = false;
        for pool_word in POOL_WORDS
            .iter()
            .map(|w| u16::try_from(bip39::word_index(w).unwrap()).unwrap())
        {
            variant[11] = pool_word;
            if bip39::validate_indices(&variant) {
                found_checksum_completion = true;
                break;
            }
        }
        assert!(
            found_checksum_completion,
            "the pool covers every checksum nibble exactly once"
        );
        let variant_phrase = bip39::mnemonic_from_indices(&variant).unwrap();
        assert!(pool.contains_mnemonic(&variant_phrase));

        // The famous all-zero wallet is valid but outside (fixed words differ).
        assert!(!pool.contains_mnemonic(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
        ));
        // A valid wordlist word that is not a pool word at an even position
        // is outside ("across" is wordlist #19; the pool stops at #16).
        assert!(!pool.contains_mnemonic(
            "ocean across raven accident hill absent winter abstract candy abuse mango able"
        ));
        // A checksum failure is never inside (12th word must be the unique
        // valid pool completion).
        assert!(!pool.contains_mnemonic(
            "ocean abstract raven accident hill absent winter abstract candy abuse mango about"
        ));
        // Wrong word count is outside.
        assert!(!pool.contains_mnemonic(
            "ocean abstract raven accident hill absent winter abstract candy abuse mango able extra"
        ));
    }

    #[test]
    fn varied_membership_rejects_out_of_pool_words_in_any_slot() {
        let pool = varied_pool();
        assert!(pool.contains_mnemonic(VARIED_TARGET));

        // "acid" is in the slot-12 pool but "abuse" is the unique checksum
        // completion for the target prefix, so this phrase is invalid BIP-39
        // and outside.
        assert!(!pool.contains_mnemonic(
            "ocean raven hill winter candy mango harbor echo orbit marble velvet acid"
        ));
        // "river" IS a slot-1 pool word: a checksum-valid phrase that swaps
        // the target's slot-1 word for another pool word is inside (the space
        // genuinely varies every slot).
        let mut indices = [0u16; 12];
        for (i, w) in [
            "river", "raven", "hill", "winter", "candy", "mango", "harbor", "echo", "orbit",
            "marble", "velvet", "abuse",
        ]
        .iter()
        .enumerate()
        {
            indices[i] = u16::try_from(bip39::word_index(w).unwrap()).unwrap();
        }
        // Only assert if checksum-valid; some pool combos are not.
        if bip39::validate_indices(&indices) {
            assert!(pool.contains_mnemonic(&bip39::mnemonic_from_indices(&indices).unwrap()));
        }
        // A word that is in the wordlist but not in the slot pool is outside.
        assert!(!pool.contains_mnemonic(
            "turtle raven hill winter candy mango harbor echo orbit marble velvet abuse"
        ));
    }

    /// A pool_config that varies `vary_first11` of the first 11 slots over
    /// the full BIP-39 list, with the 12th word sweeping the full list as the
    /// checksum-filtered completion — the shape the limited-keyspace mode
    /// builds.
    fn full_list_config(vary_first11: usize) -> PoolConfigJson {
        let full: Vec<String> = (0..crate::bip39::word_count())
            .filter_map(|i| crate::bip39::word(i).map(String::from))
            .collect();
        let mut variable: Vec<u8> = (1..=11).take(vary_first11).map(|p| p as u8).collect();
        variable.push(12); // the 12th word is always the swept completion slot
        let mut fixed = BTreeMap::new();
        let sample = |p: usize| -> String {
            crate::bip39::word((p * 7) % crate::bip39::word_count())
                .unwrap()
                .to_string()
        };
        for p in 1..=11 {
            if !variable.contains(&(p as u8)) {
                fixed.insert(p.to_string(), sample(p));
            }
        }
        PoolConfigJson {
            pool_words: Some(full),
            variable_positions: Some(variable),
            fixed_words: Some(fixed),
            slot_pools: None,
            traversal: None,
        }
    }

    #[test]
    fn full_wordlist_template_spaces_follow_the_documented_counts() {
        // 4 varied slots among the first 11, 12th sweeping the full list:
        // 2048^4 prefixes, 2048^5 raw.
        let pool = PoolSearch::from_config(&full_list_config(4), "").unwrap();
        assert_eq!(pool.total_prefixes(), 2_048u64.pow(4));
        assert_eq!(pool.raw_candidates(), 2_048u64.pow(5));

        // 3 varied slots: 2048^3 prefixes, 2048^4 raw.
        let pool = PoolSearch::from_config(&full_list_config(3), "").unwrap();
        assert_eq!(pool.total_prefixes(), 2_048u64.pow(3));
        assert_eq!(pool.raw_candidates(), 2_048u64.pow(4));
    }

    #[test]
    fn template_space_that_overflows_u64_is_rejected() {
        // 5 varied prefix slots over the full list: raw assemblies 2048^6
        // (~7.4e19) exceed u64::MAX and must be rejected outright.
        assert!(PoolSearch::from_config(&full_list_config(5), "").is_err());
        // 4 varied prefix slots + the sweeping twelfth: raw 2048^5 (~3.6e16)
        // still fits and must be accepted.
        let pool = PoolSearch::from_config(&full_list_config(4), "").unwrap();
        assert_eq!(pool.total_prefixes(), 2_048u64.pow(4));
        assert_eq!(pool.raw_candidates(), 2_048u64.pow(5));
    }

    #[test]
    fn full_list_template_contains_its_own_phrase_by_construction() {
        let cfg = full_list_config(2);
        // Varying slots get arbitrary list words; every other slot is fixed.
        // Slot 12 is left unassigned (index 0, "abandon"); sweeping varying
        // slot 2 must still find a checksum-valid completion for the rest.
        let mut indices = [0u16; 12];
        for p in 1..=12 {
            if !cfg
                .variable_positions
                .as_ref()
                .unwrap()
                .contains(&(p as u8))
            {
                indices[p - 1] = crate::bip39::word_index(
                    cfg.fixed_words.as_ref().unwrap()[&p.to_string()].as_str(),
                )
                .unwrap() as u16;
            }
        }
        let mut checksum_ok = false;
        for idx in 0..crate::bip39::word_count() {
            indices[1] = idx as u16; // slot 2 varies over the full list
            if crate::bip39::validate_indices(&indices) {
                checksum_ok = true;
                break;
            }
        }
        assert!(
            checksum_ok,
            "sweeping a varying slot must find a checksum word"
        );
        let phrase = crate::bip39::mnemonic_from_indices(&indices).unwrap();
        let pool = PoolSearch::from_config(&cfg, "").unwrap();
        // Enumeration provably reaches this phrase: the limited-keyspace
        // containment guarantee.
        assert!(pool.contains_mnemonic(&phrase));
    }

    #[test]
    fn enumeration_is_deterministic() {
        for pool in [corpus_pool(), varied_pool()] {
            let mut pass1 = Vec::new();
            let mut pass2 = Vec::new();
            for display in 0..128u64 {
                let prefix = pool.assemble_prefix(pool.native_ordinal(display));
                pool.candidates_for_prefix(&prefix, &mut pass1);
                pool.candidates_for_prefix(&prefix, &mut pass2);
                assert_eq!(pass1, pass2, "prefix {display} enumerated differently");
            }
        }
    }
}
