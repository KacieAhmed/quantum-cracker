//! End-to-end derivation: mnemonic -> chain addresses (reference doc
//! sections 4-7). Three fixed paths:
//!
//! - ETH       m/44'/60'/0'/0/0  keccak-based 20-byte address (EIP-55 casing)
//! - BTC P2PKH m/44'/0'/0'/0/0   base58check, version 0x00
//! - BTC P2WPKH m/84'/0'/0'/0/0  bech32, HRP "bc", witness version 0

use serde::{Deserialize, Serialize};

use crate::bip32::{self, ExtKey, HARDENED_OFFSET};
use crate::encoding;
use crate::error::Result;
use crate::keys;
use crate::seed::mnemonic_to_seed;

/// Which derivation path(s) to run per candidate.
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PathKind {
    Eth,
    BtcP2pkh,
    BtcBech32,
}

impl PathKind {
    /// The five BIP-32 indices for this path (hardened levels pre-offset).
    pub fn path(self) -> [u32; 5] {
        let h = HARDENED_OFFSET;
        match self {
            PathKind::Eth => [h | 44, h | 60, h, 0, 0],
            PathKind::BtcP2pkh => [h | 44, h, h, 0, 0],
            PathKind::BtcBech32 => [h | 84, h, h, 0, 0],
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            PathKind::Eth => "eth",
            PathKind::BtcP2pkh => "btc-p2pkh",
            PathKind::BtcBech32 => "btc-bech32",
        }
    }

    /// The canonical BIP-32 path string this kind derives along — the exact
    /// path surfaced in match events and external-verification recipes.
    pub fn bip32_path(self) -> &'static str {
        match self {
            PathKind::Eth => "m/44'/60'/0'/0/0",
            PathKind::BtcP2pkh => "m/44'/0'/0'/0/0",
            PathKind::BtcBech32 => "m/84'/0'/0'/0/0",
        }
    }

    /// Canonical string form of a 20-byte address of this kind (doc section
    /// 9.2: compare canonical forms by exact equality).
    pub fn format_address(self, bytes: &[u8; 20]) -> String {
        match self {
            PathKind::Eth => encoding::eth_checksum_address(bytes),
            PathKind::BtcP2pkh => encoding::base58check_encode(encoding::P2PKH_VERSION, bytes),
            PathKind::BtcBech32 => encoding::bech32_encode(encoding::BECH32_HRP, 0, bytes),
        }
    }
}

/// Derived 20-byte address payloads for the requested paths.
#[derive(Debug, Clone, Copy, Default)]
pub struct DerivedAddresses {
    pub eth: Option<[u8; 20]>,
    pub btc_p2pkh: Option<[u8; 20]>,
    pub btc_bech32: Option<[u8; 20]>,
}

/// Derive the leaf extended key for one path (seed -> master -> 5 CKD steps).
pub fn derive_leaf(mnemonic: &str, passphrase: &str, kind: PathKind) -> Result<ExtKey> {
    let seed = mnemonic_to_seed(mnemonic, passphrase);
    let master = bip32::master_key(&seed)?;
    bip32::derive_path(&master, &kind.path())
}

/// Derive the requested addresses for a mnemonic (one PBKDF2 pass, then the
/// paths on the shared master key).
pub fn derive_addresses(
    mnemonic: &str,
    passphrase: &str,
    kinds: &[PathKind],
) -> Result<DerivedAddresses> {
    let seed = mnemonic_to_seed(mnemonic, passphrase);
    let master = bip32::master_key(&seed)?;
    let mut out = DerivedAddresses::default();
    for &kind in kinds {
        let leaf = bip32::derive_path(&master, &kind.path())?;
        match kind {
            PathKind::Eth => out.eth = Some(eth_address_bytes(&leaf)?),
            PathKind::BtcP2pkh => out.btc_p2pkh = Some(btc_hash160_bytes(&leaf)?),
            PathKind::BtcBech32 => out.btc_bech32 = Some(btc_hash160_bytes(&leaf)?),
        }
    }
    Ok(out)
}

