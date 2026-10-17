//! Per-session key agreement: ephemeral P-256 ECDH, authenticated by the QR
//! secret, and the short authentication string both people compare.
//!
//! A port of `src/core/session.js`. The ECDH is there for forward secrecy: the
//! QR secret alone could decrypt everything, so a code photographed off a
//! screen months later would open every transfer made with it. Keypairs that
//! live in memory for one session keep past transfers closed.

use std::fmt;

use hkdf::Hkdf;
use p256::elliptic_curve::sec1::ToEncodedPoint as _;
use p256::{PublicKey, SecretKey};
use rand_core::OsRng;
use sha2::{Digest as _, Sha256};

use crate::code::{Secret, from_base64url, to_base64url};
use crate::frame::FrameKey;
use crate::transfer::Session;

/// A raw uncompressed P-256 point: `0x04 || X || Y`.
pub const PUBLIC_KEY_BYTES: usize = 65;

/// Which end of the pairing this is. The host made the QR code and sends with
/// `host->guest`; the guest scanned it and sends with `guest->host`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Host,
    Guest,
}

/// The peer's public key could not be used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BadPublicKey;

impl fmt::Display for BadPublicKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("The other device sent a public key that is not a P-256 point")
    }
}

impl std::error::Error for BadPublicKey {}

/// One side's ephemeral keypair, for exactly one strategy join.
///
/// Neither `Clone` nor reusable: [`Keypair::establish`] consumes it, so the
/// type system holds the rule the JS keeps by convention -- one keypair per
/// join, never cached. Racing two strategies costs two keypairs, and that is
/// the price of forward secrecy; hoisting one to share across them would look
/// like an obvious saving and quietly give the property up.
pub struct Keypair {
    secret: SecretKey,
    public: [u8; PUBLIC_KEY_BYTES],
}

impl fmt::Debug for Keypair {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Keypair")
            .field("public", &to_base64url(&self.public))
            .finish_non_exhaustive()
    }
}

impl Keypair {
    pub fn generate() -> Self {
        Self::from_secret(SecretKey::random(&mut OsRng))
    }

    /// A fixed keypair, for the vectors. Never for a real pairing.
    #[cfg(test)]
    pub(crate) fn from_private(bytes: &[u8]) -> Self {
        Self::from_secret(SecretKey::from_slice(bytes).expect("a valid scalar"))
    }

    fn from_secret(secret: SecretKey) -> Self {
        let point = secret.public_key().to_encoded_point(false);
        let public = point
            .as_bytes()
            .try_into()
            .expect("an uncompressed point is 65 bytes");
        Keypair { secret, public }
    }

    /// What goes to the peer, raw.
    pub fn public_key(&self) -> &[u8; PUBLIC_KEY_BYTES] {
        &self.public
    }

    /// What goes to the peer on the `ecdh` action: base64url, no padding.
    pub fn public_key_b64url(&self) -> String {
        to_base64url(&self.public)
    }

    /// Agrees the session with the peer's public key, as it arrived on the
    /// `ecdh` action. Consumes the keypair.
    ///
    /// The QR secret goes in as the HKDF salt, which is what authenticates the
    /// exchange: an attacker who injects their own public key still cannot
    /// reach the same keys without the secret. The SAS is what tells the two
    /// people whether that happened.
    pub fn establish_b64url(
        self,
        peer_public: &str,
        secret: &Secret,
        role: Role,
    ) -> Result<Pairing, BadPublicKey> {
        let raw = from_base64url(peer_public).ok_or(BadPublicKey)?;
        self.establish(&raw, secret, role)
    }

    /// [`Keypair::establish_b64url`], from raw bytes.
    pub fn establish(
        self,
        peer_public: &[u8],
        secret: &Secret,
        role: Role,
    ) -> Result<Pairing, BadPublicKey> {
        let values = self.derive(peer_public, secret)?;
        let host = FrameKey::new(&values.host_to_guest);
        let guest = FrameKey::new(&values.guest_to_host);
        let (send, recv) = match role {
            Role::Host => (host, guest),
            Role::Guest => (guest, host),
        };
        Ok(Pairing {
            send,
            recv,
            sas: Sas(values.sas),
        })
    }

    fn derive(&self, peer_public: &[u8], secret: &Secret) -> Result<Derived, BadPublicKey> {
        // Uncompressed only, as WebCrypto's raw import takes it. A compressed
        // point would be the same key under a different transcript, which
        // would derive keys the JS peer does not have.
        if peer_public.len() != PUBLIC_KEY_BYTES || peer_public[0] != 0x04 {
            return Err(BadPublicKey);
        }
        let peer = PublicKey::from_sec1_bytes(peer_public).map_err(|_| BadPublicKey)?;
        let shared = p256::ecdh::diffie_hellman(self.secret.to_nonzero_scalar(), peer.as_affine());
        let shared: [u8; 32] = (*shared.raw_secret_bytes()).into();
        Ok(Derived::new(
            &shared,
            secret,
            &transcript(&self.public, peer_public),
        ))
    }
}

