//! Target address parsing and validation (reference doc section 8).
//!
//! Malformed addresses fail decode here, before any search starts;
//! well-formed-but-wrong addresses parse fine and simply never match.

use crate::derive::PathKind;
use crate::encoding;
use crate::error::{CrackerError, Result};

/// A validated target address, normalized to its 20-byte payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetAddr {
    Eth([u8; 20]),
    P2pkh([u8; 20]),
    Bech32([u8; 20]),
}

impl TargetAddr {
    pub fn kind(&self) -> PathKind {
        match self {
            TargetAddr::Eth(_) => PathKind::Eth,
            TargetAddr::P2pkh(_) => PathKind::BtcP2pkh,
            TargetAddr::Bech32(_) => PathKind::BtcBech32,
        }
    }

    pub fn bytes(&self) -> [u8; 20] {
        match *self {
            TargetAddr::Eth(b) | TargetAddr::P2pkh(b) | TargetAddr::Bech32(b) => b,
        }
    }
}

/// Parse any supported mainnet address, dispatching on its form:
/// `0x…` (or exactly 40 hex chars) -> Ethereum, `bc1…` -> bech32, else base58check.
pub fn parse_target(s: &str) -> Result<TargetAddr> {
    let s = s.trim();
    let hex_part = s
        .strip_prefix("0x")
        .or_else(|| s.strip_prefix("0X"))
        .unwrap_or(s);
    let looks_hex = hex_part.len() == 40 && hex_part.bytes().all(|b| b.is_ascii_hexdigit());
    if (s.starts_with("0x") || s.starts_with("0X")) && looks_hex {
        Ok(TargetAddr::Eth(parse_eth_hex(hex_part)?))
    } else if looks_hex {
        // 40 hex chars cannot be a valid P2PKH (25 bytes base58-check encodes to
        // 26-35 chars), so treat as the doc's "optional 0x" Ethereum form.
        Ok(TargetAddr::Eth(parse_eth_hex(hex_part)?))
    } else if s.len() >= 4 && s[..3].eq_ignore_ascii_case("bc1") {
        let program = encoding::bech32_decode(s)?;
        let mut hash = [0u8; 20];
        hash.copy_from_slice(&program);
        Ok(TargetAddr::Bech32(hash))
    } else {
        Ok(TargetAddr::P2pkh(parse_base58_p2pkh(s)?))
    }
}

/// Ethereum address validation (doc section 8.1): 40 hex chars; uniform case
/// carries no checksum and is accepted; mixed case must re-encode to itself
/// under EIP-55.
fn parse_eth_hex(hex_part: &str) -> Result<[u8; 20]> {
    let mut addr = [0u8; 20];
    hex::decode_to_slice(hex_part, &mut addr)
        .map_err(|_| CrackerError::MalformedAddress("invalid hex in ethereum address"))?;
    let has_lower = hex_part.bytes().any(|b| b.is_ascii_lowercase());
    let has_upper = hex_part.bytes().any(|b| b.is_ascii_uppercase());
    if has_lower && has_upper {
        // EIP-55 verify: the mixed-case input must re-encode to itself exactly
        // (a single flipped case fails with 99.9753% probability - doc 8.1).
        let expected = encoding::eth_checksum_address(&addr);
        if &expected[2..] != hex_part {
            return Err(CrackerError::MalformedAddress("EIP-55 checksum mismatch"));
        }
    }
    Ok(addr)
}

/// Bitcoin P2PKH validation (doc section 8.2): base58 charset, 25 decoded
/// bytes, version 0x00, double-SHA256 checksum, canonical re-encoding.
fn parse_base58_p2pkh(s: &str) -> Result<[u8; 20]> {
    let payload = encoding::base58check_decode(s, encoding::P2PKH_VERSION, 20)?;
    let mut hash = [0u8; 20];
    hash.copy_from_slice(&payload);
    Ok(hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_all_doc_wellformed_examples() {
        // Well-formed but wrong addresses (doc section 8.4) MUST parse: they are
        // valid addresses that simply do not match.
        for good in [
            "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
            "0x9858effd232b4033e47d90003d41ec34ecaeda94", // uniform lower: no checksum
            "0x9858EFFD232B4033E47D90003D41EC34ECAEDA94", // uniform upper: no checksum
            "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA",
            "1JaUQDVNRdhfNsVncGkXedaPSM5Gc54Hso", // P2PKH of the segwit leaf
            "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
            "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g", // index-1 BIP-84 address
            "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
        ] {
            assert!(parse_target(good).is_ok(), "should parse: {good}");
        }
    }

    #[test]
    fn rejects_malformed_examples() {
        for bad in [
            "0x9858EfFD232B4033E47d90003D41EC34EcaEda9",  // 39 chars
            "0x9858EfFD232B4033E47d90003D41EC34EcaEda9g",  // non-hex char
            "0x9858EfFD232B4033E47d90003D41EC34EcaEda95",  // EIP-55 mismatch (flipped case)
            "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabB",          // base58check checksum failure
            "1OqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA",          // 'O' outside base58 alphabet
            "1lqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA",          // 'l' outside base58 alphabet
            "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5",  // bech32 checksum failure
            "tc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",  // wrong HRP
            "BC1QW508D6QEJXTDG4Y5R3ZARVARYV98GJ9P",        // v0 program length (+ mixed case)
            "bc1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4",  // mixed case bech32
            "bc1zw508d6qejxtdg4y5r3zarvaryv98gj9pqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq", // >90 chars
        ] {
            assert!(parse_target(bad).is_err(), "should reject: {bad}");
        }
    }

    #[test]
    fn parsed_kinds_round_trip_to_canonical_strings() {
        let t = parse_target("0x9858EfFD232B4033E47d90003D41EC34EcaEda94").unwrap();
        assert_eq!(t.kind(), PathKind::Eth);
        assert_eq!(
            PathKind::Eth.format_address(&t.bytes()),
            "0x9858EfFD232B4033E47d90003D41EC34EcaEda94"
        );

        let t = parse_target("1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA").unwrap();
        assert_eq!(t.kind(), PathKind::BtcP2pkh);
        assert_eq!(
            PathKind::BtcP2pkh.format_address(&t.bytes()),
            "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA"
        );

        let t = parse_target("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu").unwrap();
        assert_eq!(t.kind(), PathKind::BtcBech32);
        assert_eq!(
            PathKind::BtcBech32.format_address(&t.bytes()),
            "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"
        );
    }
}
