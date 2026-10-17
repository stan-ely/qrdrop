//! The QR secret, the two values derived from it, and the forms a code takes.
//!
//! A port of `src/core/secret.js`. The secret is 32 bytes of CSPRNG output, a
//! full-entropy key and not a passphrase, which is why there is a KDF here and
//! no PAKE. Nothing derived from it is used raw, and the secret itself never
//! leaves the device: only values HKDF'd out of it under distinct labels.

use std::fmt;

use base64::Engine as _;
use base64::alphabet::URL_SAFE;
use base64::engine::general_purpose::NO_PAD;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use hkdf::Hkdf;
use rand_core::{OsRng, RngCore};
use sha2::Sha256;

pub const SECRET_BYTES: usize = 32;
const TOPIC_BYTES: usize = 16;

/// Domain separation salt. Fixed and public; its job is to make these
/// derivations meaningless outside this protocol version, not to be secret.
const SALT: &[u8] = b"qrdrop/v1";

/// Encoding, canonical: what every value we emit is written with.
const B64: GeneralPurpose = GeneralPurpose::new(&URL_SAFE, NO_PAD);

/// Decoding, as lenient as `atob` on the two points that are reachable here:
/// padding is optional, and the unused low bits of the last character are
/// ignored. The base64 crate rejects those bits by default, and the JS has
/// always accepted them, so a code differing only there is the same secret on
/// both sides (test/vectors/secret.json has the case). Refusing it would be a
/// code the website opens and the app calls malformed.
const B64_LENIENT: GeneralPurpose = GeneralPurpose::new(
    &URL_SAFE,
    GeneralPurposeConfig::new()
        .with_decode_allow_trailing_bits(true)
        .with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

pub(crate) fn to_base64url(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

pub(crate) fn from_base64url(text: &str) -> Option<Vec<u8>> {
    B64_LENIENT.decode(text).ok()
}

/// Why a scanned or pasted string is not a code we will use.
///
/// The messages are the JS's, word for word: both surfaces show them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodeError {
    /// A code was found in a URL's query string or path. Its own error rather
    /// than "not a code", because accepting it would be the leak and
    /// declining it silently would hide why.
    FragmentOnly,
    NotACode,
    /// The right shape, but not 32 bytes of key.
    Malformed,
    /// The base for [`Secret::url`] is not an absolute http(s) URL.
    BadBaseUrl,
}

impl fmt::Display for CodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            CodeError::FragmentOnly => {
                "qrdrop code must be in the URL fragment (after #), not the query string or path"
            }
            CodeError::NotACode => {
                "Not a qrdrop code \u{2014} expected qrdrop:\u{2026} or a link with #qrdrop:\u{2026} in it"
            }
            CodeError::Malformed => {
                "Malformed qrdrop code \u{2014} expected 32 bytes of key, base64url-encoded"
            }
            CodeError::BadBaseUrl => "base-url must be an absolute http(s) URL",
        })
    }
}

impl std::error::Error for CodeError {}

/// The 32 bytes the QR code carries.
///
/// Not `Copy`, and its `Debug` prints nothing of it: this is the one value
/// that decrypts a pairing, and a stray `{:?}` in a log line is how it would
/// leave the device.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret([u8; SECRET_BYTES]);

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(..)")
    }
}

impl Secret {
    /// Fresh bytes from the OS. A pairing that fails its SAS must come back
    /// through here and never reuse the old secret: four symbols are 24 bits
    /// only if an attacker gets one roll at them.
    pub fn generate() -> Self {
        let mut bytes = [0u8; SECRET_BYTES];
        OsRng.fill_bytes(&mut bytes);
        Secret(bytes)
    }

    pub fn from_bytes(bytes: [u8; SECRET_BYTES]) -> Self {
        Secret(bytes)
    }

    pub fn as_bytes(&self) -> &[u8; SECRET_BYTES] {
        &self.0
    }