/// SHA-256 of the two public keys sorted bytewise, so both sides hash them in
/// the same order without agreeing who is who. It pins the keys to this pair:
/// a public key replayed from another session lands on a different transcript.
fn transcript(a: &[u8], b: &[u8]) -> [u8; 32] {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    Sha256::new()
        .chain_update(lo)
        .chain_update(hi)
        .finalize()
        .into()
}

struct Derived {
    host_to_guest: [u8; 32],
    guest_to_host: [u8; 32],
    sas: [u8; 4],
}

impl Derived {
    fn new(shared: &[u8; 32], secret: &Secret, transcript: &[u8; 32]) -> Self {
        let hkdf = Hkdf::<Sha256>::new(Some(secret.as_bytes()), shared);
        let expand = |label: &str, out: &mut [u8]| {
            hkdf.expand_multi_info(&[label.as_bytes(), transcript], out)
                .expect("HKDF output this short is always valid");
        };
        let mut d = Derived {
            host_to_guest: [0; 32],
            guest_to_host: [0; 32],
            sas: [0; 4],
        };
        expand("host->guest", &mut d.host_to_guest);
        expand("guest->host", &mut d.guest_to_host);
        expand("sas", &mut d.sas);
        d
    }
}

/// A pairing agreed but not yet confirmed by the person.
///
/// Holds the session keys and offers nothing to seal with: the only way to a
/// [`Session`] is [`Pairing::confirm`], which is the person saying the SAS
/// matched. That is the sender's rule made structural -- a manifest leaks the
/// filename and size, so it cannot go out before the SAS -- and dropping a
/// `Pairing` is the sanctioned rejection. There is deliberately no way to
/// re-pair from one: a new attempt needs a fresh [`Secret`].
pub struct Pairing {
    send: FrameKey,
    recv: FrameKey,
    sas: Sas,
}

impl fmt::Debug for Pairing {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Pairing")
            .field("sas", &self.sas)
            .finish_non_exhaustive()
    }
}

impl Pairing {
    pub fn sas(&self) -> &Sas {
        &self.sas
    }

    /// The person confirmed the SAS. Never call this on their behalf: `--yes`
    /// skips the accept prompt and never this.
    pub fn confirm(self) -> Session {
        Session::new(self.send, self.recv)
    }
}

/// Four symbols out of 64: 24 bits, which is strength only because an
/// attacker gets one roll per secret.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Sas([u8; 4]);

impl fmt::Debug for Sas {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Sas({})", self.emoji())
    }
}

impl Sas {
    pub fn from_bytes(bytes: [u8; 4]) -> Self {
        Sas(bytes)
    }

    /// `[emoji, word]` for each of the four, in order.
    pub fn symbols(&self) -> [(&'static str, &'static str); 4] {
        self.0.map(|b| SAS_TABLE[usize::from(b & 0x3f)])
    }

    /// The four emoji joined by single spaces: the web's `session.sas`.
    pub fn emoji(&self) -> String {
        self.symbols().map(|(e, _)| e).join(" ")
    }

    /// The words, which are what assistive tech reads and what two people on
    /// a call say aloud.
    pub fn words(&self) -> [&'static str; 4] {
        self.symbols().map(|(_, w)| w)
    }

    /// The CLI's line: `<emoji> <word>`, four times, joined by three spaces.
    /// e2e/interop.e2e.mjs compares it between the two sides byte for byte.
    pub fn cli_line(&self) -> String {
        self.symbols().map(|(e, w)| format!("{e} {w}")).join("   ")
    }
}

