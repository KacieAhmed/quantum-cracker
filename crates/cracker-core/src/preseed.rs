//! Pre-seed P2PK lottery: uniform random draws over the secp256k1 private-key
//! range, membership-tested against the Satoshi-era P2PK public-key watchlist.
//!
//! This is the mode for coins locked directly to a public key (script
//! `<pubkey> OP_CHECKSIG`), where the key sits on-chain in the clear — unlike
//! every hashed output type, which hides it until first spend. Per draw: pick
//! a random scalar k in [1, n) (n = the secp256k1 group order, 2^256 ≈
//! 1.16×10^77 at display precision), derive the public key by scalar
//! multiplication, canonicalize to compressed form, and test membership in an
//! in-memory set of the watchlist keys. A hit STOPS the run immediately and is
//! labeled a discovery — there is no user-supplied target in this mode, so a
//! watchlist hit is never presented as a requested-target recovery.
//!
//! Honesty anchors (mirroring the phrase lottery's discipline):
//! - The draw budget is a safety cap, never a coverage claim: any budget is a
//!   vanishing fraction of the space.
//! - The odds disclosure is computed from the MEASURED draw rate, never a
//!   hoped-for one.
//! - Watchlist integrity is load-bearing: a corrupted entry would silently
//!   skip a recoverable key. Loads verify the pinned SHA-256, curve-validate
//!   every key, dedupe to canonical points, and fail LOUDLY on any mismatch.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use k256::elliptic_curve::sec1::ToEncodedPoint;
use serde::Serialize;

use crate::encoding;
use crate::error::{CrackerError, Result};
use crate::keys;
use crate::traversal::{mix_u64, SplitMix64};

/// The secp256k1 group order n at f64 display precision (~1.16×10^77). Draws
/// are uniform over [1, n); n differs from 2^256 by less than any digit this
/// value shows, so the disclosure quotes the 2^256 ≈ 1.16×10^77 field width.
pub const SECP256K1_N_F: f64 = 1.157_920_892_373_162e77;

/// SHA-256 of the vendored watchlist asset (`api/assets/p2pk-watchlist.txt`)
/// over its canonical byte content: 102,813 LF-separated 130-char uncompressed
/// public keys with NO trailing newline (the findings report pins this hash;
/// the loader normalizes one optional trailing newline before hashing).
pub const ASSET_SHA256_HEX: &str =
    "2eb2157d7170af470dade8bf5814e916990f7e88f7b29689084de884374058f8";
/// Unique canonical (compressed) keys the production asset must contain.
pub const ASSET_UNIQUE_KEYS: usize = 102_813;
/// Watchlist keys attributed to the Patoshi-pattern miner (findings report),
/// quoted in the odds disclosure.
pub const ASSET_PATOSHI_KEYS: usize = 21_953;

/// The load-time integrity contract. Production passes the pinned asset hash
/// and unique-key count; tests with fixture watchlists pass `None` fields
/// (curve validation and dedupe still apply — only the asset-specific pins
/// are relaxed).
#[derive(Debug, Clone, Copy)]
pub struct WatchlistExpectation {
    /// SHA-256 (lowercase hex) the asset bytes must hash to, after stripping
    /// one optional trailing newline. `None` skips the hash pin (fixtures).
    pub sha256_hex: Option<&'static str>,
    /// Exact unique-key count the file must dedupe to. `None` skips the pin.
    pub unique_count: Option<usize>,
}

/// Production expectation: the vendored asset's pinned integrity contract.
pub const PRODUCTION_EXPECTATION: WatchlistExpectation = WatchlistExpectation {
    sha256_hex: Some(ASSET_SHA256_HEX),
    unique_count: Some(ASSET_UNIQUE_KEYS),
};

/// The Satoshi-era P2PK watchlist: canonical compressed (33-byte) public keys
/// in a hash set for O(1) per-draw membership tests.
#[derive(Debug, Clone)]
pub struct P2pkWatchlist {
    keys: HashSet<[u8; 33]>,
}

