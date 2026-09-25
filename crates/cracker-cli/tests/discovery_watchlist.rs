//! Integration tests for the discovery watchlist: candidates that genuinely
//! derive an address on the watchlist end the run as labeled discoveries —
//! real-world wallets, never presented as the phrase for the user's requested
//! target. Pins are exempt: the calibration anchor tests requested targets
//! only, so a watchlist containing the addresses a pin derives cannot end an
//! address-only run at candidate #1.

use std::io::Write as _;
use std::process::Command;

/// The calibration phrase's Ethereum address (the binding acceptance vector:
/// the phrase genuinely derives it at m/44'/60'/0'/0/0).
const KACIE_ETH: &str = "0x55aD88B854f6fE563DD59c1E56Abb821aA55F495";
const CALIBRATION: &str =
    "permit bean gaze lawsuit expect exclude poet mercy enrich measure ocean since";
/// A checksum-valid phrase distinct from the calibration phrase (it streamed
/// as a tested candidate on the legacy bounded path).
const OTHER_PHRASE: &str = "ocean acid raven acid hill acid winter accuse candy able mango ability";
/// A well-formed address that is NOT in the embedded demo corpus.
const FOREIGN_ETH: &str = "0x1111111111111111111111111111111111111111";

/// A single-candidate pool: slots 1-11 fixed, the 12th word variable over a
/// one-word pool (the assembly always draws the 12th from the pool list), so
/// the traversal tests exactly that checksum-valid phrase.
fn single_phrase_pool(phrase: &str) -> String {
    let words: Vec<&str> = phrase.split_whitespace().collect();
    assert_eq!(words.len(), 12);
    let fixed: Vec<String> = words[..11]
        .iter()
        .enumerate()
        .map(|(i, w)| format!("\"{}\": \"{}\"", i + 1, w))
        .collect();
    format!(
        "{{\"pool_words\":[\"{twelfth}\"],\"variable_positions_1_indexed\":[12],\"fixed_words_1_indexed\":{{{fixed}}}}}",
        twelfth = words[11],
        fixed = fixed.join(",")
    )
}

/// Write text to a uniquely named temp file; tests run in parallel.
fn temp_file(name: &str, contents: &str) -> std::path::PathBuf {
    let mut path = std::env::temp_dir();
    path.push(format!("{name}-{}-{}", std::process::id(), name.len()));
    let mut f = std::fs::File::create(&path).expect("temp file creates");
    f.write_all(contents.as_bytes()).expect("temp file writes");
    path
}

fn events(stdout: &str) -> Vec<serde_json::Value> {
    stdout
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .collect()
}

fn watchlist_cmd(pool: &std::path::Path, watchlist: &std::path::Path) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_cracker-cli"));
    cmd.args([
        "--address-type",
        "eth",
        "--target",
        FOREIGN_ETH,
        "--pool-json",
        pool.to_str().unwrap(),
        "--watchlist",
        watchlist.to_str().unwrap(),
        "--seed",
        "1",
        "--workers",
        "1",
    ]);
    cmd
}

#[test]
fn pool_candidate_deriving_watchlist_address_is_a_discovery() {
    let pool = temp_file("discovery-pool", &single_phrase_pool(CALIBRATION));
    // Pin disabled: the only match must come from the traversal draw.
    let wl = temp_file("discovery-wl", &format!("{KACIE_ETH}\n"));
    let out = watchlist_cmd(&pool, &wl)
        .arg("--pinned-first")
        .arg("")
        .output()
        .expect("cracker-cli runs");
    assert_eq!(out.status.code(), Some(0), "stderr: {:?}", out.stderr);
    let stdout = String::from_utf8_lossy(&out.stdout);
    let matches: Vec<_> = events(&stdout)
        .into_iter()
        .filter(|v| v["event"] == "match")
        .collect();
    assert_eq!(matches.len(), 1, "exactly one match event: {stdout}");
    assert_eq!(
        matches[0]["discovery"], true,
        "the match is labeled a discovery: {stdout}"
    );
    assert_eq!(
        matches[0]["match"]["address"]
            .as_str()
            .unwrap()
            .to_lowercase(),
        KACIE_ETH.to_lowercase(),
        "discovered the watchlisted address: {stdout}"
    );
}