    fn hkdf(&self, info: &str, out: &mut [u8]) {
        Hkdf::<Sha256>::new(Some(SALT), &self.0)
            .expand(info.as_bytes(), out)
            .expect("HKDF output this short is always valid");
    }

    /// The public rendezvous ID: the room name peers meet on, as base64url of
    /// 16 bytes. Deliberately not the secret, which used as a room ID would
    /// be published to every relay on the network.
    pub fn topic(&self) -> String {
        self.topic_at(None)
    }

    /// The topic for one epoch of a future persistent pairing, where the room
    /// must rotate or a relay could link every transfer the pair makes. The
    /// default flow passes `None`: its secret is already fresh per session.
    pub fn topic_at(&self, epoch: Option<u64>) -> String {
        let info = match epoch {
            None => "topic".to_owned(),
            Some(n) => format!("topic/{n}"),
        };
        let mut out = [0u8; TOPIC_BYTES];
        self.hkdf(&info, &mut out);
        to_base64url(&out)
    }

    /// The password Trystero encrypts signals under. A string because that is
    /// what Trystero takes; it hashes it once into its key (no PBKDF2 and no
    /// salt, see test/vectors/trystero.json), which is enough only because
    /// this is 256 bits of HKDF output rather than a passphrase.
    pub fn password(&self) -> String {
        let mut out = [0u8; 32];
        self.hkdf("signal", &mut out);
        to_base64url(&out)
    }

    /// The bare form, `qrdrop:` and 43 characters. The CLI emits only this,
    /// and every decoder must accept it forever.
    pub fn code(&self) -> String {
        format!("qrdrop:{}", to_base64url(&self.0))
    }

    /// The URL form, with the code in the fragment.
    ///
    /// The fragment is the one part of a URL a browser never sends to the
    /// server, which is the entire reason a link may carry a decryption key.
    /// Any query or fragment already on `base` is discarded.
    pub fn url(&self, base: &str) -> Result<String, CodeError> {
        let url = Url::parse(base).ok_or(CodeError::BadBaseUrl)?;
        Ok(format!("{}#{}", url.serialize_without_query(), self.code()))
    }

    /// Reads a code from untrusted text: whatever a camera decoded, or a
    /// paste. Accepts the bare form, and an http(s) URL carrying it in the
    /// fragment and nowhere else.
    pub fn decode(text: &str) -> Result<Self, CodeError> {
        let trimmed = js_trim(text);

        if let Some(code) = bare_code(trimmed) {
            return decode_code(code);
        }

        let Some(url) = Url::parse(trimmed) else {
            return Err(CodeError::NotACode);
        };

        // The fragment, and only the fragment. Accepting a code from the
        // query or the path would quietly start sending the key to whatever
        // serves the origin, so those get an error of their own.
        if let Some(code) = url.fragment.as_deref().and_then(bare_code) {
            return decode_code(code);
        }
        if contains_code_like(url.query.as_deref().unwrap_or("")) || contains_code_like(&url.path) {
            return Err(CodeError::FragmentOnly);
        }
        Err(CodeError::NotACode)
    }
}

/// `^qrdrop:([A-Za-z0-9_-]{43})$`, returning the capture.
fn bare_code(text: &str) -> Option<&str> {
    let code = text.strip_prefix("qrdrop:")?;
    (code.len() == 43 && code.bytes().all(is_b64url)).then_some(code)
}

/// `/qrdrop:[A-Za-z0-9_-]+/`, unanchored.
fn contains_code_like(text: &str) -> bool {
    text.match_indices("qrdrop:")
        .any(|(at, m)| text[at + m.len()..].bytes().next().is_some_and(is_b64url))
}

fn is_b64url(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-' || b == b'_'
}

/// A wrong length means truncation or corruption upstream, and accepting it
/// would hand a short key straight to HKDF.
fn decode_code(code: &str) -> Result<Secret, CodeError> {
    let bytes = from_base64url(code).ok_or(CodeError::Malformed)?;
    let bytes: [u8; SECRET_BYTES] = bytes.try_into().map_err(|_| CodeError::Malformed)?;
    Ok(Secret(bytes))
}

