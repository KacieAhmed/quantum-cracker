//! The honest scale model: measured-rate extrapolation, human-duration
//! formatting, and the Grover sharding math that the report must state
//! verbatim so no output can imply a huge space was completed.

use ethnum::U256;

use crate::plan::{limbs, u256_to_f64};

pub mod notes {
    /// The honest-scaling statements embedded in run reports and the README.
    /// Kept as code so the two can never drift apart.
    pub const CLASSICAL_LINEAR: &str = "Parallel classical workers scale linearly: N workers over disjoint contiguous ranges cover the space in ~1/N wall-clock until cores saturate (measured in the factory benchmark).";

    pub const GROVER_SHARDING: &str = "Parallel Grover runs over disjoint partitions do not scale linearly: a single-target Grover search over N items costs ~sqrt(N) oracle queries; sharding N across M machines holding disjoint partitions costs M*sqrt(N/M) = sqrt(M)*sqrt(N) total queries - a sqrt(M) parallel penalty, because amplitude interference cannot be shared across oracles. Parallel quantum hardware helps per-machine wall-clock, not total query cost.";

    pub const GROVER_MULTI_TARGET: &str = "T marked targets reduce the query cost to ~sqrt(N/T) (Boyer et al., 1998): with T targets the search costs sqrt(N/T), so a fleet over disjoint partitions recovers only the sqrt(N/T) single-partition cost - multi-target amplitude amplification, not naive sharding, is where quantum parallelism pays.";

    pub const TWO_256_CLASSICAL: &str = "A 2^256 classical walk at the engine's measured 5,479 full derivations/s per 8-core worker needs 6.7e65 such workers busy for one year (1.158e77 / (5,479 * 3.156e7 s)).";

    pub const TWO_256_ENERGY: &str = "At the Landauer limit (kT*ln2 ~ 2.87e-21 J per irreversible bit erasure at 300 K), the Sun's total output (3.83e26 W) yields ~4.2e54 irreversible computations/year - a 2^256 walk needs ~2.7e22 years of the Sun's entire output (about 1e30 years if only the solar flux Earth intercepts is usable). 2^256 is out of reach even with unlimited funds.";

    pub const VERDICT_NEVER: &str =
        "verdict: never - this run measured the machine rate; it did not search the declared space";
}

/// Seconds per Julian year (365.25 d), the convention for scale math.
pub const SECONDS_PER_YEAR: f64 = 31_557_600.0;

/// Age of the universe, for the top rung of the duration ladder.
pub const UNIVERSE_AGE_YEARS: f64 = 13.8e9;

/// Seconds in a one-year walk for one 8-core worker at the engine's measured
/// rate (5,479 full BIP-39 derivations/s; classical engine PR #3).
pub const REFERENCE_DERIVATIONS_PER_SEC: f64 = 5_479.0;

/// Reference worker-years for a 2^256 walk at the reference rate: about
/// 6.7e65 8-core workers busy for a year. Takes the f64 magnitude because
/// 2^256 itself does not fit u256 — exactness is impossible, honesty is not.
pub fn worker_years_for_space_f64(space_raw: f64, derivations_per_sec: f64) -> f64 {
    space_raw / (derivations_per_sec.max(1.0) * SECONDS_PER_YEAR)
}

/// Grouped decimal for u64-scale counts, scientific `1.158e77` style beyond.
pub fn format_count(v: U256) -> String {
    let [lo, hi] = limbs(v);
    if hi == 0 {
        let mut s = lo.to_string();
        // thousands separators from the right
        let bytes = s.as_bytes();
        let mut out = String::with_capacity(s.len() + s.len() / 3);
        for (i, b) in bytes.iter().enumerate() {
            if i > 0 && (bytes.len() - i) % 3 == 0 {
                out.push(',');
            }
            out.push(*b as char);
        }
        s = out;
        return s;
    }
    format_sci(u256_to_f64(v))
}

/// `6.7e65` -> `6.7x10^65`, three significant digits.
pub fn format_sci(x: f64) -> String {
    if x == 0.0 {
        return "0".to_string();
    }
    let exp = x.abs().log10().floor() as i32;
    let mantissa = x / 10f64.powi(exp);
    format!("{mantissa:.3}x10^{exp}")
}

