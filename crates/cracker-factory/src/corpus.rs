//! The bundled demo-wallet corpus is the only valid target set.
//!
//! Addresses come from the Demo Wallet Corpus document (five self-generated
//! throwaway wallets; see the project pin). The factory refuses any target
//! outside this list: the engine only searches the pooled demo space, so a
//! target from anywhere else could never be found and a run would be a lie.
//!
//! Note only the pooled wallet's addresses can ever match: the other four
//! wallets are corpus members the engine round-trips against, not members of
//! the pooled space.

use serde::Serialize;

/// (address, engine `--address-type`) for every address in the corpus.
pub const CORPUS_ADDRESSES: &[(&str, &str)] = &[
    // pooled-demo-wallet (findable in the pooled space)
    ("0xb79f8aC312fF21AD16980a857f574A6e7e3ED9c5", "eth"),
    ("16HxxyAQvA3AKThfcJGxSqKJ3Hs9RnTgHp", "btc-p2pkh"),
    ("bc1qnm5mmckh08leuwsygfre0ls0vp7vstdju0wm57", "btc-bech32"),
    // demo-wallet-1 .. demo-wallet-4 (not in the pooled space)
    ("0x262B24744833FF3c28e174A1b7A5094C3428008b", "eth"),
    ("1D9fQWfwJftkkUWdQpeW36KFwsRxPkTiPh", "btc-p2pkh"),
    ("bc1qm0es3luvytx7uy2jjr56g72s0ksfd74xz4ljky", "btc-bech32"),
    ("0xD2acD51AA504b93420C7B548d7Eb4290a00efCfe", "eth"),
    ("1CWbimoaQ5YJYYqL1dRXY3T6uMtycHYPYW", "btc-p2pkh"),
    ("bc1q92923rcn3vtudx30vtsq2u0s3c4847wc4dhund", "btc-bech32"),
    ("0xD055C56332307D71888E5fb59d8B0D4B204218D5", "eth"),
    ("1P7gttZQ4HB3pp4onJhrJBNki1CJytiZVa", "btc-p2pkh"),
    ("bc1qwtzdxd9gnd3fsqye5ykzedxq7g7u8hazq2rusy", "btc-bech32"),
    ("0x282084023B027395a70b30aa3bD6aB74DFEE4436", "eth"),
    ("17Etaqmozf5SCkGSU9oRsL891VDkFw2D3A", "btc-p2pkh"),
    ("bc1qk3l5skgjf4cdygy9m5u90qztqqztss4rck2f9", "btc-bech32"),
];

/// The engine's pooled-space constants (demo corpus). The factory plans with
/// these and asserts the engine's own `start` events agree at runtime.
pub const POOL_LEN_RAW: u64 = 16; // raw assemblies per prefix ordinal
pub const TOTAL_PREFIXES: u64 = 1_048_576; // 16^5 checksum-valid prefixes
pub const RAW_SPACE: u64 = 16_777_216; // 16^6 = 2^24 raw assemblies

/// Derivation path group an address type maps to (engine `--address-type`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum AddressKind {
    Eth,
    BtcP2pkh,
    BtcBech32,
}

impl AddressKind {
    pub fn engine_flag(self) -> &'static str {
        match self {
            AddressKind::Eth => "eth",
            AddressKind::BtcP2pkh => "btc-p2pkh",
            AddressKind::BtcBech32 => "btc-bech32",
        }
    }

    pub fn parse(flag: &str) -> Option<Self> {
        match flag {
            "eth" => Some(AddressKind::Eth),
            "btc-p2pkh" => Some(AddressKind::BtcP2pkh),
            "btc-bech32" => Some(AddressKind::BtcBech32),
            _ => None,
        }
    }
}

