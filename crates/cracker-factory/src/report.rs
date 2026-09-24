//! Run-report construction: the run-report.json schema, scanned-prefix
//! verification, resume-range computation, and resume-file parsing.
//!
//! The report is the machine-facing artifact an app UI consumes; every field
//! it carries is either measured this run or explicitly labeled hypothetical
//! (scale estimates). It never implies a declared huge space was searched.

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::machine::MachineProfile;
use crate::scale::notes;
use crate::worker::{Fleet, MatchInfo, RangeStatus};

pub const SCHEMA_VERSION: u32 = 1;

pub const SAFE_MAX_FORMULA: &str =
    "min(logical_cores, floor(available_ram / per_worker_footprint))";

pub fn machine_json(p: &MachineProfile) -> serde_json::Value {
    json!({
        "logical_cores": p.logical_cores,
        "available_ram_bytes": p.available_ram_bytes,
        "total_ram_bytes": p.total_ram_bytes,
        "per_worker_footprint_bytes": p.per_worker_footprint_bytes,
        "per_worker_footprint_source": "measured: peak RSS 1,164 kB for a 1-thread cracker-cli worker (VmHWM, 8-core/8GB sandbox) + 3.5x headroom; plus 2 MiB stack reservation per worker thread",
        "safe_max_workers": p.safe_max_workers,
        "ram_bound_workers": p.ram_bound_workers,
        "safe_max_formula": SAFE_MAX_FORMULA,
    })
}

/// The honest-scaling statements every report carries.
pub fn honest_notes() -> Vec<&'static str> {
    vec![
        notes::CLASSICAL_LINEAR,
        notes::GROVER_SHARDING,
        notes::GROVER_MULTI_TARGET,
        notes::TWO_256_CLASSICAL,
        notes::TWO_256_ENERGY,
    ]
}

/// Prefix interval actually scanned by one range invocation.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScannedInterval {
    pub worker_id: u32,
    pub start: u64,
    /// Exclusive end.
    pub end: u64,
    pub complete: bool,
}

/// Intervals of the demo space that were actually scanned: exhausted/found
/// ranges in full, partial ranges up to their last-seen cursor.
pub fn collect_scanned(fleet: &Fleet) -> Vec<ScannedInterval> {
    let mut out = Vec::new();
    for h in &fleet.handles {
        for st in h.shared.snapshot_states() {
            let complete = matches!(st.status, RangeStatus::Exhausted | RangeStatus::Found);
            let done = st.prefixes_done.min(st.range.count);
            let end = if complete {
                st.range.end()
            } else {
                st.range.start + done
            };
            if end > st.range.start {
                out.push(ScannedInterval {
                    worker_id: h.shared.worker_id,
                    start: st.range.start,
                    end,
                    complete,
                });
            }
        }
    }
    out
}

/// Machine-check: sort by start, require strict non-overlap. Returns the
/// union size (prefix units).
pub fn verify_disjoint(intervals: &[ScannedInterval]) -> Result<u64, String> {
    let mut sorted: Vec<&ScannedInterval> = intervals.iter().collect();
    sorted.sort_by_key(|i| (i.start, i.end));
    let mut total: u64 = 0;
    let mut cursor: Option<u64> = None;
    for i in sorted {
        if let Some(c) = cursor {
            if i.start < c {
                return Err(format!(
                    "overlap detected: worker {} range [{}, {}) starts before cursor {}",
                    i.worker_id, i.start, i.end, c
                ));
            }
        }
        total += i.end - i.start;
        cursor = Some(i.end);
    }
    Ok(total)
}

/// Resume ranges for an unfinished run: exhausted/found ranges are done;
/// others contribute their exact remainder when the cursor is trustworthy
/// (1-thread walks walk ordinals in order) or their full extent otherwise.
pub fn compute_resume(fleet: &Fleet) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for h in &fleet.handles {
        for st in h.shared.snapshot_states() {
            if matches!(st.status, RangeStatus::Exhausted | RangeStatus::Found) {
                continue;
            }
            match st.exact_resume() {
                Some(r) if r.count > 0 => out.push(json!({
                    "start": r.start, "count": r.count, "resume_exact": true,
                    "origin_worker": h.shared.worker_id,
                })),
                Some(_) => {} // cursor reached the range end; nothing to redo
                None if st.range.count > 0 => out.push(json!({
                    "start": st.range.start, "count": st.range.count, "resume_exact": false,
                    "origin_worker": h.shared.worker_id,
                })),
                None => {}
            }
        }
    }
    out
}

