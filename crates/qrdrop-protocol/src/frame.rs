//! Wire framing and per-frame authenticated encryption.
//!
//! A port of `src/core/frame.js`. Everything crossing the data channel is
//! sealed here, on top of DTLS: DTLS ends at the peer's stack and, when NAT
//! traversal fails, the packets pass through a third party's TURN relay.
//!
//! The 14-byte header travels in the clear and is the AEAD's additional data,
//! and the nonce is cut from it: `fileSeq (u32) || index (u64)`. Unique by
//! counting, never by chance, because AES-GCM is catastrophic under reuse.
//!
//! **Authenticate, then trust.** [`open`] decrypts before it compares the
//! header with anything. A header that fails its tag never reaches a decision
//! about the transfer; the JS once checked order first, and fourteen bytes of
//! a stranger's cleartext could end a live transfer.

use std::fmt;

use aes_gcm::aead::{AeadInPlace as _, KeyInit as _};
use aes_gcm::{Aes256Gcm, Nonce, Tag};

pub const HEADER_BYTES: usize = 14;
pub const TAG_BYTES: usize = 16;

/// Trystero's action wire chunks a payload at `16 * 1024 - 36`, and a sealed
/// frame sized to exactly that travels as one message instead of a full one
/// and a runt. The 36 is that chunking constant, not the per-message header,
/// which measured ~66 bytes; do not re-derive this from "one SCTP message is
/// 16 KiB". See the comment in frame.js for the measurements.
const WIRE_BUDGET: usize = 16 * 1024 - 36;
pub const CHUNK_SIZE: usize = WIRE_BUDGET - HEADER_BYTES - TAG_BYTES;

/// The INBOUND tolerance, and deliberately not derived from [`CHUNK_SIZE`]: a
/// peer on the previous constant still seals 16414-byte frames. Shrinking
/// what we send is a local decision; shrinking what we accept is a wire break.
pub const MAX_FRAME_BYTES: usize = HEADER_BYTES + 16 * 1024 + TAG_BYTES;
pub const MIN_FRAME_BYTES: usize = HEADER_BYTES + TAG_BYTES;

pub const TYPE_CONTROL: u8 = 0;
pub const TYPE_CHUNK: u8 = 1;

/// The fileSeq reserved for control frames. Never assigned to a file, so
/// control and data frames share a key without ever sharing a nonce.
pub const CONTROL_SEQ: u32 = u32::MAX;

/// One direction's AES-256-GCM key. No way to read the bytes back out.
pub struct FrameKey(Aes256Gcm);

impl FrameKey {
    pub fn new(bytes: &[u8; 32]) -> Self {
        FrameKey(Aes256Gcm::new(bytes.into()))
    }
}

impl fmt::Debug for FrameKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("FrameKey(..)")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    /// The type byte as sent. Any value but [`TYPE_CONTROL`] is routed as a
    /// chunk, as the JS does, and then fails the type check once authentic.
    pub kind: u8,
    pub file_seq: u32,
    pub index: u64,
    /// Written as 1 or 0, read as true only when it is exactly 1.
    pub last: bool,
}

impl Header {
    pub fn encode(&self) -> [u8; HEADER_BYTES] {
        let mut h = [0u8; HEADER_BYTES];
        h[0] = self.kind;
        h[1..5].copy_from_slice(&self.file_seq.to_be_bytes());
        h[5..13].copy_from_slice(&self.index.to_be_bytes());
        h[13] = u8::from(self.last);
        h
    }

    pub fn decode(bytes: &[u8; HEADER_BYTES]) -> Self {
        Header {
            kind: bytes[0],
            file_seq: u32::from_be_bytes(bytes[1..5].try_into().unwrap()),
            index: u64::from_be_bytes(bytes[5..13].try_into().unwrap()),
            last: bytes[13] == 1,
        }
    }
}

/// What the caller expects the next frame to be, from its own tracked state.
/// Never read off the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Expect {
    pub kind: u8,
    pub file_seq: u32,
    pub index: u64,
}

impl Expect {
    pub fn chunk(file_seq: u32, index: u64) -> Self {
        Expect {
            kind: TYPE_CHUNK,
            file_seq,
            index,
        }
    }

