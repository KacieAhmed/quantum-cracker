//! Integration tests for the pre-seed P2PK lottery: the vendored watchlist's
//! pinned integrity contract, the loud-failure discipline (corrupted hex,
//! off-curve points, wrong counts never load), the probe consent gate, and
//! the deterministic discovery path through the real CLI event stream —
//! a fixture watchlist plus a seeded run whose draw #0 is planted in it.

use std::collections::HashSet;
use std::process::Command;

use cracker_core::keys;
use cracker_core::preseed::{draw_scalar, P2pkWatchlist, PRODUCTION_EXPECTATION};

/// Path to the vendored watchlist asset, resolved from the crate manifest.
fn asset_path(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../api/assets")
        .join(name)
}

fn cli() -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_cracker-cli"));
    cmd.args(["--progress-ms", "50"]);
    cmd
}

/// A unique temp path for a test fixture (tests run in parallel).
fn temp_file(tag: &str) -> std::path::PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!(
        "preseed-{tag}-{}-{}.txt",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0)
    ));
    p
}

fn events(stdout: &str) -> Vec<serde_json::Value> {
    stdout
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .collect()
}

/// The generator point's uncompressed rendering (k = 1).
const G_UNCOMPRESSED: &str = "0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";

#[test]
fn watchlist_asset_meets_the_pinned_integrity_contract() {
    let raw = std::fs::read(asset_path("p2pk-watchlist.txt")).expect("vendored asset exists");
    let watchlist =
        P2pkWatchlist::load_bytes(&raw, &PRODUCTION_EXPECTATION).expect("asset passes its pins");
    assert_eq!(
        watchlist.len(),
        102_813,
        "the findings report's exact count"
    );
    assert!(
        watchlist.contains_genesis_key(),
        "the genesis pubkey is a member (parser end-to-end anchor)"
    );
}

#[test]
fn corrupted_watchlist_fails_loudly() {
    let raw = std::fs::read(asset_path("p2pk-watchlist.txt")).expect("vendored asset exists");

    // Sanity: the vendored asset loads against its own pin.
    P2pkWatchlist::load_bytes(&raw, &PRODUCTION_EXPECTATION)
        .expect("vendored asset must load against its pin");

    // A one-bit corruption (flipped first byte) must fail with both digests.
    let mut corrupted = raw.clone();
    corrupted[0] ^= 0xFF;
    let err = P2pkWatchlist::load_bytes(&corrupted, &PRODUCTION_EXPECTATION)
        .expect_err("corrupted asset is refused")
        .to_string();
    assert!(err.contains("SHA-256 mismatch"), "{err}");
    assert!(
        err.contains("2eb2157d7170af470dade8bf5814e916990f7e88f7b29689084de884374058f8"),
        "the error names the pinned digest: {err}"
    );

    // A missing-entry scenario (count pin off by one) fails with the counts.
    // The SHA pin is dropped so the count pin is the layer under test — the
    // hash gate fires first whenever it is present (by design).
    let short: String = {
        let text = String::from_utf8(raw).unwrap();
        text.lines().take(102_812).collect::<Vec<_>>().join("\n")
    };
    let err = P2pkWatchlist::load_bytes(
        short.as_bytes(),
        &cracker_core::preseed::WatchlistExpectation {
            sha256_hex: None,
            unique_count: Some(102_813),
        },
    )
    .expect_err("short asset is refused")
    .to_string();
    assert!(
        err.contains("unique keys, expected 102813"),
        "count pin failure names the counts: {err}"
    );
}

#[test]
fn off_curve_watchlist_key_is_rejected_with_the_line_number() {
    // 130 hex chars, 04-prefixed, but not a curve point. The asset pins are
    // dropped so the per-line curve gate is the layer under test.
    let off_curve = format!("04{}", "00".repeat(64));
    let text = format!(
        "{}\n{}\n",
        cracker_core::preseed::GENESIS_P2PK_KEY_HEX,
        off_curve
    );
    let err = P2pkWatchlist::load_bytes(
        &text.into_bytes(),
        &cracker_core::preseed::WatchlistExpectation {
            sha256_hex: None,
            unique_count: None,
        },
    )
    .expect_err("off-curve entry is refused");
    let msg = err.to_string();
    assert!(msg.contains("line 2"), "names the offending line: {msg}");
    assert!(msg.contains("curve"), "{msg}");
}

#[test]
fn preseed_requires_the_watchlist_argument() {
    let out = cli()
        .args(["--preseed-draws", "10", "--probe", "--seed", "7"])
        .output()
        .expect("cracker-cli runs");
    assert_eq!(out.status.code(), Some(2), "stderr: {:?}", out.stderr);
    let message = String::from_utf8_lossy(&out.stderr);
    assert!(
        message.contains("--preseed-watchlist"),
        "gate error names the flag: {message}"
    );
}

