//! The order-sensitive rolling digest over a file's plaintext.
//!
//! A port of `src/core/digest.js`: start from 32 zero bytes, and for each
//! chunk `c = SHA-256(c || SHA-256(chunk))`. Per-frame AEAD and the
//! authenticated end-of-file flag already make undetected corruption or
//! truncation infeasible; this catches what they cannot, which is our own code
//! reassembling correctly sealed chunks in the wrong order or dropping one.

use sha2::{Digest as _, Sha256};
use subtle::ConstantTimeEq as _;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Chain([u8; 32]);

impl Chain {
    pub fn new() -> Self {
        Chain([0; 32])
    }

    pub fn update(&mut self, chunk: &[u8]) {
        let inner = Sha256::digest(chunk);
        self.0 = Sha256::new()
            .chain_update(self.0)
            .chain_update(inner)
            .finalize()
            .into();
    }

    pub fn bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// 64 lowercase hex characters, as the `complete` message carries it.
    pub fn hex(&self) -> String {
        hex(&self.0)
    }
}

pub fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut s, b| {
            let _ = write!(s, "{b:02x}");
            s
        })
}

/// Constant-time, so checking a digest cannot be turned into an oracle. The
/// length check is not secret: both are hex of a fixed-size hash.
pub fn equal_hex(a: &str, b: &str) -> bool {
    a.len() == b.len() && bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn order_matters() {
        let (mut ab, mut ba) = (Chain::new(), Chain::new());
        ab.update(b"a");
        ab.update(b"b");
        ba.update(b"b");
        ba.update(b"a");
        assert_ne!(ab, ba);
    }

    #[test]
    fn equal_hex_compares_whole_strings() {
        assert!(equal_hex("00ff", "00ff"));
        assert!(!equal_hex("00ff", "00fe"));
        assert!(!equal_hex("00ff", "00ff0"));
        assert!(!equal_hex("", "0"));
    }
}
