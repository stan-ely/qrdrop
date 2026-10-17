//! The sentences a transfer's surfaces say about it -- sizes, the relay cap,
//! the route -- as `src/core/messages.js` and `src/core/format.js` say them,
//! for the Rust CLI and the app's native session alike.
//!
//! The tests read those two files, for the reason `networks` reads
//! `room.js`: a sentence edited on one side and not the other fails here.

use qrdrop_protocol::NetworkPath;

use crate::path::RELAYED_MAX_BYTES;

/// What a sending side says when its peer offers a file back: element.js's
/// and cli.js's words, the same sentence in both.
pub const OFFERED_WHILE_SENDING: &str = "Peer offered a file while we were sending one";

/// `bytes` in format.js. `toFixed(1)` and `Math.round` both round a tie up,
/// where Rust's `{:.1}` rounds it to even -- 1280 bytes is exactly 1.25 KB,
/// and the two would print "1.3 KB" and "1.2 KB". The value is `n / 1024^i`
/// exactly, so the rounding is done on integers, where there is no doubt.
pub fn bytes(n: u64) -> String {
    if n < 1024 {
        return format!("{n} B");
    }
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    let n = u128::from(n);
    let mut d: u128 = 1024;
    let mut i = 0;
    while n >= d * 1024 && i < UNITS.len() - 1 {
        d *= 1024;
        i += 1;
    }
    if n < 10 * d {
        let tenths = (20 * n + d) / (2 * d);
        format!("{}.{} {}", tenths / 10, tenths % 10, UNITS[i])
    } else {
        format!("{} {}", (2 * n + d) / (2 * d), UNITS[i])
    }
}

/// `relayCapMessage`.
pub fn relay_cap(name: &str, size: u64) -> String {
    format!(
        "This connection is going through a public relay, capped at {}. {name} is {}. Try again on a network where a direct connection is possible.",
        bytes(RELAYED_MAX_BYTES),
        bytes(size)
    )
}

/// `relayCapDeclineMessage`.
pub fn relay_cap_decline(name: &str, size: u64) -> String {
    format!(
        "{name} ({}) is over the {} limit for a transfer going through a public relay.",
        bytes(size),
        bytes(RELAYED_MAX_BYTES)
    )
}

/// `pathDescription`: the label and the sentence under it.
pub fn path_description(path: NetworkPath) -> (&'static str, &'static str) {
    match path {
        NetworkPath::Local => (
            "Local network",
            "The file's bytes are staying on this network, not crossing the internet.",
        ),
        NetworkPath::Direct => (
            "Direct, over the internet",
            "A direct connection to the other device, but the bytes cross the internet.",
        ),
        NetworkPath::Relay => (
            "Through a public relay",
            "Bytes cross the internet twice, via a third-party TURN server, and are size-capped.",
        ),
        NetworkPath::Unknown => (
            "Path unknown",
            "This device can't tell which route the connection took.",
        ),
    }
}

/// `METERED_WARN_BYTES`.
pub const METERED_WARN_BYTES: u64 = 25 * 1024 * 1024;

/// `meteredWarning`.
pub fn metered_warning(name: &str, size: u64, path: NetworkPath) -> Option<String> {
    if !matches!(path, NetworkPath::Direct | NetworkPath::Relay) || size <= METERED_WARN_BYTES {
        return None;
    }
    Some(format!(
        "{name} is {} and this connection crosses the internet. On a metered connection that may cost money.",
        bytes(size)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MESSAGES_JS: &str = include_str!("../../../src/core/messages.js");

    #[test]
    fn the_messages_are_messages_js_messages() {
        for p in [
            NetworkPath::Local,
            NetworkPath::Direct,
            NetworkPath::Relay,
            NetworkPath::Unknown,
        ] {
            let (label, detail) = path_description(p);
            assert!(
                MESSAGES_JS.contains(&format!("label: '{label}'")),
                "{label}"
            );
            assert!(MESSAGES_JS.contains(detail), "{detail}");
        }
        for fragment in [
            "`This connection is going through a public relay, capped at ${bytes(limit)}. `",
            "+ `${name} is ${bytes(size)}. Try again on a network where a direct connection is possible.`",
            "`${name} (${bytes(size)}) is over the ${bytes(limit)} limit for a transfer going through a public relay.`",
            "`${name} is ${bytes(size)} and this connection crosses the internet. `",
            "+ 'On a metered connection that may cost money.'",
            "export const METERED_WARN_BYTES = 25 * 1024 * 1024",
        ] {
            assert!(MESSAGES_JS.contains(fragment), "{fragment}");
        }
    }

    #[test]
    fn bytes_rounds_as_format_js_does() {
        // The JS's own answers, from node -e "bytes(n)".
        for (n, want) in [
            (0, "0 B"),
            (1023, "1023 B"),
            (1024, "1.0 KB"),
            (1280, "1.3 KB"),
            (1536, "1.5 KB"),
            (10_188, "9.9 KB"),
            (10_189, "10.0 KB"),
            (10_240, "10 KB"),
            (300 * 1024, "300 KB"),
            (1_048_575, "1024 KB"),
            (1_048_576, "1.0 MB"),
            (8 * 1024 * 1024, "8.0 MB"),
            (100 * 1024 * 1024, "100 MB"),
            (1 << 40, "1.0 TB"),
            (1 << 52, "4096 TB"),
        ] {
            assert_eq!(bytes(n), want, "{n}");
        }
    }

    #[test]
    fn the_metered_warning_fires_as_the_js_does() {
        assert_eq!(
            metered_warning("a", METERED_WARN_BYTES + 1, NetworkPath::Local),
            None
        );
        assert_eq!(
            metered_warning("a", METERED_WARN_BYTES + 1, NetworkPath::Unknown),
            None
        );
        assert_eq!(
            metered_warning("a", METERED_WARN_BYTES, NetworkPath::Direct),
            None
        );
        assert!(metered_warning("a", METERED_WARN_BYTES + 1, NetworkPath::Relay).is_some());
    }
}
