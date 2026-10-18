//! Control messages: the JSON inside a control frame.
//!
//! The field order of each variant is the JS's object-literal order, so a
//! sealed control frame here is byte-identical to the JS one
//! (test/vectors/frames.json checks it). Serde writes an internally tagged
//! enum's tag first and the fields in declaration order; do not reorder them.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::frame::{
    CONTROL_SEQ, Expect, FrameError, FrameKey, Header, Opened, TYPE_CONTROL, open, seal,
};

pub const DEFAULT_MIME: &str = "application/octet-stream";

/// An `error` message is cut to this many UTF-16 code units, as the JS does.
pub const ERROR_MESSAGE_UNITS: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    pub seq: u32,
    pub name: String,
    pub size: u64,
    #[serde(default = "default_mime")]
    pub mime: String,
    pub chunks: u64,
}

fn default_mime() -> String {
    DEFAULT_MIME.to_owned()
}

/// Which route a side observed the connection take. Advisory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NetworkPath {
    Local,
    Direct,
    Relay,
    /// Also what a value this build has never heard of reads as: a path the
    /// peer named and we cannot is a path we do not know.
    #[serde(other)]
    Unknown,
}

/// Whether a side can listen for the local-network fast path without a
/// firewall prompt. Unknown modes count as `none`, as the JS has it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LanListen {
    Quiet,
    Prompt,
    #[serde(other)]
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "kebab-case")]
pub enum Control {
    Manifest(Manifest),
    Accept {
        seq: u32,
    },
    Decline {
        seq: u32,
    },
    Done {
        seq: u32,
    },
    Complete {
        seq: u32,
        chunks: u64,
        digest: String,
    },
    Error {
        seq: u32,
        message: String,
    },
    Path {
        path: NetworkPath,
    },
    Pause,
    Resume,
    LanHello {
        listen: LanListen,
    },
    /// Carried as sent. Whether an offer is valid -- 1 to 8 private IPv4
    /// addresses, a port, a 32-hex token -- is the LAN layer's question, and
    /// an invalid one is ignored there rather than failing a transfer here.
    LanOffer {
        addrs: Vec<String>,
        port: u64,
        token: String,
        /// What the listener answers a dialler that presents the token: 32
        /// hex, as random as the token and independent of it, so a dialler
        /// knows it reached its peer and not whoever took the connection.
        /// Absent from an older listener, which answers with one ACK byte.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        answer: Option<String>,
    },
    /// The QUIC path's first word, the sender's after its SAS confirm and the
    /// receiver's only in reply, ahead of its Accept -- `lan-hello`'s timing,
    /// for its reason: it lets the sender know at Accept whether the peer has
    /// the path at all, without a timeout. Rust peers only. A JS peer never
    /// sends one, and ignores one as a type it does not know.
    QuicHello,
    /// Where this side's QUIC endpoint can be reached, and the SHA-256 of the
    /// certificate it will present, as lowercase hex. Carried as sent; the
    /// QUIC layer checks it (qrdrop-session's `quic::parse_offer`).
    QuicOffer {
        addrs: Vec<String>,
        fp: String,
    },
    /// A type this build does not know, or an advisory one it could not read.
    /// Ignored, and it still consumes its index: a newer peer's message must
    /// never be fatal, or no message could ever be added to the protocol.
    #[serde(skip)]
    Unknown,
}

/// An authentic control frame whose body this side cannot act on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Malformed(pub String);

impl Control {
    /// An `error` message, cut as the JS cuts it.
    pub fn error(seq: u32, message: &str) -> Control {
        Control::Error {
            seq,
            message: truncate_utf16(message, ERROR_MESSAGE_UNITS).to_owned(),
        }
    }

    pub fn to_json(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("control messages always serialise")
    }