#[test]
fn preseed_requires_the_probe_consent() {
    let fixture = temp_file("consent");
    std::fs::write(&fixture, format!("{G_UNCOMPRESSED}\n")).unwrap();
    let out = cli()
        .args([
            "--preseed-draws",
            "10",
            "--preseed-watchlist",
            fixture.to_str().unwrap(),
            "--preseed-expectation",
            "fixture",
            "--seed",
            "7",
        ])
        .output()
        .expect("cracker-cli runs");
    let _ = std::fs::remove_file(&fixture);
    assert_eq!(out.status.code(), Some(2), "stderr: {:?}", out.stderr);
    let message = String::from_utf8_lossy(&out.stderr);
    assert!(
        message.contains("--probe") && message.contains("consent"),
        "gate error names the consent flag: {message}"
    );
}

#[test]
fn preseed_cannot_be_combined_with_target_or_traversal_args() {
    let out = cli()
        .args([
            "--preseed-draws",
            "10",
            "--probe",
            "--target",
            "0x1111111111111111111111111111111111111111",
        ])
        .output()
        .expect("cracker-cli runs");
    assert_eq!(out.status.code(), Some(2), "stderr: {:?}", out.stderr);
    let message = String::from_utf8_lossy(&out.stderr);
    assert!(
        message.contains("targetless"),
        "conflict error explains the mode: {message}"
    );
}

#[test]
fn preseed_run_over_the_real_asset_loads_102813_keys() {
    let asset = asset_path("p2pk-watchlist.txt");
    let out = cli()
        .args([
            "--preseed-draws",
            "10",
            "--preseed-watchlist",
            asset.to_str().unwrap(),
            "--probe",
            "--seed",
            "11",
        ])
        .output()
        .expect("cracker-cli runs");
    // Tiny budget, no discovery expected: exit 1 is the honest budget end.
    assert_eq!(out.status.code(), Some(1), "stderr: {:?}", out.stderr);
    let evs = events(&String::from_utf8_lossy(&out.stdout));
    let start = evs
        .iter()
        .find(|e| e["event"] == "start")
        .expect("start event present");
    assert_eq!(start["mode"], "preseed");
    assert_eq!(start["probe"], serde_json::json!(true));
    assert_eq!(
        start["watchlist_keys"], 102_813,
        "the full era set loaded and validated"
    );
    let done = evs
        .iter()
        .find(|e| e["event"] == "done")
        .expect("done event present");
    assert_eq!(done["draws_done"], 10, "exactly the budget was drawn");
    assert_eq!(done["matches"], 0);
}

#[test]
fn preseed_run_discovers_deterministically_through_the_cli() {
    // Plant the pubkey of the seeded stream's draw #0 (plus G) in a fixture
    // watchlist; the run MUST hit at draw #0, freeze, and emit the full
    // discovery payload — the k=1/G pair is covered by core unit tests.
    const SEED: u64 = 0x0005_EED5;
    let planted = draw_scalar(SEED, 0);
    let planted_compressed = keys::compressed_pubkey(&planted).unwrap();
    let planted_uncompressed = keys::uncompressed_pubkey(&planted).unwrap();

    let fixture = temp_file("discovery");
    std::fs::write(
        &fixture,
        format!("{G_UNCOMPRESSED}\n{}\n", hex::encode(planted_uncompressed)),
    )
    .unwrap();

    let out = cli()
        .args([
            "--preseed-draws",
            "1000",
            "--preseed-watchlist",
            fixture.to_str().unwrap(),
            "--preseed-expectation",
            "fixture",
            "--probe",
            "--seed",
            &SEED.to_string(),
            "--workers",
            "2",
        ])
        .output()
        .expect("cracker-cli runs");
    let _ = std::fs::remove_file(&fixture);

    assert_eq!(out.status.code(), Some(0), "stderr: {:?}", out.stderr);
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let evs = events(&stdout);

    let start = evs.iter().find(|e| e["event"] == "start").unwrap();
    assert_eq!(start["mode"], "preseed");
    assert_eq!(start["watchlist_keys"], 2);
    assert_eq!(start["draw_budget"], 1000);

    // Every emitted event is probe-labeled (consent discipline).
    for e in &evs {
        if e["event"].is_string() {
            assert_eq!(e["probe"], serde_json::json!(true), "unlabeled: {e}");
        }
    }

    let hits: Vec<&serde_json::Value> = evs.iter().filter(|e| e["event"] == "match").collect();
    assert_eq!(hits.len(), 1, "exactly one discovery: {stdout}");
    let m = &hits[0]["match"]["preseed"];
    assert_eq!(
        m["private_key_hex"],
        serde_json::json!(hex::encode(planted)),
        "the frozen private key is exactly draw #0"
    );
    assert_eq!(
        m["pubkey_compressed_hex"],
        serde_json::json!(hex::encode(planted_compressed))
    );
    assert_eq!(
        m["pubkey_uncompressed_hex"],
        serde_json::json!(hex::encode(planted_uncompressed))
    );
    assert_eq!(m["matched_watchlist_key"], m["pubkey_compressed_hex"]);
    assert_eq!(hits[0]["discovery"], serde_json::json!(true));
    assert_eq!(hits[0]["mode"], "preseed");
    // WIF shape: mainnet compressed-pubkey form.
    let wif = m["wif"].as_str().expect("wif present");
    assert!(
        wif.len() == 52 && (wif.starts_with('K') || wif.starts_with('L')),
        "{wif}"
    );
    // Both legacy P2PKH addresses are mainnet '1...' strings and distinct
    // (hash160 of the two encodings differs).
    let a1 = m["address_p2pkh_compressed"].as_str().unwrap();
    let a2 = m["address_p2pkh_uncompressed"].as_str().unwrap();
    assert!(a1.starts_with('1') && a2.starts_with('1'), "{a1} {a2}");
    assert_ne!(a1, a2);
    assert_eq!(m["rich_watchlist_hit"], serde_json::json!(false));

    let done = evs.iter().find(|e| e["event"] == "done").unwrap();
    assert_eq!(done["mode"], "preseed");
    assert_eq!(done["matches"], 1);
    assert!(
        done["draws_per_sec"].as_f64().unwrap_or(0.0) > 0.0,
        "the measured rate is reported: {done}"
    );
    // The engine froze at the hit: draws stay within the budget (usually 1).
    assert!(done["draws_done"].as_u64().unwrap() <= 1000);
}

