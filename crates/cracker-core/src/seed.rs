//! BIP-39 mnemonic to 512-bit seed: PBKDF2-HMAC-SHA512, 2048 iterations,
//! salt `"mnemonic" + passphrase` (reference doc section 2.3).

use pbkdf2::pbkdf2_hmac_array;
use sha2::Sha512;

/// BIP-39 fixed iteration count.
pub const PBKDF2_ROUNDS: u32 = 2048;

/// Derive the 512-bit BIP-39 seed. An empty passphrase yields salt `"mnemonic"`
/// exactly. Every candidate pays this full cost - there is no shortcut
/// (reference doc section 9.3).
pub fn mnemonic_to_seed(mnemonic: &str, passphrase: &str) -> [u8; 64] {
    let mut salt = String::with_capacity(8 + passphrase.len());
    salt.push_str("mnemonic");
    salt.push_str(passphrase);
    let mut seed = [0u8; 64];
    pbkdf2::pbkdf2_hmac::<Sha512>(
        mnemonic.as_bytes(),
        salt.as_bytes(),
        PBKDF2_ROUNDS,
        &mut seed,
    );
    seed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_published_trezor_vector() {
        // bip39.json entry 0 (entropy all-zero, passphrase "TREZOR").
        let seed = mnemonic_to_seed(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
            "TREZOR",
        );
        assert_eq!(
            hex::encode(seed),
            "c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04"
        );
    }

    #[test]
    fn matches_empty_passphrase_demo_seed() {
        let seed = mnemonic_to_seed(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
            "",
        );
        assert_eq!(
            hex::encode(seed),
            "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4"
        );
    }
}