    /// Reads the body of an authenticated control frame.
    ///
    /// Only a peer holding the session key can produce one, so nothing here
    /// is a stranger's probe -- but it can still be a peer one version ahead,
    /// or a buggy one. So: a type this build does not know is
    /// [`Control::Unknown`]; an advisory message (`path`, `pause`, `resume`,
    /// `lan-*`, `quic-*`) it cannot read is `Unknown` too, because nothing waits on one;
    /// and a transfer message it cannot read is [`Malformed`], which is fatal,
    /// because the transfer cannot go on from a manifest it did not understand.
    pub fn parse(json: &[u8]) -> Result<Control, Malformed> {
        let value =
            parse_json(json).ok_or_else(|| Malformed("Control message is not JSON".into()))?;
        let Some(t) = value.get("t").and_then(Value::as_str).map(str::to_owned) else {
            return Ok(Control::Unknown);
        };
        let advisory = matches!(
            t.as_str(),
            "path" | "pause" | "resume" | "lan-hello" | "lan-offer" | "quic-hello" | "quic-offer"
        );
        let known = advisory
            || matches!(
                t.as_str(),
                "manifest" | "accept" | "decline" | "done" | "complete" | "error"
            );
        if !known {
            return Ok(Control::Unknown);
        }
        match serde_json::from_value::<Control>(value) {
            Ok(msg) => Ok(msg),
            Err(_) if advisory => Ok(Control::Unknown),
            Err(e) => Err(Malformed(format!("Malformed {t} message: {e}"))),
        }
    }

    pub(crate) fn seq(&self) -> Option<u32> {
        match self {
            Control::Manifest(Manifest { seq, .. })
            | Control::Accept { seq }
            | Control::Decline { seq }
            | Control::Done { seq }
            | Control::Complete { seq, .. }
            | Control::Error { seq, .. } => Some(*seq),
            _ => None,
        }
    }
}

/// Seals a control message at `index`, which is its nonce and must never
/// repeat under one key.
pub fn seal_control(key: &FrameKey, index: u64, msg: &Control) -> Vec<u8> {
    let header = Header {
        kind: TYPE_CONTROL,
        file_seq: CONTROL_SEQ,
        index,
        last: false,
    };
    seal(key, &header, &msg.to_json())
}

/// Opens a control frame expected at `index`, without parsing its body.
pub fn open_control(key: &FrameKey, frame: &[u8], index: u64) -> Result<Opened, FrameError> {
    open(key, frame, Some(Expect::control(index)))
}

/// `serde_json`, plus the one thing `JSON.parse` accepts that it does not: a
/// lone surrogate escape. `String.prototype.slice(0, 200)` cuts in UTF-16
/// units and can split an emoji, and `JSON.stringify` then writes the
/// orphaned half as `\ud83d`. A Rust string cannot hold that, so it becomes
/// U+FFFD, and a JS receiver's error message reaches this side readable
/// rather than turning into a parse failure that hides it.
fn parse_json(json: &[u8]) -> Option<Value> {
    if let Ok(v) = serde_json::from_slice(json) {
        return Some(v);
    }
    let text = std::str::from_utf8(json).ok()?;
    serde_json::from_str(&replace_lone_surrogates(text)?).ok()
}

/// `None` when there was nothing to replace, so a parse that failed for any
/// other reason is not retried.
fn replace_lone_surrogates(text: &str) -> Option<String> {
    fn unit_at(b: &[u8], i: usize) -> Option<u16> {
        if b.get(i) != Some(&b'\\') || b.get(i + 1) != Some(&b'u') {
            return None;
        }
        u16::from_str_radix(std::str::from_utf8(b.get(i + 2..i + 6)?).ok()?, 16).ok()
    }
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let (mut i, mut last, mut changed) = (0, 0, false);
    while i < b.len() {
        if b[i] != b'\\' {
            i += 1;
            continue;
        }
        match unit_at(b, i) {
            Some(0xd800..=0xdbff) if matches!(unit_at(b, i + 6), Some(0xdc00..=0xdfff)) => i += 12,
            Some(0xd800..=0xdfff) => {
                out.push_str(&text[last..i]);
                out.push_str("\\ufffd");
                i += 6;
                last = i;
                changed = true;
            }
            // Any other escape, `\\` included, is two bytes or a whole `\uXXXX`.
            Some(_) => i += 6,
            None => i += 2,
        }
    }
    changed.then(|| {
        out.push_str(&text[last..]);
        out
    })
}