#[test]
fn pin_does_not_discover_even_when_watchlisted() {
    // The traversal candidate is a DIFFERENT phrase; the pin (the calibration
    // phrase) derives an address that IS on the watchlist. If the pin
    // consulted the watchlist the run would end matched at candidate #1; it
    // must instead run to exhaustion without a match.
    let pool = temp_file("pin-pool", &single_phrase_pool(OTHER_PHRASE));
    let wl = temp_file("pin-wl", &format!("{KACIE_ETH}\n"));
    let out = watchlist_cmd(&pool, &wl)
        .output()
        .expect("cracker-cli runs");
    assert_eq!(out.status.code(), Some(1), "stderr: {:?}", out.stderr);
    let stdout = String::from_utf8_lossy(&out.stdout);
    let evs = events(&stdout);
    assert!(
        evs.iter().any(|v| v["event"] == "pinned"),
        "pin was tested and labeled: {stdout}"
    );
    assert!(
        !evs.iter().any(|v| v["event"] == "match"),
        "a watchlisted pin must not end the run: {stdout}"
    );
}

#[test]
fn pin_still_matches_a_requested_target() {
    // Requested target = the address the pin derives: the own-wallet case.
    // The match must be a plain match (discovery: false) even though the
    // address is also on the watchlist — requested-target precedence.
    let pool = temp_file("pinmatch-pool", &single_phrase_pool(OTHER_PHRASE));
    let wl = temp_file("pinmatch-wl", &format!("{KACIE_ETH}\n"));
    let out = watchlist_cmd(&pool, &wl)
        .arg("--target")
        .arg(KACIE_ETH)
        .output()
        .expect("cracker-cli runs");
    assert_eq!(out.status.code(), Some(0), "stderr: {:?}", out.stderr);
    let stdout = String::from_utf8_lossy(&out.stdout);
    let matches: Vec<_> = events(&stdout)
        .into_iter()
        .filter(|v| v["event"] == "match")
        .collect();
    assert_eq!(matches.len(), 1, "exactly one match event: {stdout}");
    assert_eq!(
        matches[0]["discovery"], false,
        "requested-target matches are not discoveries: {stdout}"
    );
}

#[test]
fn malformed_watchlist_line_fails_the_run() {
    let pool = temp_file("badwl-pool", &single_phrase_pool(OTHER_PHRASE));
    let wl = temp_file("badwl-wl", "0xnotanaddress\n");
    let out = watchlist_cmd(&pool, &wl)
        .output()
        .expect("cracker-cli runs");
    assert_eq!(out.status.code(), Some(2), "stderr: {:?}", out.stderr);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("--watchlist"),
        "error names the flag: {stderr}"
    );
}

#[test]
fn embedded_watchlist_asset_is_wellformed() {
    // Guard against a mangled asset sneaking in (the workbook export turned
    // hex addresses into scientific notation — that must never load).
    let manifest = env!("CARGO_MANIFEST_DIR");
    let path = std::path::Path::new(manifest)
        .join("../../api/assets/discovery-watchlist.txt")
        .canonicalize()
        .expect("watchlist asset exists in the repo");
    let text = std::fs::read_to_string(path).expect("asset readable");
    let mut seen = std::collections::HashSet::new();
    for (n, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        assert!(
            line.len() == 42
                && line.starts_with("0x")
                && line[2..].bytes().all(|b| b.is_ascii_hexdigit())
                && line[2..].bytes().all(|b| !b.is_ascii_uppercase()),
            "line {} is not a canonical lowercase address: {line:?}",
            n + 1
        );
        assert!(seen.insert(line.to_string()), "duplicate at line {}", n + 1);
    }
    assert!(
        seen.len() >= 10_000,
        "watchlist should carry the full rich list, got {}",
        seen.len()
    );
}
