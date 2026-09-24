//! cracker-factory: worker-fleet orchestration over `cracker-cli` subprocesses.
//!
//! stdout is a machine channel: one JSON object per line
//! (`factory-start` / `factory-progress` / `factory-done`). Human narration
//! goes to stderr. The final state lands in `--report` (default
//! `run-report.json`).
//!
//! Exit codes: 0 found or budget probe completed · 1 exhausted (full cover,
//! no match) · 2 usage/config error · 3 refused by worker-count guardrails ·
//! 4 interrupted (resume point written) · 5 incomplete (worker failed).

mod corpus;
mod machine;
mod plan;
mod report;
mod scale;
mod worker;

use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::atomic::Ordering;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use ethnum::U256;
use serde_json::json;

use crate::corpus::{POOL_LEN_RAW, RAW_SPACE, TOTAL_PREFIXES};
use crate::machine::{MachineProfile, ShutdownFlag};
use crate::plan::{Range256, RangePlan};
use crate::report::RunStatus;
use crate::worker::{EngineSpec, PrefixRange, WorkerJob, WorkerSnapshot};

const EXIT_USAGE: u8 = 2;
const EXIT_REFUSED: u8 = 3;
const EXIT_INTERRUPTED: u8 = 4;
const EXIT_INCOMPLETE: u8 = 5;

/// Spaces larger than this (raw candidates) refuse to run without
/// --budget-seconds: honesty gate for enormous declared keyspaces.
const DEFAULT_HUGE_SPACE_THRESHOLD_RAW: u64 = 1u64 << 40;

#[derive(Debug, Clone)]
struct Args {
    targets: Vec<String>,
    workers: u32,
    threads_per_worker: usize,
    report_path: PathBuf,
    progress_ms: u64,
    force: bool,
    budget_seconds: Option<f64>,
    budget_space: String,
    huge_space_threshold: u64,
    cracker_cli: Option<PathBuf>,
    resume: Option<PathBuf>,
    quiet: bool,
}

fn usage() -> &'static str {
    "\
cracker-factory - orchestrate cracker-cli workers over disjoint ranges

  cracker-factory --target <address> [--target <address>...]
                  [--workers N] [--threads-per-worker K] [--report PATH]
                  [--progress-ms MS] [--cracker-cli PATH]
                  [--budget-seconds S] [--budget-space EXPR]
                  [--huge-space-threshold N] [--resume PATH] [--force] [--quiet]

Targets must be addresses from the bundled demo-wallet corpus
(demo-wallets-only is binding). Each worker runs its own cracker-cli
subprocess pinned to one contiguous range; ranges are verified disjoint with
a coverage proof before launch.

Flags:
  --target <address>          corpus address to search (repeatable, one
                              address type per run)
  --workers N                 number of engine subprocesses (default 1;
                              refused above safe-max, see --force)
  --threads-per-worker K      rayon threads per worker (default 1)
  --report PATH               run-report.json path (default run-report.json)
  --progress-ms MS            engine progress cadence (default 250)
  --cracker-cli PATH          engine binary (default: $CRACKER_CLI, then the
                              factory's own directory, then the workspace
                              target/{release,debug} dirs, then $PATH)
  --budget-seconds S          bounded mode: run at most S seconds, then
                              report the measured rate and the honest
                              full-space ETA (never claims completion)
  --budget-space EXPR         declared space for the estimate, e.g. 2^256
                              (default 2^256; requires --budget-seconds)
  --huge-space-threshold N    spaces above N raw candidates require
                              --budget-seconds (default 2^40)
  --resume PATH               resume an interrupted run from its report
  --force                     override the safe-max worker-count refusal
  --quiet                     suppress per-tick factory-progress lines

Exit codes: 0 found / probe done | 1 exhausted | 2 usage | 3 refused |
4 interrupted (resume point written) | 5 incomplete"
}

/// Consume the value after the flag at cursor `i`, advancing the cursor.
fn take_value(args: &[String], i: &mut usize, flag: &str) -> Result<String, String> {
    let v = args
        .get(*i)
        .cloned()
        .ok_or_else(|| format!("{flag} expects a value"))?;
    *i += 1;
    Ok(v)
}

