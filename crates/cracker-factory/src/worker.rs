//! Worker subprocess management: spawn `cracker-cli` pinned to one range,
//! ingest its JSON progress stream, and classify how each invocation ended.
//!
//! One driver thread per worker walks the worker's job (a list of contiguous
//! prefix ranges, normally exactly one): spawn the engine, read stdout to
//! EOF, wait, then either continue to the next range or stop because the run
//! ended (match, cancel, shutdown, failure). Children are killed with SIGKILL
//! (`std::process::Child::kill`); the engine is stateless, so an abrupt kill
//! loses at most one unflushed progress tick of accounting and never
//! correctness - the factory's last-seen cursor is what resume uses.

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::corpus::AddressKind;

/// One contiguous prefix-ordinal range for a single engine invocation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PrefixRange {
    pub start: u64,
    pub count: u64,
}

impl PrefixRange {
    pub fn end(&self) -> u64 {
        self.start + self.count
    }
}

/// A worker's assignment: the ranges it walks, in order.
#[derive(Debug, Clone)]
pub struct WorkerJob {
    pub worker_id: u32,
    pub ranges: Vec<PrefixRange>,
}

/// Everything the engine needs to run one invocation.
#[derive(Debug, Clone)]
pub struct EngineSpec {
    pub cli_path: std::path::PathBuf,
    pub targets: Vec<String>,
    pub address_type: AddressKind,
    pub threads_per_worker: usize,
    pub progress_ms: u64,
}

/// A match as the factory records it (superset of the engine's match event).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MatchInfo {
    pub worker_id: u32,
    pub range_index: usize,
    pub mnemonic: String,
    pub path: String,
    pub address: String,
    pub all_addresses: serde_json::Value,
    /// Factory-side chronological order across all workers.
    pub seq: u64,
}

/// Lifecycle of one range invocation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum RangeStatus {
    /// Not yet started (queued behind earlier ranges of the job).
    Pending,
    Running,
    /// Range walked to the end, no match.
    Exhausted,
    /// Range produced the match (engine exit 0).
    Found,
    /// Killed because the run ended (match elsewhere, cancel, shutdown, budget).
    Canceled,
    /// Died without a run-level reason: engine error, signal, contract violation.
    Failed,
}

#[derive(Debug, Clone)]
pub struct RangeState {
    pub range: PrefixRange,
    pub status: RangeStatus,
    /// Engine's last-reported progress counters for this invocation.
    pub prefixes_done: u64,
    pub derived: u64,
    pub exit_code: Option<i32>,
    /// When set, `[resume_start, resume_start + resume_count)` is the exact
    /// unscanned remainder (1 rayon thread per worker walks ordinals in
    /// order). When clear, resume must replay the whole range conservatively.
    pub resume_exact: bool,
}

impl RangeState {
    pub fn new(range: PrefixRange) -> Self {
        Self {
            range,
            status: RangeStatus::Pending,
            prefixes_done: 0,
            derived: 0,
            exit_code: None,
            resume_exact: false,
        }
    }

    /// Exact unscanned remainder of this range, if known.
    pub fn exact_resume(&self) -> Option<PrefixRange> {
        if !self.resume_exact {
            return None;
        }
        let done = self.prefixes_done.min(self.range.count);
        Some(PrefixRange {
            start: self.range.start + done,
            count: self.range.count - done,
        })
    }
}

/// Run-level signals shared by all worker drivers and the orchestrator.
#[derive(Debug, Default)]
pub struct RunSignals {
    /// SIGINT/SIGTERM received by the factory.
    pub shutdown: AtomicBool,
    /// Any worker reported a match.
    pub match_found: AtomicBool,
    /// The orchestrator decided to cancel everyone.
    pub cancel_requested: AtomicBool,
    /// Monotonic match counter for stable winner ordering.
    pub match_seq: AtomicU64,
}

/// Shared per-worker state the orchestrator polls.
pub struct WorkerShared {
    pub worker_id: u32,
    /// Job states, mutated by the driver thread, read by the orchestrator.
    pub job: Mutex<Vec<RangeState>>,
    pub signals: Arc<RunSignals>,
    /// Millis of the run clock at the worker's last event (staleness signal).
    pub last_event_ms: AtomicU64,
    /// PID of the current child, 0 when between ranges.
    pub pid: AtomicU32,
    /// The current child, held so both the reader path (wait) and the
    /// orchestrator (kill) can reach it.
    pub(crate) child: Mutex<Option<Child>>,
    /// Matches found by this worker, shared with the orchestrator.
    pub(crate) matches: Arc<Mutex<Vec<MatchInfo>>>,
}

