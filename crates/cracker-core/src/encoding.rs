//! Address encodings: EIP-55 mixed-case checksum, base58check, bech32
//! (BIP-173), and WIF (reference doc sections 5.1, 6, 8).

use crate::error::{CrackerError, Result};
use crate::keys;

/// P2PKH mainnet version byte: addresses start with `1` (doc section 6.1).
pub const P2PKH_VERSION: u8 = 0x00;
/// WIF version byte (doc section 6.1).
pub const WIF_VERSION: u8 = 0x80;
/// Bech32 human-readable part for Bitcoin mainnet (doc section 6.2).
pub const BECH32_HRP: &str = "bc";

/// EIP-55 mixed-case rendering of a 20-byte Ethereum address (doc section 5.1):
/// keccak-256 of the lowercase hex string decides per-letter casing.
pub fn eth_checksum_address(addr: &[u8; 20]) -> String {
    let lower = hex::encode(addr);
    let digest = keys::keccak256(lower.as_bytes());
    let mut out = String::with_capacity(42);
    out.push_str("0x");
    for (i, c) in lower.bytes().enumerate() {
        let nibble = if i % 2 == 0 {
            digest[i / 2] >> 4
        } else {
            digest[i / 2] & 0x0f
        };
        if c.is_ascii_digit() || nibble < 8 {
            out.push(c as char);
        } else {
            out.push(c.to_ascii_uppercase() as char);
        }
    }
    out
}

/// base58check: version byte, payload, first 4 bytes of SHA256(SHA256(...))
/// appended, then base-58 (doc section 6.1).
pub fn base58check_encode(version: u8, payload: &[u8]) -> String {
    let mut buf = Vec::with_capacity(payload.len() + 5);
    buf.push(version);
    buf.extend_from_slice(payload);
    let checksum = keys::sha256d(&buf);
    buf.extend_from_slice(&checksum[..4]);
    bs58::encode(buf).into_string()
}

/// Decode and fully validate a base58check string for an expected version:
/// length limit, checksum, version byte, and canonical re-encoding (doc
/// section 8.2). Returns the payload without version or checksum.
pub fn base58check_decode(s: &str, expected_version: u8, payload_len: usize) -> Result<Vec<u8>> {
    let raw = bs58::decode(s)
        .into_vec()
        .map_err(|_| CrackerError::MalformedAddress("not valid base58"))?;
    if raw.len() != 1 + payload_len + 4 {
        return Err(CrackerError::MalformedAddress(
            "decoded length is not version+payload+4-byte checksum",
        ));
    }
    let (payload_with_version, checksum) = raw.split_at(raw.len() - 4);
    let digest = keys::sha256d(payload_with_version);
    if digest[..4] != checksum[..] {
        return Err(CrackerError::MalformedAddress(
            "base58check checksum mismatch",
        ));
    }
    if payload_with_version[0] != expected_version {
        return Err(CrackerError::MalformedAddress("unsupported version byte"));
    }
    if base58check_encode(expected_version, &payload_with_version[1..]) != s {
        return Err(CrackerError::MalformedAddress(
            "non-canonical base58 encoding",
        ));
    }
    Ok(payload_with_version[1..].to_vec())
}

const BECH32_CHARSET: &[u8; 32] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/// BIP-173 polymod, verbatim from the reference implementation (doc section 11).
fn bech32_polymod(values: &[u8]) -> u32 {
    const GEN: [u32; 5] = [
        0x3b6a_57b2,
        0x2650_8e6d,
        0x1ea1_19fa,
        0x3d42_33dd,
        0x2a14_62b3,
    ];
    let mut chk: u32 = 1;
    for value in values {
        let b = chk >> 25;
        chk = ((chk & 0x1ff_ffff) << 5) ^ u32::from(*value);
        for (i, g) in GEN.iter().enumerate() {
            if (b >> i) & 1 == 1 {
                chk ^= g;
            }
        }
    }
    chk
}

fn bech32_hrp_expand(hrp: &str) -> Vec<u8> {
    hrp.bytes()
        .map(|b| b >> 5)
        .chain(std::iter::once(0))
        .chain(hrp.bytes().map(|b| b & 31))
        .collect()
}

/// 8-to-5-bit regrouping per BIP-173's convertbits (with padding for encoding).
fn convert_bits(data: &[u8], from: u32, to: u32, pad: bool) -> Option<Vec<u8>> {
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    let mut out = Vec::new();
    let maxv = (1u32 << to) - 1;
    for &value in data {
        let v = u32::from(value);
        if v >> from != 0 {
            return None;
        }
        acc = (acc << from) | v;
        bits += from;
        while bits >= to {
            bits -= to;
            out.push(((acc >> bits) & maxv) as u8);
        }
    }
    if pad {
        if bits > 0 {
            out.push(((acc << (to - bits)) & maxv) as u8);
        }
    } else if bits >= from || ((acc << (to - bits)) & maxv) != 0 {
        return None;
    }
    Some(out)
}