#[test]
fn rich_address_watchlist_upgrades_the_discovery_label() {
    const SEED: u64 = 0x0005_EED5;
    let planted = draw_scalar(SEED, 0);
    let planted_compressed = keys::compressed_pubkey(&planted).unwrap();
    let planted_uncompressed = keys::uncompressed_pubkey(&planted).unwrap();

    // The discovery's compressed-encoding P2PKH address, planted in the
    // rich-address watchlist.
    let hash = keys::hash160(&planted_compressed);
    let address =
        cracker_core::encoding::base58check_encode(cracker_core::encoding::P2PKH_VERSION, &hash);

    let fixture = temp_file("rich-discovery");
    std::fs::write(
        &fixture,
        format!("{G_UNCOMPRESSED}\n{}\n", hex::encode(planted_uncompressed)),
    )
    .unwrap();
    let rich = temp_file("rich-list");
    std::fs::write(&rich, format!("{address}\n")).unwrap();

    let out = cli()
        .args([
            "--preseed-draws",
            "1000",
            "--preseed-watchlist",
            fixture.to_str().unwrap(),
            "--preseed-expectation",
            "fixture",
            "--watchlist",
            rich.to_str().unwrap(),
            "--probe",
            "--seed",
            &SEED.to_string(),
            "--workers",
            "2",
        ])
        .output()
        .expect("cracker-cli runs");
    let _ = std::fs::remove_file(&fixture);
    let _ = std::fs::remove_file(&rich);

    assert_eq!(out.status.code(), Some(0), "stderr: {:?}", out.stderr);
    let hit = events(&String::from_utf8_lossy(&out.stdout))
        .into_iter()
        .find(|e| e["event"] == "match")
        .expect("discovery present");
    assert_eq!(
        hit["match"]["preseed"]["rich_watchlist_hit"],
        serde_json::json!(true),
        "the derived address is on the rich-address watchlist: {hit}"
    );
}

#[test]
fn preseed_budget_end_without_discovery_exits_1() {
    // Watchlist holds ONLY G; the seeded draws (draw indices 0..16) are
    // overwhelmingly not k=1, so the budget ends without a discovery — the
    // honest not-an-exhausted-search outcome.
    const SEED: u64 = 0x0005_EED5;
    let planted = draw_scalar(SEED, 0);
    let planted_compressed = keys::compressed_pubkey(&planted).unwrap();
    let mut seen = HashSet::new();
    for d in 0..16u64 {
        seen.insert(draw_scalar(SEED, d));
    }
    assert!(
        !seen.contains(&[1u8; 32])
            && !seen.contains(&{
                let mut k = [0u8; 32];
                k[31] = 1;
                k
            }),
        "test premise: no draw in 0..16 equals k=1"
    );
    let _ = planted_compressed;

    let fixture = temp_file("budget-end");
    std::fs::write(&fixture, format!("{G_UNCOMPRESSED}\n")).unwrap();
    let out = cli()
        .args([
            "--preseed-draws",
            "16",
            "--preseed-watchlist",
            fixture.to_str().unwrap(),
            "--preseed-expectation",
            "fixture",
            "--probe",
            "--seed",
            &SEED.to_string(),
            "--workers",
            "2",
        ])
        .output()
        .expect("cracker-cli runs");
    let _ = std::fs::remove_file(&fixture);

    assert_eq!(out.status.code(), Some(1), "budget end: {:?}", out.stderr);
    let evs = events(&String::from_utf8_lossy(&out.stdout));
    assert!(
        evs.iter().all(|e| e["event"] != "match"),
        "no discovery claimed"
    );
    let done = evs.iter().find(|e| e["event"] == "done").unwrap();
    assert_eq!(done["draws_done"], 16, "the full budget was drawn");
    assert_eq!(done["matches"], 0);
}
