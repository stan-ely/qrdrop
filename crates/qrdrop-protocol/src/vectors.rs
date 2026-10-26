//! test/vectors/, written by scripts/make-vectors.mjs from the JS core. Every
//! case in secret, session, frames and digest is checked here; trystero.json
//! and the recordings are tryst's, and live in crates/tryst/vectors/.

use serde_json::Value;

use crate::code::{Locator, Secret};
use crate::control::{Control, seal_control};
use crate::digest::Chain;
use crate::frame::{
    CHUNK_SIZE, CONTROL_SEQ, Expect, FrameError, FrameKey, HEADER_BYTES, Header, MAX_FRAME_BYTES,
    MIN_FRAME_BYTES, TAG_BYTES, TYPE_CHUNK, TYPE_CONTROL, open, seal,
};
use crate::pairing::{Keypair, Role, SAS_TABLE, Sas, tests::derived};
use crate::transfer::chunk_count;
use crate::{CodeError, digest::hex};

fn load(json: &str) -> Value {
    serde_json::from_str(json).unwrap()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn arr<const N: usize>(v: &Value) -> [u8; N] {
    unhex(v.as_str().unwrap()).try_into().unwrap()
}

fn mod251(n: u64) -> Vec<u8> {
    (0..n).map(|i| (i % 251) as u8).collect()
}

fn plaintext(v: &Value) -> Vec<u8> {
    match v {
        Value::String(s) => unhex(s),
        _ => mod251(v["mod251"].as_u64().unwrap()),
    }
}

fn sha256_hex(b: &[u8]) -> String {
    use sha2::Digest as _;
    hex(&sha2::Sha256::digest(b))
}

#[test]
fn secret() {
    let v = load(include_str!("../../../test/vectors/secret.json"));
    let base = v["base_url"].as_str().unwrap();
    for c in v["derive"].as_array().unwrap() {
        let secret = Secret::from_bytes(arr(&c["secret"]));
        assert_eq!(secret.code(), c["code"]);
        assert_eq!(secret.url(base).unwrap(), c["url"]);
        assert_eq!(secret.topic(), c["topic"]);
        assert_eq!(secret.password(), c["password"]);
        assert_eq!(secret.topic_at(Some(1)), c["topic_epoch_1"]);
    }
    for c in v["decode"].as_array().unwrap() {
        let why = c["why"].as_str().unwrap();
        let got = Secret::decode_pairing(c["input"].as_str().unwrap());
        match c.get("secret") {
            Some(s) => {
                let (secret, locator) = got.unwrap_or_else(|e| panic!("{why}: {e}"));
                assert_eq!(*secret.as_bytes(), arr(s), "{why}");
                let want = (!c["locator"].is_null()).then(|| Locator {
                    port: c["locator"]["port"].as_u64().unwrap().try_into().unwrap(),
                    addresses: c["locator"]["addresses"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|a| a.as_str().unwrap().parse().unwrap())
                        .collect(),
                });
                assert_eq!(locator, want, "{why}");
                // What the JS encoded, the Rust encodes byte for byte.
                if let Some(want) = &want {
                    let input = c["input"].as_str().unwrap();
                    assert!(input.ends_with(&secret.code_with(want)), "{why}");
                }
            }
            None => {
                let want = match c["error"].as_str().unwrap() {
                    "fragment-only" => CodeError::FragmentOnly,
                    "not-a-code" => CodeError::NotACode,
                    "malformed" => CodeError::Malformed,
                    "malformed-locator" => CodeError::MalformedLocator,
                    e => panic!("unknown error kind {e}"),
                };
                assert_eq!(got.err(), Some(want), "{why}");
            }
        }
    }
}

#[test]
fn session() {
    let v = load(include_str!("../../../test/vectors/session.json"));
    for c in v["cases"].as_array().unwrap() {
        let secret = Secret::from_bytes(arr(&c["secret"]));
        let host = Keypair::from_private(&unhex(c["host_private"].as_str().unwrap()));
        let guest = Keypair::from_private(&unhex(c["guest_private"].as_str().unwrap()));
        assert_eq!(hex(host.public_key()), c["host_public"]);
        assert_eq!(host.public_key_b64url(), c["host_public_b64url"]);
        assert_eq!(guest.public_key_b64url(), c["guest_public_b64url"]);

        let shared = p256::ecdh::diffie_hellman(
            p256::SecretKey::from_slice(&unhex(c["host_private"].as_str().unwrap()))
                .unwrap()
                .to_nonzero_scalar(),
            p256::PublicKey::from_sec1_bytes(guest.public_key())
                .unwrap()
                .as_affine(),
        );
        assert_eq!(hex(shared.raw_secret_bytes()), c["shared"]);

        let (transcript, h2g, g2h, sas) = derived(
            &unhex(c["host_private"].as_str().unwrap()),
            guest.public_key(),
            &secret,
        );
        assert_eq!(hex(&transcript), c["transcript"]);
        assert_eq!(hex(&h2g), c["host_to_guest"]);
        assert_eq!(hex(&g2h), c["guest_to_host"]);
        assert_eq!(hex(&sas), c["sas_bytes"]);

        // And through the public path: both sides see the vector's SAS.
        let gp = guest.public_key_b64url();
        let hp = host.public_key_b64url();
        let h = host.establish_b64url(&gp, &secret, Role::Host).unwrap();
        let g = guest.establish_b64url(&hp, &secret, Role::Guest).unwrap();
        for p in [&h, &g] {
            assert_eq!(p.sas().emoji(), c["sas"]);
            assert_eq!(p.sas().cli_line(), c["cli_line"]);
            assert_eq!(Value::from(p.sas().words().to_vec()), c["sas_words"]);
        }
    }
    for r in v["render"].as_array().unwrap() {
        let sas = Sas::from_bytes(arr(&r["sas_bytes"]));
        assert_eq!(sas.emoji(), r["sas"]);
        assert_eq!(sas.cli_line(), r["cli_line"]);
        assert_eq!(Value::from(sas.words().to_vec()), r["sas_words"]);
    }
    let table: Vec<Value> = SAS_TABLE
        .iter()
        .map(|(e, w)| Value::from(vec![*e, *w]))
        .collect();
    assert_eq!(Value::from(table), v["sas_table"]);
}

#[test]
fn frames() {
    let v = load(include_str!("../../../test/vectors/frames.json"));
    let key_bytes = |name: &str| -> [u8; 32] { arr(&v["keys"][name]) };
    let key = |name: &Value| FrameKey::new(&key_bytes(name.as_str().unwrap()));

    let k = &v["constants"];
    assert_eq!(k["HEADER_BYTES"], HEADER_BYTES);
    assert_eq!(k["TAG_BYTES"], TAG_BYTES);
    assert_eq!(k["CHUNK_SIZE"], CHUNK_SIZE);
    assert_eq!(k["MAX_FRAME_BYTES"], MAX_FRAME_BYTES);
    assert_eq!(k["CONTROL_SEQ"], CONTROL_SEQ);
    assert_eq!(k["TYPE_CONTROL"], TYPE_CONTROL);
    assert_eq!(k["TYPE_CHUNK"], TYPE_CHUNK);
    assert_eq!(k["MIN_FRAME_BYTES"], MIN_FRAME_BYTES);
    assert_eq!(k["FULL_FRAME_BYTES"], HEADER_BYTES + CHUNK_SIZE + TAG_BYTES);

    let fields = |f: &Value| Header {
        kind: f["type"].as_u64().unwrap() as u8,
        file_seq: f["fileSeq"].as_u64().unwrap() as u32,
        index: f["index"].as_u64().unwrap(),
        last: f["last"].as_bool().unwrap(),
    };
    for h in v["headers"].as_array().unwrap() {
        assert_eq!(hex(&fields(&h["fields"]).encode()), h["header"]);
    }
    for h in v["decode"].as_array().unwrap() {
        assert_eq!(Header::decode(&arr(&h["header"])), fields(&h["fields"]));
    }

    for c in v["chunks"].as_array().unwrap() {
        let why = c["why"].as_str().unwrap();
        let k = key(&c["key"]);
        let header = Header {
            kind: TYPE_CHUNK,
            file_seq: c["file_seq"].as_u64().unwrap() as u32,
            index: c["index"].as_u64().unwrap(),
            last: c["last"].as_bool().unwrap(),
        };
        let pt = plaintext(&c["plaintext"]);
        let frame = seal(&k, &header, &pt);
        match c.get("frame") {
            Some(f) => assert_eq!(hex(&frame), *f, "{why}"),
            None => {
                assert_eq!(
                    frame.len() as u64,
                    c["frame_length"].as_u64().unwrap(),
                    "{why}"
                );
                assert_eq!(sha256_hex(&frame), c["frame_sha256"], "{why}");
            }
        }
        let opened = open(
            &k,
            &frame,
            Some(Expect::chunk(header.file_seq, header.index)),
        )
        .unwrap();
        assert_eq!(opened.plaintext, pt, "{why}");
        assert_eq!(opened.header, header, "{why}");
    }

    for c in v["controls"].as_array().unwrap() {
        let k = key(&c["key"]);
        let index = c["index"].as_u64().unwrap();
        let msg: Control = serde_json::from_value(c["message"].clone()).unwrap();
        assert_eq!(String::from_utf8(msg.to_json()).unwrap(), c["plaintext"]);
        let frame = seal_control(&k, index, &msg);
        assert_eq!(hex(&frame), c["frame"], "{:?}", c["message"]);
        let opened = open(
            &k,
            &unhex(c["frame"].as_str().unwrap()),
            Some(Expect::control(index)),
        )
        .unwrap();
        assert_eq!(Control::parse(&opened.plaintext), Ok(msg));
    }

    for r in v["reject"].as_array().unwrap() {
        let why = r["why"].as_str().unwrap();
        let k = key(&r["key"]);
        let frame = match r.get("frame_zeros") {
            Some(n) => vec![0u8; n.as_u64().unwrap() as usize],
            None => unhex(r["frame"].as_str().unwrap()),
        };
        let expect = (!r["expect"].is_null()).then(|| Expect {
            kind: r["expect"]["type"].as_u64().unwrap() as u8,
            file_seq: r["expect"]["fileSeq"].as_u64().unwrap() as u32,
            index: r["expect"]["index"].as_u64().unwrap(),
        });
        let got = open(&k, &frame, expect).unwrap_err();
        let kind = match got {
            FrameError::Unauthenticated => "unauthenticated",
            FrameError::Index { .. } => "index",
            FrameError::Type => "type",
            FrameError::FileSeq => "file-seq",
            FrameError::TooShort => "too-short",
            FrameError::TooLarge => "too-large",
        };
        assert_eq!(kind, r["error"], "{why}");
    }
    // The control sequence is reserved: no file may take it.
    assert_eq!(
        Header {
            kind: TYPE_CONTROL,
            file_seq: CONTROL_SEQ,
            index: 0,
            last: false
        }
        .encode()[1..5],
        [0xff; 4]
    );
}

#[test]
fn digest() {
    let v = load(include_str!("../../../test/vectors/digest.json"));
    for c in v["cases"].as_array().unwrap() {
        let why = c["why"].as_str().unwrap();
        let file = plaintext(&c["file"]);
        let chunks = chunk_count(file.len() as u64);
        assert_eq!(chunks, c["chunks"].as_u64().unwrap(), "{why}");
        let mut chain = Chain::new();
        let steps = c["steps"].as_array().unwrap();
        for (i, step) in steps.iter().enumerate() {
            let end = ((i + 1) * CHUNK_SIZE).min(file.len());
            chain.update(&file[i * CHUNK_SIZE..end]);
            assert_eq!(chain.hex(), *step, "{why}, step {i}");
        }
        assert_eq!(steps.len() as u64, chunks, "{why}");
        assert_eq!(chain.hex(), c["digest"], "{why}");
    }
    for c in v["chunk_counts"].as_array().unwrap() {
        assert_eq!(
            chunk_count(c["size"].as_u64().unwrap()),
            c["chunks"].as_u64().unwrap()
        );
    }
}
