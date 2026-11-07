//! The offline rendezvous's four messages: a port of `src/core/rendezvous.js`,
//! which carries the reasoning, and `test/vectors/rendezvous.json` holds the
//! two to the same bytes.
//!
//! In short: a listener on the local network is open to anyone there before
//! pairing, so every message proves the code under an HMAC key derived from
//! it, and nothing latches on a message that does not verify. A stranger
//! costs a handshake slot and nothing else, where a listener that latched on
//! the first key to arrive would let them force a SAS mismatch and spend the
//! secret's one roll.
//!
//! ```text
//! 1. listener -> dialler  hello   n                                  16
//! 2. dialler -> listener  dial    D || HMAC("dial" || n || D)        97
//! 3. listener -> dialler  listen  L || HMAC("listen" || n || D || L) 97
//! 4. dialler -> listener  ok      HMAC("ok" || n || D || L)          32
//! ```
//!
//! The `open_*` methods answer `None` or `false` for anything that does not
//! verify and never error: a stranger is the expected case on a shared
//! network. The comparison is `hmac`'s `verify_slice`, which is constant-time.

use std::fmt;

use hmac::{Hmac, Mac};
use rand_core::{OsRng, RngCore};
use sha2::Sha256;

use crate::pairing::PUBLIC_KEY_BYTES;

pub const NONCE_BYTES: usize = 16;
pub const MAC_BYTES: usize = 32;
/// The dial and listen messages: a public key and its MAC.
pub const KEYED_BYTES: usize = PUBLIC_KEY_BYTES + MAC_BYTES;

pub type Nonce = [u8; NONCE_BYTES];
pub type PublicKey = [u8; PUBLIC_KEY_BYTES];

const DIAL: &[u8] = b"dial";
const LISTEN: &[u8] = b"listen";
const OK: &[u8] = b"ok";

/// A fresh nonce, for the hello.
pub fn nonce() -> Nonce {
    let mut n = [0u8; NONCE_BYTES];
    OsRng.fill_bytes(&mut n);
    n
}

/// The HMAC key, from [`crate::Secret::rendezvous_key`].
#[derive(Clone)]
pub struct RendezvousKey([u8; 32]);

impl fmt::Debug for RendezvousKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RendezvousKey(..)")
    }
}

impl RendezvousKey {
    pub(crate) fn from_bytes(bytes: [u8; 32]) -> Self {
        RendezvousKey(bytes)
    }

    #[cfg(test)]
    pub(crate) fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    fn mac(&self, parts: &[&[u8]]) -> Hmac<Sha256> {
        let mut m =
            <Hmac<Sha256> as Mac>::new_from_slice(&self.0).expect("HMAC takes a key of any length");
        for p in parts {
            m.update(p);
        }
        m
    }

    fn seal_keyed(&self, key: &PublicKey, parts: &[&[u8]]) -> [u8; KEYED_BYTES] {
        let mut out = [0u8; KEYED_BYTES];
        out[..PUBLIC_KEY_BYTES].copy_from_slice(key);
        out[PUBLIC_KEY_BYTES..].copy_from_slice(&self.mac(parts).finalize().into_bytes());
        out
    }

    /// Message 2, the dialler's key and its proof of the code.
    pub fn seal_dial(&self, nonce: &Nonce, dial: &PublicKey) -> [u8; KEYED_BYTES] {
        self.seal_keyed(dial, &[DIAL, nonce, dial])
    }

    /// The listener's check of message 2: the dialler's key, or `None` for
    /// anyone who does not hold the code.
    pub fn open_dial(&self, nonce: &Nonce, message: &[u8]) -> Option<PublicKey> {
        let (dial, tag) = split_keyed(message)?;
        self.mac(&[DIAL, nonce, &dial])
            .verify_slice(tag)
            .ok()
            .map(|()| dial)
    }

    /// Message 3, the listener's key, bound to the dialler's.
    pub fn seal_listen(
        &self,
        nonce: &Nonce,
        dial: &PublicKey,
        listen: &PublicKey,
    ) -> [u8; KEYED_BYTES] {
        self.seal_keyed(listen, &[LISTEN, nonce, dial, listen])
    }

