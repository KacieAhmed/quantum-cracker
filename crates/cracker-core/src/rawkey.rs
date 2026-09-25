//! Raw private-key own-wallet proofs: parse a 64-hex scalar or a mainnet WIF,
//! derive every supported address directly from the scalar, and freeze the
//! full derivation chain as a proof payload (reference doc sections 5, 6.1,
//! 7.5, 8.4, 9).
//!
//! This is the pre-BIP-39 half of the own-wallet flow: holders of wallets
//! from before deterministic seed phrases hold a raw private key, and the
//! proof answers exactly one question — what does THIS key derive to? A raw
//! key IS the leaf: there is no BIP-32 tree and no path, so the derivation
//! runs scalar -> public key -> addresses with nothing in between.
//!
//! There is no search, no budget, and no consent gate — the user already
//! holds the key, and the derivation is the same engine math a search runs
//! per candidate. Nothing is exposed by proving it.
//!
//! Match discipline (doc section 9.2): the expected address, when supplied,
//! is compared by exact byte equality against each derived address in its
//! canonical form. Malformed expectations are rejected at parse time (doc
//! section 8.4 — malformed fails decode); a well-formed address the key does
//! not derive is an honest no-match, reported with the full derivation chain
//! (well-formed-but-wrong fails compare).

use serde::Serialize;

use crate::encoding::{self, P2PKH_VERSION, WIF_VERSION};
use crate::error::{CrackerError, Result};
use crate::keys;
use crate::validate::{parse_target, TargetAddr};

/// How the user entered the key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RawKeyForm {
    /// Raw 64-hex scalar (0x prefix tolerated).
    Hex,
    /// Mainnet WIF (wallet-import format).
    Wif,
}

/// Which of the key's derived addresses the expected address equaled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MatchedPath {
    /// keccak-256(x‖y)[-20:], EIP-55 rendered (doc section 5).
    Eth,
    /// base58check(hash160(compressed pubkey), version 0x00) (doc section 6.1).
    BtcP2pkhCompressed,
    /// base58check(hash160(uncompressed pubkey), version 0x00).
    BtcP2pkhUncompressed,
}

impl MatchedPath {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Eth => "eth",
            Self::BtcP2pkhCompressed => "btc-p2pkh-compressed",
            Self::BtcP2pkhUncompressed => "btc-p2pkh-uncompressed",
        }
    }
}

/// A parsed key: the in-range scalar plus how it was entered.
#[derive(Debug, Clone)]
pub struct RawPrivateKey {
    pub scalar: [u8; 32],
    pub form: RawKeyForm,
    /// The WIF string as entered (None for hex input).
    pub input_wif: Option<String>,
}

/// A WIF-decoded key: the scalar plus the compression flag the encoding
/// carried. The flag decides the WIF's canonical re-encoding — it is an
/// encoding property, not a key property.
#[derive(Debug, Clone)]
pub struct WifKey {
    pub scalar: [u8; 32],
    pub compressed: bool,
}

/// The full derivation chain, frozen — every intermediate a reader needs to
/// verify the result externally (the proof card renders this 1:1).
#[derive(Debug, Clone, Serialize)]
pub struct RawKeyProof {
    /// How the key was entered.
    pub input_form: RawKeyForm,
    /// The WIF as entered (None when the input was raw hex).
    pub input_wif: Option<String>,
    /// Canonical WIF renderings of the same scalar. The compression flag is
    /// part of the WIF encoding, not the key, so both always exist.
    pub wif_compressed: String,
    pub wif_uncompressed: String,
    /// 64-hex scalar (32 bytes, big-endian).
    pub private_key_hex: String,
    /// k·G — 66-hex compressed and 130-hex uncompressed encodings.
    pub pubkey_compressed_hex: String,
    pub pubkey_uncompressed_hex: String,
    /// keccak-256(x‖y)[-20:], EIP-55 cased (doc section 5).
    pub address_eth: String,
    /// base58check P2PKH from the compressed pubkey encoding (doc section 6.1).
    pub address_p2pkh_compressed: String,
    /// base58check P2PKH from the uncompressed pubkey encoding.
    pub address_p2pkh_uncompressed: String,
    /// The user's expected address, canonicalized (None when not supplied).
    pub expected_address: Option<String>,
    /// Which derived address the expected address equaled (None = no match).
    pub matched_path: Option<MatchedPath>,
}

