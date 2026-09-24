//! BIP-32 hierarchical derivation: master key from seed, CKDpriv steps, and
//! xprv/xpub serialization (reference doc section 3).

use hmac::{Hmac, Mac};
use sha2::Sha512;

use crate::error::{CrackerError, Result};
use crate::keys;

/// Hardened derivation offset: index i' means i + 2^31 (doc section 3.2).
pub const HARDENED_OFFSET: u32 = 0x8000_0000;

const BITCOIN_SEED_KEY: &[u8] = b"Bitcoin seed";
const XPRV_VERSION: u32 = 0x0488_ADE4;
const XPUB_VERSION: u32 = 0x0488_B21E;

type HmacSha512 = Hmac<Sha512>;

/// Extended private key: 32-byte secret key plus 32-byte chain code.
#[derive(Clone, Copy, Debug)]
pub struct ExtKey {
    pub key: [u8; 32],
    pub chain_code: [u8; 32],
}

fn hmac512(key: &[u8], data: &[u8]) -> [u8; 64] {
    let mut mac = HmacSha512::new_from_slice(key).expect("HMAC accepts keys of any length");
    mac.update(data);
    let mut out = [0u8; 64];
    out.copy_from_slice(&mac.finalize().into_bytes());
    out
}

/// BIP-32 master key: `I = HMAC-SHA512("Bitcoin seed", seed)`; `IL` is the key,
/// `IR` the chain code (doc section 3.1). Errors on the (measure-zero) invalid
/// case `IL = 0` or `IL >= n`.
pub fn master_key(seed: &[u8; 64]) -> Result<ExtKey> {
    let out = hmac512(BITCOIN_SEED_KEY, seed);
    let mut key = [0u8; 32];
    key.copy_from_slice(&out[..32]);
    let mut chain_code = [0u8; 32];
    chain_code.copy_from_slice(&out[32..]);
    if !keys::scalar_in_range(&key) {
        return Err(CrackerError::InvalidKey(
            "master IL is zero or >= secp256k1 n",
        ));
    }
    Ok(ExtKey { key, chain_code })
}

/// Child derivation with a hardened index (`i >= 2^31`): HMAC data is
/// `0x00 || ser256(k_par) || ser32(i)` (doc section 3.3).
pub fn ckd_hardened(parent: &ExtKey, index: u32) -> Result<ExtKey> {
    debug_assert!(index >= HARDENED_OFFSET);
    let mut data = [0u8; 37];
    data[1..33].copy_from_slice(&parent.key);
    data[33..37].copy_from_slice(&index.to_be_bytes());
    let out = hmac512(&parent.chain_code, &data);
    child_from_il_ir(parent, &out)
}

/// Child derivation with a non-hardened index: HMAC data is
/// `serP(point(k_par)) || ser32(i)` - the parent *public* key (doc section 3.3).
pub fn ckd_normal(parent: &ExtKey, index: u32) -> Result<ExtKey> {
    debug_assert!(index < HARDENED_OFFSET);
    let pubkey = keys::compressed_pubkey(&parent.key)?;
    let mut data = [0u8; 37];
    data[..33].copy_from_slice(&pubkey);
    data[33..37].copy_from_slice(&index.to_be_bytes());
    let out = hmac512(&parent.chain_code, &data);
    child_from_il_ir(parent, &out)
}

fn child_from_il_ir(parent: &ExtKey, out: &[u8; 64]) -> Result<ExtKey> {
    let mut il = [0u8; 32];
    il.copy_from_slice(&out[..32]);
    let mut chain_code = [0u8; 32];
    chain_code.copy_from_slice(&out[32..]);
    if !keys::scalar_in_range(&il) {
        // BIP-32: parse256(IL) >= n makes the child invalid (probability < 2^-127).
        return Err(CrackerError::InvalidKey("child IL >= n"));
    }
    // k_i = (parse256(IL) + k_par) mod n; errors if the sum is zero.
    let key = keys::scalar_add_mod_n(&il, &parent.key)?;
    Ok(ExtKey { key, chain_code })
}

/// Walk `path` (each element already offset by `HARDENED_OFFSET` when hardened)
/// down from an extended key.
pub fn derive_path(root: &ExtKey, path: &[u32]) -> Result<ExtKey> {
    let mut current = *root;
    for &index in path {
        current = if index >= HARDENED_OFFSET {
            ckd_hardened(&current, index)?
        } else {
            ckd_normal(&current, index)?
        };
    }
    Ok(current)
}

fn extended_key_string(
    version: u32,
    depth: u8,
    parent_fingerprint: [u8; 4],
    child_number: u32,
    chain_code: &[u8; 32],
    key_data: &[u8; 33],
) -> String {
    let mut payload = Vec::with_capacity(78 + 4);
    payload.extend_from_slice(&version.to_be_bytes());
    payload.push(depth);
    payload.extend_from_slice(&parent_fingerprint);
    payload.extend_from_slice(&child_number.to_be_bytes());
    payload.extend_from_slice(chain_code);
    payload.extend_from_slice(key_data);
    let checksum = keys::sha256d(&payload);
    payload.extend_from_slice(&checksum[..4]);
    bs58::encode(payload).into_string()
}

/// Master xprv (`xprv9s21...`): depth 0, zero fingerprint and child number.
pub fn master_xprv(master: &ExtKey) -> String {
    let mut key_data = [0u8; 33];
    key_data[1..].copy_from_slice(&master.key);
    extended_key_string(XPRV_VERSION, 0, [0; 4], 0, &master.chain_code, &key_data)
}

/// Master xpub (`xpub661...`): the compressed public key of the master key.
pub fn master_xpub(master: &ExtKey) -> Result<String> {
    let pubkey = keys::compressed_pubkey(&master.key)?;
    Ok(extended_key_string(
        XPUB_VERSION,
        0,
        [0; 4],
        0,
        &master.chain_code,
        &pubkey,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::seed::mnemonic_to_seed;

    fn master_of(mnemonic: &str, passphrase: &str) -> ExtKey {
        master_key(&mnemonic_to_seed(mnemonic, passphrase)).unwrap()
    }

    #[test]
    fn famous_wallet_master_xprv_xpub() {
        // Empty-passphrase "abandon..about" anchors from the BIP-39 vectors doc.
        let master = master_of(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
            "",
        );
        assert_eq!(
            master_xprv(&master),
            "xprv9s21ZrQH143K3GJpoapnV8SFfukcVBSfeCficPSGfubmSFDxo1kuHnLisriDvSnRRuL2Qrg5ggqHKNVpxR86QEC8w35uxmGoggxtQTPvfUu"
        );
        assert_eq!(
            master_xpub(&master).unwrap(),
            "xpub661MyMwAqRbcFkPHucMnrGNzDwb6teAX1RbKQmqtEF8kK3Z7LZ59qafCjB9eCRLiTVG3uxBxgKvRgbubRhqSKXnGGb1aoaqLrpMBDrVxga8"
        );
    }

    #[test]
    fn trezor_passphrase_master_xprv() {
        let master = master_of(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
            "TREZOR",
        );
        assert_eq!(
            master_xprv(&master),
            "xprv9s21ZrQH143K3h3fDYiay8mocZ3afhfULfb5GX8kCBdno77K4HiA15Tg23wpbeF1pLfs1c5SPmYHrEpTuuRhxMwvKDwqdKiGJS9XFKzUsAF"
        );
    }
}