fn parse_args(args: &[String]) -> Result<Args, String> {
    if args.is_empty() {
        return Err("no arguments given".to_string());
    }
    let mut parsed = Args {
        targets: Vec::new(),
        workers: 1,
        threads_per_worker: 1,
        report_path: PathBuf::from("run-report.json"),
        progress_ms: 250,
        force: false,
        budget_seconds: None,
        budget_space: "2^256".to_string(),
        huge_space_threshold: DEFAULT_HUGE_SPACE_THRESHOLD_RAW,
        cracker_cli: None,
        resume: None,
        quiet: false,
    };
    let mut i = 0;
    let mut budget_space_given = false;
    while i < args.len() {
        let flag = args[i].as_str().to_string();
        i += 1; // the flag itself is consumed even when it takes no value
        match flag.as_str() {
            "--target" => {
                for t in take_value(args, &mut i, "--target")?
                    .split(',')
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                {
                    parsed.targets.push(t.to_string());
                }
            }
            "--workers" => {
                parsed.workers = take_value(args, &mut i, "--workers")?
                    .parse()
                    .map_err(|_| "--workers expects a number")?;
            }
            "--threads-per-worker" => {
                parsed.threads_per_worker = take_value(args, &mut i, "--threads-per-worker")?
                    .parse()
                    .map_err(|_| "--threads-per-worker expects a number")?;
            }
            "--report" => parsed.report_path = PathBuf::from(take_value(args, &mut i, "--report")?),
            "--progress-ms" => {
                parsed.progress_ms = take_value(args, &mut i, "--progress-ms")?
                    .parse()
                    .map_err(|_| "--progress-ms expects a number")?;
            }
            "--force" => parsed.force = true,
            "--quiet" => parsed.quiet = true,
            "--budget-seconds" => {
                parsed.budget_seconds = Some(
                    take_value(args, &mut i, "--budget-seconds")?
                        .parse::<f64>()
                        .map_err(|_| "--budget-seconds expects a number")?,
                );
            }
            "--budget-space" => {
                parsed.budget_space = take_value(args, &mut i, "--budget-space")?;
                budget_space_given = true;
            }
            "--huge-space-threshold" => {
                parsed.huge_space_threshold = take_value(args, &mut i, "--huge-space-threshold")?
                    .parse()
                    .map_err(|_| "--huge-space-threshold expects a number")?;
            }
            "--cracker-cli" => {
                parsed.cracker_cli = Some(PathBuf::from(take_value(args, &mut i, "--cracker-cli")?))
            }
            "--resume" => {
                parsed.resume = Some(PathBuf::from(take_value(args, &mut i, "--resume")?))
            }
            "--help" | "-h" => {
                println!("{}", usage());
                std::process::exit(0);
            }
            other => return Err(format!("unknown flag {other}")),
        }
    }

    if parsed.targets.is_empty() && parsed.resume.is_none() {
        return Err("at least one --target is required (or --resume)".to_string());
    }
    if parsed.workers == 0 {
        return Err("--workers must be at least 1".to_string());
    }
    if parsed.threads_per_worker == 0 {
        return Err("--threads-per-worker must be at least 1".to_string());
    }
    if let Some(s) = parsed.budget_seconds {
        if !(s.is_finite() && s > 0.0) {
            return Err("--budget-seconds must be a positive number".to_string());
        }
    }
    if budget_space_given && parsed.budget_seconds.is_none() {
        return Err("--budget-space requires --budget-seconds".to_string());
    }
    // The declared space is reporting-only; 2^256 itself is the honest
    // default and does not fit u256, so validate it as an f64 magnitude.
    plan::parse_space_f64(&parsed.budget_space).map_err(|e| format!("--budget-space: {e}"))?;
    Ok(parsed)
}

/// Locate the engine binary. Order: explicit flag, $CRACKER_CLI, the
/// factory's own directory, the workspace target dirs, $PATH.
fn resolve_engine(flag: Option<&PathBuf>) -> Result<PathBuf, String> {
    if let Some(p) = flag {
        return Ok(p.clone());
    }
    if let Ok(p) = std::env::var("CRACKER_CLI") {
        if !p.is_empty() {
            return Ok(PathBuf::from(p));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("cracker-cli");
            if p.exists() {
                return Ok(p);
            }
        }
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for profile in ["release", "debug"] {
        let p = manifest.join(format!("../../target/{profile}/cracker-cli"));
        if p.exists() {
            return Ok(p);
        }
    }
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let p = dir.join("cracker-cli");
            if p.exists() {
                return Ok(p);
            }
        }
    }
    Err(
        "cracker-cli not found: build it with `cargo build -p cracker-cli --release` \
         or pass --cracker-cli <path>"
            .to_string(),
    )
}

