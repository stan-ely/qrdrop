//! The two layers every data-channel message carries: Trystero's room frame
//! outside (`core/dist/shared-peer.mjs`) and its action chunk inside
//! (`core/dist/action-wire.mjs`).

use std::collections::HashMap;

use serde_json::Value;

/// Bytes before an action chunk's payload: a 32-byte name, a u16 nonce, a
/// flags byte and a progress byte.
pub const CHUNK_HEADER_BYTES: usize = 36;
/// The most payload one chunk carries, so a chunk is at most 16 KiB.
pub const CHUNK_PAYLOAD_BYTES: usize = 16 * 1024 - CHUNK_HEADER_BYTES;
/// The longest action name, in UTF-8 bytes.
pub const MAX_ACTION_NAME_BYTES: usize = 32;

const FLAG_LAST: u8 = 1;
const FLAG_META: u8 = 2;
const FLAG_BINARY: u8 = 4;
const FLAG_JSON: u8 = 8;

/// What an action carries, in the three encodings Trystero tells apart.
///
/// A JS string goes as its UTF-8 with neither type bit set; bytes set **both**
/// the binary and JSON bits (`typeof` a typed array is not `"string"`); any
/// other value goes as JSON. So a receiver must test binary before JSON, and
/// `Json` here never holds a `Value::String` -- that is `Text`.
#[derive(Clone, Debug, PartialEq)]
pub enum Payload {
    /// A JS string: UTF-8 text.
    Text(String),
    /// Any JS value other than a string or bytes, as its JSON text.
    Json(Value),
    /// Raw bytes, as a JS typed array.
    Binary(Vec<u8>),
}

impl Payload {
    /// The JSON form of a value, with a string mapped to `Text` as a JS
    /// sender would map it.
    pub fn json(v: Value) -> Self {
        match v {
            Value::String(s) => Payload::Text(s),
            v => Payload::Json(v),
        }
    }

    fn encode(&self) -> (Vec<u8>, u8) {
        match self {
            Payload::Text(s) => (s.as_bytes().to_vec(), 0),
            Payload::Json(v) => (v.to_string().into_bytes(), FLAG_JSON),
            Payload::Binary(b) => (b.clone(), FLAG_BINARY | FLAG_JSON),
        }
    }
}

/// Why an action could not be encoded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WireError {
    /// An action name longer than 32 bytes, or empty. Trystero refuses both
    /// when the action is made, before anything is sent.
    ActionName,
}

/// Every chunk of one action message, in order. `nonce` is the action's
/// counter, which the caller advances by one (wrapping at u16) per message.
pub fn encode_action(
    action: &str,
    nonce: u16,
    payload: &Payload,
    meta: Option<&Value>,
) -> Result<Vec<Vec<u8>>, WireError> {
    let name = action.as_bytes();
    if name.is_empty() || name.len() > MAX_ACTION_NAME_BYTES {
        return Err(WireError::ActionName);
    }
    let (body, type_bits) = payload.encode();
    let meta = meta.map(|m| m.to_string().into_bytes());
    // `ceil(len / size) + (meta ? 1 : 0) || 1`: an empty payload with metadata
    // is the metadata chunk alone, marked last, and not a second empty chunk.
    let total = (body.len().div_ceil(CHUNK_PAYLOAD_BYTES) + usize::from(meta.is_some())).max(1);

    let mut out = Vec::with_capacity(total);
    for i in 0..total {
        let is_meta = meta.is_some() && i == 0;
        let is_last = i == total - 1;
        let part: &[u8] = if is_meta {
            meta.as_deref().unwrap_or_default()
        } else {
            let d = i.saturating_sub(usize::from(meta.is_some()));
            let start = (d * CHUNK_PAYLOAD_BYTES).min(body.len());
            let end = ((d + 1) * CHUNK_PAYLOAD_BYTES).min(body.len());
            &body[start..end]
        };
        let mut chunk = Vec::with_capacity(CHUNK_HEADER_BYTES + part.len());
        chunk.extend_from_slice(name);
        chunk.resize(MAX_ACTION_NAME_BYTES, 0);
        chunk.extend_from_slice(&nonce.to_be_bytes());
        // Every chunk carries the payload's type bits, the metadata chunk
        // included, exactly as action-wire.mjs sets them.
        let flags = u8::from(is_last) | if is_meta { FLAG_META } else { 0 } | type_bits;
        chunk.push(flags);
        chunk.push(progress(i, total));
        chunk.extend_from_slice(part);
        out.push(chunk);
    }
    Ok(out)
}

