//! Randomized ("lottery-style") traversal — the one ordering model every
//! search version uses (Kacie's unification: every run is a random draw).
//!
//! Bounded spaces keep exact coverage: a seeded pseudo-random permutation
//! over the prefix ordinals means every phrase is still drawn exactly once,
//! just in shuffled order, so a sweep remains finishable with the same
//! disclosed space size and ETA. The full 2048^12 space has no finishable
//! order at all; its uniform sampler lives in [`crate::sampler`].
//!
//! [`Permutation`] is a Feistel-network PRP over `[0, domain)` with
//! cycle-walking for non-power-of-two domains: O(1) memory (no ordinal list
//! is ever materialized — a 3-slot varied pool spans 2048^3 ≈ 8.6e9
//! prefixes), a true bijection (coverage stays provably exact), and
//! invertible (a test that must scan a specific ordinal asks for its
//! preimage instead of assuming identity order).

/// SplitMix64: small, dependency-free, well-mixed 64-bit PRNG. Every draw's
/// words depend only on (seed, draw index), so parallel sampling is
/// deterministic regardless of thread scheduling or chunk boundaries.
pub struct SplitMix64 {
    state: u64,
}

impl SplitMix64 {
    pub fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform index in [0, 2048): the top 11 bits of a well-mixed u64
    /// (every bit of SplitMix64 output is equidistributed; the top bits are
    /// the conventional strongest).
    pub fn next_word_index(&mut self) -> u16 {
        (self.next_u64() >> 53) as u16
    }
}