impl WorkerShared {
    fn take_child(&self) -> Option<Child> {
        self.child.lock().expect("child mutex poisoned").take()
    }

    fn kill_child(&self) {
        if let Some(c) = self.child.lock().expect("child mutex poisoned").as_mut() {
            let _ = c.kill(); // SIGKILL; ignore - race with natural exit is fine
        }
    }

    /// Point-in-time clone of the job states for report readers.
    pub fn snapshot_states(&self) -> Vec<RangeState> {
        self.job.lock().expect("job mutex poisoned").clone()
    }
}

pub struct WorkerHandle {
    pub shared: Arc<WorkerShared>,
    /// Driver thread; pub(crate) so report tests can stage fake workers.
    pub(crate) driver: JoinHandle<()>,
}

impl WorkerHandle {
    pub fn is_finished(&self) -> bool {
        self.driver.is_finished()
    }

    pub fn join(self) {
        let _ = self.driver.join();
    }
}

/// Spawn one worker: a driver thread that walks the job's ranges.
pub fn spawn_worker(
    spec: &EngineSpec,
    job: WorkerJob,
    signals: Arc<RunSignals>,
    matches: Arc<Mutex<Vec<MatchInfo>>>,
) -> WorkerHandle {
    let shared = Arc::new(WorkerShared {
        worker_id: job.worker_id,
        job: Mutex::new(job.ranges.iter().map(|r| RangeState::new(*r)).collect()),
        signals: Arc::clone(&signals),
        last_event_ms: AtomicU64::new(0),
        pid: AtomicU32::new(0),
        child: Mutex::new(None),
        matches,
    });
    let driver_shared = Arc::clone(&shared);
    let driver_spec = spec.clone();
    let driver = std::thread::Builder::new()
        .name(format!("factory-worker-{}", job.worker_id))
        .spawn(move || drive_worker(&driver_spec, job, driver_shared))
        .expect("failed to spawn worker driver thread");
    WorkerHandle { shared, driver }
}

/// One worker's sequential walk over its ranges.
fn drive_worker(spec: &EngineSpec, job: WorkerJob, shared: Arc<WorkerShared>) {
    for (range_index, range) in job.ranges.iter().enumerate() {
        if run_over(&shared.signals) {
            return;
        }
        {
            let mut states = shared.job.lock().expect("job mutex poisoned");
            states[range_index].status = RangeStatus::Running;
        }
        let outcome = run_one_invocation(spec, &shared, range_index, *range);
        match outcome {
            InvocationEnd::RangeFinished(status) => {
                shared.job.lock().expect("job mutex poisoned")[range_index].status = status;
            }
            InvocationEnd::RunOver => return,
        }
    }
}

fn run_over(signals: &RunSignals) -> bool {
    signals.shutdown.load(Ordering::Relaxed)
        || signals.cancel_requested.load(Ordering::Relaxed)
        || signals.match_found.load(Ordering::Relaxed)
}

enum InvocationEnd {
    /// The invocation ended on its own; the range has a terminal status.
    RangeFinished(RangeStatus),
    /// The run ended (match/cancel/shutdown); the driver should stop.
    RunOver,
}