/// Human duration: `3.2 s`, `5.1 min`, `2.4 h`, `317 d`, `1.2 yr`, `4.5 kyr`,
/// `3.0 Myr`, `2.1 Gyr`, and beyond that multiples of the age of the universe.
pub fn format_duration(seconds: f64) -> String {
    if !seconds.is_finite() || seconds < 0.0 {
        return "unknown".to_string();
    }
    const MIN: f64 = 60.0;
    const HOUR: f64 = 3600.0;
    const DAY: f64 = 86_400.0;
    const YEAR: f64 = SECONDS_PER_YEAR;
    if seconds < MIN {
        format!("{seconds:.1} s")
    } else if seconds < HOUR {
        format!("{:.1} min", seconds / MIN)
    } else if seconds < DAY {
        format!("{:.1} h", seconds / HOUR)
    } else if seconds < YEAR {
        format!("{:.1} d", seconds / DAY)
    } else {
        let years = seconds / YEAR;
        if years < 1e3 {
            format!("{years:.1} yr")
        } else if years < 1e6 {
            format!("{:.1} kyr", years / 1e3)
        } else if years < 1e9 {
            format!("{:.1} Myr", years / 1e6)
        } else if years < UNIVERSE_AGE_YEARS {
            format!("{:.1} Gyr", years / 1e9)
        } else {
            format!(
                "{} ages of the universe ({:.1e} yr)",
                format_sci(years / UNIVERSE_AGE_YEARS),
                years
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() <= tol * b.abs().max(1.0)
    }

    #[test]
    fn worker_years_for_two_to_the_256_match_the_published_figure() {
        // The claim in the README: 6.7e65 8-core workers for a one-year walk.
        // 2^256 is not representable in u256, so use the f64 magnitude.
        let years = worker_years_for_space_f64(2.0f64.powi(256), REFERENCE_DERIVATIONS_PER_SEC);
        assert!(close(years, 6.7e65, 0.02), "got {years:e}, want ~6.7e65");
    }

    #[test]
    fn format_sci_and_count_render_honest_magnitudes() {
        assert_eq!(format_sci(6.696e65), "6.696x10^65");
        assert_eq!(format_count(U256::from(16_777_216u64)), "16,777,216");
        assert_eq!(format_count(U256::from(999u64)), "999");
        // A u256-scale count renders in scientific notation.
        let big = (U256::from(1u8)) << 255;
        assert!(
            format_count(big).contains("x10^76"),
            "{}",
            format_count(big)
        );
    }

    #[test]
    fn durations_climb_the_honest_ladder() {
        assert_eq!(format_duration(0.5), "0.5 s");
        assert_eq!(format_duration(90.0), "1.5 min");
        assert_eq!(format_duration(7_200.0), "2.0 h");
        assert_eq!(format_duration(3.0 * 86_400.0), "3.0 d");
        assert_eq!(format_duration(SECONDS_PER_YEAR * 1.5), "1.5 yr");
        assert_eq!(format_duration(SECONDS_PER_YEAR * 40_000.0), "40.0 kyr");
        assert_eq!(format_duration(SECONDS_PER_YEAR * 2.5e6), "2.5 Myr");
        assert_eq!(format_duration(SECONDS_PER_YEAR * 5e9), "5.0 Gyr");
        let far = format_duration(SECONDS_PER_YEAR * 2.7e22);
        assert!(far.contains("ages of the universe"), "{far}");
    }

    #[test]
    fn energy_note_arithmetic_is_self_consistent() {
        // Sun: 3.828e26 W -> ops/year at the 300 K Landauer limit.
        let sun_ops_per_year = 3.828e26 * SECONDS_PER_YEAR / 2.87e-21;
        assert!(close(sun_ops_per_year, 4.21e54, 0.02));
        let years = 1.158e77 / sun_ops_per_year;
        assert!(close(years, 2.75e22, 0.02));
        // Earth-intercepted fraction gives the ~1e30-year scenario.
        let earth_ops_per_year = 1.74e17 * SECONDS_PER_YEAR / 2.87e-21;
        let earth_years = 1.158e77 / earth_ops_per_year;
        assert!(close(earth_years, 6.0e31, 0.05));
    }
}
