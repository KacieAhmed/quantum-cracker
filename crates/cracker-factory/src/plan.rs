//! u256-safe range planning and machine-checkable coverage proofs.
//!
//! The planner works in **raw-candidate units** over a half-open interval
//! `[start, start + len)` represented as `u256` endpoints, so any keyspace
//! that fits in 256 bits can be planned — even though the current engine only
//! ever searches the pooled demo spaces (2^24-2^25 raw assemblies).
//! Representing or partitioning a huge keyspace says nothing about being able
//! to search it.
//!
//! Ranges are aligned to the enumeration's assembly granularity: the engine
//! enumerates 16 raw assemblies per prefix ordinal in both demo spaces (the
//! 12th-word pool is 16 words in each), so a worker range maps onto whole
//! prefix ordinals only when its start and length are multiples of the pool
//! size. [`RangePlan::split_aligned`] guarantees this.

use std::fmt;

use ethnum::U256;
use serde::Serialize;

/// Error type for planning and space-size parsing.
#[derive(Debug, thiserror::Error)]
pub enum PlanError {
    #[error("space size expression is not representable: {0}")]
    BadExpr(String),
    #[error("worker count must be at least 1")]
    ZeroWorkers,
    #[error("granularity must be at least 1")]
    ZeroGranularity,
    #[error("space start {start} is not aligned to granularity {granularity}")]
    UnalignedSpace { start: String, granularity: String },
    #[error("range does not fit in u64 (needed by the engine's --start/--count): start={start} len={len}")]
    NotU64 { start: String, len: String },
}

const LO: usize = 0; // little-endian limb order in ethnum's [u128; 2]
const HI: usize = 1;

/// (low, high) u128 limbs of a `u256` (ethnum's layout).
pub const fn limbs(v: U256) -> [u128; 2] {
    [v.0[LO], v.0[HI]]
}

/// Lossy-but-honest widening used only for ratio math in the scale model:
/// the high limb dominates long before f64 precision runs out.
pub fn u256_to_f64(v: U256) -> f64 {
    let [lo, hi] = limbs(v);
    (hi as f64) * 340_282_366_920_938_463_463_374_607_431_768_211_456.0 + (lo as f64)
}

/// Half-open range `[start, start + len)` in raw-candidate units, u256-wide.
/// `len` is stored instead of an exclusive end so the full 2^256-space
/// (`start = 0, len = 2^256 - 1` and everything below) is representable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Range256 {
    pub start: U256,
    pub len: U256,
}

impl Range256 {
    pub fn new(start: u64, len: U256) -> Self {
        Self {
            start: U256::from(start),
            len,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len == U256::from(0u8)
    }

    pub fn end(&self) -> U256 {
        self.start + self.len
    }
}

impl fmt::Display for Range256 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}, {})", self.start, self.end())
    }
}

impl Serialize for Range256 {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("Range256", 2)?;
        s.serialize_field("start", &self.start.to_string())?;
        s.serialize_field("len", &self.len.to_string())?;
        s.end()
    }
}

/// A planned fleet: one contiguous aligned range per worker (empty ranges for
/// workers beyond the space's capacity), plus the proof that the plan covers
/// the space exactly.
#[derive(Debug, Clone)]
pub struct RangePlan {
    /// Full space that was planned (raw-candidate units).
    pub space: Range256,
    /// Alignment unit (raw assemblies per prefix ordinal; 16 for the corpus pool).
    pub granularity: U256,
    /// Exactly `n` ranges in worker order; ranges after the space is exhausted
    /// are empty.
    pub ranges: Vec<Range256>,
}

impl RangePlan {
    /// Split `space` into `n` ranges, contiguous in worker order, pairwise
    /// disjoint, whose union is exactly `space`.
    ///
    /// Every non-final range start and length is a multiple of `granularity`;
    /// the final range additionally absorbs any ragged tail (`space.len %
    /// granularity`) so the union stays exact. When the space holds fewer than
    /// `n` aligned units, the surplus workers get empty ranges.
    pub fn split_aligned(space: Range256, n: usize, granularity: U256) -> Result<Self, PlanError> {
        if n == 0 {
            return Err(PlanError::ZeroWorkers);
        }
        if granularity == U256::from(0u8) {
            return Err(PlanError::ZeroGranularity);
        }
        let one = U256::from(1u8);
        if space.start % granularity != U256::from(0u8) {
            return Err(PlanError::UnalignedSpace {
                start: space.start.to_string(),
                granularity: granularity.to_string(),
            });
        }

        let g = granularity;
        let units_total = space.len / g;
        let ragged = space.len % g;
        let units_per = units_total / U256::from(n as u64);
        let remainder_units = units_total % U256::from(n as u64);

        let mut ranges = Vec::with_capacity(n);
        let mut cursor = space.start;
        for i in 0..n {
            let extra = if U256::from(i as u64) < remainder_units {
                one
            } else {
                U256::from(0u8)
            };
            let units = units_per + extra;
            let mut len = units * g;
            if i == n - 1 {
                len += ragged; // last worker absorbs the ragged tail, keeping the union exact
            }
            ranges.push(Range256 { start: cursor, len });
            cursor += len;
        }

        Ok(Self {
            space,
            granularity: g,
            ranges,
        })
    }