/// Spawn the engine for one range, drain its stdout, wait, classify.
fn run_one_invocation(
    spec: &EngineSpec,
    shared: &Arc<WorkerShared>,
    range_index: usize,
    range: PrefixRange,
) -> InvocationEnd {
    let mut cmd = Command::new(&spec.cli_path);
    for t in &spec.targets {
        cmd.args(["--target", t]);
    }
    cmd.args([
        "--address-type",
        spec.address_type.engine_flag(),
        "--start",
        &range.start.to_string(),
        "--count",
        &range.count.to_string(),
        "--workers",
        &spec.threads_per_worker.to_string(),
        "--progress-ms",
        &spec.progress_ms.to_string(),
    ]);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::inherit());

    let started = Instant::now();
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("factory: worker {} spawn failed: {e}", shared.worker_id);
            shared.job.lock().expect("job mutex poisoned")[range_index].status =
                RangeStatus::Failed;
            return InvocationEnd::RangeFinished(RangeStatus::Failed);
        }
    };
    shared.pid.store(child.id(), Ordering::Relaxed);
    let stdout = child.stdout.take().expect("engine stdout was piped");

    {
        let mut slot = shared.child.lock().expect("child mutex poisoned");
        *slot = Some(child);
    }

    // Drain and ingest stdout until EOF (engine exit or kill).
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        shared.last_event_ms.store(
            u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            Ordering::Relaxed,
        );
        if let Some(event) = parse_event(&line) {
            apply_event(shared, range_index, event);
        }
        if run_over(&shared.signals) {
            // The engine is about to lose its match/stop anyway; kill early
            // and classify below.
            shared.kill_child();
        }
    }

    // Reap the child and classify the ending.
    let child = shared.take_child();
    shared.pid.store(0, Ordering::Relaxed);
    let Some(mut child) = child else {
        return InvocationEnd::RangeFinished(RangeStatus::Failed);
    };
    let exit_code = child.wait().ok().and_then(|s| s.code());
    {
        let mut states = shared.job.lock().expect("job mutex poisoned");
        states[range_index].exit_code = exit_code;
    }

    let found_now = {
        let states = shared.job.lock().expect("job mutex poisoned");
        states[range_index].status == RangeStatus::Found
    };
    let status = if run_over(&shared.signals) {
        if found_now {
            RangeStatus::Found
        } else {
            RangeStatus::Canceled
        }
    } else {
        match exit_code {
            Some(0) => RangeStatus::Found, // engine exits 0 only on match
            Some(1) => RangeStatus::Exhausted,
            _ => RangeStatus::Failed,
        }
    };
    shared.job.lock().expect("job mutex poisoned")[range_index].status = status;

    if matches!(status, RangeStatus::Found | RangeStatus::Failed) {
        InvocationEnd::RunOver
    } else {
        InvocationEnd::RangeFinished(status)
    }
}

/// A parsed engine stdout event (subset the factory consumes).
#[derive(Debug, Clone, PartialEq)]
pub enum EngineEvent {
    Start {
        total_prefixes: u64,
        raw_candidates: u64,
        start: u64,
        end: u64,
    },
    Progress {
        prefixes_done: u64,
        derived: u64,
        derived_per_sec: f64,
        matches: u64,
    },
    Match(MatchInfo),
    Done {
        prefixes_done: u64,
        derived: u64,
        recovered: Option<String>,
    },
}

/// Parse one stdout line. Non-JSON and unknown events return None (skipped,
/// never fatal: stderr noise must not break ingestion).
pub fn parse_event(line: &str) -> Option<EngineEvent> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    let event = value.get("event")?.as_str()?;
    match event {
        "start" => Some(EngineEvent::Start {
            total_prefixes: value.get("total_prefixes")?.as_u64()?,
            raw_candidates: value.get("raw_candidates")?.as_u64()?,
            start: value.get("start")?.as_u64()?,
            end: value.get("end")?.as_u64()?,
        }),
        "progress" => Some(EngineEvent::Progress {
            prefixes_done: value.get("prefixes_done")?.as_u64()?,
            derived: value.get("derived")?.as_u64()?,
            derived_per_sec: value.get("derived_per_sec")?.as_f64()?,
            matches: value.get("matches")?.as_u64()?,
        }),
        "match" => {
            let m = value.get("match")?;
            Some(EngineEvent::Match(MatchInfo {
                worker_id: 0, // stamped by apply_event; parse is pure
                range_index: 0,
                mnemonic: m.get("mnemonic")?.as_str()?.to_string(),
                path: m.get("path")?.as_str()?.to_string(),
                address: m.get("address")?.as_str()?.to_string(),
                all_addresses: m
                    .get("all_addresses")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
                seq: 0,
            }))
        }
        "done" => Some(EngineEvent::Done {
            prefixes_done: value.get("prefixes_done")?.as_u64()?,
            derived: value.get("derived")?.as_u64()?,
            recovered: value
                .get("recovered")
                .and_then(|r| r.as_str())
                .map(|s| s.to_string()),
        }),
        _ => None,
    }
}

