//! Round-trips every entry of the embedded fixtures through the engine:
//! all 24 published BIP-39 vectors, the computed 160/224-bit vectors, the
//! famous empty-passphrase wallet, and all five demo-corpus wallets.

use cracker_core::bip32;
use cracker_core::bip39;
use cracker_core::derive::{self, PathKind};
use cracker_core::encoding;
use cracker_core::seed::mnemonic_to_seed;
use serde_json::Value;

fn fixture(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("test-vectors")
        .join(name);
    serde_json::from_str(&std::fs::read_to_string(path).expect("fixture readable"))
        .expect("fixture json")
}

fn check_mnemonic_seed_and_master(entry: &Value, label: &str) {
    let mnemonic = entry["mnemonic"].as_str().expect("mnemonic");
    let passphrase = entry["passphrase"].as_str().unwrap_or("");
    bip39::validate(mnemonic)
        .unwrap_or_else(|e| panic!("{label}: checksum failed for {mnemonic}: {e}"));
    let seed = mnemonic_to_seed(mnemonic, passphrase);
    assert_eq!(
        hex::encode(seed),
        entry["seed"].as_str().expect("seed"),
        "{label}: seed mismatch for {mnemonic}"
    );
    if let Some(xprv) = entry["bip32_master_xprv"].as_str() {
        let master = bip32::master_key(&seed).unwrap();
        assert_eq!(
            bip32::master_xprv(&master),
            xprv,
            "{label}: xprv for {mnemonic}"
        );
    }
}

fn check_wallet(wallet: &Value, label: &str) {
    let mnemonic = wallet["mnemonic"].as_str().expect("mnemonic");
    let passphrase = wallet["passphrase"].as_str().unwrap_or("");

    // Seed + master keys.
    let seed = mnemonic_to_seed(mnemonic, passphrase);
    assert_eq!(
        hex::encode(seed),
        wallet["seed_hex"].as_str().unwrap(),
        "{label}: seed"
    );
    let master = bip32::master_key(&seed).unwrap();
    assert_eq!(
        bip32::master_xprv(&master),
        wallet["bip32_master_xprv"].as_str().unwrap(),
        "{label}: xprv"
    );
    assert_eq!(
        bip32::master_xpub(&master).unwrap(),
        wallet["bip32_master_xpub"].as_str().unwrap(),
        "{label}: xpub"
    );

    // ETH leaf key + address (EIP-55).
    let eth_leaf = derive::derive_leaf(mnemonic, passphrase, PathKind::Eth).unwrap();
    assert_eq!(
        hex::encode(eth_leaf.key),
        wallet["eth"]["private_key_hex"].as_str().unwrap(),
        "{label}: eth leaf key"
    );
    let eth_addr = derive::eth_address_bytes(&eth_leaf).unwrap();
    assert_eq!(
        PathKind::Eth.format_address(&eth_addr),
        wallet["eth"]["address"].as_str().unwrap(),
        "{label}: eth address"
    );

    // BTC P2PKH: leaf key WIF + base58check address.
    let p2pkh_leaf = derive::derive_leaf(mnemonic, passphrase, PathKind::BtcP2pkh).unwrap();
    assert_eq!(
        encoding::wif_encode(&p2pkh_leaf.key, true),
        wallet["btc_p2pkh"]["wif"].as_str().unwrap(),
        "{label}: p2pkh wif"
    );
    assert_eq!(
        PathKind::BtcP2pkh.format_address(&derive::btc_hash160_bytes(&p2pkh_leaf).unwrap()),
        wallet["btc_p2pkh"]["address"].as_str().unwrap(),
        "{label}: p2pkh address"
    );

    // BTC P2WPKH bech32.
    let bech32_leaf = derive::derive_leaf(mnemonic, passphrase, PathKind::BtcBech32).unwrap();
    assert_eq!(
        PathKind::BtcBech32.format_address(&derive::btc_hash160_bytes(&bech32_leaf).unwrap()),
        wallet["btc_bech32"]["address"].as_str().unwrap(),
        "{label}: bech32 address"
    );
}

#[test]
fn all_24_published_bip39_vectors_round_trip() {
    let entries = fixture("bip39.json")["published_english_vectors"]
        .as_array()
        .expect("published_english_vectors array")
        .clone();
    assert_eq!(
        entries.len(),
        24,
        "fixture must carry all 24 published vectors"
    );
    for entry in &entries {
        check_mnemonic_seed_and_master(
            entry,
            &format!("published[{}]", entry["index"].as_u64().unwrap_or(u64::MAX)),
        );
    }
}

#[test]
fn computed_160_and_224_bit_vectors_round_trip() {
    let entries = fixture("bip39.json")["computed_vectors_160_224_bit"]
        .as_array()
        .expect("computed vectors array")
        .clone();
    assert!(!entries.is_empty());
    for entry in &entries {
        check_mnemonic_seed_and_master(entry, "computed");
    }
}

#[test]
fn famous_empty_passphrase_wallet_full_round_trip() {
    check_wallet(
        &fixture("bip39.json")["famous_vector_empty_passphrase"],
        "famous",
    );
}

#[test]
fn all_five_demo_wallets_round_trip() {
    let doc = fixture("wallets.json");
    let wallets = doc["wallets"].as_array().expect("wallets array").clone();
    assert_eq!(wallets.len(), 4, "corpus carries four uniform wallets");
    for wallet in &wallets {
        check_wallet(wallet, "demo-wallet");
    }
    check_wallet(&doc["pooled_demo_wallet"], "pooled-demo-wallet");
}