impl P2pkWatchlist {
    /// Load from raw asset bytes: SHA-256 gate first (a byte-level mismatch
    /// fails before any per-line work), then strict per-line parsing with
    /// curve validation, then the unique-count pin. Any mismatch fails the
    /// load LOUDLY — a corrupted entry would silently skip recoverable keys
    /// (the workbook-export corruption precedent, applied to 130-hex keys).
    pub fn load_bytes(raw: &[u8], expectation: &WatchlistExpectation) -> Result<Self> {
        let canonical = strip_one_trailing_newline(raw);
        if let Some(expected) = expectation.sha256_hex {
            let actual = hex::encode(keys::sha256(canonical));
            if !actual.eq_ignore_ascii_case(expected) {
                return Err(CrackerError::Other(format!(
                    "P2PK watchlist SHA-256 mismatch: expected {expected}, got {actual} — \
                     the asset is corrupted or swapped; refusing to run (a corrupted entry \
                     would silently skip recoverable keys)"
                )));
            }
        }
        let text = std::str::from_utf8(canonical)
            .map_err(|_| CrackerError::Other("P2PK watchlist is not valid UTF-8".to_string()))?;
        Self::load_text(text, expectation)
    }

    /// Load from the decoded text: one 65-byte uncompressed hex public key per
    /// line, blank lines and `#` comments skipped. Every key is curve-validated
    /// and canonicalized to compressed form; duplicates collapse into the same
    /// canonical point (one entry per point, never two for encodings).
    pub fn load_text(text: &str, expectation: &WatchlistExpectation) -> Result<Self> {
        let mut keys: HashSet<[u8; 33]> = HashSet::new();
        let mut duplicates = 0usize;
        for (idx, line) in text.lines().enumerate() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let key = parse_uncompressed_watchlist_line(line).map_err(|e| {
                CrackerError::Other(format!("P2PK watchlist line {}: {e}", idx + 1))
            })?;
            if !keys.insert(key) {
                duplicates += 1;
            }
        }
        if keys.is_empty() {
            return Err(CrackerError::Other(
                "P2PK watchlist is empty — refusing to run: the lottery would be a no-op \
                 disclosed as a real hunt"
                    .to_string(),
            ));
        }
        if let Some(expected) = expectation.unique_count {
            if keys.len() != expected {
                return Err(CrackerError::Other(format!(
                    "P2PK watchlist holds {} unique keys, expected {expected} — refusing to \
                     run (missing entries would silently skip recoverable keys; \
                     {duplicates} duplicate point(s) collapsed)",
                    keys.len()
                )));
            }
        }
        Ok(Self { keys })
    }

    pub fn len(&self) -> usize {
        self.keys.len()
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    /// Membership test in canonical compressed form — the exact encoding the
    /// per-draw hot loop derives.
    pub fn contains(&self, compressed: &[u8; 33]) -> bool {
        self.keys.contains(compressed)
    }

    /// Does the watchlist contain the genesis block's P2PK public key? A
    /// self-check the integration tests run against the real asset.
    pub fn contains_genesis_key(&self) -> bool {
        let genesis = GENESIS_P2PK_KEY_HEX;
        let Ok(raw) = hex::decode(genesis) else {
            return false;
        };
        let Ok(point) = k256::PublicKey::from_sec1_bytes(&raw) else {
            return false;
        };
        let compressed = point.to_encoded_point(true);
        let mut key = [0u8; 33];
        key.copy_from_slice(compressed.as_bytes());
        self.contains(&key)
    }
}

/// The genesis block's spendable P2PK public key (block 0 coinbase), the
/// end-to-end parser anchor from the findings report.
pub const GENESIS_P2PK_KEY_HEX: &str = "04678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5f";

fn strip_one_trailing_newline(mut raw: &[u8]) -> &[u8] {
    if raw.ends_with(b"\n") {
        raw = &raw[..raw.len() - 1];
    }
    if raw.ends_with(b"\r") {
        raw = &raw[..raw.len() - 1];
    }
    raw
}

/// Parse one watchlist line: exactly 130 hex chars, `04||x||y`, a valid
/// secp256k1 point. Returns the canonical compressed (33-byte) form.
fn parse_uncompressed_watchlist_line(line: &str) -> Result<[u8; 33]> {
    if line.len() != 130 {
        return Err(CrackerError::Other(format!(
            "expected a 130-char uncompressed public key (65-byte 04||x||y), found {} chars",
            line.len()
        )));
    }
    if !line.starts_with("04") {
        return Err(CrackerError::Other(
            "uncompressed keys start with the 04 prefix".to_string(),
        ));
    }
    let raw = hex::decode(line)?;
    let point = k256::PublicKey::from_sec1_bytes(&raw)
        .map_err(|_| CrackerError::Other("point is not on the secp256k1 curve".to_string()))?;
    let compressed = point.to_encoded_point(true);
    let mut out = [0u8; 33];
    out.copy_from_slice(compressed.as_bytes());
    Ok(out)
}

