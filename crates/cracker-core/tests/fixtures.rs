//! Acceptance round-trips over the embedded fixtures (test-vectors/):
//! every published BIP-39 vector (24), the two computed 160/224-bit entries,
//! the famous empty-passphrase wallet, and all six demo-wallet-corpus
//! wallets (four random + the legacy pooled target + the varied-slot pooled
//! target) must reproduce seed, master xprv/xpub, and every address exactly.

use cracker_core::bip32;
use cracker_core::derive::{derive_addresses, DerivedAddresses, PathKind};
use cracker_core::encoding::{
    base58check_encode, bech32_encode, eth_checksum_address, BECH32_HRP, P2PKH_VERSION,
};
use cracker_core::seed::mnemonic_to_seed;
use cracker_core::{BIP39_VECTORS_JSON, WALLETS_JSON};
use serde_json::Value;

fn doc(json: &'static str) -> Value {
    serde_json::from_str(json).expect("fixture JSON parses")
}

/// Derive all three addresses for a wallet and require exact equality with
/// the corpus entries (ETH via EIP-55, P2PKH via base58check, P2WPKH via
/// bech32 - reference doc sections 5-6).
fn check_wallet(mnemonic: &str, passphrase: &str, eth: &Value, p2pkh: &Value, bech32: &Value) {
    let derived: DerivedAddresses = derive_addresses(
        mnemonic,
        passphrase,
        &[PathKind::Eth, PathKind::BtcP2pkh, PathKind::BtcBech32],
    )
    .expect("derivation succeeds");
    assert_eq!(
        eth_checksum_address(derived.eth.as_ref().expect("eth address")),
        eth["address"].as_str().expect("eth address string"),
        "ETH address mismatch"
    );
    assert_eq!(
        base58check_encode(P2PKH_VERSION, &derived.btc_p2pkh.expect("p2pkh hash")),
        p2pkh["address"].as_str().expect("p2pkh address string"),
        "BTC P2PKH address mismatch"
    );
    assert_eq!(
        bech32_encode(BECH32_HRP, 0, &derived.btc_bech32.expect("bech32 hash")),
        bech32["address"].as_str().expect("bech32 address string"),
        "BTC P2WPKH address mismatch"
    );
}

#[test]
fn all_published_bip39_vectors_round_trip() {
    let doc = doc(BIP39_VECTORS_JSON);
    let vectors = doc["published_english_vectors"]
        .as_array()
        .expect("published_english_vectors array");
    assert_eq!(
        vectors.len(),
        24,
        "all 24 published vectors must be present"
    );
    for v in vectors {
        let mnemonic = v["mnemonic"].as_str().unwrap();
        let passphrase = v["passphrase"].as_str().unwrap();
        let seed = mnemonic_to_seed(mnemonic, passphrase);
        assert_eq!(
            hex::encode(seed),
            v["seed"].as_str().unwrap(),
            "seed mismatch for {mnemonic}"
        );
        let master = bip32::master_key(&seed).unwrap();
        assert_eq!(
            bip32::master_xprv(&master),
            v["bip32_master_xprv"].as_str().unwrap(),
            "master xprv mismatch for {mnemonic}"
        );
    }
}

#[test]
fn computed_vectors_round_trip_seed() {
    // The 160/224-bit entries carry no published xprv; the seed is the anchor.
    let doc = doc(BIP39_VECTORS_JSON);
    for v in doc["computed_vectors_160_224_bit"]
        .as_array()
        .expect("computed_vectors array")
    {
        let mnemonic = v["mnemonic"].as_str().unwrap();
        let seed = mnemonic_to_seed(mnemonic, v["passphrase"].as_str().unwrap());
        assert_eq!(
            hex::encode(seed),
            v["seed"].as_str().unwrap(),
            "seed mismatch for {mnemonic}"
        );
    }
}

#[test]
fn famous_wallet_matches_the_corpus_exactly() {
    let doc = doc(BIP39_VECTORS_JSON);
    let f = &doc["famous_vector_empty_passphrase"];
    let mnemonic = f["mnemonic"].as_str().unwrap();
    let passphrase = f["passphrase"].as_str().unwrap();
    let seed = mnemonic_to_seed(mnemonic, passphrase);
    assert_eq!(hex::encode(seed), f["seed_hex"].as_str().unwrap());
    let master = bip32::master_key(&seed).unwrap();
    assert_eq!(
        bip32::master_xprv(&master),
        f["bip32_master_xprv"].as_str().unwrap()
    );
    assert_eq!(
        bip32::master_xpub(&master).unwrap(),
        f["bip32_master_xpub"].as_str().unwrap()
    );
    check_wallet(
        mnemonic,
        passphrase,
        &f["eth"],
        &f["btc_p2pkh"],
        &f["btc_bech32"],
    );
}

#[test]
fn all_demo_wallets_match_the_corpus_exactly() {
    let doc = doc(WALLETS_JSON);
    let wallets = doc["wallets"].as_array().expect("wallets array");
    let pooled = &doc["pooled_demo_wallet"];
    let pooled_varied = &doc["pooled_demo_wallet_varied"];
    assert_eq!(wallets.len(), 4, "four random demo wallets");
    for w in wallets
        .iter()
        .chain([pooled, pooled_varied])
    {
        let label = w
            .get("label")
            .and_then(|l| l.as_str())
            .unwrap_or("pooled_demo_wallet");
        let mnemonic = w["mnemonic"].as_str().unwrap();
        let passphrase = w["passphrase"].as_str().unwrap();
        let seed = mnemonic_to_seed(mnemonic, passphrase);
        assert_eq!(
            hex::encode(seed),
            w["seed_hex"].as_str().unwrap(),
            "seed mismatch for {label}"
        );
        let master = bip32::master_key(&seed).unwrap();
        assert_eq!(
            bip32::master_xprv(&master),
            w["bip32_master_xprv"].as_str().unwrap(),
            "master xprv mismatch for {label}"
        );
        assert_eq!(
            bip32::master_xpub(&master).unwrap(),
            w["bip32_master_xpub"].as_str().unwrap(),
            "master xpub mismatch for {label}"
        );
        check_wallet(
            mnemonic,
            passphrase,
            &w["eth"],
            &w["btc_p2pkh"],
            &w["btc_bech32"],
        );
    }
}