/// SplitMix64 finalizer used to scatter draw indices into independent
/// streams: `stream(seed, i)` never correlates with `i`'s low bits.
pub fn mix_u64(mut z: u64) -> u64 {
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

const ROUNDS: u32 = 8;

/// A seeded pseudo-random permutation (PRP) over `[0, domain)`.
pub struct Permutation {
    domain: u64,
    /// Bits of the balanced Feistel block: the next even count >= bits needed
    /// for `domain - 1` (so both halves fit in <= 32 bits for every demo
    /// space: corpus 2^20, max varied pool 2048^3 ≈ 2^33).
    half_bits: u32,
    key: u64,
}

impl Permutation {
    /// `domain >= 1`; a domain of 1 (e.g. a pool varying only the twelfth
    /// word) is the identity permutation.
    pub fn new(domain: u64, key: u64) -> Self {
        assert!(domain >= 1, "permutation domain must be non-empty");
        let bits = 64 - (domain - 1).leading_zeros(); // domain >= 2 here
        let block_bits = bits.max(2) + (bits.max(2) & 1); // next even >= max(2, bits)
        Self {
            domain,
            half_bits: block_bits / 2,
            key,
        }
    }

    pub fn domain(&self) -> u64 {
        self.domain
    }

    fn round_f(&self, round: u32, half: u64) -> u64 {
        let z = self.key
            ^ (u64::from(round)).wrapping_mul(0x9E37_79B9_7F4A_7C15)
            ^ half.wrapping_mul(0xD6E8_FEB8_6659_3F93);
        mix_u64(z)
    }

    /// The raw (uncycle-walked) Feistel on `2 * half_bits` bits.
    fn feistel(&self, x: u64, inverse: bool) -> u64 {
        let mask = (1u64 << self.half_bits) - 1;
        let (mut left, mut right) = (x >> self.half_bits, x & mask);
        for i in 0..ROUNDS {
            let round = if inverse { ROUNDS - 1 - i } else { i };
            if inverse {
                // Forward round was (L, R) -> (R, L ^ F(R)); undo it.
                let prev_left = right ^ (self.round_f(round, left) & mask);
                right = left;
                left = prev_left;
            } else {
                let new_left = right;
                right = left ^ (self.round_f(round, right) & mask);
                left = new_left;
            }
        }
        (left << self.half_bits) | right
    }

    /// Image of `x` in `[0, domain)`: a bijection, so a sweep over all x
    /// draws every ordinal exactly once (shuffled full coverage).
    pub fn encode(&self, x: u64) -> u64 {
        debug_assert!(x < self.domain);
        if self.half_bits == 0 {
            return 0;
        }
        let mut y = self.feistel(x, false);
        while y >= self.domain {
            y = self.feistel(y, false);
        }
        y
    }

    /// Unique preimage of `y` (used by tests and by callers that must aim a
    /// range at a specific ordinal under the shuffled order).
    pub fn decode(&self, y: u64) -> u64 {
        debug_assert!(y < self.domain);
        if self.half_bits == 0 {
            return 0;
        }
        let mut x = self.feistel(y, true);
        while x >= self.domain {
            x = self.feistel(x, true);
        }
        x
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bijection_holds(domain: u64, key: u64) {
        let perm = Permutation::new(domain, key);
        let mut seen = vec![false; domain as usize];
        for x in 0..domain {
            let y = perm.encode(x);
            assert!(y < domain, "encode({x}) = {y} escaped domain {domain}");
            seen[y as usize] = true;
            assert_eq!(perm.decode(y), x, "decode is not the inverse of encode");
        }
        assert!(
            seen.iter().all(|&s| s),
            "domain {domain} key {key}: some ordinal was never drawn"
        );
    }

    #[test]
    fn permutation_is_a_bijection_on_representative_domains() {
        for &domain in &[1u64, 2, 3, 7, 100, 1_023, 2_048, 65_537, 1 << 20] {
            for &key in &[0u64, 1, 0xDEAD_BEEF, u64::MAX] {
                bijection_holds(domain, key);
            }
        }
    }

    #[test]
    fn permutation_of_a_non_power_of_two_domain_is_exact() {
        // Cycle-walking must not bias or drop ordinals near the ceiling.
        bijection_holds(2048 * 2048 * 2048 % 1_000_003 + 7, 42);
    }

    #[test]
    fn shuffle_order_depends_on_the_seed() {
        let a = Permutation::new(1 << 20, 0x1111);
        let b = Permutation::new(1 << 20, 0x2222);
        let first_diff = (0..1 << 20)
            .find(|&x| a.encode(x) != b.encode(x))
            .expect("two keys produced identical permutations");
        assert!(first_diff < 64, "permutations agreed far too long");

        // Determinism: the same key reproduces the same order exactly.
        let a2 = Permutation::new(1 << 20, 0x1111);
        assert_eq!(a.encode(123456), a2.encode(123456));
    }

    #[test]
    fn shuffle_actually_shuffles() {
        // Not a proof of randomness — a guard against an accidentally
        // identity (or near-identity) permutation: with a fixed key, the
        // first ordinals must map far from themselves.
        let perm = Permutation::new(1 << 20, 0xABCDEF);
        for x in 0..16u64 {
            let y = perm.encode(x);
            assert!(
                y >= 16,
                "ordinal {x} stayed near the front under the shuffle"
            );
        }
    }

    #[test]
    fn splitmix_streams_are_deterministic_and_well_spread() {
        let mut rng = SplitMix64::new(7);
        let first: Vec<u64> = (0..4).map(|_| rng.next_u64()).collect();
        let mut rng = SplitMix64::new(7);
        for expected in &first {
            assert_eq!(rng.next_u64(), *expected);
        }

        // 11-bit word draws: chi-square over 16 buckets (2^7 draws each
        // bucket expected) must not reject uniformity for a fixed seed.
        let mut rng = SplitMix64::new(0xC0FFEE);
        let draws = 1 << 20;
        let mut buckets = [0u64; 16];
        for _ in 0..draws {
            buckets[(rng.next_word_index() >> 7) as usize] += 1;
        }
        let expected = draws as f64 / 16.0;
        let chi2: f64 = buckets
            .iter()
            .map(|&b| {
                let d = b as f64 - expected;
                d * d / expected
            })
            .sum();
        assert!(
            chi2 < 60.0,
            "word-index stream failed the uniformity check (chi2 = {chi2})"
        );
    }
}