/// Ethereum address bytes: keccak256 of the 64-byte `x || y` (uncompressed
/// pubkey minus its 0x04 prefix), last 20 bytes (doc section 5).
pub fn eth_address_bytes(leaf: &ExtKey) -> Result<[u8; 20]> {
    let uncompressed = keys::uncompressed_pubkey(&leaf.key)?;
    let digest = keys::keccak256(&uncompressed[1..65]);
    let mut addr = [0u8; 20];
    addr.copy_from_slice(&digest[12..32]);
    Ok(addr)
}

/// Bitcoin hash160 of the compressed public key (doc section 6).
pub fn btc_hash160_bytes(leaf: &ExtKey) -> Result<[u8; 20]> {
    Ok(keys::hash160(&keys::compressed_pubkey(&leaf.key)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FAMOUS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    #[test]
    fn famous_wallet_all_three_addresses() {
        // Doc section 7.7 summary anchors (empty passphrase).
        let d = derive_addresses(
            FAMOUS,
            "",
            &[PathKind::Eth, PathKind::BtcP2pkh, PathKind::BtcBech32],
        )
        .unwrap();
        let eth = d.eth.unwrap();
        assert_eq!(
            PathKind::Eth.format_address(&eth),
            "0x9858EfFD232B4033E47d90003D41EC34EcaEda94"
        );
        let p2pkh = d.btc_p2pkh.unwrap();
        assert_eq!(
            PathKind::BtcP2pkh.format_address(&p2pkh),
            "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA"
        );
        let bech32 = d.btc_bech32.unwrap();
        assert_eq!(
            PathKind::BtcBech32.format_address(&bech32),
            "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"
        );
    }

    #[test]
    fn famous_wallet_leaf_private_keys_and_wif() {
        let eth_leaf = derive_leaf(FAMOUS, "", PathKind::Eth).unwrap();
        assert_eq!(
            hex::encode(eth_leaf.key),
            "1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727"
        );
        let btc_leaf = derive_leaf(FAMOUS, "", PathKind::BtcP2pkh).unwrap();
        assert_eq!(
            encoding::wif_encode(&btc_leaf.key, true),
            "L4p2b9VAf8k5aUahF1JCJUzZkgNEAqLfq8DDdQiyAprQAKSbu8hf"
        );
    }

    #[test]
    fn bip32_path_strings_match_the_derivation_indices() {
        // The displayed path string must be the path the engine actually
        // walks: parse it back and compare against PathKind::path().
        for kind in [PathKind::Eth, PathKind::BtcP2pkh, PathKind::BtcBech32] {
            let parsed: Vec<u32> = kind
                .bip32_path()
                .split('/')
                .skip(1)
                .map(|step| {
                    let hardened = step.ends_with('\'');
                    let idx: u32 = step.trim_end_matches('\'').parse().unwrap();
                    if hardened {
                        idx | HARDENED_OFFSET
                    } else {
                        idx
                    }
                })
                .collect();
            assert_eq!(parsed, kind.path(), "path string for {kind:?}");
        }
    }

    #[test]
    fn index_one_differs_from_index_zero() {
        // Doc section 7.4: index 1 on the ETH path is a different, valid address.
        let seed = mnemonic_to_seed(FAMOUS, "");
        let master = bip32::master_key(&seed).unwrap();
        let leaf = bip32::derive_path(
            &master,
            &[
                HARDENED_OFFSET | 44,
                HARDENED_OFFSET | 60,
                HARDENED_OFFSET,
                0,
                1,
            ],
        )
        .unwrap();
        let addr = PathKind::Eth.format_address(&eth_address_bytes(&leaf).unwrap());
        assert_eq!(addr, "0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0");
        assert_ne!(addr, "0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
    }
}