    /// The non-empty ranges, sorted by start — the canonical view for proofs.
    pub fn non_empty_sorted(&self) -> Vec<Range256> {
        let mut v: Vec<Range256> = self
            .ranges
            .iter()
            .filter(|r| !r.is_empty())
            .cloned()
            .collect();
        v.sort_by_key(|r| r.start);
        v
    }

    /// Machine-checkable proof: sort the non-empty ranges, walk them in order,
    /// and collect every gap (uncovered hole inside the space) and overlap
    /// (double-covered interval). `exact_cover` is true iff there are none and
    /// the covered total equals the space length.
    pub fn coverage_proof(&self) -> CoverageProof {
        let sorted = self.non_empty_sorted();
        let mut gaps = Vec::new();
        let mut overlaps = Vec::new();
        let mut expected = self.space.start;
        let mut total = U256::from(0u8);
        let mut overflow = false;

        for r in &sorted {
            if r.start > expected {
                gaps.push(Range256 {
                    start: expected,
                    len: r.start - expected,
                });
            } else if r.start < expected {
                let overlap_end = if r.end() < expected {
                    r.end()
                } else {
                    expected
                };
                overlaps.push(Range256 {
                    start: r.start,
                    len: overlap_end - r.start,
                });
            }
            if r.end() > expected {
                let newly = r.end() - expected;
                total = match total.checked_add(newly) {
                    Some(t) => t,
                    None => {
                        overflow = true;
                        U256::from(0u8)
                    }
                };
                expected = r.end();
            }
        }
        if expected < self.space.end() {
            gaps.push(Range256 {
                start: expected,
                len: self.space.end() - expected,
            });
        }

        CoverageProof {
            space: self.space.clone(),
            granularity: self.granularity,
            ranges: sorted,
            total_covered: total,
            total_overflowed: overflow,
            gaps,
            overlaps,
        }
    }
}

/// Machine-checkable coverage proof over a planned space.
#[derive(Debug, Clone)]
pub struct CoverageProof {
    pub space: Range256,
    pub granularity: U256,
    /// Non-empty ranges, sorted by start.
    pub ranges: Vec<Range256>,
    /// Sum of covered units (0 and `total_overflowed = true` if the sum
    /// overflowed u256 — which itself invalidates the cover).
    pub total_covered: U256,
    pub total_overflowed: bool,
    /// Holes inside the space that no range covers, in ascending order.
    pub gaps: Vec<Range256>,
    /// Intervals covered by more than one range, in ascending order.
    pub overlaps: Vec<Range256>,
}

impl CoverageProof {
    pub fn exact_cover(&self) -> bool {
        !self.total_overflowed
            && self.total_covered == self.space.len
            && self.gaps.is_empty()
            && self.overlaps.is_empty()
    }

    /// Serialize the proof with u256 values as strings (JSON has no u256).
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "space": {
                "start": self.space.start.to_string(),
                "len": self.space.len.to_string(),
            },
            "granularity": self.granularity.to_string(),
            "ranges": self.ranges.iter().map(|r| serde_json::json!({
                "start": r.start.to_string(),
                "len": r.len.to_string(),
            })).collect::<Vec<_>>(),
            "total_covered_raw": self.total_covered.to_string(),
            "total_overflowed": self.total_overflowed,
            "gaps": self.gaps.iter().map(|g| serde_json::json!({
                "start": g.start.to_string(),
                "len": g.len.to_string(),
            })).collect::<Vec<_>>(),
            "overlaps": self.overlaps.iter().map(|o| serde_json::json!({
                "start": o.start.to_string(),
                "len": o.len.to_string(),
            })).collect::<Vec<_>>(),
            "exact_cover": self.exact_cover(),
        })
    }
}