/// Assign ranges to workers, biggest range first, to the least-loaded worker.
/// Workers beyond the range count get no job (they are not spawned).
fn distribute_jobs(ranges: Vec<PrefixRange>, workers: usize) -> Vec<WorkerJob> {
    let mut ranges: Vec<PrefixRange> = ranges.into_iter().filter(|r| r.count > 0).collect();
    if workers == 0 || ranges.is_empty() {
        return Vec::new();
    }
    let n = workers.min(ranges.len());
    let mut loads = vec![0u64; n];
    let mut jobs: Vec<Vec<PrefixRange>> = vec![Vec::new(); n];
    ranges.sort_by_key(|r| std::cmp::Reverse(r.count));
    for r in ranges {
        let i = (0..n).min_by_key(|&i| loads[i]).unwrap();
        loads[i] += r.count;
        jobs[i].push(r);
    }
    jobs.into_iter()
        .enumerate()
        .map(|(i, rs)| WorkerJob {
            worker_id: i as u32,
            ranges: rs,
        })
        .collect()
}

fn emit(value: &serde_json::Value) {
    println!("{value}");
    let _ = std::io::stdout().flush();
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let parsed = match parse_args(&args) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("factory: {e}\n\n{}", usage());
            return ExitCode::from(EXIT_USAGE);
        }
    };
    match orchestrate(parsed) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("factory: {e}");
            ExitCode::from(EXIT_USAGE)
        }
    }
}

