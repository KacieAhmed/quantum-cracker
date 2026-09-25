//! Pool enumeration + engine search integration tests (small ranges; the full
//! 2^20 walk is the CLI end-to-end run, and the corpus-space dimension tests
//! live with the pool module).

use cracker_core::engine::{SearchConfig, Searcher, Target};
use cracker_core::pool::{PoolSearch, WalletsFileJson};
use cracker_core::validate::parse_target;

fn corpus_pool() -> PoolSearch {
    let doc: WalletsFileJson = serde_json::from_str(cracker_core::WALLETS_JSON).unwrap();
    PoolSearch::from_config(&doc.pooled.pool_config, "").unwrap()
}

fn corpus_searcher(target_address: &str) -> Searcher {
    let pool = corpus_pool();
    let target = parse_target(target_address).unwrap();
    Searcher::new(
        SearchConfig {
            pool,
            targets: vec![Target {
                kind: target.kind(),
                bytes: target.bytes(),
            }],
            traversal_seed: 0,
            pinned_first: None,
            discovery: Vec::new(),
        },
        true,
    )
}

const TARGET_ETH: &str = "0xb79f8aC312fF21AD16980a857f574A6e7e3ED9c5";
const TARGET_PREFIX_ORDINAL: u64 = (((7u64 * 16 + 11) * 16 + 5) * 16 + 7) * 16 + 9;

#[test]
fn engine_recovers_the_target_from_its_prefix_ordinal() {
    let searcher = corpus_searcher(TARGET_ETH);
    // The traversal is shuffled: claim the preimage of the target's prefix
    // ordinal, so the one-ordinal range lands on the target's candidate.
    let claimed = searcher.decode_ordinal(TARGET_PREFIX_ORDINAL);
    let matches = searcher.run_range(claimed..claimed + 1);
    assert_eq!(matches.len(), 1);
    assert_eq!(
        matches[0].mnemonic,
        "ocean abstract raven accident hill absent winter abstract candy abuse mango able"
    );
    assert_eq!(matches[0].address, TARGET_ETH);
    // The hit's BTC addresses cross-confirm the corpus values.
    assert_eq!(
        matches[0].all_addresses.btc_p2pkh,
        "16HxxyAQvA3AKThfcJGxSqKJ3Hs9RnTgHp"
    );
    assert_eq!(
        matches[0].all_addresses.btc_bech32,
        "bc1qnm5mmckh08leuwsygfre0ls0vp7vstdju0wm57"
    );
}

#[test]
fn engine_finds_nothing_in_an_early_range() {
    let searcher = corpus_searcher(TARGET_ETH);
    let matches = searcher.run_range(0..64);
    assert!(matches.is_empty());
    assert_eq!(
        searcher
            .progress
            .prefixes_done
            .load(std::sync::atomic::Ordering::Relaxed),
        64
    );
}

#[test]
fn stop_flag_halts_the_scan_before_any_work() {
    let searcher = corpus_searcher(TARGET_ETH);
    searcher.request_stop();
    let matches = searcher.run_range(0..1024);
    assert!(matches.is_empty());
    assert_eq!(
        searcher
            .progress
            .prefixes_done
            .load(std::sync::atomic::Ordering::Relaxed),
        0
    );
}

#[test]
fn ranges_outside_the_space_are_empty() {
    let searcher = corpus_searcher(TARGET_ETH);
    assert!(searcher.run_range(9_999_999..10_000_000).is_empty());
}

#[test]
fn pool_dimensions_match_the_documented_contract() {
    let pool = corpus_pool();
    assert_eq!(pool.total_prefixes(), 1_048_576); // 16^5
    assert_eq!(pool.raw_candidates(), 16_777_216); // 16^6 = 2^24
    assert_eq!(pool.prefix_positions(), vec![1, 3, 5, 7, 9]);
    assert_eq!(pool.passphrase(), "");
}