/// Terminal status of a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RunStatus {
    /// A target was recovered.
    Found,
    /// Full space walked, no match (exit 1).
    Exhausted,
    /// SIGINT/SIGTERM: stopped with a resume point (exit 4).
    Interrupted,
    /// A worker failed and part of the space went unscanned (exit 5).
    Incomplete,
    /// --budget-seconds probe: rate measured, space not searched (exit 0).
    BudgetedProbe,
}

/// Minimal typed view of a saved run report, for `--resume`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResumeFile {
    pub schema_version: u32,
    #[serde(default)]
    pub targets: Vec<String>,
    pub address_type: String,
    pub resume: ResumeSection,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResumeSection {
    #[serde(default)]
    pub ranges: Vec<ResumeRange>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct ResumeRange {
    pub start: u64,
    pub count: u64,
    #[serde(default)]
    pub resume_exact: bool,
}

pub fn load_resume_file(path: &std::path::Path) -> Result<ResumeFile, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("cannot read resume file {}: {e}", path.display()))?;
    let file: ResumeFile = serde_json::from_str(&text).map_err(|e| {
        format!(
            "resume file {} is not a valid run report: {e}",
            path.display()
        )
    })?;
    if file.schema_version != SCHEMA_VERSION {
        return Err(format!(
            "resume file schema_version {} != {}",
            file.schema_version, SCHEMA_VERSION
        ));
    }
    Ok(file)
}