/// f64 magnitude of a space-size expression. Accepts everything
/// `parse_space_size` does plus values beyond u256 (2^256 itself): the
/// declared-space field is reporting-only, so honesty needs the magnitude,
/// not exact representability.
pub fn parse_space_f64(expr: &str) -> Result<f64, PlanError> {
    let bad = |reason: &'static str| PlanError::BadExpr(format!("{expr:?}: {reason}"));
    let trimmed = expr.trim();
    if trimmed.is_empty() {
        return Err(bad("empty expression"));
    }
    let (base_str, exp) = match trimmed.split_once('^') {
        Some((b, e)) => (b, Some(e)),
        None => (trimmed, None),
    };
    let base = parse_u256(base_str).map_err(&bad)?;
    let Some(exp_str) = exp else {
        return Ok(u256_to_f64(base));
    };
    let exp: u32 = exp_str
        .trim()
        .parse()
        .map_err(|_| bad("exponent is not a u32"))?;
    Ok(u256_to_f64(base).powi(exp as i32))
}

/// Convert a raw-candidate plan range to the engine's prefix-ordinal range
/// (`--start` / `--count`). Exact because plan ranges are granularity-aligned.
pub fn to_prefix_range(raw: &Range256, granularity: u64) -> Result<(u64, u64), PlanError> {
    let g = U256::from(granularity);
    if raw.start % g != U256::from(0u8) || (raw.len % g != U256::from(0u8) && !raw.is_empty()) {
        return Err(PlanError::NotU64 {
            start: format!("unaligned start {}", raw.start),
            len: format!("unaligned len {}", raw.len),
        });
    }
    let start = raw.start / g;
    let count = raw.len / g;
    let [start_lo, start_hi] = limbs(start);
    let [count_lo, count_hi] = limbs(count);
    if start_hi != 0 || count_hi != 0 || start_lo > u64::MAX as u128 || count_lo > u64::MAX as u128
    {
        return Err(PlanError::NotU64 {
            start: start.to_string(),
            len: count.to_string(),
        });
    }
    Ok((start_lo as u64, count_lo as u64))
}

/// Parse a space-size expression: decimal, `0x` hex, or `base^exp` power form
/// ("2^40", "16^6"). The result must fit in u256, i.e. be at most 2^256 - 1;
/// the one value that does not fit is 2^256 itself.
pub fn parse_space_size(expr: &str) -> Result<U256, PlanError> {
    let bad = |reason: &'static str| PlanError::BadExpr(format!("{expr:?}: {reason}"));
    let trimmed = expr.trim();
    if trimmed.is_empty() {
        return Err(bad("empty expression"));
    }
    let (base_str, exp) = match trimmed.split_once('^') {
        Some((b, e)) => (b, Some(e)),
        None => (trimmed, None),
    };

    let base = parse_u256(base_str).map_err(&bad)?;
    let Some(exp_str) = exp else {
        return Ok(base);
    };
    let exp: u32 = exp_str
        .trim()
        .parse()
        .map_err(|_| bad("exponent is not a u32"))?;

    // Exponentiation by squaring with overflow detection.
    let mut result = U256::from(1u8);
    let mut base_pow = base;
    let mut e = exp;
    while e > 0 {
        if e & 1 == 1 {
            result = result
                .checked_mul(base_pow)
                .ok_or_else(|| bad("result exceeds 2^256 - 1"))?;
        }
        e >>= 1;
        if e > 0 {
            base_pow = base_pow
                .checked_mul(base_pow)
                .ok_or_else(|| bad("intermediate power exceeds 2^256 - 1"))?;
        }
    }
    Ok(result)
}

fn parse_u256(s: &str) -> Result<U256, &'static str> {
    let (digits, radix) = match s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        Some(hex) => (hex, 16),
        None => (s, 10),
    };
    if digits.is_empty() {
        return Err("no digits");
    }
    let mut acc = U256::from(0u8);
    let radix_u = U256::from(radix as u64);
    for c in digits.chars() {
        let d = c.to_digit(radix).ok_or("invalid digit for radix")? as u64;
        acc = acc.checked_mul(radix_u).ok_or("number exceeds 2^256 - 1")?;
        acc = acc
            .checked_add(U256::from(d))
            .ok_or("number exceeds 2^256 - 1")?;
    }
    Ok(acc)
}

#[cfg(test)]
mod tests {
    use super::*;

    const POOL_LEN: u64 = 16; // raw assemblies per prefix ordinal (both demo spaces)
    const RAW_SPACE_LEN: u64 = 33_554_432; // 2^21 x 16 = 2^25 (default varied-slot space)
    const LEGACY_RAW_SPACE_LEN: u64 = 16_777_216; // 16^6 = 2^24 (legacy fixed-slot space)