/// The longest prefix of `text` within `units` UTF-16 code units. Where the
/// JS would split a surrogate pair, this stops before it: a Rust `String`
/// cannot end in half an emoji.
pub fn truncate_utf16(text: &str, units: usize) -> &str {
    let mut used = 0;
    for (at, c) in text.char_indices() {
        used += c.len_utf16();
        if used > units {
            return &text[..at];
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn field_order_is_the_js_object_literal_order() {
        let m = Control::Manifest(Manifest {
            seq: 0,
            name: "a".into(),
            size: 1,
            mime: DEFAULT_MIME.into(),
            chunks: 1,
        });
        assert_eq!(
            String::from_utf8(m.to_json()).unwrap(),
            r#"{"t":"manifest","seq":0,"name":"a","size":1,"mime":"application/octet-stream","chunks":1}"#
        );
        assert_eq!(
            String::from_utf8(Control::Pause.to_json()).unwrap(),
            r#"{"t":"pause"}"#
        );
    }

    #[test]
    fn an_unknown_type_is_ignored_not_fatal() {
        assert_eq!(
            Control::parse(br#"{"t":"some-future-thing","x":1}"#),
            Ok(Control::Unknown)
        );
        assert_eq!(Control::parse(br#"{"no":"t"}"#), Ok(Control::Unknown));
        assert_eq!(Control::parse(b"5"), Ok(Control::Unknown));
    }

    #[test]
    fn the_quic_messages_have_the_shape_peers_expect() {
        assert_eq!(
            String::from_utf8(Control::QuicHello.to_json()).unwrap(),
            r#"{"t":"quic-hello"}"#
        );
        let offer = Control::QuicOffer {
            addrs: vec!["192.0.2.1:4433".into()],
            fp: "ab".into(),
        };
        assert_eq!(
            String::from_utf8(offer.to_json()).unwrap(),
            r#"{"t":"quic-offer","addrs":["192.0.2.1:4433"],"fp":"ab"}"#
        );
        assert_eq!(
            Control::parse(br#"{"t":"quic-offer","addrs":["192.0.2.1:4433"],"fp":"ab"}"#),
            Ok(offer)
        );
        assert_eq!(
            Control::parse(br#"{"t":"quic-offer","addrs":"x"}"#),
            Ok(Control::Unknown)
        );
    }

    #[test]
    fn an_unreadable_advisory_message_is_ignored_and_a_transfer_one_is_fatal() {
        assert_eq!(
            Control::parse(br#"{"t":"lan-offer","port":"x"}"#),
            Ok(Control::Unknown)
        );
        assert!(Control::parse(br#"{"t":"manifest","seq":0}"#).is_err());
        assert!(Control::parse(br#"{"t":"accept","seq":"0"}"#).is_err());
        assert!(Control::parse(b"{not json").is_err());
    }

    #[test]
    fn unknown_enum_values_read_as_the_fallback() {
        assert_eq!(
            Control::parse(br#"{"t":"path","path":"satellite"}"#),
            Ok(Control::Path {
                path: NetworkPath::Unknown
            })
        );
        assert_eq!(
            Control::parse(br#"{"t":"lan-hello","listen":"maybe"}"#),
            Ok(Control::LanHello {
                listen: LanListen::None
            })
        );
    }

    #[test]
    fn a_manifest_without_mime_reads_as_octet_stream() {
        let Ok(Control::Manifest(m)) =
            Control::parse(br#"{"t":"manifest","seq":0,"name":"x","size":0,"chunks":1}"#)
        else {
            panic!()
        };
        assert_eq!(m.mime, DEFAULT_MIME);
    }

    #[test]
    fn a_js_error_cut_through_an_emoji_still_reads() {
        // What JSON.stringify writes for "a📄".slice(0, 2).
        let msg = Control::parse(br#"{"t":"error","seq":0,"message":"a\ud83d"}"#).unwrap();
        assert_eq!(
            msg,
            Control::Error {
                seq: 0,
                message: "a\u{fffd}".into()
            }
        );
        // A whole pair, and an escaped backslash before a u, are left alone.
        // Built at runtime so no tool along the way decodes the escaped pair.
        let json = format!(
            r#"{{"t":"error","seq":0,"message":"\\{u}d83d \{u}d83d\{u}dcc4"}}"#,
            u = "u"
        );
        let msg = Control::parse(json.as_bytes()).unwrap();
        assert_eq!(
            msg,
            Control::Error {
                seq: 0,
                message: "\\ud83d 📄".into()
            }
        );
    }

    #[test]
    fn error_messages_are_cut_in_utf16_units_without_splitting_a_pair() {
        let long = "x".repeat(300);
        assert_eq!(truncate_utf16(&long, 200).len(), 200);
        let emoji = format!("{}📄", "x".repeat(199));
        assert_eq!(truncate_utf16(&emoji, 200), "x".repeat(199));
        assert_eq!(truncate_utf16("é", 200), "é");
    }
}