    pub fn control(index: u64) -> Self {
        Expect {
            kind: TYPE_CONTROL,
            file_seq: CONTROL_SEQ,
            index,
        }
    }
}

/// Why a frame was not opened.
///
/// [`FrameError::Unauthenticated`] is the odd one out, and the caller's answer
/// to it is entirely different: the bytes did not come from our peer, so they
/// are dropped and counted, never fatal. The three order checks can only fire
/// on a frame that provably did come from our peer, which is our own peer
/// contradicting itself, and those are fatal. The two size checks are bounds,
/// not provenance claims.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameError {
    TooShort,
    TooLarge,
    Unauthenticated,
    Type,
    FileSeq,
    Index { expected: u64, got: u64 },
}

impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FrameError::TooShort => f.write_str("Frame too short"),
            FrameError::TooLarge => f.write_str("Frame exceeds maximum size"),
            FrameError::Unauthenticated => {
                f.write_str("Frame did not authenticate under the session key")
            }
            FrameError::Type => f.write_str("Unexpected frame type"),
            FrameError::FileSeq => f.write_str("Frame from unexpected file"),
            FrameError::Index { expected, got } => {
                write!(f, "Out-of-order frame: expected {expected}, got {got}")
            }
        }
    }
}

impl std::error::Error for FrameError {}

fn nonce(header: &[u8; HEADER_BYTES]) -> &Nonce<aes_gcm::aead::consts::U12> {
    Nonce::from_slice(&header[1..13])
}

