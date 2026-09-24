//! Error types shared by the engine, CLI, and wasm wrapper.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum CrackerError {
    #[error("mnemonic must contain 12, 15, 18, 21 or 24 words, found {0}")]
    BadWordCount(usize),
    #[error("word at position {0} is not in the BIP-39 English wordlist")]
    UnknownWord(usize),
    #[error("BIP-39 checksum mismatch")]
    ChecksumMismatch,
    #[error("invalid BIP-32 key: {0}")]
    InvalidKey(&'static str),
    #[error("invalid secp256k1 scalar: {0}")]
    InvalidScalar(&'static str),
    #[error("malformed address: {0}")]
    MalformedAddress(&'static str),
    #[error("invalid pool configuration: {0}")]
    BadPoolConfig(&'static str),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("hex decode error: {0}")]
    Hex(#[from] hex::FromHexError),
    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, CrackerError>;
