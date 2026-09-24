//! Machine profile detection and the worker-count guardrails.
//!
//! At startup the factory detects logical cores and available RAM, computes a
//! safe-max worker count, and refuses (unless `--force`) to oversubscribe the
//! machine into memory exhaustion. The detected profile and the formula are
//! recorded in the run report so an app UI can reuse them.

use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Measured per-worker memory footprint base: peak RSS of a `cracker-cli`
/// worker with 1 rayon thread was 1,164 kB on the dev sandbox (8-core,
/// 8 GB RAM; measured by sampling VmHWM during a 3,000-prefix walk). The
/// constant carries ~3.5x headroom for allocator arenas, deeper call stacks
/// on longer walks, and page-table overhead.
pub const WORKER_BASE_FOOTPRINT_BYTES: u64 = 4 * 1024 * 1024;

/// Additional footprint per worker thread: rayon reserves a default 2 MiB
/// stack per thread; touched RSS is far smaller but the reservation is the
/// honest planning number for what the OS must be able to back.
pub const WORKER_THREAD_FOOTPRINT_BYTES: u64 = 2 * 1024 * 1024;

/// Per-worker footprint for a worker running `threads` rayon threads.
pub fn per_worker_footprint_bytes(threads: usize) -> u64 {
    WORKER_BASE_FOOTPRINT_BYTES + WORKER_THREAD_FOOTPRINT_BYTES.saturating_mul(threads as u64)
}

/// Safe-max worker count: `min(logical_cores, floor(available_ram / footprint))`,
/// never zero. When RAM is undetectable the core count is the only bound and
/// the caller must note that detection failed.
pub fn safe_max_workers(
    logical_cores: u32,
    available_ram_bytes: Option<u64>,
    footprint_per_worker: u64,
) -> (u32, Option<u32>) {
    let ram_bound = available_ram_bytes
        .map(|ram| (ram / footprint_per_worker.max(1)).max(1) as u32)
        .filter(|_| footprint_per_worker > 0);
    let safe = match ram_bound {
        Some(ram_bound) => logical_cores.min(ram_bound),
        None => logical_cores,
    };
    (safe.max(1), ram_bound)
}

/// What the OS reports about this machine.
#[derive(Debug, Clone)]
pub struct MachineProfile {
    pub logical_cores: u32,
    pub available_ram_bytes: Option<u64>,
    pub total_ram_bytes: Option<u64>,
    /// Footprint used for the safe-max computation.
    pub per_worker_footprint_bytes: u64,
    pub safe_max_workers: u32,
    /// The RAM half of the min() when RAM was detectable, else None.
    pub ram_bound_workers: Option<u32>,
}

impl MachineProfile {
    pub fn detect(threads_per_worker: usize) -> Self {
        let logical_cores = std::thread::available_parallelism()
            .map(NonZeroUsize::get)
            .unwrap_or(1) as u32;
        let (available, total) = read_meminfo();
        let footprint = per_worker_footprint_bytes(threads_per_worker);
        let (safe_max_workers, ram_bound_workers) =
            safe_max_workers(logical_cores, available, footprint);
        Self {
            logical_cores,
            available_ram_bytes: available,
            total_ram_bytes: total,
            per_worker_footprint_bytes: footprint,
            safe_max_workers,
            ram_bound_workers,
        }
    }

    /// Guardrail verdict for a requested worker count. `Ok(warnings)` runs
    /// normally; `Err(reason)` refuses.
    pub fn check_worker_count(&self, requested: u32) -> Result<Vec<String>, String> {
        let mut warnings = Vec::new();
        if requested > self.safe_max_workers {
            let ram_part = match (self.available_ram_bytes, self.ram_bound_workers) {
                (Some(ram), Some(ram_bound)) => format!(
                    "floor(available RAM {} / per-worker footprint {} B) = {}",
                    format_bytes(ram),
                    self.per_worker_footprint_bytes,
                    ram_bound
                ),
                _ => "available RAM undetectable (no bound applied)".to_string(),
            };
            let binding = if self.ram_bound_workers.is_some()
                && self.ram_bound_workers.unwrap() < self.logical_cores
            {
                "memory exhaustion risk: the RAM bound is the binding constraint"
            } else {
                "the core count is the binding constraint (oversubscribed workers thrash caches and add no throughput)"
            };
            return Err(format!(
                "refusing to start: requested {} workers exceeds safe-max {}\n  \
                 safe-max = min(logical cores {}, {}) = {}\n  \
                 per-worker footprint = {} B (base {} B + {} B per worker thread)\n  \
                 why: {} - memory accounting, not ideology; pass --force to override",
                requested,
                self.safe_max_workers,
                self.logical_cores,
                ram_part,
                self.safe_max_workers,
                self.per_worker_footprint_bytes,
                WORKER_BASE_FOOTPRINT_BYTES,
                WORKER_THREAD_FOOTPRINT_BYTES,
                binding,
            ));
        }
        if requested > self.logical_cores {
            warnings.push(format!(
                "{} workers > {} logical cores: diminishing returns (oversubscription ~{:.1}x); throughput will plateau near the core count",
                requested,
                self.logical_cores,
                requested as f64 / self.logical_cores as f64
            ));
        }
        Ok(warnings)
    }
}