/// The scalar for draw index `draw`: 32 bytes from the run's deterministic
/// SplitMix64 stream (the same RNG discipline as the phrase lottery — pure in
/// `(seed, draw)`, so parallel sampling is replayable regardless of thread
/// scheduling), rejection-sampled into [1, n). The rejection loop almost
/// never fires: n exceeds 2^256 − 2^33, so a uniform 256-bit draw lands
/// outside [1, n) with probability ~4×10^-39. On rejection the stream
/// advances — never wraps.
pub fn draw_scalar(seed: u64, draw: u64) -> [u8; 32] {
    let mut rng = SplitMix64::new(seed ^ mix_u64(draw.wrapping_mul(0x9E37_79B9_7F4A_7C15)));
    loop {
        let mut bytes = [0u8; 32];
        for word in bytes.as_chunks_mut::<8>().0 {
            word.copy_from_slice(&rng.next_u64().to_be_bytes());
        }
        if keys::scalar_in_range(&bytes) {
            return bytes;
        }
    }
}

/// A hit, frozen at the moment of discovery: the full key material plus the
/// derived addresses, everything a reader needs to verify the hit externally.
#[derive(Debug, Clone, Serialize)]
pub struct PreSeedDiscovery {
    /// The drawn private key, 64-hex (the discovery's core material).
    pub private_key_hex: String,
    /// The same key as WIF (mainnet 0x80 version, compressed-marker 0x01).
    pub wif: String,
    /// Derived public key, compressed (66 hex) — the membership-test form.
    pub pubkey_compressed_hex: String,
    /// Derived public key, uncompressed (130 hex) — the era's on-chain form.
    pub pubkey_uncompressed_hex: String,
    /// The watchlist entry that matched, canonical compressed hex.
    pub matched_watchlist_key: String,
    /// Legacy P2PKH address from the compressed pubkey encoding.
    pub address_p2pkh_compressed: String,
    /// Legacy P2PKH address from the uncompressed pubkey encoding.
    pub address_p2pkh_uncompressed: String,
    /// Cross-check against the rich-address watchlist: either derived P2PKH
    /// address appearing there upgrades the discovery's label.
    pub rich_watchlist_hit: bool,
}

/// Build the discovery payload for one drawn scalar — the ONLY path a
/// discovery claim may rest on. `None` when the derived compressed key is not
/// on the watchlist (the per-draw common case).
pub fn discovery_for_scalar(
    k: &[u8; 32],
    watchlist: &P2pkWatchlist,
    rich_addresses: &HashSet<[u8; 20]>,
) -> Option<PreSeedDiscovery> {
    let compressed = keys::compressed_pubkey(k).ok()?;
    if !watchlist.contains(&compressed) {
        return None;
    }
    let uncompressed = keys::uncompressed_pubkey(k).ok()?;
    let hash_compressed = keys::hash160(&compressed);
    let hash_uncompressed = keys::hash160(&uncompressed);
    let p2pkh = |hash: [u8; 20]| encoding::base58check_encode(encoding::P2PKH_VERSION, &hash);
    Some(PreSeedDiscovery {
        private_key_hex: hex::encode(k),
        wif: encoding::wif_encode(k, true),
        pubkey_compressed_hex: hex::encode(compressed),
        pubkey_uncompressed_hex: hex::encode(uncompressed),
        matched_watchlist_key: hex::encode(compressed),
        address_p2pkh_compressed: p2pkh(hash_compressed),
        address_p2pkh_uncompressed: p2pkh(hash_uncompressed),
        rich_watchlist_hit: rich_addresses.contains(&hash_compressed)
            || rich_addresses.contains(&hash_uncompressed),
    })
}

/// Lock-free progress counters (the other searchers' shape, draw-centric).
#[derive(Debug, Default)]
pub struct PreSeedProgress {
    /// Random scalars drawn and tested.
    pub draws: AtomicU64,
    pub matches: AtomicU64,
    /// Most recent drawn candidate's compressed pubkey hex, for the sampled
    /// "what is being tried right now" display (short-held mutex).
    pub last_pubkey: Mutex<Option<String>>,
}

