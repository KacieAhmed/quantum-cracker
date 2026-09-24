//! wasm-bindgen wrapper exposing the cracker engine to browser Web Workers.
//!
//! The API layer hosts one `CrackerWorker` per Web Worker. Browser workers
//! cannot share a rayon thread pool, so each worker scans a slice of the
//! prefix-ordinal space synchronously: `start(start, end)` sets the range,
//! `poll(maxPrefixes)` scans up to that many prefix ordinals (each prefix is
//! ~one address derivation plus pool.len() checksum tests), and `stop()`
//! halts. `poll` returns a JSON status the worker posts back to the page;
//! splitting the space across workers is the caller's job (start/end ranges).

use std::sync::atomic::Ordering;

use serde::Deserialize;
use wasm_bindgen::prelude::*;

use cracker_core::engine::{SearchConfig, Searcher, Target};
use cracker_core::pool::{PoolConfigJson, PoolSearch};
use cracker_core::validate::parse_target;
use cracker_core::PathKind;

#[derive(Deserialize)]
struct WorkerTargetJson {
    kind: PathKind,
    address: String,
}

#[derive(Deserialize)]
struct WorkerConfigJson {
    pool: PoolConfigJson,
    targets: Vec<WorkerTargetJson>,
    #[serde(default)]
    passphrase: String,
}

fn js_err(e: cracker_core::CrackerError) -> JsValue {
    JsValue::from_str(&e.to_string())
}

/// Validate one address string with the engine's decode rules (reference doc
/// section 8) for instant in-browser input feedback: malformed fails decode
/// here; well-formed-but-wrong decodes fine (only a search can fail compare).
/// Returns `{valid: true, kind, normalized}` or `{valid: false, error}`.
#[wasm_bindgen]
pub fn validate_address(address: &str) -> String {
    match cracker_core::validate::parse_target(address) {
        Ok(parsed) => serde_json::json!({
            "valid": true,
            "kind": parsed.kind().label(),
            "normalized": parsed.kind().format_address(&parsed.bytes()),
        })
        .to_string(),
        Err(err) => serde_json::json!({ "valid": false, "error": err.to_string() }).to_string(),
    }
}

#[wasm_bindgen]
pub struct CrackerWorker {
    searcher: Searcher,
    cursor: u64,
    end: u64,
}

#[wasm_bindgen]
impl CrackerWorker {
    /// `config_json` shape:
    /// `{"pool": <pool_config object>, "passphrase": "",
    ///   "targets": [{"kind": "eth" | "btc-p2pkh" | "btc-bech32", "address": "..."}]}`
    #[wasm_bindgen(constructor)]
    pub fn new(config_json: &str) -> Result<CrackerWorker, JsValue> {
        let cfg: WorkerConfigJson =
            serde_json::from_str(config_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let pool = PoolSearch::from_config(&cfg.pool, &cfg.passphrase).map_err(js_err)?;
        let mut targets = Vec::with_capacity(cfg.targets.len());
        for t in &cfg.targets {
            let parsed = parse_target(&t.address).map_err(js_err)?;
            if parsed.kind() != t.kind {
                return Err(JsValue::from_str(
                    "target address does not match its declared kind",
                ));
            }
            targets.push(Target {
                kind: t.kind,
                bytes: parsed.bytes(),
            });
        }
        Ok(CrackerWorker {
            searcher: Searcher::new(SearchConfig { pool, targets }, true),
            cursor: 0,
            end: 0,
        })
    }

    /// Size of the prefix-ordinal space (16^5 = 1,048,576 for the corpus pool).
    pub fn total_prefixes(&self) -> u64 {
        self.searcher.total_prefixes()
    }

    /// Raw assemblies before checksum filtering (16^6 = 16,777,216).
    pub fn raw_candidates(&self) -> u64 {
        self.searcher.config.pool.raw_candidates()
    }

    /// Begin (or resume) scanning prefix ordinals `[start, end)`.
    pub fn start(&mut self, start: u64, end: u64) -> Result<(), JsValue> {
        let total = self.searcher.total_prefixes();
        if start > end || end > total {
            return Err(JsValue::from_str("range outside the search space"));
        }
        self.searcher.stop.store(false, Ordering::Relaxed);
        self.cursor = start;
        self.end = end;
        Ok(())
    }

    /// Synchronously scan up to `max_prefixes` more prefix ordinals and return
    /// the status JSON: `{cursor, end, prefixes_done, derived, done, matches}`.
    /// Call from the worker's event loop so the page stays responsive.
    pub fn poll(&mut self, max_prefixes: u32) -> String {
        let step = u64::from(max_prefixes.max(1));
        let target = self.cursor.saturating_add(step).min(self.end);
        self.searcher.run_range(self.cursor..target);
        self.cursor = target;
        self.status()
    }

    /// Halt the scan; the returned status carries any matches found so far.
    pub fn stop(&mut self) -> String {
        self.searcher.request_stop();
        self.cursor = self.end;
        self.status()
    }

    fn status(&self) -> String {
        let matches = self.searcher.take_matches();
        serde_json::json!({
            "cursor": self.cursor,
            "end": self.end,
            "prefixes_done": self.searcher.progress.prefixes_done.load(Ordering::Relaxed),
            "derived": self.searcher.progress.derived.load(Ordering::Relaxed),
            "done": self.cursor >= self.end,
            "matches": matches,
        })
        .to_string()
    }
}
