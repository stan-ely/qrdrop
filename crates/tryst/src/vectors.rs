//! test/vectors/trystero.json, written by scripts/make-vectors.mjs from
//! Trystero 0.25.4's own modules. Every value in it is checked here.

use serde_json::Value;

use crate::crypto::{SignalCipher, Topics, handshake_response, nostr_kind, sha1_b36};
use crate::wire::{
    CHUNK_HEADER_BYTES, CHUNK_PAYLOAD_BYTES, Frame, Payload, Reassembler, decode_chunk,
    encode_action, unwrap_frame, wrap_presence, wrap_room,
};

pub(crate) fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

pub(crate) fn sha256_hex(b: &[u8]) -> String {
    use sha2::Digest as _;
    crate::crypto::hex(&sha2::Sha256::digest(b))
}

fn mod251(n: u64) -> Vec<u8> {
    (0..n).map(|i| (i % 251) as u8).collect()
}

fn load() -> Value {
    serde_json::from_str(include_str!("../../../test/vectors/trystero.json")).unwrap()
}

#[test]
fn topics() {
    let v = load();
    let t = &v["topics"];
    let app = t["app_id"].as_str().unwrap();
    let room = t["room_id"].as_str().unwrap();
    let topics = Topics::new(app, room);
    assert_eq!(format!("Trystero@{app}@{room}"), t["root_topic_plaintext"]);
    assert_eq!(topics.root(), t["root_topic"]);
    assert_eq!(
        nostr_kind(topics.root()),
        t["nostr_kind_root"].as_u64().unwrap() as u32
    );
    assert_eq!(topics.info_hash(), t["torrent_info_hash"]);
    assert_eq!(format!("Trystero:{app}:{room}"), t["room_token_plaintext"]);
    assert_eq!(topics.room_token(), t["room_token"]);
    for p in t["peers"].as_array().unwrap() {
        let topic = topics.peer_topic(p["self_id"].as_str().unwrap());
        assert_eq!(topic, p["self_topic"]);
        assert_eq!(sha1_b36(p["self_topic_plaintext"].as_str().unwrap()), topic);
        assert_eq!(
            nostr_kind(&topic),
            p["nostr_kind_self"].as_u64().unwrap() as u32
        );
    }
    for c in v["sha1"].as_array().unwrap() {
        assert_eq!(
            sha1_b36(c["input"].as_str().unwrap()),
            c["base36"],
            "{}",
            c["input"]
        );
    }
}

#[test]
fn signal() {
    let v = load();
    let s = &v["signal"];
    let t = &v["topics"];
    let password = v["password"].as_str().unwrap();
    let (app, room) = (
        t["app_id"].as_str().unwrap(),
        t["room_id"].as_str().unwrap(),
    );
    assert_eq!(format!("{password}:{app}:{room}"), s["key_plaintext"]);
    assert_eq!(
        sha256_hex(s["key_plaintext"].as_str().unwrap().as_bytes()),
        s["key"]
    );
    assert_eq!(s["iv_bytes"], 16);
    let cipher = SignalCipher::new(password, app, room);
    for c in s["cases"].as_array().unwrap() {
        let why = c["why"].as_str().unwrap();
        let iv: [u8; 16] = unhex(c["iv"].as_str().unwrap()).try_into().unwrap();
        let pt = c["plaintext"].as_str().unwrap();
        assert_eq!(cipher.encrypt_with_iv(pt, &iv), c["wire"], "{why}");
        assert_eq!(
            cipher.decrypt(c["wire"].as_str().unwrap()).as_deref(),
            Some(pt),
            "{why}"
        );
        // A fresh IV each time, and still one this side can open.
        let fresh = cipher.encrypt(pt);
        assert_ne!(fresh, cipher.encrypt(pt));
        assert_eq!(cipher.decrypt(&fresh).as_deref(), Some(pt), "{why}");
    }
    // A wrong password, a flipped byte and a malformed wire string all come
    // back as nothing, which is how every caller drops them.
    let wire = s["cases"][0]["wire"].as_str().unwrap();
    assert_eq!(SignalCipher::new("wrong", app, room).decrypt(wire), None);
    let (iv, ct) = wire.split_once('$').unwrap();
    let flipped = format!(
        "{iv}${}{}",
        if ct.starts_with('A') { 'B' } else { 'A' },
        &ct[1..]
    );
    assert_eq!(cipher.decrypt(&flipped), None);
    for bad in [
        "",
        "$",
        "1,2,3$AAAA",
        "no dollar",
        "300,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0$AAAA",
    ] {
        assert_eq!(cipher.decrypt(bad), None, "{bad:?}");
    }
}