fn invalid(reason: String) -> CrackerError {
    CrackerError::Other(format!("invalid private key: {reason}"))
}

fn hex_body_len(body: &str) -> usize {
    body.chars().count()
}

/// Reject scalars outside [1, n) with precise messages: the zero scalar and
/// values at or beyond the secp256k1 group order are unusable keys.
fn require_in_range(scalar: &[u8; 32]) -> Result<()> {
    if *scalar == [0u8; 32] {
        return Err(invalid(
            "the zero scalar is not a usable secp256k1 key".to_string(),
        ));
    }
    if !keys::scalar_in_range(scalar) {
        return Err(invalid(
            "scalar is out of range — secp256k1 keys must lie in [1, n), \
             below the group order n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFE\
             BAAEDCE6AF48A03BBFD25E8CD0364141"
                .to_string(),
        ));
    }
    Ok(())
}

/// Parse a private key in either accepted form (doc section 8.4 discipline:
/// malformed input fails decode with a precise message):
/// - raw scalar: exactly 64 hex digits, optional `0x`/`0X` prefix
/// - mainnet WIF: base58check, version 0x80, 32- or 33-byte payload
///
/// Dispatch rule: an explicit 0x prefix always means hex; otherwise a body
/// that is exactly 64 hex digits means hex, and anything else is WIF (so a
/// WIF-typo error speaks about WIF, and a hex-typo error about hex).
pub fn parse_private_key(input: &str) -> Result<RawPrivateKey> {
    let trimmed = input.trim();
    let hex_body = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .unwrap_or(trimmed);
    let prefixed = hex_body.len() != trimmed.len();
    if prefixed || (hex_body.len() == 64 && hex_body.bytes().all(|b| b.is_ascii_hexdigit())) {
        if hex_body.len() != 64 {
            return Err(invalid(format!(
                "raw scalar must be exactly 64 hex characters (32 bytes, optional 0x prefix), found {} hex characters",
                hex_body_len(hex_body)
            )));
        }
        if !hex_body.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(invalid(
                "raw scalar must be hex digits — the input contains a non-hex character"
                    .to_string(),
            ));
        }
        let mut scalar = [0u8; 32];
        scalar.copy_from_slice(&hex::decode(hex_body)?);
        require_in_range(&scalar)?;
        return Ok(RawPrivateKey {
            scalar,
            form: RawKeyForm::Hex,
            input_wif: None,
        });
    }
    let wif = wif_decode(trimmed)?;
    Ok(RawPrivateKey {
        scalar: wif.scalar,
        form: RawKeyForm::Wif,
        input_wif: Some(trimmed.to_string()),
    })
}