fn format_bytes(bytes: u64) -> String {
    let gib = bytes as f64 / (1024.0 * 1024.0 * 1024.0);
    format!("{gib:.1} GiB")
}

/// (MemAvailable, MemTotal) in bytes from /proc/meminfo; None when absent
/// (non-Linux or restricted /proc) so callers degrade to core-only bounds.
fn read_meminfo() -> (Option<u64>, Option<u64>) {
    let Ok(text) = std::fs::read_to_string("/proc/meminfo") else {
        return (None, None);
    };
    let parse_kb = |key: &str| -> Option<u64> {
        text.lines()
            .find_map(|line| {
                let rest = line.strip_prefix(key)?;
                let rest = rest.strip_prefix(':')?;
                rest.split_whitespace().next()?.parse::<u64>().ok()
            })
            .map(|kb| kb * 1024)
    };
    (parse_kb("MemAvailable"), parse_kb("MemTotal"))
}

/// Shared run state the orchestrator polls.
#[derive(Debug, Clone, Default)]
pub struct ShutdownFlag(pub Arc<AtomicBool>);

impl ShutdownFlag {
    pub fn raised(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

/// Register SIGINT and SIGTERM to raise `flag`. Returns an error string when
/// registration fails (the run then simply cannot be interrupted gracefully).
pub fn register_signal_handlers(flag: &ShutdownFlag) -> Result<(), String> {
    use signal_hook::consts::{SIGINT, SIGTERM};
    signal_hook::flag::register(SIGINT, Arc::clone(&flag.0))
        .map_err(|e| format!("SIGINT handler: {e}"))?;
    signal_hook::flag::register(SIGTERM, Arc::clone(&flag.0))
        .map_err(|e| format!("SIGTERM handler: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_max_binds_to_the_tighter_constraint() {
        // RAM-rich: cores bind.
        let (safe, ram) = safe_max_workers(8, Some(8 * 1024 * 1024 * 1024), 4 * 1024 * 1024);
        assert_eq!(safe, 8);
        assert_eq!(ram, Some(2048));
        // RAM-poor: RAM binds (24 MiB / 4 MiB per worker = 6 < 8 cores).
        let (safe, ram) = safe_max_workers(8, Some(24 * 1024 * 1024), 4 * 1024 * 1024);
        assert_eq!(safe, 6);
        assert_eq!(ram, Some(6));
        // Absurdly small RAM still yields at least one worker.
        let (safe, _) = safe_max_workers(8, Some(1024), 4 * 1024 * 1024);
        assert_eq!(safe, 1);
        // Undetectable RAM: core-only bound.
        let (safe, ram) = safe_max_workers(12, None, 4 * 1024 * 1024);
        assert_eq!((safe, ram), (12, None));
        // Zero footprint (defensive): no RAM bound, cores only.
        let (safe, ram) = safe_max_workers(8, Some(1024), 0);
        assert_eq!((safe, ram), (8, None));
    }

    #[test]
    fn footprint_grows_with_worker_threads() {
        assert_eq!(per_worker_footprint_bytes(1), 6 * 1024 * 1024);
        assert_eq!(per_worker_footprint_bytes(4), 12 * 1024 * 1024);
    }

    #[test]
    fn guardrail_refuses_over_safe_max_and_warns_over_cores() {
        let profile = MachineProfile {
            logical_cores: 8,
            available_ram_bytes: Some(8 * 1024 * 1024 * 1024),
            total_ram_bytes: Some(8 * 1024 * 1024 * 1024),
            per_worker_footprint_bytes: per_worker_footprint_bytes(1),
            safe_max_workers: 8,
            ram_bound_workers: Some(2048),
        };
        // N <= safe-max, N <= cores: clean run.
        assert_eq!(profile.check_worker_count(8).unwrap(), Vec::<String>::new());
        // N > safe-max: refusal names the formula and the bound.
        let err = profile.check_worker_count(64).unwrap_err();
        assert!(err.contains("safe-max 8"), "{err}");
        assert!(err.contains("--force"), "{err}");
        assert!(err.contains("memory accounting"), "{err}");
    }

    #[test]
    fn guardrail_warns_when_ram_is_scarcer_than_cores() {
        // 8 cores but only 3 workers of RAM headroom: N=3..8 warns, 9+ refuses.
        let profile = MachineProfile {
            logical_cores: 8,
            available_ram_bytes: Some(12 * 1024 * 1024),
            total_ram_bytes: Some(16 * 1024 * 1024),
            per_worker_footprint_bytes: 4 * 1024 * 1024,
            safe_max_workers: 3,
            ram_bound_workers: Some(3),
        };
        let warnings = profile.check_worker_count(3).unwrap();
        assert!(warnings.is_empty());
        assert!(profile.check_worker_count(9).is_err());
        assert!(profile
            .check_worker_count(9)
            .unwrap_err()
            .contains("memory exhaustion risk"));
    }

    #[test]
    fn meminfo_parses_on_this_machine() {
        let (available, total) = read_meminfo();
        if let (Some(a), Some(t)) = (available, total) {
            assert!(a > 0 && t > 0 && a <= t);
        }
        // Either way the profile detector must not panic.
        let p = MachineProfile::detect(1);
        assert!(p.logical_cores >= 1);
        assert!(p.safe_max_workers >= 1);
    }
}