fn apply_event(shared: &Arc<WorkerShared>, range_index: usize, event: EngineEvent) {
    let mut states = shared.job.lock().expect("job mutex poisoned");
    let st = &mut states[range_index];
    match event {
        EngineEvent::Start { .. } => {} // recorded via the range state's own lifecycle
        EngineEvent::Progress {
            prefixes_done,
            derived,
            ..
        } => {
            st.prefixes_done = prefixes_done;
            st.derived = derived;
            st.resume_exact = true; // see RangeState::resume_exact: 1-thread walks are in order
        }
        EngineEvent::Match(info) => {
            let seq = shared.signals.match_seq.fetch_add(1, Ordering::Relaxed);
            st.status = RangeStatus::Found;
            shared.signals.match_found.store(true, Ordering::Relaxed);
            let mut stamped = info;
            stamped.worker_id = shared.worker_id;
            stamped.range_index = range_index;
            stamped.seq = seq;
            shared
                .matches
                .lock()
                .expect("matches mutex poisoned")
                .push(stamped);
        }
        EngineEvent::Done { .. } => {}
    }
}

/// Aggregate view of one worker for progress reporting.
#[derive(Debug, Clone, Serialize)]
pub struct WorkerSnapshot {
    pub worker_id: u32,
    /// 0-based index of the range the worker is on (or last touched).
    pub range_index: usize,
    pub status: String,
    pub prefixes_done: u64,
    pub derived: u64,
    pub range_count: usize,
}

impl WorkerHandle {
    pub fn snapshot(&self) -> WorkerSnapshot {
        let shared = &self.shared;
        let job = shared.job.lock().expect("job mutex poisoned");
        // Last range that is not Pending, clamped to the last index.
        let range_index = job
            .iter()
            .rposition(|r| r.status != RangeStatus::Pending)
            .unwrap_or(0);
        let st = &job[range_index];
        WorkerSnapshot {
            worker_id: shared.worker_id,
            range_index,
            status: format!("{:?}", st.status).to_lowercase(),
            prefixes_done: st.prefixes_done,
            derived: st.derived,
            range_count: job.len(),
        }
    }

    pub fn kill(&self) {
        self.shared.kill_child();
    }
}

/// The orchestrator's handle on all live workers.
pub struct Fleet {
    pub handles: Vec<WorkerHandle>,
    pub signals: Arc<RunSignals>,
    pub matches: Arc<Mutex<Vec<MatchInfo>>>,
}

impl Fleet {
    pub fn kill_all(&self) {
        self.signals.cancel_requested.store(true, Ordering::Relaxed);
        for h in &self.handles {
            h.kill();
        }
    }

    /// Wait for every driver to finish (bounded by the OS, drivers exit on
    /// cancel). Children are already SIGKILLed on the cancel path.
    pub fn join_all(self) {
        for h in self.handles {
            h.join();
        }
    }
}

/// Spawn a whole fleet, one worker per job.
pub fn spawn_fleet(spec: &EngineSpec, jobs: Vec<WorkerJob>) -> Fleet {
    let signals = Arc::new(RunSignals::default());
    let matches: Arc<Mutex<Vec<MatchInfo>>> = Arc::new(Mutex::new(Vec::new()));
    let mut handles = Vec::with_capacity(jobs.len());
    for job in jobs {
        let handle = spawn_worker(spec, job, Arc::clone(&signals), Arc::clone(&matches));
        handles.push(handle);
    }
    Fleet {
        handles,
        signals,
        matches,
    }
}