/// Decode a mainnet WIF with WIF-precise errors, checked in the reference
/// doc's order (section 8.2): charset, length, checksum, version, flag byte.
pub fn wif_decode(s: &str) -> Result<WifKey> {
    let raw = bs58::decode(s).into_vec().map_err(|_| {
        invalid(
            "WIF contains characters outside the base-58 alphabet \
             (0, O, I and l are never used)"
                .to_string(),
        )
    })?;
    if raw.len() != 37 && raw.len() != 38 {
        return Err(invalid(format!(
            "WIF decodes to {} bytes — a mainnet WIF is a 0x80 version byte, \
             a 32-byte key, an optional 0x01 compressed marker, and a 4-byte \
             checksum (51 or 52 base-58 characters)",
            raw.len()
        )));
    }
    let (payload_with_version, checksum) = raw.split_at(raw.len() - 4);
    let digest = keys::sha256d(payload_with_version);
    if digest[..4] != checksum[..] {
        return Err(invalid(
            "WIF base-58 checksum mismatch — the string was mistyped or truncated".to_string(),
        ));
    }
    if payload_with_version[0] != WIF_VERSION {
        return Err(invalid(format!(
            "WIF version byte 0x{:02X} is not mainnet (0x80) — this tool proves mainnet keys",
            payload_with_version[0]
        )));
    }
    let payload = &payload_with_version[1..];
    let compressed = match payload.len() {
        32 => false,
        33 => {
            if payload[32] != 0x01 {
                return Err(invalid(
                    "WIF's 33-byte payload must end in the 0x01 compressed-key marker".to_string(),
                ));
            }
            true
        }
        _ => unreachable!("payload length gated above"),
    };
    let mut scalar = [0u8; 32];
    scalar.copy_from_slice(&payload[..32]);
    require_in_range(&scalar)?;
    // Canonical re-encoding (doc section 8.2): the decoded key must re-encode
    // to the exact string it came from — this catches altered-leading-zero
    // hand-edits that no checksum was designed to catch.
    if encoding::wif_encode(&scalar, compressed) != s {
        return Err(invalid(
            "WIF is not in canonical base-58 form (re-encoding it produces a different string)"
                .to_string(),
        ));
    }
    Ok(WifKey { scalar, compressed })
}

/// Canonical display for a parsed expected address: EIP-55 for Ethereum, the
/// base58 string re-encoded from its bytes for P2PKH (base58 is case-sensitive),
/// bech32 re-encoded for native segwit.
fn canonical_expected(target: &TargetAddr) -> String {
    target.kind().format_address(&target.bytes())
}

