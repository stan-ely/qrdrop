//! Nostr's half of the wire that is not the signaller's: the keypair, the
//! signed event a topic message travels in, and the subscription filter.
//! Trystero 0.25.4's `nostr/dist/index.mjs` is the source.
//!
//! Events follow NIP-01 -- `id` is SHA-256 of
//! `[0, pubkey, created_at, kind, tags, content]` as JSON, `sig` a BIP-340
//! Schnorr signature over it -- with no proof of work. Inbound events are not
//! verified, as Trystero does not verify them: everything a peer says that
//! matters is under the signal cipher, and a forged event that does not open
//! is dropped there.

use k256::schnorr::SigningKey;
use rand_core::{OsRng, RngCore};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::crypto::{gen_id, hex, nostr_kind};

/// The event tag that carries a topic.
pub const TOPIC_TAG: &str = "x";

/// One Schnorr keypair per process in Trystero; one per [`Keys`] here.
pub struct Keys {
    key: SigningKey,
    pubkey: String,
}

impl std::fmt::Debug for Keys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Keys")
            .field("pubkey", &self.pubkey)
            .finish_non_exhaustive()
    }
}

impl Keys {
    pub fn generate() -> Self {
        Self::from_key(SigningKey::random(&mut OsRng))
    }

    #[cfg(test)]
    pub(crate) fn from_secret(bytes: &[u8]) -> Option<Self> {
        SigningKey::from_bytes(bytes).ok().map(Self::from_key)
    }

    fn from_key(key: SigningKey) -> Self {
        let pubkey = hex(&key.verifying_key().to_bytes());
        Keys { key, pubkey }
    }

    /// The x-only public key, lowercase hex.
    pub fn pubkey(&self) -> &str {
        &self.pubkey
    }

    /// `["EVENT", {...}]` for `content` on `topic`, signed with fresh
    /// auxiliary randomness.
    pub fn event(&self, topic: &str, content: &str, created_at: u64) -> String {
        let mut aux = [0u8; 32];
        OsRng.fill_bytes(&mut aux);
        self.event_with_aux(topic, content, created_at, &aux)
    }

    pub(crate) fn event_with_aux(
        &self,
        topic: &str,
        content: &str,
        created_at: u64,
        aux: &[u8; 32],
    ) -> String {
        let kind = nostr_kind(topic);
        let tags = json!([[TOPIC_TAG, topic]]);
        let id =
            Sha256::digest(json!([0, self.pubkey, created_at, kind, tags, content]).to_string());
        let sig = self
            .key
            .sign_raw(&id, aux)
            .expect("signing a 32-byte digest cannot fail");
        // Trystero's key order, which no relay needs and a byte comparison does.
        json!(["EVENT", {
            "kind": kind,
            "tags": tags,
            "created_at": created_at,
            "content": content,
            "pubkey": self.pubkey,
            "id": hex(&id),
            "sig": hex(&sig.to_bytes()),
        }])
        .to_string()
    }
}

/// A subscription to `topics` from `since` (seconds), with a fresh 64-char ID:
/// `["REQ", subId, {kinds, since, "#x": topics}]`. Returns the ID and the
/// message.
pub fn subscribe(topics: &[&str], since: u64) -> (String, String) {
    let id = gen_id(64);
    let mut kinds: Vec<u32> = vec![];
    for t in topics {
        let k = nostr_kind(t);
        if !kinds.contains(&k) {
            kinds.push(k);
        }
    }
    let msg = json!(["REQ", id, {"kinds": kinds, "since": since, "#x": topics}]).to_string();
    (id, msg)
}

/// What a relay said, as far as a Trystero client cares.
#[derive(Clone, Debug, PartialEq)]
pub enum RelayMsg {
    /// An event on one of our subscriptions: its topic tag and content.
    Event { topic: String, content: String },
    /// `OK`: whether the relay took the event, and why not.
    Ok {
        event_id: String,
        accepted: bool,
        reason: String,
    },
    /// `CLOSED`: the relay ended a subscription, which Trystero treats as the
    /// relay refusing us for good.
    Closed { reason: String },
    /// Anything else: `EOSE`, `NOTICE`, `AUTH`.
    Other,
}