/// Canonical form for comparison (doc section 9.2): ETH lowercased, bech32
/// lowercased (BIP-173 accepts all-lower or all-upper input; mixed case is
/// invalid and has no canonical form), base58 as-is.
fn canonical(addr: &str) -> String {
    if let Some(rest) = addr.strip_prefix("0x") {
        return format!("0x{}", rest.to_lowercase());
    }
    let lower = addr.to_lowercase();
    if lower.starts_with("bc1") {
        let all_lower = addr
            .chars()
            .all(|c| !c.is_ascii_alphabetic() || c.is_ascii_lowercase());
        let all_upper = addr
            .chars()
            .all(|c| !c.is_ascii_alphabetic() || c.is_ascii_uppercase());
        if all_lower || all_upper {
            return lower;
        }
        // Mixed case: invalid per BIP-173; never matches a corpus entry.
        return addr.to_string();
    }
    addr.to_string()
}

/// Validate every target is in the bundled demo corpus and all targets share
/// one address type (the engine takes a single `--address-type` per run).
pub fn validate_targets(targets: &[String]) -> Result<AddressKind, String> {
    if targets.is_empty() {
        return Err("at least one --target is required".to_string());
    }
    let mut kind: Option<AddressKind> = None;
    for t in targets {
        let canon = canonical(t);
        let corpus_kind = CORPUS_ADDRESSES
            .iter()
            .filter(|(a, _)| canonical(a) == canon)
            .map(|(_, k)| *k)
            .next()
            .ok_or_else(|| {
                format!(
                    "target {t} is not in the bundled demo-wallet corpus; \
                     demo-wallets-only is binding - the pooled space can never contain any other wallet"
                )
            })?;
        let k = AddressKind::parse(corpus_kind)
            .ok_or_else(|| format!("corpus entry {t} has unknown kind {corpus_kind}"))?;
        match kind {
            None => kind = Some(k),
            Some(prev) if prev == k => {}
            Some(prev) => {
                return Err(format!(
                    "mixed target types ({:?} vs {:?}): the engine takes one --address-type per run; split the run",
                    prev, k
                ))
            }
        }
    }
    Ok(kind.unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pooled_wallet_targets_validate_to_their_kind() {
        let kind =
            validate_targets(&["0xb79f8aC312fF21AD16980a857f574A6e7e3ED9c5".to_string()]).unwrap();
        assert_eq!(kind, AddressKind::Eth);
        let kind = validate_targets(&["16HxxyAQvA3AKThfcJGxSqKJ3Hs9RnTgHp".to_string()]).unwrap();
        assert_eq!(kind, AddressKind::BtcP2pkh);
        // bech32 accepts case-insensitive canonicalization
        let kind =
            validate_targets(&["BC1QNM5MMCKH08LEUWSYGFRE0LS0VP7VSTDJU0WM57".to_string()]).unwrap();
        assert_eq!(kind, AddressKind::BtcBech32);
    }

    #[test]
    fn multi_target_same_kind_is_allowed() {
        let kind = validate_targets(&[
            "0xb79f8aC312fF21AD16980a857f574A6e7e3ED9c5".to_string(),
            "0x262B24744833FF3c28e174A1b7A5094C3428008b".to_string(),
        ])
        .unwrap();
        assert_eq!(kind, AddressKind::Eth);
    }

    #[test]
    fn foreign_targets_are_refused() {
        // Well-formed ETH address that is not in the corpus.
        let err = validate_targets(&["0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed".to_string()])
            .unwrap_err();
        assert!(err.contains("demo-wallets-only"), "{err}");
        // Garbage.
        assert!(validate_targets(&["not-an-address".to_string()]).is_err());
        assert!(validate_targets(&[]).is_err());
    }

    #[test]
    fn mixed_target_types_are_refused() {
        let err = validate_targets(&[
            "0xb79f8aC312fF21AD16980a857f574A6e7e3ED9c5".to_string(),
            "16HxxyAQvA3AKThfcJGxSqKJ3Hs9RnTgHp".to_string(),
        ])
        .unwrap_err();
        assert!(err.contains("mixed target types"), "{err}");
    }

    #[test]
    fn engine_space_constants_match_the_corpus_document() {
        assert_eq!(POOL_LEN_RAW, 16);
        assert_eq!(TOTAL_PREFIXES, 1_048_576); // 16^5
        assert_eq!(RAW_SPACE, 16_777_216); // 16^6 = 2^24
        assert_eq!(TOTAL_PREFIXES * POOL_LEN_RAW, RAW_SPACE);
    }
}