/// One frame, ready to hand to the channel.
pub fn seal(key: &FrameKey, header: &Header, plaintext: &[u8]) -> Vec<u8> {
    let h = header.encode();
    let mut frame = Vec::with_capacity(HEADER_BYTES + plaintext.len() + TAG_BYTES);
    frame.extend_from_slice(&h);
    frame.extend_from_slice(plaintext);
    let tag = key
        .0
        .encrypt_in_place_detached(nonce(&h), &h, &mut frame[HEADER_BYTES..])
        .expect("a frame is far below AES-GCM's length limit");
    frame.extend_from_slice(&tag);
    frame
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opened {
    pub header: Header,
    pub plaintext: Vec<u8>,
}

/// Opens a frame, then holds it to `expect`.
///
/// `None` opens with the tag as the only check, which answers one question
/// about a frame there is no expectation for: is this our peer at all?
pub fn open(key: &FrameKey, frame: &[u8], expect: Option<Expect>) -> Result<Opened, FrameError> {
    // Bounds, ahead of everything: the first keeps a runt out of the header
    // decode, the second keeps an arbitrarily large buffer out of the cipher,
    // which is what stops decrypt-first from being an invitation to burn CPU.
    if frame.len() < MIN_FRAME_BYTES {
        return Err(FrameError::TooShort);
    }
    if frame.len() > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge);
    }

    let h: [u8; HEADER_BYTES] = frame[..HEADER_BYTES].try_into().unwrap();
    let body = &frame[HEADER_BYTES..frame.len() - TAG_BYTES];
    let tag = Tag::from_slice(&frame[frame.len() - TAG_BYTES..]);
    let mut plaintext = body.to_vec();
    key.0
        .decrypt_in_place_detached(nonce(&h), &h, &mut plaintext, tag)
        .map_err(|_| FrameError::Unauthenticated)?;

    // Past this line the frame came from the peer holding our key, so a
    // mismatch is a real desync between the two state machines.
    let header = Header::decode(&h);
    if let Some(expect) = expect {
        if header.kind != expect.kind {
            return Err(FrameError::Type);
        }
        if header.file_seq != expect.file_seq {
            return Err(FrameError::FileSeq);
        }
        if header.index != expect.index {
            return Err(FrameError::Index {
                expected: expect.index,
                got: header.index,
            });
        }
    }
    Ok(Opened { header, plaintext })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(b: u8) -> FrameKey {
        FrameKey::new(&[b; 32])
    }

    fn chunk(index: u64, last: bool) -> Header {
        Header {
            kind: TYPE_CHUNK,
            file_seq: 0,
            index,
            last,
        }
    }

    #[test]
    fn a_sealed_chunk_round_trips() {
        let k = key(1);
        let frame = seal(&k, &chunk(0, false), b"hello");
        let opened = open(&k, &frame, Some(Expect::chunk(0, 0))).unwrap();
        assert_eq!(opened.plaintext, b"hello");
        assert!(!opened.header.last);
    }

    #[test]
    fn the_end_of_file_flag_is_authenticated() {
        let k = key(1);
        let mut frame = seal(&k, &chunk(3, false), b"data");
        frame[13] = 1;
        assert_eq!(open(&k, &frame, None), Err(FrameError::Unauthenticated));
    }

    #[test]
    fn every_header_and_ciphertext_byte_is_covered_by_the_tag() {
        let k = key(1);
        let frame = seal(&k, &chunk(7, false), b"payload bytes");
        for i in 0..frame.len() {
            let mut bad = frame.clone();
            bad[i] ^= 0x01;
            assert_eq!(
                open(&k, &bad, Some(Expect::chunk(0, 7))),
                Err(FrameError::Unauthenticated),
                "byte {i}"
            );
        }
    }

    #[test]
    fn a_tag_failure_is_unauthenticated_whatever_the_header_claims() {
        // A forged header claiming an index far ahead must not be reported as
        // out of order: that was the denial of service.
        let mut frame = seal(&key(2), &chunk(13877, false), b"x");
        frame[HEADER_BYTES] ^= 0xff;
        assert_eq!(
            open(&key(1), &frame, Some(Expect::chunk(0, 0))),
            Err(FrameError::Unauthenticated)
        );
    }

    #[test]
    fn our_own_peer_reordering_still_fails_loudly() {
        let k = key(1);
        let frame = seal(&k, &chunk(5, false), b"x");
        assert_eq!(
            open(&k, &frame, Some(Expect::chunk(0, 4))),
            Err(FrameError::Index {
                expected: 4,
                got: 5
            })
        );
        assert_eq!(
            open(&k, &frame, Some(Expect::chunk(0, 4)))
                .unwrap_err()
                .to_string(),
            "Out-of-order frame: expected 4, got 5"
        );
        assert_eq!(
            open(&k, &frame, Some(Expect::chunk(1, 5))),
            Err(FrameError::FileSeq)
        );
        assert_eq!(
            open(&k, &frame, Some(Expect::control(5))),
            Err(FrameError::Type)
        );
    }

    #[test]
    fn the_size_guards_run_ahead_of_decryption() {
        let k = key(1);
        assert_eq!(
            open(&k, &[0u8; MIN_FRAME_BYTES - 1], None),
            Err(FrameError::TooShort)
        );
        assert_eq!(
            open(&k, &vec![0u8; MAX_FRAME_BYTES + 1], None),
            Err(FrameError::TooLarge)
        );
        // At the bounds, the tag is what fails.
        assert_eq!(
            open(&k, &[0u8; MIN_FRAME_BYTES], None),
            Err(FrameError::Unauthenticated)
        );
        assert_eq!(
            open(&k, &vec![0u8; MAX_FRAME_BYTES], None),
            Err(FrameError::Unauthenticated)
        );
    }

    #[test]
    fn a_full_chunk_is_one_trystero_chunk_and_the_old_size_is_still_accepted() {
        let k = key(1);
        assert_eq!(seal(&k, &chunk(0, false), &[0u8; CHUNK_SIZE]).len(), 16348);
        let old = seal(&k, &chunk(0, false), &[0u8; 16 * 1024]);
        assert_eq!(old.len(), MAX_FRAME_BYTES);
        assert!(open(&k, &old, None).is_ok());
    }

    #[test]
    fn indices_beyond_two_to_the_32_still_produce_distinct_nonces() {
        let k = key(1);
        let a = seal(&k, &chunk(1, false), b"same");
        let b = seal(&k, &chunk(1 + (1 << 32), false), b"same");
        assert_ne!(a[HEADER_BYTES..], b[HEADER_BYTES..]);
    }

    #[test]
    fn a_different_key_cannot_open_a_frame() {
        let frame = seal(&key(1), &chunk(0, true), b"secret");
        assert_eq!(
            open(&key(2), &frame, None),
            Err(FrameError::Unauthenticated)
        );
    }
}