/// `String.prototype.trim`: JS's WhiteSpace and LineTerminator sets, which are
/// not Rust's. JS trims U+FEFF, a byte-order mark a paste can carry, and Rust
/// does not; Rust trims U+0085, and JS does not.
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| {
        matches!(
            c,
            '\u{9}'
                | '\u{a}'
                | '\u{b}'
                | '\u{c}'
                | '\u{d}'
                | ' '
                | '\u{a0}'
                | '\u{1680}'
                | '\u{2000}'
                ..='\u{200a}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202f}'
                    | '\u{205f}'
                    | '\u{3000}'
                    | '\u{feff}'
        )
    })
}

/// Just enough of the WHATWG URL parser for an http(s) URL: the scheme, the
/// authority, and where the path, query and fragment begin and end.
///
/// Not the `url` crate, which would bring IDNA and its Unicode tables into
/// every Android build for one question. The question is narrow: is this
/// http(s), and is the code in the fragment. Where this parser is looser than
/// WHATWG's -- a host IDNA would refuse, say -- the most it changes is which
/// error a bad link gets. The code is still taken from the fragment or not at
/// all, which is the property that matters.
struct Url {
    scheme: &'static str,
    /// Lowercased, userinfo dropped, the default port removed.
    authority: String,
    path: String,
    query: Option<String>,
    fragment: Option<String>,
}

impl Url {
    fn parse(input: &str) -> Option<Url> {
        // WHATWG strips leading and trailing C0 controls and spaces, then
        // removes every tab and newline wherever it is.
        let input: String = input
            .trim_matches(|c: char| c <= ' ')
            .chars()
            .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
            .collect();

        let colon = input.find(':')?;
        let scheme = &input[..colon];
        let (scheme, default_port) = if scheme.eq_ignore_ascii_case("https") {
            ("https", "443")
        } else if scheme.eq_ignore_ascii_case("http") {
            ("http", "80")
        } else {
            return None;
        };

        // A special scheme skips any run of slashes, either way round.
        let rest = input[colon + 1..].trim_start_matches(['/', '\\']);
        let (rest, fragment) = match rest.split_once('#') {
            Some((r, f)) => (r, Some(f.to_owned())),
            None => (rest, None),
        };
        let (rest, query) = match rest.split_once('?') {
            Some((r, q)) => (r, Some(q.to_owned())),
            None => (rest, None),
        };
        let auth_end = rest.find(['/', '\\']).unwrap_or(rest.len());
        let (authority, path) = rest.split_at(auth_end);

        let host_port = match authority.rfind('@') {
            Some(at) => &authority[at + 1..],
            None => authority,
        };
        let (host, port) = split_port(host_port)?;
        if host.is_empty() || !valid_host(host) {
            return None;
        }
        let port = match port {
            None | Some("") => None,
            Some(p) => {
                let n: u32 = p
                    .parse()
                    .ok()
                    .filter(|_| p.bytes().all(|b| b.is_ascii_digit()))?;
                if n > 65535 {
                    return None;
                }
                let n = n.to_string();
                (n != default_port).then_some(n)
            }
        };
        let mut authority = host.to_ascii_lowercase();
        if let Some(port) = port {
            authority.push(':');
            authority.push_str(&port);
        }

        let path = if path.is_empty() {
            "/".to_owned()
        } else {
            path.replace('\\', "/")
        };
        Some(Url {
            scheme,
            authority,
            path,
            query,
            fragment,
        })
    }

    fn serialize_without_query(&self) -> String {
        format!("{}://{}{}", self.scheme, self.authority, self.path)
    }
}

fn split_port(host_port: &str) -> Option<(&str, Option<&str>)> {
    if host_port.starts_with('[') {
        let close = host_port.find(']')?;
        let (host, rest) = host_port.split_at(close + 1);
        return match rest {
            "" => Some((host, None)),
            _ => Some((host, Some(rest.strip_prefix(':')?))),
        };
    }
    Some(match host_port.rsplit_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (host_port, None),
    })
}

