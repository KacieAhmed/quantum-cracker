//! Integration tests for the probe permission gates: targets outside the
//! embedded demo corpus require `--probe` (stamping every event with
//! `"probe": true`) or the API-attested `--derived-target` permission
//! (stamping `"derived_target": true` for own-wallet in-request derivation).

use std::process::Command;

/// The pooled demo wallet's Ethereum address — an embedded-corpus target.
const CORPUS_ETH: &str = "0xb79f8aC312fF21AD16980a857f574A6e7e3ED9c5";
/// A well-formed address that is NOT in the embedded corpus.
const FOREIGN_ETH: &str = "0x1111111111111111111111111111111111111111";

fn cli() -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_cracker-cli"));
    cmd.args(["--address-type", "eth", "--start", "0", "--count", "1"]);
    cmd
}

fn last_start_probe(stdout: &str) -> Option<bool> {
    stdout
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .find(|v| v["event"] == "start")
        .and_then(|v| v["probe"].as_bool())
}

#[test]
fn foreign_target_without_probe_is_refused() {
    let out = cli()
        .arg("--target")
        .arg(FOREIGN_ETH)
        .output()
        .expect("cracker-cli runs");
    assert_eq!(out.status.code(), Some(2), "stderr: {:?}", out.stderr);
    let message = String::from_utf8_lossy(&out.stderr);
    assert!(
        message.contains("--probe"),
        "gate error names the flag: {message}"
    );
}

#[test]
fn foreign_target_with_probe_runs_and_stamps_events() {
    let out = cli()
        .arg("--target")
        .arg(FOREIGN_ETH)
        .arg("--probe")
        .output()
        .expect("cracker-cli runs");
    // One prefix ordinal: no match expected, so exit 1 (exhausted) is the
    // honest outcome; anything else is a harness error.
    assert_eq!(out.status.code(), Some(1), "stderr: {:?}", out.stderr);
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert_eq!(
        last_start_probe(&stdout),
        Some(true),
        "start carries probe: {stdout}"
    );
    for line in stdout.lines() {
        let Ok(event) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if event["event"].is_string() {
            assert_eq!(
                event["probe"],
                serde_json::json!(true),
                "unlabeled event: {event}"
            );
        }
    }
}

#[test]
fn corpus_target_without_probe_runs_unlabeled() {
    let out = cli()
        .arg("--target")
        .arg(CORPUS_ETH)
        .output()
        .expect("cracker-cli runs");
    assert_eq!(out.status.code(), Some(1), "stderr: {:?}", out.stderr);
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert_eq!(
        last_start_probe(&stdout),
        Some(false),
        "start carries probe: {stdout}"
    );
}

#[test]
fn custom_pool_skips_the_corpus_gate() {
    // A limited-keyspace run over a custom pool config: its target is derived
    // from the user's own phrase and is normally not a corpus address, yet no
    // --probe is needed — the gate protects only the bundled pool's semantics.
    let pool = serde_json::json!({
        "pool_words": ["abandon", "ability", "able", "about", "above", "absent",
                       "absorb", "abstract", "absurd", "abuse", "access", "accident"],
        "variable_positions_1_indexed": [12],
        "fixed_words_1_indexed": {"1": "abandon", "2": "ability", "3": "able",
                                   "4": "about", "5": "above", "6": "absent",
                                   "7": "absorb", "8": "abstract", "9": "absurd",
                                   "10": "abuse", "11": "access"}
    });
    let dir = std::env::temp_dir().join("cracker-cli-probe-gate-test");
    std::fs::create_dir_all(&dir).expect("temp dir");
    let pool_path = dir.join("pool.json");
    std::fs::write(&pool_path, pool.to_string()).expect("pool written");

    let out = cli()
        .arg("--target")
        .arg(FOREIGN_ETH)
        .arg("--pool-json")
        .arg(&pool_path)
        .output()
        .expect("cracker-cli runs");
    assert_eq!(out.status.code(), Some(1), "stderr: {:?}", out.stderr);
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert_eq!(
        last_start_probe(&stdout),
        Some(false),
        "start carries probe: {stdout}"
    );
    let _ = std::fs::remove_file(&pool_path);
}

#[test]
fn foreign_target_with_derived_target_runs_stamped_not_probe() {
    // Own-wallet flow: the API attests the target was derived from a mnemonic
    // supplied in the same request, so a non-corpus target may run WITHOUT
    // probe semantics — but every event still carries "derived_target": true.
    let out = cli()
        .arg("--target")
        .arg(FOREIGN_ETH)
        .arg("--derived-target")
        .output()
        .expect("cracker-cli runs");
    assert_eq!(out.status.code(), Some(1), "stderr: {:?}", out.stderr);
    let stdout = String::from_utf8_lossy(&out.stdout);
    for line in stdout.lines() {
        let Ok(event) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if event["event"] == "start" || event["event"] == "done" {
            assert_eq!(
                event["derived_target"],
                serde_json::json!(true),
                "derived_target stamp on {event}"
            );
            assert_eq!(
                event["probe"],
                serde_json::json!(false),
                "derived-target runs are never labeled as probes: {event}"
            );
        }
    }
}

#[test]
fn probe_and_derived_target_are_mutually_exclusive() {
    let out = cli()
        .arg("--target")
        .arg(FOREIGN_ETH)
        .arg("--probe")
        .arg("--derived-target")
        .output()
        .expect("cracker-cli runs");
    assert_eq!(out.status.code(), Some(2), "stderr: {:?}", out.stderr);
    let message = String::from_utf8_lossy(&out.stderr);
    assert!(
        message.contains("mutually exclusive"),
        "error names the exclusivity: {message}"
    );
}