/// `Math.round((i + 1) / total * 255)`. JS rounds half up, and so does this,
/// in integers so that no float can land a hair under a half.
fn progress(i: usize, total: usize) -> u8 {
    (((i + 1) * 255 * 2 + total) / (total * 2)) as u8
}

/// One decoded action chunk.
#[derive(Debug, PartialEq)]
pub struct Chunk<'a> {
    /// The action name, with its NUL padding removed.
    pub action: String,
    /// The action's message counter; every chunk of one message shares it.
    pub nonce: u16,
    /// Whether this is the message's last chunk.
    pub last: bool,
    /// Whether this chunk carries the message's metadata and not its payload.
    pub meta: bool,
    /// The binary type bit. Test it before `json`: bytes set both.
    pub binary: bool,
    /// The JSON type bit.
    pub json: bool,
    /// Progress through the message, 0 to 255, as the sender wrote it.
    pub progress: u8,
    /// The chunk's body, after the header.
    pub payload: &'a [u8],
}

/// A chunk's fields, or `None` for one shorter than its header. The JS reads
/// a short buffer as zeros; nothing a real peer sends is that short.
pub fn decode_chunk(buf: &[u8]) -> Option<Chunk<'_>> {
    if buf.len() < CHUNK_HEADER_BYTES {
        return None;
    }
    let name = &buf[..MAX_ACTION_NAME_BYTES];
    // `replaceAll("\0", "")`: every NUL goes, not only the padding.
    let action = String::from_utf8_lossy(name).replace('\0', "");
    let flags = buf[34];
    Some(Chunk {
        action,
        nonce: u16::from_be_bytes([buf[32], buf[33]]),
        last: flags & FLAG_LAST != 0,
        meta: flags & FLAG_META != 0,
        binary: flags & FLAG_BINARY != 0,
        json: flags & FLAG_JSON != 0,
        progress: buf[35],
        payload: &buf[CHUNK_HEADER_BYTES..],
    })
}

/// A whole action message, reassembled.
#[derive(Clone, Debug, PartialEq)]
pub struct Message {
    /// The action name.
    pub action: String,
    /// The reassembled payload.
    pub payload: Payload,
    /// The metadata sent with the message, if there was any and it parsed.
    pub meta: Option<Value>,
}

/// Reassembles one peer's chunks, per (action, nonce), until each message's
/// last chunk.
///
/// Bounded, which the JS is not: a peer that never sends a last chunk would
/// otherwise hold memory for as long as the connection lives. A message over
/// `max_bytes` is dropped whole, and so is one whose JSON does not parse --
/// the JS throws there, inside a data handler, which drops it too.
#[derive(Debug)]
pub struct Reassembler {
    pending: HashMap<(String, u16), Pending>,
    max_bytes: usize,
}

#[derive(Debug, Default)]
struct Pending {
    chunks: Vec<u8>,
    meta: Option<Value>,
    over: bool,
}

/// The default bound on one reassembled message: comfortably over anything a
/// Trystero peer sends in practice, and far under what would hurt a phone.
pub const DEFAULT_MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

impl Default for Reassembler {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_MESSAGE_BYTES)
    }
}

impl Reassembler {
    /// A reassembler that drops any message over `max_bytes`.
    pub fn new(max_bytes: usize) -> Self {
        Reassembler {
            pending: HashMap::new(),
            max_bytes,
        }
    }