/// Derive the full chain for one key and build the proof. `expected` (the
/// user's "my wallet shows this address" cross-check) is optional; when
/// supplied it must decode (malformed → error) and is compared by exact
/// bytes against each derived address (doc section 9.2).
pub fn raw_key_proof(key: &RawPrivateKey, expected: Option<&str>) -> Result<RawKeyProof> {
    let scalar = &key.scalar;
    let compressed = keys::compressed_pubkey(scalar)?;
    let uncompressed = keys::uncompressed_pubkey(scalar)?;

    // ETH (doc section 5): keccak-256 over the 64 bytes of x‖y — the
    // uncompressed encoding minus its 04 prefix — last 20 bytes, EIP-55.
    let eth_bytes: [u8; 20] = keys::keccak256(&uncompressed[1..65])[12..32]
        .try_into()
        .expect("20-byte tail of a 32-byte digest");

    // BTC P2PKH (doc section 6.1): hash160 of each pubkey encoding.
    let hash_compressed = keys::hash160(&compressed);
    let hash_uncompressed = keys::hash160(&uncompressed);
    let p2pkh = |hash: [u8; 20]| encoding::base58check_encode(P2PKH_VERSION, &hash);

    let (expected_address, matched_path) = match expected.map(str::trim).filter(|s| !s.is_empty()) {
        None => (None, None),
        Some(addr) => {
            let target = parse_target(addr)?;
            // Native-segwit bech32 is not among the raw-key derivations: a
            // bech32 expectation is well-formed and simply cannot match — the
            // honest answer is a no-match, and the proof shows exactly what
            // the key does derive to.
            let matched = match &target {
                TargetAddr::Eth(bytes) => *bytes == eth_bytes,
                TargetAddr::P2pkh(bytes) => {
                    *bytes == hash_compressed || *bytes == hash_uncompressed
                }
                TargetAddr::Bech32(_) => false,
            };
            let matched_path = if matched {
                match target {
                    TargetAddr::Eth(_) => Some(MatchedPath::Eth),
                    TargetAddr::P2pkh(bytes) => {
                        if bytes == hash_compressed {
                            Some(MatchedPath::BtcP2pkhCompressed)
                        } else {
                            Some(MatchedPath::BtcP2pkhUncompressed)
                        }
                    }
                    TargetAddr::Bech32(_) => None,
                }
            } else {
                None
            };
            (Some(canonical_expected(&target)), matched_path)
        }
    };

    Ok(RawKeyProof {
        input_form: key.form,
        input_wif: key.input_wif.clone(),
        wif_compressed: encoding::wif_encode(scalar, true),
        wif_uncompressed: encoding::wif_encode(scalar, false),
        private_key_hex: hex::encode(scalar),
        pubkey_compressed_hex: hex::encode(compressed),
        pubkey_uncompressed_hex: hex::encode(uncompressed),
        address_eth: encoding::eth_checksum_address(&eth_bytes),
        address_p2pkh_compressed: p2pkh(hash_compressed),
        address_p2pkh_uncompressed: p2pkh(hash_uncompressed),
        expected_address,
        matched_path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const G_COMPRESSED: &str = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    const G_UNCOMPRESSED: &str = "0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";
    const WIF_K1_COMPRESSED: &str = "KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn";
    const WIF_K1_UNCOMPRESSED: &str = "5HpHagT65TZzG1PH3CSu63k8DbpvD8s5ip4nEB3kEsreAnchuDf";

    fn one() -> [u8; 32] {
        let mut k = [0u8; 32];
        k[31] = 1;
        k
    }

    fn hex_key(hex: &str) -> RawPrivateKey {
        parse_private_key(hex).expect("test key parses")
    }

    /// Reference doc section 7.5 anchor key (compressed-pubkey P2PKH vector).
    const DOC_KEY_HEX: &str = "e284129cc0922579a535bbf4d1a3b25773090d28c909bc0fed73b5e0222cc372";
    /// Reference doc section 7.4 anchor key (Ethereum/EIP-55 vector).
    const DOC_ETH_KEY_HEX: &str =
        "1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727";
    /// The scalar 1 in the 64-hex form (prefixed and bare).
    const HEX_ONE: &str = "0000000000000000000000000000000000000000000000000000000000000001";

    #[test]
    fn k1_derives_the_generator_in_both_encodings() {
        let proof = raw_key_proof(
            &RawPrivateKey {
                scalar: one(),
                form: RawKeyForm::Hex,
                input_wif: None,
            },
            None,
        )
        .unwrap();
        assert_eq!(proof.pubkey_compressed_hex, G_COMPRESSED);
        assert_eq!(proof.pubkey_uncompressed_hex, G_UNCOMPRESSED);
        assert_eq!(
            proof.private_key_hex,
            "0000000000000000000000000000000000000000000000000000000000000001"
        );
    }

    #[test]
    fn k1_p2pkh_addresses_match_published_vectors() {
        // Independently computed (pure-Python point arithmetic + base58check)
        // before pinning, then cross-checked against published k=1 results.
        let proof = raw_key_proof(&hex_key(HEX_ONE), None).unwrap();
        assert_eq!(
            proof.address_p2pkh_compressed,
            "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH"
        );
        assert_eq!(
            proof.address_p2pkh_uncompressed,
            "1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm"
        );
        // Both start with 1 (version byte 0x00) and differ across encodings.
        assert_ne!(
            proof.address_p2pkh_compressed,
            proof.address_p2pkh_uncompressed
        );
    }

    #[test]
    fn doc_p2pkh_anchor_key_derives_the_pinned_address_compressed() {
        // Doc section 7.5: compressed pubkey 03aaeb52… and P2PKH
        // 1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA are the pinned anchors.
        let proof = raw_key_proof(&hex_key(DOC_KEY_HEX), None).unwrap();
        assert_eq!(
            proof.pubkey_compressed_hex,
            "03aaeb52dd7494c361049de67cc680e83ebcbbbdbeb13637d92cd845f70308af5e"
        );
        assert_eq!(
            proof.address_p2pkh_compressed,
            "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA"
        );
        // The uncompressed encoding of the same point (computed independently
        // before pinning) and its P2PKH address.
        assert_eq!(
            proof.pubkey_uncompressed_hex,
            "04aaeb52dd7494c361049de67cc680e83ebcbbbdbeb13637d92cd845f70308af5e9370164133294e5fd1679672fe7866c307daf97281a28f66dca7cbb52919824f"
        );
        assert_eq!(
            proof.address_p2pkh_uncompressed,
            "18LhnLKXjcTw5xJFiTxntnKit2Gd63eWFm"
        );
    }

    #[test]
    fn doc_eth_anchor_key_derives_the_eip55_cased_address() {
        // Doc section 7.4: the keccak vector for the EIP-55-cased address.
        let proof = raw_key_proof(&hex_key(DOC_ETH_KEY_HEX), None).unwrap();
        assert_eq!(
            proof.address_eth,
            "0x9858EfFD232B4033E47d90003D41EC34EcaEda94"
        );
    }

    #[test]
    fn hex_scalar_parses_with_and_without_0x_and_tolerates_case() {
        for form in [
            format!("0x{HEX_ONE}"),
            format!("0X{HEX_ONE}"),
            HEX_ONE.to_string(),
        ] {
            let key = parse_private_key(&form).unwrap();
            assert_eq!(key.form, RawKeyForm::Hex, "{form}");
            assert_eq!(key.scalar, one(), "{form}");
            assert_eq!(key.input_wif, None, "{form}");
        }
    }

    #[test]
    fn zero_scalar_is_rejected_with_a_precise_message() {
        let err = parse_private_key(&format!("0x{}", "00".repeat(32))).unwrap_err();
        assert!(err.to_string().contains("zero scalar"), "{err}");
        // Through the WIF path too: encode zero as uncompressed WIF.
        let wif_zero = encoding::wif_encode(&[0u8; 32], false);
        let err = wif_decode(&wif_zero).unwrap_err();
        assert!(err.to_string().contains("zero scalar"), "{err}");
    }

    #[test]
    fn scalars_at_or_above_n_are_rejected() {
        // n itself and 2^256-1 (max u256) are out of range.
        let n = hex::encode(keys::SECP256K1_N);
        let err = parse_private_key(&n).unwrap_err();
        assert!(err.to_string().contains("out of range"), "{err}");
        let err = parse_private_key(&format!("0x{}", "ff".repeat(32))).unwrap_err();
        assert!(err.to_string().contains("out of range"), "{err}");
        // n-1 IS in range and must parse.
        let mut n_minus_1 = keys::SECP256K1_N;
        n_minus_1[31] -= 1;
        assert!(parse_private_key(&hex::encode(n_minus_1)).is_ok());
        // Through the WIF path: the WIF of n must fail range validation.
        let wif_n = encoding::wif_encode(&keys::SECP256K1_N, true);
        let err = wif_decode(&wif_n).unwrap_err();
        assert!(err.to_string().contains("out of range"), "{err}");
    }

    #[test]
    fn hex_form_rejects_wrong_lengths_and_non_hex_characters() {
        // A 0x-prefixed string is unambiguously hex: any length is a hex error.
        let err = parse_private_key("0x1234").unwrap_err();
        assert!(
            err.to_string().contains("exactly 64 hex characters"),
            "{err}"
        );
        let err = parse_private_key(&format!("0x{}", "ab".repeat(10))).unwrap_err();
        assert!(
            err.to_string().contains("exactly 64 hex characters"),
            "{err}"
        );
        // 64 chars whose non-hex letter ('l' is never hex) falls to the WIF
        // path, whose base-58 alphabet error names the real problem.
        let err = parse_private_key(&format!("{}l", "a".repeat(63))).unwrap_err();
        assert!(err.to_string().contains("base-58 alphabet"), "{err}");
    }

    #[test]
    fn wif_round_trip_both_compression_flags() {
        // Decode the published k=1 WIFs and re-encode: the strings must
        // reproduce themselves, and the flags must come back right.
        let wif_c = wif_decode(WIF_K1_COMPRESSED).unwrap();
        assert!(wif_c.compressed);
        assert_eq!(wif_c.scalar, one());
        assert_eq!(encoding::wif_encode(&wif_c.scalar, true), WIF_K1_COMPRESSED);

        let wif_u = wif_decode(WIF_K1_UNCOMPRESSED).unwrap();
        assert!(!wif_u.compressed);
        assert_eq!(wif_u.scalar, one());
        assert_eq!(
            encoding::wif_encode(&wif_u.scalar, false),
            WIF_K1_UNCOMPRESSED
        );

        // Doc section 7.5 anchor WIF (compressed) decodes to the doc's key.
        let doc_wif = wif_decode("L4p2b9VAf8k5aUahF1JCJUzZkgNEAqLfq8DDdQiyAprQAKSbu8hf").unwrap();
        assert!(doc_wif.compressed);
        assert_eq!(hex::encode(doc_wif.scalar), DOC_KEY_HEX);

        // Proof payload: a WIF-entered key echoes the input and shows both
        // canonical WIF renderings.
        let key = parse_private_key(WIF_K1_COMPRESSED).unwrap();
        assert_eq!(key.form, RawKeyForm::Wif);
        assert_eq!(key.input_wif.as_deref(), Some(WIF_K1_COMPRESSED));
        let proof = raw_key_proof(&key, None).unwrap();
        assert_eq!(proof.wif_compressed, WIF_K1_COMPRESSED);
        assert_eq!(proof.wif_uncompressed, WIF_K1_UNCOMPRESSED);
        assert_eq!(proof.input_form, RawKeyForm::Wif);
    }

    #[test]
    fn wif_rejects_checksum_failures_with_a_precise_message() {
        // First character flipped: same alphabet, different value, dead checksum.
        let corrupted = format!("L{}", &WIF_K1_COMPRESSED[1..]);
        let err = wif_decode(&corrupted).unwrap_err();
        assert!(err.to_string().contains("checksum mismatch"), "{err}");
        // A truncation that keeps the decoded length inside the gate (50 of
        // 52 chars still decodes to 37 bytes) is caught by the checksum; one
        // that shortens the byte length hits the length gate instead.
        let err = wif_decode(&WIF_K1_COMPRESSED[..50]).unwrap_err();
        assert!(err.to_string().contains("checksum mismatch"), "{err}");
        let err = wif_decode(&WIF_K1_COMPRESSED[..40]).unwrap_err();
        assert!(err.to_string().contains("bytes — a mainnet WIF"), "{err}");
    }

    #[test]
    fn wif_rejects_non_mainnet_version_bytes() {
        // Testnet WIFs (version 0xEF) for k=1, computed independently before
        // pinning: they decode cleanly as base58check but the version byte
        // must be rejected with a message that names the mismatch.
        let err = wif_decode("cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87JcbXMTcA").unwrap_err();
        assert!(err.to_string().contains("not mainnet"), "{err}");
        let err = wif_decode("91avARGdfge8E4tZfYLoxeJ5sGBdNJQH4kvjJoQFacbgwmaKkrx").unwrap_err();
        assert!(err.to_string().contains("not mainnet"), "{err}");
    }

    #[test]
    fn wif_rejects_a_corrupt_compression_marker() {
        // 33-byte payload whose flag byte is not 0x01.
        let mut payload = one().to_vec();
        payload.push(0x00);
        let fake = encoding::base58check_encode(WIF_VERSION, &payload);
        let err = wif_decode(&fake).unwrap_err();
        assert!(
            err.to_string().contains("0x01 compressed-key marker"),
            "{err}"
        );
    }

    #[test]
    fn expected_address_matching_covers_every_derived_target() {
        let key = hex_key(DOC_KEY_HEX);
        // The doc-pinned compressed-encoding P2PKH address matches, and the
        // proof names which derivation matched.
        let proof = raw_key_proof(&key, Some("1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA")).unwrap();
        assert_eq!(proof.matched_path, Some(MatchedPath::BtcP2pkhCompressed));
        assert_eq!(
            proof.expected_address.as_deref(),
            Some("1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA")
        );

        // The uncompressed-encoding address (computed before pinning) matches
        // the OTHER derivation.
        let proof = raw_key_proof(&key, Some("18LhnLKXjcTw5xJFiTxntnKit2Gd63eWFm")).unwrap();
        assert_eq!(proof.matched_path, Some(MatchedPath::BtcP2pkhUncompressed));

        // Ethereum match via the doc's EIP-55 vector key.
        let proof = raw_key_proof(
            &hex_key(DOC_ETH_KEY_HEX),
            Some("0x9858EfFD232B4033E47d90003D41EC34EcaEda94"),
        )
        .unwrap();
        assert_eq!(proof.matched_path, Some(MatchedPath::Eth));
    }

    #[test]
    fn expected_address_is_canonicalized_and_blank_is_treated_as_none() {
        // Uniform-lower ETH input canonicalizes to EIP-55 casing.
        let key = hex_key(DOC_ETH_KEY_HEX);
        let proof =
            raw_key_proof(&key, Some("0x9858effd232b4033e47d90003d41ec34ecaeda94")).unwrap();
        assert_eq!(
            proof.expected_address.as_deref(),
            Some("0x9858EfFD232B4033E47d90003D41EC34EcaEda94")
        );
        assert_eq!(proof.matched_path, Some(MatchedPath::Eth));
        // Whitespace-only expectation = not supplied.
        let proof = raw_key_proof(&key, Some("   ")).unwrap();
        assert_eq!(proof.expected_address, None);
        assert_eq!(proof.matched_path, None);
    }

    #[test]
    fn well_formed_but_wrong_expectation_is_an_honest_no_match() {
        // Doc section 8.4: a valid address that the key does not derive must
        // parse (no 422-style rejection) and report no match.
        let proof = raw_key_proof(
            &hex_key(DOC_KEY_HEX),
            Some("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH"),
        )
        .unwrap();
        assert_eq!(proof.matched_path, None);
        assert_eq!(
            proof.expected_address.as_deref(),
            Some("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH")
        );
    }

    #[test]
    fn malformed_expectation_fails_decode_not_compare() {
        // EIP-55 case-flip and a base58 checksum failure must be ERRORS —
        // they can never participate in a match (doc section 8.4).
        for bad in [
            "0x9858EfFD232B4033E47d90003D41EC34EcaEda95", // EIP-55 flip
            "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabB",         // base58 checksum
            "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5", // bech32 checksum
        ] {
            let err = raw_key_proof(&hex_key(HEX_ONE), Some(bad)).unwrap_err();
            assert!(!err.to_string().is_empty(), "{bad}");
        }
    }

    #[test]
    fn bech32_expectation_cannot_match_and_reports_the_no_match() {
        // A valid bech32 address is well-formed but outside this flow's
        // derivations: the proof must stay a no-match, never an error.
        let proof = raw_key_proof(
            &hex_key(DOC_KEY_HEX),
            Some("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"),
        )
        .unwrap();
        assert_eq!(proof.matched_path, None);
        assert_eq!(
            proof.expected_address.as_deref(),
            Some("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu")
        );
    }

    #[test]
    fn matched_path_serializes_as_kebab_labels() {
        assert_eq!(MatchedPath::Eth.as_str(), "eth");
        assert_eq!(
            MatchedPath::BtcP2pkhCompressed.as_str(),
            "btc-p2pkh-compressed"
        );
        assert_eq!(
            MatchedPath::BtcP2pkhUncompressed.as_str(),
            "btc-p2pkh-uncompressed"
        );
        let json = serde_json::to_string(&MatchedPath::BtcP2pkhCompressed).unwrap();
        assert_eq!(json, "\"btc-p2pkh-compressed\"");
        let json = serde_json::to_string(&RawKeyForm::Hex).unwrap();
        assert_eq!(json, "\"hex\"");
    }
}
