//! Topics, the room token, the signal cipher and the password handshake's hash:
//! every value Trystero derives from an app ID, a room ID and a password.
//!
//! Trystero 0.25.4's `core/dist/crypto.mjs` and `strategy.mjs` are the source.
//! None of it is a KDF in the usual sense: the signal key is one SHA-256 of
//! the password, with no salt and no stretching, and that is the wire --
//! anything stronger would be a key no JS peer could derive.

use aes_gcm::aead::consts::U16;
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::aes::Aes256;
use aes_gcm::{AesGcm, Nonce};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use rand_core::{OsRng, RngCore};
use sha1::Sha1;
use sha2::{Digest, Sha256};

/// Trystero's library name, which every derivation starts from.
pub(crate) const LIB_NAME: &str = "Trystero";

/// Trystero's "sha1": the SHA-1 digest with each byte written in lowercase
/// base 36 and no padding, so the length varies with the digest. It is not a
/// hex digest and cannot be parsed back; it is only ever compared.
pub fn sha1_b36(input: &str) -> String {
    let digest = Sha1::digest(input.as_bytes());
    let mut out = String::with_capacity(digest.len() * 2);
    for &b in digest.iter() {
        push_b36(&mut out, b);
    }
    out
}

fn push_b36(out: &mut String, mut b: u8) {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if b >= 36 {
        out.push(DIGITS[(b / 36) as usize] as char);
        b %= 36;
    }
    out.push(DIGITS[b as usize] as char);
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// What one room is called on every channel Trystero has: the two Nostr
/// topics, the tracker's info hash, and the token that prefixes every data
/// channel message.
#[derive(Clone, Debug)]
pub struct Topics {
    root_plain: String,
    root: String,
    room_token: String,
}

impl Topics {
    /// The names for the room `room_id` of the app `app_id`. Both are the
    /// strings Trystero is given, and an empty one is hashed as it stands.
    pub fn new(app_id: &str, room_id: &str) -> Self {
        let root_plain = format!("{LIB_NAME}@{app_id}@{room_id}");
        Topics {
            root: sha1_b36(&root_plain),
            // Colons here, where the topics use `@`: two derivations, two
            // separators, and only the vectors say which is which.
            room_token: hex(&Sha256::digest(format!("{LIB_NAME}:{app_id}:{room_id}"))),
            root_plain,
        }
    }

    /// The topic every peer in the room announces on.
    pub fn root(&self) -> &str {
        &self.root
    }

    /// A peer's own topic, where signals addressed to it go.
    pub fn peer_topic(&self, peer_id: &str) -> String {
        sha1_b36(&format!("{}@{peer_id}", self.root_plain))
    }

    /// The tracker's `info_hash`: the first 20 characters of the root topic's
    /// own sha1. Twenty characters, not twenty bytes -- it is a string.
    pub fn info_hash(&self) -> String {
        sha1_b36(&self.root).chars().take(20).collect()
    }

    /// Lowercase hex SHA-256 of `Trystero:<appId>:<roomId>`, 64 characters.
    pub fn room_token(&self) -> &str {
        &self.room_token
    }
}

/// The Nostr event kind for a topic: the sum of its UTF-16 code units mod
/// 10000, in the ephemeral range from 20000. Topics are ASCII, so a byte sum
/// is the same number.
pub fn nostr_kind(topic: &str) -> u32 {
    topic.encode_utf16().map(u32::from).sum::<u32>() % 10_000 + 20_000
}

type SignalAead = AesGcm<Aes256, U16>;

/// The cipher every SDP and candidate travels under: AES-256-GCM with a
/// **16-byte** IV, which WebCrypto accepts by deriving J0 through GHASH. A
/// 12-byte nonce here would produce ciphertext no JS peer can open.
pub struct SignalCipher {
    aead: SignalAead,
}

impl std::fmt::Debug for SignalCipher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SignalCipher(..)")
    }
}

impl SignalCipher {
    /// A cipher keyed by `password`, `app_id` and `room_id`: the key is the
    /// SHA-256 of `password:appId:roomId`, as Trystero derives it.
    pub fn new(password: &str, app_id: &str, room_id: &str) -> Self {
        let key = Sha256::digest(format!("{password}:{app_id}:{room_id}"));
        SignalCipher {
            aead: SignalAead::new_from_slice(&key).expect("a SHA-256 digest is a 256-bit key"),
        }
    }

    /// `iv.join(",") + "$" + base64(ciphertext ‖ tag)`, with a fresh IV.
    pub fn encrypt(&self, plaintext: &str) -> String {
        let mut iv = [0u8; 16];
        OsRng.fill_bytes(&mut iv);
        self.encrypt_with_iv(plaintext, &iv)
    }

    pub(crate) fn encrypt_with_iv(&self, plaintext: &str, iv: &[u8; 16]) -> String {
        let ct = self
            .aead
            .encrypt(Nonce::<U16>::from_slice(iv), plaintext.as_bytes())
            .expect("AES-GCM encryption of a bounded message cannot fail");
        let ivs: Vec<String> = iv.iter().map(u8::to_string).collect();
        format!("{}${}", ivs.join(","), STANDARD.encode(ct))
    }

    /// The plaintext, or `None` for anything that does not open under this
    /// key: a wrong password, a malformed wire string, or a forgery. The JS
    /// drops all three the same way, and so does every caller here.
    pub fn decrypt(&self, wire: &str) -> Option<String> {
        let (iv, ct) = wire.split_once('$')?;
        let iv: Vec<u8> = iv
            .split(',')
            .map(|n| n.parse::<u8>().ok())
            .collect::<Option<_>>()?;
        let iv: [u8; 16] = iv.try_into().ok()?;
        let ct = STANDARD.decode(ct).ok()?;
        let pt = self
            .aead
            .decrypt(Nonce::<U16>::from_slice(&iv), ct.as_slice())
            .ok()?;
        String::from_utf8(pt).ok()
    }
}

/// The password handshake's answer to a challenge: lowercase hex
/// SHA-256(`<challenge>:<password>:<appId>:<roomId>`).
pub fn handshake_response(challenge: &str, password: &str, app_id: &str, room_id: &str) -> String {
    hex(&Sha256::digest(format!(
        "{challenge}:{password}:{app_id}:{room_id}"
    )))
}

/// Trystero's ID alphabet, in its own order. The order matters nowhere --
/// IDs are compared as strings, never decoded -- but keeping it makes the
/// distribution the same.
const ID_CHARS: &[u8; 62] = b"0123456789AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUuVvWwXxYyZz";

/// A random ID of `len` characters from `0-9A-Za-z`: a self ID is 20, a
/// handshake challenge 36, a Nostr offer ID 12, a tracker offer ID 20.
pub fn gen_id(len: usize) -> String {
    let mut out = String::with_capacity(len);
    while out.len() < len {
        let mut b = [0u8; 1];
        OsRng.fill_bytes(&mut b);
        // 248 = 4 * 62: rejection sampling keeps every character equally likely.
        if b[0] < 248 {
            out.push(ID_CHARS[(b[0] % 62) as usize] as char);
        }
    }
    out
}
