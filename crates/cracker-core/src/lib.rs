//! Classical cracker engine for BIP-39 seed phrases.
//!
//! Pipeline per candidate (see the "Wallet Cryptography - Derivation and
//! Validation" reference, sections cited inline):
//!
//! ```text
//! mnemonic -> PBKDF2-HMAC-SHA512 (2048 iters, salt "mnemonic"+passphrase) -> 512-bit seed
//!          -> BIP-32 master key (HMAC-SHA512, "Bitcoin seed")
//!          -> CKDpriv x5 along m/44'/60'/0'/0/0 (ETH), m/44'/0'/0'/0/0 (BTC P2PKH),
//!             m/84'/0'/0'/0/0 (BTC P2WPKH)
//!          -> ETH: keccak256(x||y)[-20:] with EIP-55 casing
//!             BTC: hash160 -> base58check (P2PKH) or bech32 (P2WPKH)
//!          -> exact byte equality against the target (doc section 9.2)
//! ```
//!
//! Candidate enumeration is specialized to the pooled search space of the demo
//! wallet corpus: fixed words at chosen positions, a word pool elsewhere
//! (16^6 = 2^24 raw assemblies, 2^20 checksum-valid candidates).
//!
//! Every intermediate value is anchored against the published test vectors in
//! `test-vectors/` (see the integration tests).

#![forbid(unsafe_code)]

pub mod bip32;
pub mod bip39;
pub mod derive;
pub mod encoding;
pub mod engine;
pub mod error;
pub mod keys;
pub mod pool;
pub mod sampler;
pub mod seed;
pub mod traversal;
pub mod validate;

pub use derive::{derive_addresses, derive_leaf, DerivedAddresses, PathKind};
pub use engine::{Match, Progress, SearchConfig, Searcher, Target};
pub use error::{CrackerError, Result};
pub use pool::{PoolConfigJson, PoolSearch};
pub use sampler::{LotteryConfig, LotteryProgress, LotterySearcher};
pub use validate::TargetAddr;

/// Embedded machine-readable BIP-39 test vectors (24 published entries plus
/// computed 160/224-bit entries and the empty-passphrase demo anchor).
pub const BIP39_VECTORS_JSON: &str = include_str!("../test-vectors/bip39.json");

/// Embedded demo wallet corpus (4 random wallets + the pooled 2^24-space target).
/// The CLI uses this as its built-in default search space.
pub const WALLETS_JSON: &str = include_str!("../test-vectors/wallets.json");

/// Official BIP-39 English wordlist (2048 words, sorted), from bitcoin/bips.
pub const ENGLISH_WORDLIST: &str = include_str!("../test-vectors/english.txt");