    fn raw_space() -> Range256 {
        Range256::new(0, U256::from(RAW_SPACE_LEN))
    }

    #[test]
    fn split_covers_the_real_demo_spaces_for_n_one_to_one_thousand() {
        for raw_len in [RAW_SPACE_LEN, LEGACY_RAW_SPACE_LEN] {
            let space = Range256::new(0, U256::from(raw_len));
            let g = U256::from(POOL_LEN);
            for n in 1..=1000usize {
                let plan = RangePlan::split_aligned(space.clone(), n, g).unwrap();
                let proof = plan.coverage_proof();
                assert!(
                    proof.exact_cover(),
                    "raw_len={raw_len} n={n}: gaps={:?} overlaps={:?} total={}",
                    proof.gaps,
                    proof.overlaps,
                    proof.total_covered
                );
                assert_eq!(proof.total_covered, U256::from(raw_len));
                // Sorted, contiguous, aligned: every non-final start+len is a
                // multiple of 16 and equals the next start.
                let sorted = proof.ranges;
                assert_eq!(sorted.len(), n.min(raw_len as usize));
                for (i, w) in sorted.iter().enumerate() {
                    assert_eq!(
                        w.start % g,
                        U256::from(0u8),
                        "raw_len={raw_len} n={n} worker {i}: unaligned start"
                    );
                    if i + 1 < sorted.len() {
                        assert_eq!(
                            w.len % g,
                            U256::from(0u8),
                            "raw_len={raw_len} n={n} worker {i}: unaligned len"
                        );
                        assert_eq!(
                            w.end(),
                            sorted[i + 1].start,
                            "raw_len={raw_len} n={n}: not contiguous at {i}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn split_with_more_workers_than_aligned_units_yields_empty_ranges() {
        // Space of 3 aligned units, 10 workers: 3 non-empty (length 1 unit),
        // 7 empty; union still exact.
        let space = Range256::new(0, U256::from(3u64 * POOL_LEN));
        let plan = RangePlan::split_aligned(space, 10, U256::from(POOL_LEN)).unwrap();
        assert_eq!(plan.ranges.iter().filter(|r| !r.is_empty()).count(), 3);
        let proof = plan.coverage_proof();
        assert!(proof.exact_cover());
        assert_eq!(proof.total_covered, U256::from(3u64 * POOL_LEN));
    }

    #[test]
    fn split_exhaustive_n_greator_than_space_size_for_every_n() {
        let space = Range256::new(0, U256::from(48u64)); // 3 units of 16
        for n in 4..=64usize {
            let plan = RangePlan::split_aligned(space.clone(), n, U256::from(POOL_LEN)).unwrap();
            assert_eq!(plan.ranges.len(), n);
            let proof = plan.coverage_proof();
            assert!(proof.exact_cover(), "n={n}");
        }
    }

    #[test]
    fn giant_u256_space_splits_exactly() {
        // A 2^100-scale space: far beyond u64, comfortably inside u256.
        let len = parse_space_size("2^100").unwrap();
        let space = Range256 {
            start: U256::from(0u8),
            len,
        };
        let g = U256::from(16u64);
        for n in [1usize, 3, 7, 128, 1000] {
            let plan = RangePlan::split_aligned(space.clone(), n, g).unwrap();
            let proof = plan.coverage_proof();
            assert!(proof.exact_cover(), "n={n}");
            assert_eq!(proof.total_covered, len, "n={n}");
            for w in &proof.ranges[..proof.ranges.len() - 1] {
                assert_eq!(w.start % g, U256::from(0u8));
                assert_eq!(w.len % g, U256::from(0u8));
            }
        }
    }

    #[test]
    fn offset_space_starts_stay_aligned() {
        let space = Range256 {
            start: U256::from(64u64),
            len: U256::from(1024u64),
        };
        let plan = RangePlan::split_aligned(space, 5, U256::from(POOL_LEN)).unwrap();
        let proof = plan.coverage_proof();
        assert!(proof.exact_cover());
        assert_eq!(proof.ranges.first().unwrap().start, U256::from(64u64));
    }

    #[test]
    fn unaligned_space_is_rejected() {
        let space = Range256 {
            start: U256::from(17u64),
            len: U256::from(1024u64),
        };
        assert!(RangePlan::split_aligned(space, 4, U256::from(POOL_LEN)).is_err());
    }

    #[test]
    fn zero_workers_and_zero_granularity_are_rejected() {
        assert!(matches!(
            RangePlan::split_aligned(raw_space(), 0, U256::from(16u64)),
            Err(PlanError::ZeroWorkers)
        ));
        assert!(matches!(
            RangePlan::split_aligned(raw_space(), 4, U256::from(0u8)),
            Err(PlanError::ZeroGranularity)
        ));
    }

    #[test]
    fn proof_detects_synthetic_gaps_and_overlaps() {
        // Manually built range sets (not from the planner) must be flagged.
        let space = Range256::new(0, U256::from(300u64));

        // Gap: [0,100) and [200,300) leave [100,200) uncovered.
        let plan_gap = RangePlan {
            space: space.clone(),
            granularity: U256::from(1u8),
            ranges: vec![
                Range256::new(0, U256::from(100u64)),
                Range256::new(200, U256::from(100u64)),
            ],
        };
        let proof = plan_gap.coverage_proof();
        assert!(!proof.exact_cover());
        assert_eq!(proof.gaps.len(), 1);
        assert_eq!(proof.gaps[0].start, U256::from(100u64));
        assert_eq!(proof.gaps[0].len, U256::from(100u64));

        // Overlap: [0,150) and [100,300) double-cover [100,150).
        let plan_overlap = RangePlan {
            space,
            granularity: U256::from(1u8),
            ranges: vec![
                Range256::new(0, U256::from(150u64)),
                Range256::new(100, U256::from(200u64)),
            ],
        };
        let proof = plan_overlap.coverage_proof();
        assert!(!proof.exact_cover());
        assert_eq!(proof.overlaps.len(), 1);
        assert_eq!(proof.overlaps[0].start, U256::from(100u64));
        assert_eq!(proof.overlaps[0].len, U256::from(50u64));
    }

    #[test]
    fn prefix_range_conversion_is_exact_for_aligned_ranges() {
        let (start, count) =
            to_prefix_range(&Range256::new(0, U256::from(2_097_152u64)), POOL_LEN).unwrap();
        assert_eq!((start, count), (0, 131_072));
        let (start, count) =
            to_prefix_range(&Range256::new(2_097_152, U256::from(16u64)), POOL_LEN).unwrap();
        assert_eq!((start, count), (131_072, 1));
    }

    #[test]
    fn prefix_range_conversion_rejects_unaligned_or_oversized() {
        assert!(to_prefix_range(&Range256::new(3, U256::from(16u64)), POOL_LEN).is_err());
        assert!(to_prefix_range(&Range256::new(0, U256::from(17u64)), POOL_LEN).is_err());
        let huge = Range256 {
            start: U256::from(0u8),
            // 2^68 raw / 16 = 2^64 prefix steps, which exceeds u64::MAX.
            len: parse_space_size("2^68").unwrap(),
        };
        assert!(to_prefix_range(&huge, POOL_LEN).is_err());
    }

    #[test]
    fn space_size_expressions_parse() {
        assert_eq!(parse_space_size("2^24").unwrap(), U256::from(16_777_216u64));
        assert_eq!(parse_space_size("16^6").unwrap(), U256::from(16_777_216u64));
        assert_eq!(
            parse_space_size("1048576").unwrap(),
            U256::from(1_048_576u64)
        );
        assert_eq!(parse_space_size("0x10000").unwrap(), U256::from(65_536u64));
        assert_eq!(parse_space_size(" 2^40 ").unwrap(), U256::from(1u64) << 40);
        assert_eq!(
            parse_space_size("2^256-1") // not supported syntax
                .err()
                .map(|e| e.to_string()),
            Some(
                "space size expression is not representable: \"2^256-1\": exponent is not a u32"
                    .to_string()
            )
        );
        // 2^256 itself cannot fit; one below can.
        assert!(parse_space_size("2^256").is_err());
        assert_eq!(parse_space_size("2^255").unwrap(), (U256::from(1u8)) << 255);
    }

    #[test]
    fn u256_roundtrip_helpers() {
        assert_eq!(
            limbs(U256::from(0x1234_5678_9abc_def0u64)),
            [0x1234_5678_9abc_def0, 0]
        );
        assert_eq!(limbs((U256::from(1u8)) << 64), [1u128 << 64, 0]);
        assert!(
            (u256_to_f64(parse_space_size("2^256").unwrap_or((U256::from(1u8)) << 255))
                - 5.789_604_461_865_81e76)
                .abs()
                < 1e60
        );
    }
}