/// Bech32 encode a segwit address: witness version + 5-bit groups of the
/// witness program, BIP-173 checksum, lowercase output (doc section 6.2).
pub fn bech32_encode(hrp: &str, witness_version: u8, program: &[u8]) -> String {
    let mut data = convert_bits(program, 8, 5, true).expect("8-bit input always converts");
    data.insert(0, witness_version);
    let mut values = bech32_hrp_expand(hrp);
    values.extend_from_slice(&data);
    values.extend_from_slice(&[0; 6]);
    let chk = bech32_polymod(&values) ^ 1;
    let mut out = String::with_capacity(hrp.len() + 1 + data.len() + 6);
    out.push_str(hrp);
    out.push('1');
    for &v in &data {
        out.push(BECH32_CHARSET[usize::from(v)] as char);
    }
    for i in 0..6 {
        out.push(BECH32_CHARSET[(((chk >> (5 * (5 - i))) & 31) as usize)] as char);
    }
    out
}

fn bech32_char_value(c: u8) -> Option<u8> {
    BECH32_CHARSET.iter().position(|&x| x == c).map(|p| p as u8)
}

/// Validate a bech32 segwit address per BIP-173 decoding rules (doc section
/// 8.3) and return the witness program. Only mainnet `bc` HRP and witness
/// version 0 are accepted here.
pub fn bech32_decode(s: &str) -> Result<Vec<u8>> {
    if s.len() > 90 {
        return Err(CrackerError::MalformedAddress(
            "bech32 string exceeds 90 chars",
        ));
    }
    let has_lower = s.bytes().any(|b| b.is_ascii_lowercase());
    let has_upper = s.bytes().any(|b| b.is_ascii_uppercase());
    if has_lower && has_upper {
        return Err(CrackerError::MalformedAddress("bech32 mixed case"));
    }
    let lower = s.to_ascii_lowercase();
    let (hrp, data_str) = lower.split_once('1').ok_or(CrackerError::MalformedAddress(
        "bech32 missing '1' separator",
    ))?;
    if hrp != BECH32_HRP {
        return Err(CrackerError::MalformedAddress("unsupported bech32 HRP"));
    }
    let mut values = Vec::with_capacity(data_str.len());
    for c in data_str.bytes() {
        values.push(bech32_char_value(c).ok_or(CrackerError::MalformedAddress(
            "character outside bech32 charset",
        ))?);
    }
    let mut full = bech32_hrp_expand(hrp);
    full.extend_from_slice(&values);
    if bech32_polymod(&full) != 1 {
        return Err(CrackerError::MalformedAddress("bech32 checksum failure"));
    }
    let witness_version = values[0];
    if witness_version > 16 {
        return Err(CrackerError::MalformedAddress(
            "witness version out of range",
        ));
    }
    let program = convert_bits(&values[1..], 5, 8, false).ok_or(CrackerError::MalformedAddress(
        "invalid witness program padding",
    ))?;
    if witness_version == 0 && program.len() != 20 && program.len() != 32 {
        return Err(CrackerError::MalformedAddress(
            "version-0 witness program must be 20 or 32 bytes",
        ));
    }
    if witness_version != 0 {
        return Err(CrackerError::MalformedAddress(
            "only witness version 0 (P2WPKH/P2WSH) is supported",
        ));
    }
    if program.len() != 20 {
        return Err(CrackerError::MalformedAddress(
            "32-byte v0 program is P2WSH; this engine matches P2WPKH (20-byte) only",
        ));
    }
    Ok(program)
}

/// WIF private key (mainnet `0x80` version; `0x01` suffix marks a
/// compressed-pubkey wallet - doc section 6.1).
pub fn wif_encode(priv_key: &[u8; 32], compressed: bool) -> String {
    let mut payload = Vec::with_capacity(33);
    payload.extend_from_slice(priv_key);
    if compressed {
        payload.push(0x01);
    }
    base58check_encode(WIF_VERSION, &payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eip55_matches_doc_examples() {
        // Mixed-case examples quoted in the reference doc (section 5.1).
        let a = [
            hex::decode("5aaeb6053f3e94c9b9a09f33669435e7ef1beaed").unwrap(),
            hex::decode("fb6916095ca1df60bb79ce92ce3ea74c37c5d359").unwrap(),
        ];
        assert_eq!(
            eth_checksum_address(a[0].as_slice().try_into().unwrap()),
            "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"
        );
        assert_eq!(
            eth_checksum_address(a[1].as_slice().try_into().unwrap()),
            "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359"
        );
    }

    #[test]
    fn bech32_generator_anchor() {
        // hash160(serP(G)) = 751e76e8..33bd6 -> BIP-173 example address.
        let program = hex::decode("751e76e8199196d454941c45d1b3a323f1433bd6").unwrap();
        assert_eq!(
            bech32_encode("bc", 0, &program),
            "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"
        );
        assert_eq!(
            bech32_decode("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4").unwrap(),
            program
        );
    }

    #[test]
    fn bech32_rejects_malformed_doc_examples() {
        // Doc section 8.3/8.4 malformed examples.
        assert!(bech32_decode("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5").is_err()); // checksum
        assert!(bech32_decode("tc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4").is_err()); // wrong HRP
        assert!(bech32_decode("BC1QW508D6QEJXTDG4Y5R3ZARVARYV98GJ9P").is_err());
        // program length
    }
}