/// WHATWG's forbidden domain code points, and a bracketed IPv6 literal.
fn valid_host(host: &str) -> bool {
    if let Some(inner) = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        return !inner.is_empty()
            && inner
                .bytes()
                .all(|b| b.is_ascii_hexdigit() || b == b':' || b == b'.');
    }
    !host.chars().any(|c| {
        c <= ' '
            || c == '\u{7f}'
            || matches!(
                c,
                '#' | '%' | '/' | ':' | '<' | '>' | '?' | '@' | '[' | '\\' | ']' | '^' | '|'
            )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_form_round_trips() {
        let secret = Secret::generate();
        let code = secret.code();
        assert_eq!(code.len(), 7 + 43);
        assert!(bare_code(&code).is_some());
        assert_eq!(Secret::decode(&code).unwrap(), secret);
    }

    #[test]
    fn url_form_round_trips() {
        let secret = Secret::generate();
        let url = secret.url("https://example.com/qrdrop/").unwrap();
        assert_eq!(
            url,
            format!("https://example.com/qrdrop/#{}", secret.code())
        );
        assert_eq!(Secret::decode(&url).unwrap(), secret);
    }

    #[test]
    fn url_strips_an_existing_fragment_or_query_from_the_base() {
        let secret = Secret::generate();
        let url = secret.url("https://example.com/app?ref=old#stale").unwrap();
        assert_eq!(url, format!("https://example.com/app#{}", secret.code()));
        assert_eq!(url.split('#').count(), 2);
    }

    #[test]
    fn url_serialises_the_base_as_whatwg_does() {
        let secret = Secret::generate();
        let code = secret.code();
        for (base, want) in [
            ("https://Example.COM", "https://example.com/"),
            ("HTTPS://example.com:443/x", "https://example.com/x"),
            ("http://example.com:8080", "http://example.com:8080/"),
            ("https://user:pw@example.com/", "https://example.com/"),
        ] {
            assert_eq!(
                secret.url(base).unwrap(),
                format!("{want}#{code}"),
                "{base}"
            );
        }
    }

    #[test]
    fn a_code_in_the_query_or_path_is_refused_by_name() {
        let code = Secret::generate().code();
        for input in [
            format!("https://example.com/?{code}"),
            format!("https://example.com/{code}"),
        ] {
            assert_eq!(
                Secret::decode(&input),
                Err(CodeError::FragmentOnly),
                "{input}"
            );
        }
    }

    #[test]
    fn malformed_and_wrong_length_codes_are_refused() {
        assert!(Secret::decode("nope").is_err());
        assert!(Secret::decode("qrdrop:not-valid-base64url-at-all!!!!!!!!!!!").is_err());
        assert!(Secret::decode("qrdrop:tooshort").is_err());
        let long = format!("{}extra", Secret::generate().code());
        assert!(Secret::decode(&long).is_err());
    }

    #[test]
    fn whitespace_js_trims_is_tolerated() {
        let secret = Secret::generate();
        for pad in [" ", "\n", "\u{feff}", "\u{3000}"] {
            let input = format!("{pad}{}{pad}", secret.code());
            assert_eq!(Secret::decode(&input).unwrap(), secret, "{pad:?}");
        }
        // U+0085 is Rust whitespace and not JS whitespace; JS refuses it.
        assert!(Secret::decode(&format!("\u{85}{}", secret.code())).is_err());
    }

    #[test]
    fn url_rejects_a_base_that_is_not_absolute_http() {
        let secret = Secret::generate();
        for base in [
            "/qrdrop",
            "not a url",
            "ftp://example.com/",
            "mailto:someone@example.com",
            "https://",
        ] {
            assert_eq!(secret.url(base), Err(CodeError::BadBaseUrl), "{base}");
        }
    }

    #[test]
    fn debug_never_prints_the_secret() {
        let secret = Secret::from_bytes([0xab; 32]);
        assert_eq!(format!("{secret:?}"), "Secret(..)");
    }
}