    /// Feed one chunk. Returns the message its last chunk completes.
    pub fn push(&mut self, chunk: &Chunk<'_>) -> Option<Message> {
        let key = (chunk.action.clone(), chunk.nonce);
        let p = self.pending.entry(key.clone()).or_default();
        if chunk.meta {
            p.meta = serde_json::from_slice(chunk.payload).ok();
        } else if !p.over {
            if p.chunks.len() + chunk.payload.len() > self.max_bytes {
                p.over = true;
                p.chunks = Vec::new();
            } else {
                p.chunks.extend_from_slice(chunk.payload);
            }
        }
        if !chunk.last {
            return None;
        }
        let p = self.pending.remove(&key)?;
        if p.over {
            return None;
        }
        let payload = if chunk.binary {
            Payload::Binary(p.chunks)
        } else if chunk.json {
            Payload::json(serde_json::from_slice(&p.chunks).ok()?)
        } else {
            // TextDecoder replaces invalid UTF-8 rather than throwing.
            Payload::Text(String::from_utf8_lossy(&p.chunks).into_owned())
        };
        Some(Message {
            action: chunk.action.clone(),
            payload,
            meta: p.meta,
        })
    }

    /// Messages still waiting for their last chunk.
    pub fn pending(&self) -> usize {
        self.pending.len()
    }
}

const ROOM_FRAME: u8 = 1;
const PRESENCE_FRAME: u8 = 2;

/// An action chunk wrapped for one room: `[1][len u16 BE][token][chunk]`.
pub fn wrap_room(token: &str, chunk: &[u8]) -> Vec<u8> {
    let t = token.as_bytes();
    let mut f = Vec::with_capacity(3 + t.len() + chunk.len());
    f.push(ROOM_FRAME);
    f.extend_from_slice(&(t.len() as u16).to_be_bytes());
    f.extend_from_slice(t);
    f.extend_from_slice(chunk);
    f
}

/// A presence frame: `[2][1 present / 0 gone][len u16 BE][token]`.
pub fn wrap_presence(token: &str, present: bool) -> Vec<u8> {
    let t = token.as_bytes();
    let mut f = Vec::with_capacity(4 + t.len());
    f.push(PRESENCE_FRAME);
    f.push(u8::from(present));
    f.extend_from_slice(&(t.len() as u16).to_be_bytes());
    f.extend_from_slice(t);
    f
}

/// A data-channel message with its outer frame read.
#[derive(Debug, PartialEq)]
pub enum Frame<'a> {
    /// A message for a room: the room token and the action chunk it carries.
    Room {
        /// The room token the sender prefixed.
        token: String,
        /// The action chunk, which [`decode_chunk`] reads.
        chunk: &'a [u8],
    },
    /// A peer saying whether it is present in a room.
    Presence {
        /// The room token the sender prefixed.
        token: String,
        /// Whether the peer is now in the room.
        present: bool,
    },
}

/// A data-channel message's outer frame, or `None` for anything else -- a
/// bare action chunk included, which a Trystero 0.25 peer never sends.
pub fn unwrap_frame(buf: &[u8]) -> Option<Frame<'_>> {
    if buf.len() < 3 {
        return None;
    }
    match buf[0] {
        ROOM_FRAME => {
            let len = u16::from_be_bytes([buf[1], buf[2]]) as usize;
            let end = 3 + len;
            if len == 0 || buf.len() < end {
                return None;
            }
            Some(Frame::Room {
                token: String::from_utf8_lossy(&buf[3..end]).into_owned(),
                chunk: &buf[end..],
            })
        }
        PRESENCE_FRAME if buf.len() >= 4 => {
            let len = u16::from_be_bytes([buf[2], buf[3]]) as usize;
            let end = 4 + len;
            if len == 0 || buf.len() < end {
                return None;
            }
            Some(Frame::Presence {
                token: String::from_utf8_lossy(&buf[4..end]).into_owned(),
                present: buf[1] == 1,
            })
        }
        _ => None,
    }
}