    /// The dialler's check of message 3: the listener's key, or `None`.
    pub fn open_listen(
        &self,
        nonce: &Nonce,
        dial: &PublicKey,
        message: &[u8],
    ) -> Option<PublicKey> {
        let (listen, tag) = split_keyed(message)?;
        self.mac(&[LISTEN, nonce, dial, &listen])
            .verify_slice(tag)
            .ok()
            .map(|()| listen)
    }

    /// Message 4: the dialler has the listener's key and agrees on all of it.
    pub fn seal_ok(&self, nonce: &Nonce, dial: &PublicKey, listen: &PublicKey) -> [u8; MAC_BYTES] {
        self.mac(&[OK, nonce, dial, listen])
            .finalize()
            .into_bytes()
            .into()
    }

    /// The listener's check of message 4. Only after this may it show a SAS.
    pub fn open_ok(
        &self,
        nonce: &Nonce,
        dial: &PublicKey,
        listen: &PublicKey,
        message: &[u8],
    ) -> bool {
        message.len() == MAC_BYTES
            && self
                .mac(&[OK, nonce, dial, listen])
                .verify_slice(message)
                .is_ok()
    }
}

fn split_keyed(message: &[u8]) -> Option<(PublicKey, &[u8])> {
    if message.len() != KEYED_BYTES {
        return None;
    }
    let (key, tag) = message.split_at(PUBLIC_KEY_BYTES);
    Some((key.try_into().ok()?, tag))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Secret;

    fn setup() -> (RendezvousKey, Nonce, PublicKey, PublicKey) {
        (
            Secret::generate().rendezvous_key(),
            nonce(),
            [1; PUBLIC_KEY_BYTES],
            [2; PUBLIC_KEY_BYTES],
        )
    }

    #[test]
    fn the_four_messages_go_round() {
        let (k, n, d, l) = setup();
        assert_eq!(k.open_dial(&n, &k.seal_dial(&n, &d)), Some(d));
        assert_eq!(k.open_listen(&n, &d, &k.seal_listen(&n, &d, &l)), Some(l));
        assert!(k.open_ok(&n, &d, &l, &k.seal_ok(&n, &d, &l)));
    }

    #[test]
    fn a_dialler_without_the_code_is_refused() {
        let (k, n, d, _) = setup();
        let stranger = Secret::generate().rendezvous_key();
        assert_eq!(k.open_dial(&n, &stranger.seal_dial(&n, &d)), None);
    }

    #[test]
    fn a_dial_replayed_from_another_connection_does_not_latch() {
        let (k, n, d, _) = setup();
        assert_eq!(k.open_dial(&nonce(), &k.seal_dial(&n, &d)), None);
    }

    #[test]
    fn a_key_swapped_on_the_path_fails_in_either_direction() {
        let (k, n, d, l) = setup();
        let other = [9; PUBLIC_KEY_BYTES];
        let mut dial = k.seal_dial(&n, &d);
        dial[..PUBLIC_KEY_BYTES].copy_from_slice(&other);
        assert_eq!(k.open_dial(&n, &dial), None);
        let mut listen = k.seal_listen(&n, &d, &l);
        listen[..PUBLIC_KEY_BYTES].copy_from_slice(&other);
        assert_eq!(k.open_listen(&n, &d, &listen), None);
        assert_eq!(k.open_listen(&n, &other, &k.seal_listen(&n, &d, &l)), None);
        assert!(!k.open_ok(&n, &d, &other, &k.seal_ok(&n, &d, &l)));
    }

    #[test]
    fn no_message_reflects_back_as_another() {
        let (k, n, d, l) = setup();
        assert_eq!(k.open_listen(&n, &d, &k.seal_dial(&n, &d)), None);
        assert_eq!(k.open_dial(&n, &k.seal_listen(&n, &d, &l)), None);
        assert!(!k.open_ok(&n, &d, &l, &k.seal_listen(&n, &d, &l)[PUBLIC_KEY_BYTES..]));
    }

    #[test]
    fn a_message_of_the_wrong_length_is_refused() {
        let (k, n, d, l) = setup();
        let dial = k.seal_dial(&n, &d);
        assert_eq!(k.open_dial(&n, &dial[..KEYED_BYTES - 1]), None);
        assert_eq!(k.open_dial(&n, &[]), None);
        assert_eq!(k.open_listen(&n, &d, &[0; KEYED_BYTES + 1]), None);
        assert!(!k.open_ok(&n, &d, &l, &[0; MAC_BYTES - 1]));
    }
}