fn orchestrate(args: Args) -> Result<ExitCode, String> {
    // Targets: CLI args, or the resume file's targets when none given.
    let resume_file = match &args.resume {
        Some(path) => Some(report::load_resume_file(path)?),
        None => None,
    };
    let targets = match (&args.targets.is_empty(), &resume_file) {
        (false, _) => args.targets.clone(),
        (true, Some(file)) => file.targets.clone(),
        (true, None) => return Err("at least one --target is required".to_string()),
    };
    let kind = corpus::validate_targets(&targets)?;

    let engine_path = resolve_engine(args.cracker_cli.as_ref())?;
    if !engine_path.exists() {
        return Err(format!(
            "cracker-cli not found at {}",
            engine_path.display()
        ));
    }

    // Machine profile and worker-count guardrails.
    let profile = MachineProfile::detect(args.threads_per_worker);
    let mut warnings: Vec<String> = Vec::new();
    match profile.check_worker_count(args.workers) {
        Ok(ws) => warnings = ws,
        Err(reason) if args.force => {
            eprintln!("factory: --force overruled the guardrail:\n{reason}");
            warnings.push("worker count forced past safe-max".to_string());
        }
        Err(reason) => {
            eprintln!("factory: {reason}");
            eprintln!("(the guardrail is memory accounting, not ideology; override with --force)");
            return Ok(ExitCode::from(EXIT_REFUSED));
        }
    }
    for w in &warnings {
        eprintln!("factory warning: {w}");
    }

    // Plan the ranges (fresh plan or resume ranges) and verify coverage.
    let mode = if args.budget_seconds.is_some() {
        "budgeted-probe"
    } else {
        "exhaustive"
    };
    let (prefix_ranges, coverage_json) = match &resume_file {
        Some(file) => {
            let rs: Vec<PrefixRange> = file
                .resume
                .ranges
                .iter()
                .map(|r| PrefixRange {
                    start: r.start,
                    count: r.count,
                })
                .collect();
            for r in &rs {
                if r.end() > TOTAL_PREFIXES {
                    return Err(format!(
                        "resume range [{}, {}) exceeds the space ({TOTAL_PREFIXES} prefixes)",
                        r.start,
                        r.end()
                    ));
                }
            }
            let intervals: Vec<report::ScannedInterval> = rs
                .iter()
                .map(|r| report::ScannedInterval {
                    worker_id: 0,
                    start: r.start,
                    end: r.end(),
                    complete: false,
                })
                .collect();
            report::verify_disjoint(&intervals)
                .map_err(|e| format!("resume file ranges are not disjoint: {e}"))?;
            let ranges_json: Vec<serde_json::Value> = rs
                .iter()
                .map(|r| json!({ "start": r.start, "count": r.count }))
                .collect();
            (
                rs,
                json!({
                    "mode": "resume",
                    "disjoint": true,
                    "ranges": ranges_json,
                }),
            )
        }
        None => {
            let space = Range256::new(0, U256::from(RAW_SPACE));
            let plan =
                RangePlan::split_aligned(space, args.workers as usize, U256::from(POOL_LEN_RAW))
                    .map_err(|e| e.to_string())?;
            let proof = plan.coverage_proof();
            if !proof.exact_cover() {
                return Err(format!(
                    "internal: planner produced a non-exact cover: {}",
                    proof.to_json()
                ));
            }
            let mut rs = Vec::with_capacity(plan.ranges.len());
            for r in &plan.ranges {
                let (start, count) =
                    plan::to_prefix_range(r, POOL_LEN_RAW).map_err(|e| e.to_string())?;
                rs.push(PrefixRange { start, count });
            }
            (rs, proof.to_json())
        }
    };

    // Honesty bookkeeping: the huge-space threshold applies to the DECLARED
    // space in budget mode (the only place a huge space can be named). A run
    // without --budget-seconds always searches the demo space; the flag
    // exists so the app UI can bound what it offers by the same number.
    let huge_space_threshold = U256::from(args.huge_space_threshold);

    let jobs = distribute_jobs(prefix_ranges, args.workers as usize);
    if jobs.is_empty() {
        eprintln!("factory: nothing left to scan (all ranges already complete)");
    }

    let started_unix = unix_now();
    let started = Instant::now();
    emit(&json!({
        "event": "factory-start",
        "mode": mode,
        "targets": targets,
        "address_type": kind.engine_flag(),
        "workers_requested": args.workers,
        "workers_effective": jobs.len(),
        "threads_per_worker": args.threads_per_worker,
        "machine": report::machine_json(&profile),
        "space": {
            "raw_len": RAW_SPACE.to_string(),
            "prefixes": TOTAL_PREFIXES,
            "pool_len": POOL_LEN_RAW,
        },
        "coverage_proof": coverage_json,
        "budget_seconds": args.budget_seconds,
        "declared_space": if args.budget_seconds.is_some() {
            serde_json::Value::String(args.budget_space.clone())
        } else {
            serde_json::Value::Null
        },
        "warnings": warnings,
        "engine": engine_path.display().to_string(),
    }));
    eprintln!(
        "factory: {} workers x {} thread(s), engine {}, targets {}",
        jobs.len(),
        args.threads_per_worker,
        engine_path.display(),
        targets.join(", ")
    );

    let spec = EngineSpec {
        cli_path: engine_path,
        targets: targets.clone(),
        address_type: kind,
        threads_per_worker: args.threads_per_worker,
        progress_ms: args.progress_ms,
    };

    let shutdown = ShutdownFlag::default();
    if let Err(e) = machine::register_signal_handlers(&shutdown) {
        eprintln!("factory warning: {e}");
    }

    // Report-time snapshot: the fleet takes ownership of the jobs.
    let jobs_snapshot = jobs.clone();
    let fleet = worker::spawn_fleet(&spec, jobs);
    let mut cancel_started = false;
    let mut interrupted = false;
    let mut prev: Option<(Instant, u64)> = None;
    let mut window_rate = 0.0f64;

    loop {
        std::thread::sleep(worker::TICK);
        if shutdown.raised() && !cancel_started {
            cancel_started = true;
            interrupted = true;
            eprintln!("factory: interrupt received - canceling workers, writing resume point");
            fleet.kill_all();
        }
        if fleet.signals.match_found.load(Ordering::Relaxed) && !cancel_started {
            cancel_started = true;
            eprintln!("factory: match reported - canceling remaining workers");
            fleet.kill_all();
        }
        if let Some(budget) = args.budget_seconds {
            if !cancel_started && started.elapsed().as_secs_f64() >= budget {
                cancel_started = true;
                eprintln!("factory: time budget exhausted - stopping workers");
                fleet.kill_all();
            }
        }

        let snapshots: Vec<WorkerSnapshot> = fleet.handles.iter().map(|h| h.snapshot()).collect();
        let derived_total: u64 = snapshots.iter().map(|s| s.derived).sum();
        let prefixes_scanned: u64 = snapshots.iter().map(|s| s.prefixes_done).sum();
        let now = Instant::now();
        match prev {
            Some((t_prev, d_prev)) => {
                let dt = (now - t_prev).as_secs_f64();
                if dt > 0.0 {
                    window_rate = (derived_total.saturating_sub(d_prev)) as f64 / dt;
                }
            }
            None => {
                let dt = (now - started).as_secs_f64();
                if dt > 0.0 {
                    window_rate = derived_total as f64 / dt;
                }
            }
        }
        prev = Some((now, derived_total));

        if !args.quiet {
            emit(&json!({
                "event": "factory-progress",
                "elapsed_s": started.elapsed().as_secs_f64(),
                "workers": snapshots,
                "derived_total": derived_total,
                "prefixes_scanned": prefixes_scanned,
                "aggregate_derived_per_sec": window_rate,
                "match_found": fleet.signals.match_found.load(Ordering::Relaxed),
            }));
        }
        if fleet.handles.iter().all(|h| h.is_finished()) {
            break;
        }
    }
    // Finalize: drivers have all exited (the loop breaks only when every
    // driver is_finished), so the shared state is final. Read all of it
    // before join_all consumes the handles.
    let workers_effective = fleet.handles.len();
    let all_matches = fleet.matches.lock().map(|m| m.clone()).unwrap_or_default();
    let winner = all_matches.iter().min_by_key(|m| m.seq).cloned();
    let scanned = report::collect_scanned(&fleet);
    let scanned_total = report::verify_disjoint(&scanned).ok();
    let resume_ranges_out = report::compute_resume(&fleet);

    let status = if interrupted {
        RunStatus::Interrupted
    } else if winner.is_some() {
        RunStatus::Found
    } else if args.budget_seconds.is_some() {
        RunStatus::BudgetedProbe
    } else if resume_ranges_out.is_empty() {
        RunStatus::Exhausted
    } else {
        RunStatus::Incomplete
    };
    let status_str = serde_json::to_value(status)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".to_string());

    let wall = started.elapsed().as_secs_f64();
    let derived_total: u64 = fleet
        .handles
        .iter()
        .flat_map(|h| h.shared.snapshot_states())
        .map(|st| st.derived)
        .sum();
    let aggregate_rate = derived_total as f64 / wall.max(1e-3);

    fleet.join_all(); // reap the driver threads; all state was read above

    // Scale estimates: only meaningful in budget mode, always labeled.
    let scale_estimates = args.budget_seconds.map(|budget| {
        // Exact u256 when representable (raw string, grouped count);
        // otherwise the f64 magnitude (2^256 itself) — never silently 0.
        let declared_exact = plan::parse_space_size(&args.budget_space).ok();
        let declared_f = declared_exact
            .map(plan::u256_to_f64)
            .or_else(|| plan::parse_space_f64(&args.budget_space).ok())
            .unwrap_or(f64::NAN);
        let declared_raw = declared_exact
            .map(|v| v.to_string())
            .unwrap_or_else(|| args.budget_space.clone());
        let declared_human = declared_exact
            .map(scale::format_count)
            .unwrap_or_else(|| scale::format_sci(declared_f));
        let eta_seconds = declared_f / aggregate_rate.max(1e-9);
        json!({
            "declared_space": args.budget_space,
            "declared_space_raw": declared_raw,
            "declared_space_human": declared_human,
            "budget_seconds": budget,
            "searched_space": "the bundled demo space (2^24 raw assemblies), not the declared space",
            "huge_space_threshold_raw": huge_space_threshold.to_string(),
            "declared_exceeds_threshold": declared_f > plan::u256_to_f64(huge_space_threshold),
            "measured_aggregate_derived_per_sec": aggregate_rate,
            "workers_effective": workers_effective,
            "full_space_eta_seconds": eta_seconds,
            "full_space_eta_human": scale::format_duration(eta_seconds),
            "worker_years_at_reference_rate": scale::worker_years_for_space_f64(
                declared_f,
                scale::REFERENCE_DERIVATIONS_PER_SEC,
            ),
            "verdict": scale::notes::VERDICT_NEVER,
        })
    });

    let report_json = json!({
        "schema_version": report::SCHEMA_VERSION,
        "mode": mode,
        "status": status_str,
        "started_at_unix_s": started_unix,
        "elapsed_s": wall,
        "targets": targets,
        "address_type": kind.engine_flag(),
        "workers_requested": args.workers,
        "workers_effective": workers_effective,
        "threads_per_worker": args.threads_per_worker,
        "machine": report::machine_json(&profile),
        "space": {
            "raw_len": RAW_SPACE.to_string(),
            "prefixes": TOTAL_PREFIXES,
            "pool_len": POOL_LEN_RAW,
        },
        "coverage_proof": coverage_json,
        "aggregate": {
            "derived_total": derived_total,
            "aggregate_derived_per_sec": aggregate_rate,
            "scanned_prefixes_verified": scanned_total,
            "scanned_intervals": scanned.len(),
            "wall_seconds": wall,
        },
        "winning": winner.as_ref().map(|w| {
            // Name the exact planned range the winner ran, in the engine's
            // prefix-ordinal units, so the report is self-contained.
            let winning_range = jobs_snapshot
                .iter()
                .find(|j| j.worker_id == w.worker_id)
                .and_then(|j| j.ranges.get(w.range_index));
            json!({
                "worker_id": w.worker_id,
                "range_index": w.range_index,
                "winning_range": winning_range.map(|r| json!({
                    "prefix_start": r.start,
                    "prefix_count": r.count,
                })),
                "mnemonic": w.mnemonic,
                "path": w.path,
                "address": w.address,
                "all_addresses": w.all_addresses,
            })
        }),
        "matches": report::matches_json(&all_matches, winner.as_ref().map(|w| w.seq)),
        "resume": {
            "resumable": !resume_ranges_out.is_empty(),
            "ranges": resume_ranges_out,
            "targets": targets,
            "address_type": kind.engine_flag(),
        },
        "scale_estimates": scale_estimates,
        "honest_scaling": report::honest_notes(),
    });

    let report_path = args.report_path.display().to_string();
    let written = serde_json::to_string_pretty(&report_json)
        .map(|s| format!("{s}\n"))
        .map_err(|e| format!("report serialization: {e}"))
        .and_then(|s| std::fs::write(&args.report_path, s).map_err(|e| e.to_string()));
    if let Err(e) = written {
        eprintln!("factory: could not write report {report_path}: {e}");
    }

    emit(&json!({
        "event": "factory-done",
        "status": status_str,
        "report_path": report_path,
        "report": report_json,
    }));

    // Human summary on stderr.
    match (&status, &winner) {
        (RunStatus::Found, Some(w)) => {
            eprintln!(
                "factory: MATCH {status_str}: {} on worker {} ({})",
                w.mnemonic, w.worker_id, w.address
            );
        }
        (RunStatus::BudgetedProbe, _) => {
            if let Some(se) = args.budget_seconds.map(|_| &report_json["scale_estimates"]) {
                eprintln!(
                    "factory: probe done. measured {:.0} derivations/s across {} workers; declared space {} ({}): full-space ETA {}",
                    se["measured_aggregate_derived_per_sec"].as_f64().unwrap_or(0.0),
                    se["workers_effective"],
                    se["declared_space"],
                    se["declared_space_human"],
                    se["full_space_eta_human"],
                );
                eprintln!("factory: {}", scale::notes::VERDICT_NEVER);
            }
        }
        (RunStatus::Exhausted, _) => {
            eprintln!("factory: full space walked, no match (report: {report_path})");
        }
        (RunStatus::Interrupted, _) => {
            eprintln!("factory: interrupted - resume with --resume {report_path}");
        }
        (RunStatus::Incomplete, _) => {
            eprintln!("factory: some ranges failed - see report {report_path}");
        }
        _ => {}
    }

    let code = match status {
        RunStatus::Found | RunStatus::BudgetedProbe => 0u8,
        RunStatus::Exhausted => 1,
        RunStatus::Interrupted => EXIT_INTERRUPTED,
        RunStatus::Incomplete => EXIT_INCOMPLETE,
    };
    Ok(ExitCode::from(code))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_targets_workers_and_report_path() {
        let a = parse_args(&args(&[
            "--target",
            "0xb79f8aC312fF21AD16980a857f574A6e7e3ED9c5",
            "--workers",
            "4",
            "--report",
            "/tmp/x.json",
            "--quiet",
        ]))
        .unwrap();
        assert_eq!(a.targets.len(), 1);
        assert_eq!(a.workers, 4);
        assert_eq!(a.report_path, PathBuf::from("/tmp/x.json"));
        assert!(a.quiet);
        assert!(!a.force);
    }

    #[test]
    fn comma_separated_targets_and_flags_are_order_independent() {
        let a = parse_args(&args(&[
            "--force",
            "--target",
            "16HxxyAQvA3AKThfcJGxSqKJ3Hs9RnTgHp,bc1qnm5mmckh08leuwsygfre0ls0vp7vstdju0wm57",
        ]))
        .unwrap();
        assert_eq!(a.targets.len(), 2);
        assert!(a.force);
    }

    #[test]
    fn missing_values_and_unknown_flags_are_usage_errors() {
        assert!(parse_args(&args(&["--target"])).is_err());
        assert!(parse_args(&args(&["--nope"])).is_err());
        assert!(parse_args(&args(&[])).is_err());
    }

    #[test]
    fn budget_space_requires_budget_seconds() {
        assert!(parse_args(&args(&["--target", "x", "--budget-space", "2^256"])).is_err());
        let a = parse_args(&args(&[
            "--target",
            "x",
            "--budget-seconds",
            "1.5",
            "--budget-space",
            "2^40",
        ]))
        .unwrap();
        assert_eq!(a.budget_seconds, Some(1.5));
        assert_eq!(a.budget_space, "2^40");
        assert!(parse_args(&args(&["--target", "x", "--budget-seconds", "0"])).is_err());
        assert!(parse_args(&args(&["--target", "x", "--budget-seconds", "-2"])).is_err());
    }

    #[test]
    fn zero_workers_and_zero_threads_are_rejected() {
        assert!(parse_args(&args(&["--target", "x", "--workers", "0"])).is_err());
        assert!(parse_args(&args(&["--target", "x", "--threads-per-worker", "0"])).is_err());
    }

    #[test]
    fn jobs_are_distributed_big_first_to_the_least_loaded() {
        let ranges = vec![
            PrefixRange {
                start: 0,
                count: 40,
            },
            PrefixRange {
                start: 40,
                count: 40,
            },
            PrefixRange {
                start: 80,
                count: 20,
            },
        ];
        let jobs = distribute_jobs(ranges, 2);
        assert_eq!(jobs.len(), 2);
        let total: u64 = jobs
            .iter()
            .flat_map(|j| j.ranges.iter().map(|r| r.count))
            .sum();
        assert_eq!(total, 100); // nothing dropped
                                // Loads 60/40 at worst: biggest (40) to w0, next (40) to w1, 20 to w1.
        let mut counts: Vec<u64> = jobs
            .iter()
            .map(|j| j.ranges.iter().map(|r| r.count).sum())
            .collect();
        counts.sort_unstable();
        assert_eq!(counts, vec![40, 60]);
    }

    #[test]
    fn empty_ranges_and_surplus_workers_are_dropped() {
        let jobs = distribute_jobs(
            vec![
                PrefixRange {
                    start: 0,
                    count: 10,
                },
                PrefixRange {
                    start: 10,
                    count: 0,
                },
            ],
            8,
        );
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].ranges.len(), 1);
        assert!(distribute_jobs(vec![], 4).is_empty());
        assert!(distribute_jobs(vec![PrefixRange { start: 0, count: 5 }], 0).is_empty());
    }

    #[test]
    fn engine_resolution_prefers_the_explicit_flag() {
        // Explicit flag wins even when the file does not exist (the caller
        // then surfaces the missing-file error with the exact path).
        let p = resolve_engine(Some(&PathBuf::from("/nonexistent/cracker-cli"))).unwrap();
        assert_eq!(p, PathBuf::from("/nonexistent/cracker-cli"));
        assert!(
            resolve_engine(None).is_ok(),
            "dev checkout should find the built engine or fail with the guidance error"
        );
    }

    #[test]
    fn exit_code_table_is_stable() {
        // The codes are contract; the compiler enforces exhaustiveness, this
        // pins the values.
        assert_eq!(EXIT_USAGE, 2);
        assert_eq!(EXIT_REFUSED, 3);
        assert_eq!(EXIT_INTERRUPTED, 4);
        assert_eq!(EXIT_INCOMPLETE, 5);
    }
}