pub struct PreSeedConfig {
    /// The era watchlist — the lottery's whole target set.
    pub watchlist: P2pkWatchlist,
    /// Rich-address watchlist for the discovery label upgrade (either derived
    /// P2PKH address appearing there upgrades the label).
    pub rich_addresses: HashSet<[u8; 20]>,
}

/// One pre-seed lottery searcher. `stop` is shared; with `stop_on_match` the
/// first genuine watchlist hit halts sampling.
pub struct PreSeedSearcher {
    pub config: Arc<PreSeedConfig>,
    pub progress: Arc<PreSeedProgress>,
    pub stop: Arc<AtomicBool>,
    stop_on_match: bool,
    matches: Mutex<Vec<PreSeedDiscovery>>,
}

impl PreSeedSearcher {
    pub fn new(config: PreSeedConfig, stop_on_match: bool) -> Self {
        Self {
            config: Arc::new(config),
            progress: Arc::default(),
            stop: Arc::default(),
            stop_on_match,
            matches: Mutex::new(Vec::new()),
        }
    }

    /// Sample exactly `budget` draws (the run's safety cap); returns
    /// discoveries found by this call. `stop` ends early. There is
    /// deliberately no "exhausted" outcome: the budget is a vanishing
    /// fraction of 2^256.
    pub fn run(&self, budget: u64, seed: u64) -> Vec<PreSeedDiscovery> {
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
            self.test_draw(draw_scalar(seed, draw));
        }
    }

    /// Hot loop body: one scalar -> one public key -> one set lookup. The
    /// scalar multiplication dominates; everything here is O(1) per draw.
    fn test_draw(&self, k: [u8; 32]) {
        self.progress.draws.fetch_add(1, Ordering::Relaxed);
        let compressed = match keys::compressed_pubkey(&k) {
            Ok(c) => c,
            // Unreachable: draw_scalar is in [1, n), a valid scalar.
            Err(_) => return,
        };
        *self
            .progress
            .last_pubkey
            .lock()
            .expect("last_pubkey mutex poisoned") = Some(hex::encode(compressed));
        if !self.config.watchlist.contains(&compressed) {
            return;
        }
        // HIT: freeze the run and build the full payload. The hit is a
        // discovery by construction — there is no user target in this mode.
        if let Some(d) =
            discovery_for_scalar(&k, &self.config.watchlist, &self.config.rich_addresses)
        {
            self.matches.lock().expect("matches mutex poisoned").push(d);
            self.progress.matches.fetch_add(1, Ordering::Relaxed);
            if self.stop_on_match {
                self.stop.store(true, Ordering::Relaxed);
            }
        }
    }

    pub fn take_matches(&self) -> Vec<PreSeedDiscovery> {
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

    fn one() -> [u8; 32] {
        let mut k = [0u8; 32];
        k[31] = 1;
        k
    }

    fn empty_rich() -> HashSet<[u8; 20]> {
        HashSet::new()
    }

    fn fixture_watchlist(uncompressed_keys: &[&str]) -> P2pkWatchlist {
        let text = uncompressed_keys.join("\n");
        P2pkWatchlist::load_text(
            &text,
            &WatchlistExpectation {
                sha256_hex: None,
                unique_count: None,
            },
        )
        .expect("fixture watchlist loads")
    }

    #[test]
    fn k1_derives_the_generator_compressed() {
        let g = keys::compressed_pubkey(&one()).unwrap();
        assert_eq!(
            hex::encode(g),
            "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
        );
        // The uncompressed form carries the same point, 04-prefixed.
        let u = keys::uncompressed_pubkey(&one()).unwrap();
        assert_eq!(
            hex::encode(u),
            format!(
                "04{}{}",
                &hex::encode(g)[2..],
                "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8"
            )
        );
    }

    #[test]
    fn k2_derives_the_known_successor() {
        // 2G, computed independently by pure-Python point arithmetic before
        // pinning (double the generator, y-parity even).
        let two = {
            let mut k = [0u8; 32];
            k[31] = 2;
            k
        };
        assert_eq!(
            hex::encode(keys::compressed_pubkey(&two).unwrap()),
            "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"
        );
    }

    #[test]
    fn k1_discovers_against_a_watchlist_containing_g() {
        let g_uncompressed = "0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";
        let watchlist = fixture_watchlist(&[g_uncompressed]);
        let d = discovery_for_scalar(&one(), &watchlist, &empty_rich())
            .expect("k=1 must discover against a watchlist containing G");
        assert_eq!(
            d.private_key_hex,
            "0000000000000000000000000000000000000000000000000000000000000001"
        );
        assert_eq!(
            d.pubkey_compressed_hex,
            "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
        );
        assert_eq!(d.matched_watchlist_key, d.pubkey_compressed_hex);
        assert_eq!(
            d.pubkey_uncompressed_hex, g_uncompressed,
            "the uncompressed rendering round-trips the fixture entry"
        );
        // The legacy P2PKH addresses exist and differ by encoding (hash160 of
        // the two encodings differs, so the addresses differ).
        assert_ne!(d.address_p2pkh_compressed, d.address_p2pkh_uncompressed);
        assert!(d.address_p2pkh_compressed.starts_with('1'));
        assert!(!d.rich_watchlist_hit);
        // WIF: mainnet compressed-pubkey form (version 0x80 + 0x01 marker).
        assert!(d.wif.starts_with('K') || d.wif.starts_with('L'));
    }

    #[test]
    fn k2_stays_undiscovered_when_only_g_is_listed() {
        let g_uncompressed = "0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";
        let watchlist = fixture_watchlist(&[g_uncompressed]);
        let two = {
            let mut k = [0u8; 32];
            k[31] = 2;
            k
        };
        assert!(discovery_for_scalar(&two, &watchlist, &empty_rich()).is_none());
    }

    #[test]
    fn rich_address_cross_check_upgrades_the_label() {
        // The discovery's compressed-encoding P2PKH address, planted in the
        // rich-address set, must flip rich_watchlist_hit.
        let g_uncompressed = "0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";
        let watchlist = fixture_watchlist(&[g_uncompressed]);
        assert!(
            discovery_for_scalar(&one(), &watchlist, &empty_rich()).is_some(),
            "the base discovery exists before the upgrade check"
        );
        let mut addr = [0u8; 20];
        addr.copy_from_slice(&keys::hash160(&keys::compressed_pubkey(&one()).unwrap()));
        let mut rich = HashSet::new();
        rich.insert(addr);
        let upgraded = discovery_for_scalar(&one(), &watchlist, &rich).unwrap();
        assert!(upgraded.rich_watchlist_hit);
    }

    #[test]
    fn draw_stream_is_deterministic_seed_separated_and_in_range() {
        let a: Vec<[u8; 32]> = (0..256).map(|d| draw_scalar(0xC0FFEE, d)).collect();
        let b: Vec<[u8; 32]> = (0..256).map(|d| draw_scalar(0xC0FFEE, d)).collect();
        assert_eq!(a, b, "same seed must replay the same draw stream");
        let c: Vec<[u8; 32]> = (0..256).map(|d| draw_scalar(0xBAD_F00D, d)).collect();
        assert_ne!(a, c, "different seeds must not reproduce the draws");
        for k in &a {
            assert!(keys::scalar_in_range(k), "every draw is in [1, n)");
        }
    }

    #[test]
    fn search_run_stops_on_the_planted_hit_and_freezes() {
        // Same planted-draw discipline as the phrase sampler: plant the pubkey
        // of the stream's draw #3, then check both sides — a budget covering
        // that draw discovers; one draw short claims nothing.
        let seed = 0x501A;
        let planted = draw_scalar(seed, 3);
        let planted_compressed = keys::compressed_pubkey(&planted).unwrap();
        let planted_uncompressed = keys::uncompressed_pubkey(&planted).unwrap();
        // A watchlist file holding exactly the planted point in its
        // uncompressed on-chain rendering (the asset's line format).
        let watchlist = P2pkWatchlist::load_text(
            &hex::encode(planted_uncompressed),
            &WatchlistExpectation {
                sha256_hex: None,
                unique_count: None,
            },
        )
        .unwrap();
        let short = PreSeedSearcher::new(
            PreSeedConfig {
                watchlist: watchlist.clone(),
                rich_addresses: empty_rich(),
            },
            true,
        );
        assert!(short.run(3, seed).is_empty(), "draws 0..3 must not hit");
        assert!(!short.stop.load(Ordering::Relaxed));

        let covering = PreSeedSearcher::new(
            PreSeedConfig {
                watchlist,
                rich_addresses: empty_rich(),
            },
            true,
        );
        let hits = covering.run(4, seed);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].private_key_hex, hex::encode(planted));
        assert_eq!(
            hits[0].pubkey_compressed_hex,
            hex::encode(planted_compressed)
        );
        assert_eq!(
            hits[0].pubkey_uncompressed_hex,
            hex::encode(planted_uncompressed)
        );
        assert!(
            covering.stop.load(Ordering::Relaxed),
            "a discovery freezes the engine exactly like a target match"
        );
        assert_eq!(covering.progress.draws.load(Ordering::Relaxed), 4);
    }

    #[test]
    fn watchlist_loader_enforces_sha_count_and_curve() {
        let genesis = GENESIS_P2PK_KEY_HEX;
        let text = format!("{genesis}\n");

        // Wrong hash fails LOUDLY, naming both digests.
        let err = P2pkWatchlist::load_bytes(
            text.as_bytes(),
            &WatchlistExpectation {
                sha256_hex: Some("0000"),
                unique_count: None,
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("SHA-256 mismatch"), "{err}");

        // The correct hash (over the exact bytes, no trailing newline) loads.
        let canonical = text.trim_end(); // the fixture IS one line + \n
        let hash = hex::encode(keys::sha256(canonical.as_bytes()));
        let ok = P2pkWatchlist::load_bytes(
            text.as_bytes(),
            &WatchlistExpectation {
                sha256_hex: Some(Box::leak(hash.clone().into_boxed_str())),
                unique_count: None,
            },
        )
        .expect("matching hash loads");
        assert_eq!(ok.len(), 1);
        assert!(ok.contains_genesis_key());

        // A count pin mismatch fails loudly with the collapsed-duplicate note.
        let err = P2pkWatchlist::load_text(
            &format!("{genesis}\n{genesis}\n"),
            &WatchlistExpectation {
                sha256_hex: None,
                unique_count: Some(2),
            },
        )
        .unwrap_err();
        assert!(
            err.to_string().contains("unique keys, expected 2"),
            "count pin failure must name the counts: {err}"
        );
        assert!(err.to_string().contains("duplicate"));

        // An off-curve point fails with the line number (curve-validation
        // rejection: 130 hex chars, 04-prefixed, not on the curve).
        let off_curve = format!("04{}", "00".repeat(64));
        let err = P2pkWatchlist::load_text(
            &format!("{genesis}\n{off_curve}\n"),
            &WatchlistExpectation {
                sha256_hex: None,
                unique_count: None,
            },
        )
        .unwrap_err();
        assert!(
            err.to_string().contains("line 2") && err.to_string().contains("curve"),
            "{err}"
        );

        // Malformed lines fail: wrong length, wrong prefix, non-hex.
        for bad in [
            "04678afdb0",                      // wrong length
            &format!("05{}", &genesis[2..]),   // wrong prefix
            &format!("04{}", "zz".repeat(64)), // non-hex
        ] {
            let err = P2pkWatchlist::load_text(
                bad,
                &WatchlistExpectation {
                    sha256_hex: None,
                    unique_count: None,
                },
            )
            .unwrap_err();
            assert!(!err.to_string().is_empty());
        }

        // A trailing newline (added by editors/exports) does not change the
        // canonical hash: a multi-key file ending in exactly one \n verifies
        // against the pin computed over the same bytes sans that newline.
        // TWO trailing newlines are a substantive byte difference and must
        // still fail loudly (only ONE optional trailing newline is
        // normalized — the asset-export quirk this tolerates).
        let generator = "0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";
        let multi = format!("{genesis}\n{generator}\n");
        let multi_canonical = multi.trim_end();
        let multi_hash = hex::encode(keys::sha256(multi_canonical.as_bytes()));
        let loaded = P2pkWatchlist::load_bytes(
            multi.as_bytes(),
            &WatchlistExpectation {
                sha256_hex: Some(Box::leak(multi_hash.clone().into_boxed_str())),
                unique_count: None,
            },
        )
        .expect("one trailing newline is normalized before hashing");
        assert_eq!(loaded.len(), 2);
        let err = P2pkWatchlist::load_bytes(
            format!("{multi}\n").as_bytes(),
            &WatchlistExpectation {
                sha256_hex: Some(Box::leak(multi_hash.into_boxed_str())),
                unique_count: None,
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("SHA-256 mismatch"), "{err}");
    }
}