/// Match records as serialized into the report.
pub fn matches_json(matches: &[MatchInfo], winner_seq: Option<u64>) -> serde_json::Value {
    let arr: Vec<serde_json::Value> = matches
        .iter()
        .map(|m| {
            json!({
                "seq": m.seq,
                "worker_id": m.worker_id,
                "range_index": m.range_index,
                "mnemonic": m.mnemonic,
                "path": m.path,
                "address": m.address,
                "all_addresses": m.all_addresses,
                "is_winner": winner_seq == Some(m.seq),
            })
        })
        .collect();
    serde_json::Value::Array(arr)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker::PrefixRange;

    /// Two workers, one range each, with manually staged states - no real
    /// subprocesses needed for report-logic tests.
    type StagedRange = (PrefixRange, RangeStatus, u64, bool);
    type StagedWorker = (u32, Vec<StagedRange>);

    fn staged_fleet(states: Vec<StagedWorker>) -> Fleet {
        let mut handles = Vec::new();
        let signals = std::sync::Arc::new(crate::worker::RunSignals::default());
        let matches = std::sync::Arc::new(std::sync::Mutex::new(Vec::<MatchInfo>::new()));
        for (worker_id, ranges) in states {
            let shared = std::sync::Arc::new(crate::worker::WorkerShared {
                worker_id,
                job: std::sync::Mutex::new(
                    ranges
                        .into_iter()
                        .map(|(range, status, prefixes_done, resume_exact)| {
                            crate::worker::RangeState {
                                range,
                                status,
                                prefixes_done,
                                derived: prefixes_done,
                                exit_code: None,
                                resume_exact,
                            }
                        })
                        .collect(),
                ),
                signals: std::sync::Arc::clone(&signals),
                last_event_ms: std::sync::atomic::AtomicU64::new(0),
                pid: std::sync::atomic::AtomicU32::new(0),
                child: std::sync::Mutex::new(None),
                matches: std::sync::Arc::clone(&matches),
            });
            handles.push(crate::worker::WorkerHandle {
                shared,
                driver: std::thread::spawn(|| {}),
            });
        }
        Fleet {
            handles,
            signals,
            matches,
        }
    }

    #[test]
    fn scanned_intervals_are_disjoint_for_split_ranges() {
        let fleet = staged_fleet(vec![
            (
                0,
                vec![(
                    PrefixRange {
                        start: 0,
                        count: 10,
                    },
                    RangeStatus::Exhausted,
                    10,
                    false,
                )],
            ),
            (
                1,
                vec![(
                    PrefixRange {
                        start: 10,
                        count: 10,
                    },
                    RangeStatus::Exhausted,
                    10,
                    false,
                )],
            ),
        ]);
        let intervals = collect_scanned(&fleet);
        let total = verify_disjoint(&intervals).unwrap();
        assert_eq!(total, 20);
    }

    #[test]
    fn overlapping_scan_is_detected() {
        let fleet = staged_fleet(vec![
            (
                0,
                vec![(
                    PrefixRange {
                        start: 0,
                        count: 10,
                    },
                    RangeStatus::Exhausted,
                    10,
                    false,
                )],
            ),
            (
                1,
                vec![(
                    PrefixRange {
                        start: 5,
                        count: 10,
                    },
                    RangeStatus::Exhausted,
                    10,
                    false,
                )],
            ),
        ]);
        let intervals = collect_scanned(&fleet);
        let err = verify_disjoint(&intervals).unwrap_err();
        assert!(err.contains("overlap"), "{err}");
    }

    #[test]
    fn partial_cursors_count_only_scanned_prefixes() {
        let fleet = staged_fleet(vec![(
            0,
            vec![(
                PrefixRange {
                    start: 100,
                    count: 50,
                },
                RangeStatus::Canceled,
                20,
                true,
            )],
        )]);
        let intervals = collect_scanned(&fleet);
        assert_eq!(verify_disjoint(&intervals).unwrap(), 20);
        let resume = compute_resume(&fleet);
        assert_eq!(resume.len(), 1);
        assert_eq!(resume[0]["start"], 120);
        assert_eq!(resume[0]["count"], 30);
        assert_eq!(resume[0]["resume_exact"], true);
    }

    #[test]
    fn conservative_resume_replays_when_cursor_untrusted() {
        let fleet = staged_fleet(vec![(
            0,
            vec![(
                PrefixRange {
                    start: 100,
                    count: 50,
                },
                RangeStatus::Canceled,
                20,
                false, // cursor not trustworthy (multi-thread walk)
            )],
        )]);
        let resume = compute_resume(&fleet);
        assert_eq!(resume.len(), 1);
        assert_eq!(resume[0]["start"], 100);
        assert_eq!(resume[0]["count"], 50);
        assert_eq!(resume[0]["resume_exact"], false);
    }

    #[test]
    fn finished_ranges_produce_no_resume() {
        let fleet = staged_fleet(vec![(
            0,
            vec![
                (
                    PrefixRange {
                        start: 0,
                        count: 10,
                    },
                    RangeStatus::Exhausted,
                    10,
                    false,
                ),
                (
                    PrefixRange {
                        start: 10,
                        count: 0,
                    },
                    RangeStatus::Canceled,
                    0,
                    false,
                ),
            ],
        )]);
        assert!(compute_resume(&fleet).is_empty());
    }

    #[test]
    fn resume_file_round_trip() {
        let file = ResumeFile {
            schema_version: 1,
            targets: vec!["0xabc".to_string()],
            address_type: "eth".to_string(),
            resume: ResumeSection {
                ranges: vec![ResumeRange {
                    start: 5,
                    count: 10,
                    resume_exact: true,
                }],
            },
        };
        let text = serde_json::to_string(&file).unwrap();
        let parsed = load_resume_file_from_str(&text).unwrap();
        assert_eq!(parsed.resume.ranges[0].start, 5);
        assert_eq!(parsed.resume.ranges[0].count, 10);
        assert!(parsed.resume.ranges[0].resume_exact);
        // Wrong schema version is rejected.
        let bad = text.replace("\"schema_version\":1", "\"schema_version\":999");
        assert!(load_resume_file_from_str(&bad).is_err());
    }

    fn load_resume_file_from_str(text: &str) -> Result<ResumeFile, String> {
        let file: ResumeFile = serde_json::from_str(text)
            .map_err(|e| format!("resume file is not a valid run report: {e}"))?;
        if file.schema_version != SCHEMA_VERSION {
            return Err(format!(
                "resume file schema_version {} != {}",
                file.schema_version, SCHEMA_VERSION
            ));
        }
        Ok(file)
    }
}
