//! BIP-39 mnemonic handling: wordlist access, validation, index conversion
//! (reference doc sections 2.1-2.2).

use std::sync::LazyLock;

use sha2::{Digest, Sha256};

use crate::error::{CrackerError, Result};

/// Official BIP-39 English wordlist: exactly 2048 words, sorted, embedded at
/// build time from `test-vectors/english.txt`.
const WORDLIST_TXT: &str = include_str!("../test-vectors/english.txt");

static WORDS: LazyLock<Vec<&'static str>> =
    LazyLock::new(|| WORDLIST_TXT.lines().map(str::trim).collect());

/// Number of words in the BIP-39 English wordlist (2048).
pub fn word_count() -> usize {
    WORDS.len()
}

/// Word at a wordlist index (0..2048), or `None` if out of range.
pub fn word(index: usize) -> Option<&'static str> {
    WORDS.get(index).copied()
}

/// Index of a word in the sorted English wordlist, or `None`.
pub fn word_index(word: &str) -> Option<usize> {
    WORDS.binary_search(&word).ok()
}

/// Number of mnemonic words for a given entropy size in bytes (128..=256 bits).
fn word_count_for_entropy_bits(entropy_bits: usize) -> usize {
    // ENT/32 checksum bits appended to ENT bits, split into 11-bit words.
    (entropy_bits + entropy_bits / 32) / 11
}

/// Checksum bit count for a mnemonic of `ms` words: 12->4, 15->5, 18->6, 21->7, 24->8.
fn checksum_bits(ms: usize) -> usize {
    ms / 3
}

/// Validate a mnemonic string against the English wordlist and its BIP-39
/// checksum (doc section 2.1/2.2).
///
/// Input convention: single spaces, lowercase (the English list is pure ASCII,
/// so NFKD normalization is the identity - doc checklist item 1).
pub fn validate(mnemonic: &str) -> Result<()> {
    let words: Vec<&str> = mnemonic.split_whitespace().collect();
    let indices = indices_from_words(&words)?;
    if validate_indices(&indices) {
        Ok(())
    } else {
        Err(CrackerError::ChecksumMismatch)
    }
}

/// Convert mnemonic words to wordlist indices, checking word count and membership.
pub fn indices_from_words(words: &[&str]) -> Result<Vec<u16>> {
    if !matches!(words.len(), 12 | 15 | 18 | 21 | 24) {
        return Err(CrackerError::BadWordCount(words.len()));
    }
    words
        .iter()
        .enumerate()
        .map(|(i, w)| {
            word_index(w)
                .ok_or(CrackerError::UnknownWord(i + 1))
                .map(|i| i as u16)
        })
        .collect()
}

/// Split a mnemonic string into wordlist indices.
pub fn indices_from_mnemonic(mnemonic: &str) -> Result<Vec<u16>> {
    let words: Vec<&str> = mnemonic.split_whitespace().collect();
    indices_from_words(&words)
}

/// Build a mnemonic string from wordlist indices.
pub fn mnemonic_from_indices(indices: &[u16]) -> Result<String> {
    let mut out = String::new();
    for (i, &idx) in indices.iter().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        out.push_str(word(usize::from(idx)).ok_or(CrackerError::UnknownWord(i + 1))?);
    }
    Ok(out)
}

/// BIP-39 checksum check over raw wordlist indices - no string building, so it
/// is cheap enough to run on every enumerated candidate (doc section 9.3
/// pre-filter). Returns `false` unless the word count is valid and the trailing
/// checksum bits match the first bits of SHA-256 of the entropy bits.
pub fn validate_indices(indices: &[u16]) -> bool {
    let ms = indices.len();
    if !matches!(ms, 12 | 15 | 18 | 21 | 24) {
        return false;
    }
    // 132..264 total bits fit a 33-byte buffer.
    let mut buf = [0u8; 33];
    let mut bit = 0usize;
    for &idx in indices {
        for i in (0..11).rev() {
            if (idx >> i) & 1 == 1 {
                buf[bit / 8] |= 1 << (7 - (bit % 8));
            }
            bit += 1;
        }
    }
    let total_bits = ms * 11;
    let cs_bits = checksum_bits(ms);
    let ent_bytes = (total_bits - cs_bits) / 8;
    let digest = Sha256::digest(&buf[..ent_bytes]);
    for j in 0..cs_bits {
        let pos = ent_bytes * 8 + j;
        let have = (buf[pos / 8] >> (7 - (pos % 8))) & 1;
        let want = (digest[j / 8] >> (7 - (j % 8))) & 1;
        if have != want {
            return false;
        }
    }
    true
}

/// Number of mnemonic words implied by an entropy size in bits.
pub fn words_for_entropy_bits(entropy_bits: usize) -> usize {
    word_count_for_entropy_bits(entropy_bits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wordlist_is_complete_and_sorted() {
        assert_eq!(word_count(), 2048);
        assert!(WORDS.windows(2).all(|w| w[0] < w[1]));
        // The demo corpus pool is exactly the first 16 words (wordlist indices 0..15).
        let pool = [
            "abandon", "ability", "able", "about", "above", "absent", "absorb", "abstract",
            "absurd", "abuse", "access", "accident", "account", "accuse", "achieve", "acid",
        ];
        for (i, w) in pool.iter().enumerate() {
            assert_eq!(word_index(w), Some(i));
        }
    }

    #[test]
    fn all_zero_entropy_is_the_famous_mnemonic() {
        // Entropy 128 zero bits -> checksum 0011 -> indices [0 x11, 3].
        let indices = [0u16; 11].into_iter().chain([3u16]).collect::<Vec<_>>();
        assert!(validate_indices(&indices));
        assert_eq!(
            mnemonic_from_indices(&indices).unwrap(),
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
        );
    }

    #[test]
    fn flipped_checksum_word_is_rejected() {
        let mut indices = vec![0u16; 11];
        indices.push(2); // "able" instead of "about" -> wrong checksum
        assert!(!validate_indices(&indices));
    }
}