impl RelayMsg {
    pub fn parse(text: &str) -> Option<Self> {
        let v: Value = serde_json::from_str(text).ok()?;
        let a = v.as_array()?;
        let s = |i: usize| {
            a.get(i)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        Some(match a.first()?.as_str()? {
            "EVENT" => {
                let ev = a.get(2)?;
                let content = ev.get("content")?.as_str()?.to_owned();
                let topic = ev
                    .get("tags")?
                    .as_array()?
                    .iter()
                    .find(|t| t.get(0).and_then(Value::as_str) == Some(TOPIC_TAG))?
                    .get(1)?
                    .as_str()?
                    .to_owned();
                RelayMsg::Event { topic, content }
            }
            "OK" => RelayMsg::Ok {
                event_id: s(1),
                accepted: a.get(2).and_then(Value::as_bool).unwrap_or(false),
                reason: s(3),
            },
            "CLOSED" => RelayMsg::Closed { reason: s(2) },
            _ => RelayMsg::Other,
        })
    }

    /// An `OK false` that is neither rate limiting nor a duplicate, or a
    /// `CLOSED`: the relay has said, in words, that it will not carry us.
    /// That -- and never a dropped socket -- is what retires a relay.
    pub fn is_refusal(&self) -> bool {
        match self {
            RelayMsg::Closed { .. } => true,
            RelayMsg::Ok {
                accepted: false,
                reason,
                ..
            } => !reason.starts_with("rate-limited:") && !reason.starts_with("duplicate:"),
            _ => false,
        }
    }

    pub fn is_rate_limited(&self) -> bool {
        matches!(self, RelayMsg::Ok { accepted: false, reason, .. } if reason.starts_with("rate-limited:"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_vector_event_is_byte_identical() {
        let v: Value =
            serde_json::from_str(include_str!("../../../test/vectors/trystero.json")).unwrap();
        let e = &v["nostr_event"];
        let sk = crate::vectors::unhex(e["secret_key"].as_str().unwrap());
        let aux: [u8; 32] = crate::vectors::unhex(e["aux_rand"].as_str().unwrap())
            .try_into()
            .unwrap();
        let keys = Keys::from_secret(&sk).unwrap();
        let msg: Value = serde_json::from_str(e["message"].as_str().unwrap()).unwrap();
        let ev = &msg[1];
        assert_eq!(keys.pubkey(), ev["pubkey"]);
        let preimage = json!([
            0,
            keys.pubkey(),
            ev["created_at"],
            ev["kind"],
            ev["tags"],
            ev["content"]
        ])
        .to_string();
        assert_eq!(preimage, e["id_preimage"]);
        let got = keys.event_with_aux(
            ev["tags"][0][1].as_str().unwrap(),
            ev["content"].as_str().unwrap(),
            ev["created_at"].as_u64().unwrap(),
            &aux,
        );
        assert_eq!(got, e["message"]);
    }

    #[test]
    fn relay_messages_parse_and_classify() {
        let ev = r#"["EVENT","sub",{"kind":22388,"tags":[["x","topic"]],"content":"{\"peerId\":\"a\"}"}]"#;
        assert_eq!(
            RelayMsg::parse(ev),
            Some(RelayMsg::Event {
                topic: "topic".into(),
                content: r#"{"peerId":"a"}"#.into()
            })
        );
        let refusal = RelayMsg::parse(r#"["OK","id",false,"blocked: no"]"#).unwrap();
        assert!(refusal.is_refusal());
        let limited = RelayMsg::parse(r#"["OK","id",false,"rate-limited: slow down"]"#).unwrap();
        assert!(!limited.is_refusal() && limited.is_rate_limited());
        assert!(
            !RelayMsg::parse(r#"["OK","id",false,"duplicate: have it"]"#)
                .unwrap()
                .is_refusal()
        );
        assert!(
            !RelayMsg::parse(r#"["OK","id",true,""]"#)
                .unwrap()
                .is_refusal()
        );
        assert!(
            RelayMsg::parse(r#"["CLOSED","sub","auth-required: no"]"#)
                .unwrap()
                .is_refusal()
        );
        assert_eq!(RelayMsg::parse(r#"["EOSE","sub"]"#), Some(RelayMsg::Other));
        assert_eq!(RelayMsg::parse("not json"), None);
        let (id, req) = subscribe(&["a", "b"], 1_760_000_000);
        assert_eq!(id.len(), 64);
        let v: Value = serde_json::from_str(&req).unwrap();
        assert_eq!(v[2]["#x"], json!(["a", "b"]));
        assert_eq!(v[2]["kinds"], json!([nostr_kind("a"), nostr_kind("b")]));
    }
}
