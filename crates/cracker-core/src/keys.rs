//! secp256k1 public keys, scalar arithmetic mod n, and small hash primitives.
//!
//! Scalar addition mod n is implemented on big-endian bytes (a + b, subtract n
//! when the sum reaches n); correctness is anchored end-to-end by every address
//! test vector, since CKDpriv adds scalars on every derivation step.

use k256::SecretKey;
use ripemd::Ripemd160;
use sha2::{Digest, Sha256};
use tiny_keccak::{Hasher, Keccak};

use crate::error::{CrackerError, Result};

/// secp256k1 group order n, big-endian bytes.
pub const SECP256K1_N: [u8; 32] = [
    0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFE,
    0xBA, 0xAE, 0xDC, 0xE6, 0xAF, 0x48, 0xA0, 0x3B, 0xBF, 0xD2, 0x5E, 0x8C, 0xD0, 0x36, 0x41, 0x41,
];

fn cmp_be(a: &[u8; 32], b: &[u8; 32]) -> std::cmp::Ordering {
    for i in 0..32 {
        match a[i].cmp(&b[i]) {
            std::cmp::Ordering::Equal => continue,
            other => return other,
        }
    }
    std::cmp::Ordering::Equal
}

/// A 32-byte big-endian scalar is a valid non-zero group element if 0 < v < n.
pub fn scalar_in_range(bytes: &[u8; 32]) -> bool {
    *bytes != [0u8; 32] && cmp_be(bytes, &SECP256K1_N) == std::cmp::Ordering::Less
}

/// (a + b) mod n over big-endian 256-bit scalars; errors if the result is zero
/// (BIP-32 invalid child) or if either input is out of range.
pub fn scalar_add_mod_n(a: &[u8; 32], b: &[u8; 32]) -> Result<[u8; 32]> {
    if !scalar_in_range(a) || !scalar_in_range(b) {
        return Err(CrackerError::InvalidScalar("addend out of range"));
    }
    // 256-bit big-endian add with a 257th carry bit.
    let mut sum = [0u8; 33];
    let mut carry = 0u16;
    for i in (0..32).rev() {
        let s = u16::from(a[i]) + u16::from(b[i]) + carry;
        sum[i + 1] = s as u8;
        carry = s >> 8;
    }
    sum[0] = carry as u8;
    // Reduce by n when the sum reached or passed it. When carry == 1 the low
    // 256 bits are < n (a, b < n implies a + b < 2n), so subtracting n from the
    // low bits is exact in both cases.
    let mut out = [0u8; 32];
    out.copy_from_slice(&sum[1..33]);
    let needs_reduce = carry == 1 || cmp_be(&out, &SECP256K1_N) != std::cmp::Ordering::Less;
    if needs_reduce {
        let mut borrow = 0i16;
        for i in (0..32).rev() {
            let d = i32::from(sum[i + 1]) - i32::from(SECP256K1_N[i]) - i32::from(borrow);
            out[i] = ((d + 256) & 0xff) as u8;
            borrow = i16::from(d < 0);
        }
        debug_assert_eq!(borrow, 0);
    }
    if out == [0u8; 32] {
        // BIP-32: k_i = 0 makes the child invalid.
        return Err(CrackerError::InvalidScalar("child key is zero"));
    }
    Ok(out)
}

fn public_key(priv_key: &[u8; 32]) -> Result<k256::PublicKey> {
    let sk = SecretKey::from_slice(priv_key)
        .map_err(|_| CrackerError::InvalidScalar("not a valid secp256k1 scalar"))?;
    Ok(sk.public_key())
}

/// 33-byte compressed public key `(0x02|0x03) || x` for a private key.
pub fn compressed_pubkey(priv_key: &[u8; 32]) -> Result<[u8; 33]> {
    let p = public_key(priv_key)?.to_encoded_point(true);
    let mut out = [0u8; 33];
    out.copy_from_slice(p.as_bytes());
    Ok(out)
}

/// 65-byte uncompressed public key `0x04 || x || y` for a private key.
pub fn uncompressed_pubkey(priv_key: &[u8; 32]) -> Result<[u8; 65]> {
    let p = public_key(priv_key)?.to_encoded_point(false);
    let mut out = [0u8; 65];
    out.copy_from_slice(p.as_bytes());
    debug_assert_eq!(out[0], 0x04);
    Ok(out)
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

/// Double SHA-256, the base58check checksum hash.
pub fn sha256d(data: &[u8]) -> [u8; 32] {
    sha256(&sha256(data))
}

/// RIPEMD160(SHA256(data)) - the Bitcoin "hash160" (doc section 6).
pub fn hash160(data: &[u8]) -> [u8; 20] {
    Ripemd160::digest(Sha256::digest(data)).into()
}

/// Keccak-256 with the original Keccak padding (domain byte 0x01) - the
/// Ethereum variant, NOT FIPS-202 SHA3-256 (doc section 5).
pub fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut keccak = Keccak::v256();
    let mut out = [0u8; 32];
    keccak.update(data);
    keccak.finalize(&mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keccak_matches_reference_prefixes() {
        // Doc section 11 anchors: keccak256("") = c5d246..5a470, keccak256("abc") = 4e0365..6c45.
        let empty = keccak256(b"");
        assert_eq!(empty[0..3], [0xc5, 0xd2, 0x46]);
        assert_eq!(empty[29..32], [0x5a, 0x47, 0x70]);
        let abc = keccak256(b"abc");
        assert_eq!(abc[0..3], [0x4e, 0x03, 0x65]);
        assert_eq!(abc[30..32], [0x6c, 0x45]);
    }

    #[test]
    fn scalar_add_wraps_below_n() {
        let one = {
            let mut v = [0u8; 32];
            v[31] = 1;
            v
        };
        let two = {
            let mut v = [0u8; 32];
            v[31] = 2;
            v
        };
        assert_eq!(scalar_add_mod_n(&one, &one).unwrap(), two);

        // (n - 1) + 1 = 0 -> invalid child.
        let n_minus_1 = {
            let mut v = SECP256K1_N;
            v[31] -= 1;
            v
        };
        assert!(matches!(
            scalar_add_mod_n(&n_minus_1, &one),
            Err(CrackerError::InvalidScalar("child key is zero"))
        ));

        // (n - 1) + (n - 1) = n - 2.
        let n_minus_2 = {
            let mut v = SECP256K1_N;
            v[31] -= 2;
            v
        };
        assert_eq!(scalar_add_mod_n(&n_minus_1, &n_minus_1).unwrap(), n_minus_2);
    }

    #[test]
    fn scalar_range_checks() {
        assert!(!scalar_in_range(&SECP256K1_N));
        assert!(!scalar_in_range(&[0u8; 32]));
        assert!(!scalar_in_range(&[0xffu8; 32]));
        let mut ok = [0u8; 32];
        ok[31] = 7;
        assert!(scalar_in_range(&ok));
    }

    #[test]
    fn hash160_of_generator_matches_bip173_example() {
        // Doc section 11 anchor: hash160(serP(G)) = 751e76e8..33bd6, whose bech32
        // encoding is bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4.
        let g_compressed = k256::ProjectivePoint::GENERATOR;
        let encoded = k256::PublicKey::from_affine(g_compressed.into())
            .unwrap()
            .to_encoded_point(true);
        let h = hash160(encoded.as_bytes());
        assert_eq!(hex::encode(h), "751e76e8199196d454941c45d1b3a323f1433bd6");
    }
}