/// Poll tick the orchestrator sleeps between aggregate updates.
pub const TICK: Duration = Duration::from_millis(250);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::corpus::{AddressKind, TOTAL_PREFIXES};

    fn spec() -> EngineSpec {
        EngineSpec {
            cli_path: "/bin/true".into(),
            targets: vec!["0xabc".to_string()],
            address_type: AddressKind::Eth,
            threads_per_worker: 1,
            progress_ms: 50,
        }
    }

    #[test]
    fn parses_the_engine_s_real_event_shapes() {
        // Sampled verbatim from cracker-cli output on the varied-slot pooled
        // target (the default demo space).
        let start = parse_event(
            r#"{"address_type":"eth","end":2097152,"event":"start","raw_candidates":33554432,"start":0,"targets":["0x5a92f105dBC635b8fe707dfAA023234aA243c734"],"total_prefixes":2097152,"workers":8}"#,
        )
        .unwrap();
        assert_eq!(
            start,
            EngineEvent::Start {
                total_prefixes: TOTAL_PREFIXES,
                raw_candidates: 33_554_432,
                start: 0,
                end: 2_097_152,
            }
        );

        let progress = parse_event(
            r#"{"derived":1,"derived_per_sec":3.99,"event":"progress","fraction_of_space":9.5e-7,"matches":1,"prefixes_done":1}"#,
        )
        .unwrap();
        assert_eq!(
            progress,
            EngineEvent::Progress {
                prefixes_done: 1,
                derived: 1,
                derived_per_sec: 3.99,
                matches: 1,
            }
        );

        let m = parse_event(
            r#"{"event":"match","match":{"address":"0xb79f8aC312fF21AD16980a857f574A6e7e3ED9c5","all_addresses":{"btc_bech32":"bc1qnm5mmckh08leuwsygfre0ls0vp7vstdju0wm57","btc_p2pkh":"16HxxyAQvA3AKThfcJGxSqKJ3Hs9RnTgHp","eth":"0xb79f8aC312fF21AD16980a857f574A6e7e3ED9c5"},"mnemonic":"ocean abstract raven accident hill absent winter abstract candy abuse mango able","path":"eth"}}"#,
        )
        .unwrap();
        match m {
            EngineEvent::Match(info) => {
                assert_eq!(info.mnemonic, "ocean abstract raven accident hill absent winter abstract candy abuse mango able");
                assert_eq!(info.address, "0xb79f8aC312fF21AD16980a857f574A6e7e3ED9c5");
                assert_eq!(info.path, "eth");
                assert_eq!(
                    info.all_addresses["btc_p2pkh"],
                    "16HxxyAQvA3AKThfcJGxSqKJ3Hs9RnTgHp"
                );
            }
            other => panic!("wrong event: {other:?}"),
        }

        let done = parse_event(
            r#"{"derived":1,"derived_per_sec":310.13,"elapsed_ms":3,"event":"done","matches":1,"prefixes_done":1,"recovered":"ocean abstract raven accident hill absent winter abstract candy abuse mango able"}"#,
        )
        .unwrap();
        assert_eq!(
            done,
            EngineEvent::Done {
                prefixes_done: 1,
                derived: 1,
                recovered: Some("ocean abstract raven accident hill absent winter abstract candy abuse mango able".to_string()),
            }
        );
    }

    #[test]
    fn non_json_lines_are_skipped_not_fatal() {
        assert!(parse_event("not json at all").is_none());
        assert!(parse_event(r#"{"event":"unknown-thing"}"#).is_none());
        assert!(parse_event("").is_none());
    }

    #[test]
    fn exact_resume_cursor_respects_progress_and_bounds() {
        let mut st = RangeState::new(PrefixRange {
            start: 1000,
            count: 500,
        });
        assert_eq!(st.exact_resume(), None, "no progress yet -> conservative");
        st.resume_exact = true;
        st.prefixes_done = 150;
        assert_eq!(
            st.exact_resume(),
            Some(PrefixRange {
                start: 1150,
                count: 350
            })
        );
        st.prefixes_done = 500;
        assert_eq!(
            st.exact_resume(),
            Some(PrefixRange {
                start: 1500,
                count: 0
            })
        );
        st.prefixes_done = 999_999; // engine over-report is clamped
        assert_eq!(
            st.exact_resume(),
            Some(PrefixRange {
                start: 1500,
                count: 0
            })
        );
        st.resume_exact = false;
        assert_eq!(st.exact_resume(), None);
    }

    #[test]
    fn engine_spec_arg_construction_matches_the_cli_contract() {
        // Guard the exact flag spellings the engine parses.
        let s = spec();
        assert_eq!(s.address_type.engine_flag(), "eth");
        assert_eq!(AddressKind::BtcP2pkh.engine_flag(), "btc-p2pkh");
        assert_eq!(AddressKind::BtcBech32.engine_flag(), "btc-bech32");
    }
}