/// `SAS_EMOJI` from session.js, in order. Visually distinct, describable out
/// loud, no near-duplicates in either column. Six carry U+FE0F, spelled out
/// below because it is invisible; test/vectors/session.json holds the table
/// and the test fails on any difference.
#[rustfmt::skip]
pub const SAS_TABLE: [(&str, &str); 64] = [
    ("🍎", "apple"), ("🐝", "bee"), ("🌵", "cactus"), ("🐬", "dolphin"),
    ("🐘", "elephant"), ("🔥", "fire"), ("👻", "ghost"), ("🍄", "mushroom"),
    ("🧊", "ice"), ("🔑", "key"), ("🍋", "lemon"), ("🌙", "moon"),
    ("🦉", "owl"), ("🐙", "octopus"), ("🌴", "palm"), ("👑", "crown"),
    ("🌈", "rainbow"), ("🐍", "snake"), ("🌻", "sunflower"), ("🌮", "taco"),
    ("🦄", "unicorn"), ("🌊", "wave"), ("⌛", "hourglass"), ("🦓", "zebra"),
    ("⚓", "anchor"), ("🎈", "balloon"), ("\u{1f56f}\u{fe0f}", "candle"), ("💎", "diamond"),
    ("🥚", "egg"), ("🎸", "guitar"), ("🔨", "hammer"), ("🧲", "magnet"),
    ("🎺", "trumpet"), ("🪐", "saturn"), ("🧩", "puzzle"), ("🚀", "rocket"),
    ("\u{2702}\u{fe0f}", "scissors"), ("💀", "skull"), ("🔭", "telescope"), ("\u{1f32a}\u{fe0f}", "tornado"),
    ("🧵", "thread"), ("🚂", "train"), ("\u{2602}\u{fe0f}", "umbrella"), ("🎻", "violin"),
    ("⚡", "lightning"), ("🪓", "axe"), ("🧶", "yarn"), ("🦴", "bone"),
    ("🏹", "arrow"), ("🧱", "brick"), ("\u{1f570}\u{fe0f}", "clock"), ("🍩", "donut"),
    ("🥁", "drum"), ("🪶", "feather"), ("🍇", "grapes"), ("🔔", "bell"),
    ("🪁", "kite"), ("🍿", "popcorn"), ("🎯", "target"), ("🧭", "compass"),
    ("🪞", "mirror"), ("🧪", "flask"), ("\u{1f321}\u{fe0f}", "thermometer"), ("🪄", "wand"),
];

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::frame::{Expect, Header, TYPE_CHUNK, open, seal};

    fn pair(secret: &Secret) -> (Pairing, Pairing) {
        let (host, guest) = (Keypair::generate(), Keypair::generate());
        let (hp, gp) = (host.public_key_b64url(), guest.public_key_b64url());
        (
            host.establish_b64url(&gp, secret, Role::Host).unwrap(),
            guest.establish_b64url(&hp, secret, Role::Guest).unwrap(),
        )
    }

    fn crosses(from: &FrameKey, to: &FrameKey) -> bool {
        let header = Header {
            kind: TYPE_CHUNK,
            file_seq: 0,
            index: 0,
            last: true,
        };
        let frame = seal(from, &header, b"x");
        open(to, &frame, Some(Expect::chunk(0, 0))).is_ok()
    }

    #[test]
    fn both_peers_derive_matching_directional_keys_and_the_same_sas() {
        let (host, guest) = pair(&Secret::generate());
        assert_eq!(host.sas(), guest.sas());
        assert!(crosses(&host.send, &guest.recv));
        assert!(crosses(&guest.send, &host.recv));
        // The two directions are distinct keys, so they never share a nonce space.
        assert!(!crosses(&host.send, &host.recv));
    }

    #[test]
    fn a_wrong_qr_secret_yields_a_different_session_even_with_valid_ecdh() {
        let (host, guest) = (Keypair::generate(), Keypair::generate());
        let (hp, gp) = (*host.public_key(), *guest.public_key());
        let host = host
            .establish(&gp, &Secret::generate(), Role::Host)
            .unwrap();
        let guest = guest
            .establish(&hp, &Secret::generate(), Role::Guest)
            .unwrap();
        assert!(!crosses(&host.send, &guest.recv));
    }

    #[test]
    fn two_pairings_over_one_secret_cannot_open_each_other() {
        let secret = Secret::generate();
        let (a, _) = pair(&secret);
        let (_, b) = pair(&secret);
        assert!(!crosses(&a.send, &b.recv));
    }

    #[test]
    fn generated_keypairs_differ() {
        assert_ne!(
            Keypair::generate().public_key(),
            Keypair::generate().public_key()
        );
    }

    #[test]
    fn a_public_key_that_is_not_an_uncompressed_point_is_refused() {
        let secret = Secret::generate();
        let peer = Keypair::generate();
        let point = PublicKey::from_sec1_bytes(peer.public_key()).unwrap();
        let compressed = point.to_encoded_point(true);
        let mut off_curve = *peer.public_key();
        off_curve[64] ^= 1;
        for bad in [
            compressed.as_bytes(),
            &off_curve[..],
            &[0u8; 65][..],
            &[][..],
        ] {
            assert_eq!(
                Keypair::generate()
                    .establish(bad, &secret, Role::Host)
                    .err(),
                Some(BadPublicKey)
            );
        }
        assert!(
            Keypair::generate()
                .establish_b64url("!!", &secret, Role::Host)
                .is_err()
        );
    }

    pub(crate) fn derived(
        host_private: &[u8],
        guest_public: &[u8],
        secret: &Secret,
    ) -> ([u8; 32], [u8; 32], [u8; 32], [u8; 4]) {
        let host = Keypair::from_private(host_private);
        let t = transcript(host.public_key(), guest_public);
        let d = host.derive(guest_public, secret).unwrap();
        (t, d.host_to_guest, d.guest_to_host, d.sas)
    }
}
