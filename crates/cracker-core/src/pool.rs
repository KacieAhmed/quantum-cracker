//! Pooled candidate enumeration (Demo Wallet Corpus / wallets.json).
//!
//! The corpus pool varies six word positions over a 16-word slice of the
//! official wordlist: 16^6 = 2^24 raw assemblies. Because the pool covers each
//! 4-bit checksum nibble exactly once, every first-11-word prefix has exactly
//! one checksum-valid pool completion, so prefix ordinals map one-to-one onto
//! checksum-valid candidates: 16^5 = 2^20 prefixes.

use std::collections::BTreeMap;

use serde::Deserialize;

use crate::bip39;
use crate::error::{CrackerError, Result};

/// Subset of `wallets.json` this engine consumes (serde ignores the rest).
#[derive(Deserialize, Debug)]
pub struct WalletsFileJson {
    #[serde(rename = "pooled_demo_wallet")]
    pub pooled: PooledWalletJson,
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

/// The machine-readable `pool_config` block from the corpus document.
#[derive(Deserialize, Debug, Clone)]
pub struct PoolConfigJson {
    pub pool_words: Vec<String>,
    #[serde(rename = "variable_positions_1_indexed")]
    pub variable_positions: Vec<u8>,
    #[serde(rename = "fixed_words_1_indexed")]
    pub fixed_words: BTreeMap<String, String>,
}

/// Compiled pool search: which slots are fixed, the pool word indices, and the
/// passphrase. Enumeration is fully deterministic: mixed-radix over the varying
/// prefix positions (ascending position order, last varying position cycling
/// fastest), then the checksum filter over the 12th word.
#[derive(Debug, Clone)]
pub struct PoolSearch {
    /// Word index per position; `None` = variable (drawn from the pool).
    slots: [Option<u16>; 12],
    pool: Vec<u16>,
    passphrase: String,
}

fn bad_pool(msg: &'static str) -> CrackerError {
    CrackerError::BadPoolConfig(msg)
}

impl PoolSearch {
    pub fn from_config(config: &PoolConfigJson, passphrase: &str) -> Result<Self> {
        if config.pool_words.is_empty() {
            return Err(bad_pool("empty word pool"));
        }
        let mut slots: [Option<u16>; 12] = [None; 12];
        for (pos_str, word) in &config.fixed_words {
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
        for &p in &config.variable_positions {
            if !(1..=12).contains(&p) {
                return Err(bad_pool("variable position outside 1..=12"));
            }
            if slots[usize::from(p) - 1].is_some() {
                return Err(bad_pool("position marked both fixed and variable"));
            }
        }
        let fixed_count = slots.iter().filter(|s| s.is_some()).count();
        if fixed_count + config.variable_positions.len() != 12 {
            return Err(bad_pool(
                "fixed and variable positions must cover all 12 slots exactly once",
            ));
        }
        let mut pool = Vec::with_capacity(config.pool_words.len());
        for word in &config.pool_words {
            let idx = bip39::word_index(word)
                .ok_or_else(|| bad_pool("pool word not in BIP-39 wordlist"))?
                as u16;
            pool.push(idx);
        }
        pool.sort_unstable();
        pool.dedup();
        Ok(Self {
            slots,
            pool,
            passphrase: passphrase.to_string(),
        })
    }

    /// Positions (0-indexed) among the first 11 words that vary over the pool.
    /// The 12th word slot is the checksum-filtered completion.
    pub fn prefix_positions(&self) -> Vec<usize> {
        (0..11).filter(|&p| self.slots[p].is_none()).collect()
    }

    /// Distinct first-11-word prefixes: the product of the pool size over each
    /// varying prefix position (16^5 = 2^20 for the corpus pool).
    pub fn total_prefixes(&self) -> u64 {
        let mut total: u64 = 1;
        for _ in self.prefix_positions() {
            total = total.saturating_mul(self.pool.len() as u64);
        }
        total
    }

    /// Raw assemblies the corpus counts: every prefix x every pool word as the
    /// 12th word (16^6 = 2^24 for the corpus pool), before checksum filtering.
    pub fn raw_candidates(&self) -> u64 {
        self.total_prefixes().saturating_mul(self.pool.len() as u64)
    }

    /// Assemble the first 11 word indices for a prefix ordinal.
    pub fn assemble_prefix(&self, ordinal: u64) -> [u16; 11] {
        let mut digits = [0u16; 11];
        for (p, slot) in self.slots.iter().take(11).enumerate() {
            if let Some(idx) = slot {
                digits[p] = *idx;
            }
        }
        let radix = self.pool.len() as u64;
        let mut rem = ordinal;
        for &pos in self.prefix_positions().iter().rev() {
            digits[pos] = self.pool[(rem % radix) as usize];
            rem /= radix;
        }
        debug_assert_eq!(rem, 0, "prefix ordinal out of range");
        digits
    }

    /// Checksum-valid 12-word candidates for one prefix: the 12th word drawn
    /// from the pool, kept iff the BIP-39 checksum passes. Appends to the
    /// caller-reused buffer so hot loops do not allocate (doc section 9.3:
    /// the filter spares PBKDF2 for the 1-in-16 survivors).
    pub fn candidates_for_prefix(&self, prefix: &[u16; 11], out: &mut Vec<[u16; 12]>) {
        out.clear();
        for &twelfth in &self.pool {
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

    /// The checksum-valid candidate for a prefix ordinal, as a phrase string.
    /// Every prefix has exactly one pool completion that passes the checksum
    /// (the pool covers each checksum nibble exactly once), so this is the
    /// deterministic candidate the engine tests at `ordinal` — used for
    /// sampled live-view displays. `None` iff `ordinal >= total_prefixes()`
    /// or the (sub-2^-127) completion round-trips badly.
    pub fn candidate_at(&self, ordinal: u64) -> Option<String> {
        if ordinal >= self.total_prefixes() {
            return None;
        }
        let prefix = self.assemble_prefix(ordinal);
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

    #[test]
    fn corpus_space_dimensions_match_the_documented_contract() {
        let pool = corpus_pool();
        assert_eq!(pool.total_prefixes(), 1_048_576); // 16^5
        assert_eq!(pool.raw_candidates(), 16_777_216); // 16^6 = 2^24
        assert_eq!(pool.prefix_positions(), vec![1, 3, 5, 7, 9]);
        assert_eq!(pool.passphrase(), "");
    }

    #[test]
    fn rejects_broken_configs() {
        let doc: WalletsFileJson = serde_json::from_str(crate::WALLETS_JSON).unwrap();
        let mut cfg = doc.pooled.pool_config.clone();
        cfg.variable_positions.push(2); // collides with fixed position 2
        assert!(PoolSearch::from_config(&cfg, "").is_err());

        let mut cfg = doc.pooled.pool_config.clone();
        cfg.pool_words.push("notaword".into());
        assert!(PoolSearch::from_config(&cfg, "").is_err());

        let mut cfg = doc.pooled.pool_config.clone();
        cfg.variable_positions.clear(); // under-covers the 12 slots
        assert!(PoolSearch::from_config(&cfg, "").is_err());
    }

    #[test]
    fn prefix_ordinal_maps_to_documented_target_indices() {
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
        // the target prefix we can assert it exactly.
        let pool = corpus_pool();
        let prefix = pool.assemble_prefix(505_209);
        let mut candidates = Vec::new();
        pool.candidates_for_prefix(&prefix, &mut candidates);
        assert_eq!(candidates.len(), 1);
        let mnemonic = bip39::mnemonic_from_indices(&candidates[0]).unwrap();
        assert_eq!(
            mnemonic,
            "ocean abstract raven accident hill absent winter abstract candy abuse mango able"
        );
    }

    #[test]
    fn enumeration_is_deterministic() {
        let pool = corpus_pool();
        let mut pass1 = Vec::new();
        let mut pass2 = Vec::new();
        for o in 0..128u64 {
            let prefix = pool.assemble_prefix(o);
            pool.candidates_for_prefix(&prefix, &mut pass1);
            pool.candidates_for_prefix(&prefix, &mut pass2);
            assert_eq!(pass1, pass2, "prefix {o} enumerated differently");
        }
    }
}