#[test]
fn handshake() {
    let v = load();
    let h = &v["handshake"];
    let t = &v["topics"];
    let c = h["challenge_message"]["c"].as_str().unwrap();
    assert_eq!(c.len(), 36);
    assert_eq!(h["challenge_message"]["__trystero_pw"], "challenge");
    assert_eq!(h["response_message"]["__trystero_pw"], "response");
    let password = v["password"].as_str().unwrap();
    let (app, room) = (
        t["app_id"].as_str().unwrap(),
        t["room_id"].as_str().unwrap(),
    );
    assert_eq!(
        format!("{c}:{password}:{app}:{room}"),
        h["response_plaintext"]
    );
    assert_eq!(
        handshake_response(c, password, app, room),
        h["response_message"]["h"]
    );
    assert_eq!(h["ready_payload"], "");
}

#[test]
fn action_wire() {
    let v = load();
    let w = &v["action_wire"];
    assert_eq!(w["header_bytes"], CHUNK_HEADER_BYTES);
    assert_eq!(w["max_payload_bytes"], CHUNK_PAYLOAD_BYTES);
    let mut nonces = std::collections::HashMap::<String, u16>::new();
    for c in w["cases"].as_array().unwrap() {
        let action = c["action"].as_str().unwrap();
        let payload = match &c["payload"] {
            p if p.get("binary").is_some() => Payload::Binary(match &p["binary"] {
                Value::String(s) => unhex(s),
                n => mod251(n["mod251"].as_u64().unwrap()),
            }),
            p => Payload::json(p["json"].clone()),
        };
        let meta = c.get("metadata");
        let nonce = nonces.entry(action.to_owned()).or_insert(0);
        let chunks = encode_action(action, *nonce, &payload, meta).unwrap();
        *nonce += 1;
        let want = c["chunks"].as_array().unwrap();
        assert_eq!(chunks.len(), want.len(), "{action}");
        let mut r = Reassembler::default();
        let mut done = None;
        for (i, (got, want)) in chunks.iter().zip(want).enumerate() {
            match want.get("hex") {
                Some(h) => assert_eq!(crate::crypto::hex(got), *h, "{action} chunk {i}"),
                None => {
                    assert_eq!(
                        crate::crypto::hex(&got[..CHUNK_HEADER_BYTES]),
                        want["header"],
                        "{action} chunk {i}"
                    );
                    assert_eq!(got.len() as u64, want["length"].as_u64().unwrap());
                    assert_eq!(sha256_hex(got), want["sha256"], "{action} chunk {i}");
                }
            }
            let chunk = decode_chunk(got).unwrap();
            assert_eq!(chunk.action, action);
            if let Some(m) = r.push(&chunk) {
                done = Some(m);
            }
        }
        let m = done.expect("the last chunk completes the message");
        assert_eq!(m.payload, payload, "{action}");
        assert_eq!(m.meta.as_ref(), meta, "{action}");
        assert_eq!(r.pending(), 0);
    }
    // Names Trystero refuses before sending.
    assert!(encode_action("", 0, &Payload::Text(String::new()), None).is_err());
    assert!(encode_action(&"x".repeat(33), 0, &Payload::Text(String::new()), None).is_err());
}

#[test]
fn room_frame() {
    let v = load();
    let f = &v["room_frame"];
    let token = v["topics"]["room_token"].as_str().unwrap();
    let inner = unhex(f["data"]["inner"].as_str().unwrap());
    let frame = wrap_room(token, &inner);
    assert_eq!(crate::crypto::hex(&frame), f["data"]["frame"]);
    assert_eq!(
        unwrap_frame(&frame),
        Some(Frame::Room {
            token: token.to_owned(),
            chunk: &inner
        })
    );
    for p in f["presence"].as_array().unwrap() {
        let present = p["present"].as_bool().unwrap();
        let frame = wrap_presence(token, present);
        assert_eq!(crate::crypto::hex(&frame), p["frame"]);
        assert_eq!(
            unwrap_frame(&frame),
            Some(Frame::Presence {
                token: token.to_owned(),
                present
            })
        );
    }
    for bad in [
        &[][..],
        &[1, 0],
        &[1, 0, 0, 9],
        &[1, 0, 9, b'a'],
        &[2, 1, 0],
        &[3, 0, 1, b'a'],
        &[2, 1, 0, 0],
    ] {
        assert_eq!(unwrap_frame(bad), None, "{bad:?}");
    }
}

#[test]
fn nostr_event_topic() {
    // The event itself (its id and BIP-340 signature) is the nostr client's,
    // in phase 4; what the core owns is the kind and the tag.
    let v = load();
    let msg: Value = serde_json::from_str(v["nostr_event"]["message"].as_str().unwrap()).unwrap();
    let ev = &msg[1];
    let topic = ev["tags"][0][1].as_str().unwrap();
    assert_eq!(topic, v["topics"]["root_topic"]);
    assert_eq!(ev["kind"].as_u64().unwrap() as u32, nostr_kind(topic));
}
