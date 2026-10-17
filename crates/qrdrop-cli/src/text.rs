//! Every sentence the CLI prints that the Node CLI also prints, in one place,
//! and the tests that hold the two to the same words.
//!
//! The tests read the JS itself -- `src/cli.js` for the help, and
//! `src/core/messages.js` and `src/core/format.js` for the rest -- for the
//! reason `qrdrop_session::networks` reads `room.js`: two copies of a string
//! drift the first time one is edited without the other, and a check against
//! a third copy here would only move the drift.

use qrdrop_protocol::NetworkPath;
use qrdrop_session::path::RELAYED_MAX_BYTES;

/// `OPTIONS` in cli.js, from which the help's table is laid out.
const OPTIONS: &[(&str, &[&str])] = &[
    (
        "--no-qr",
        &["Don't draw the QR code (the qrdrop:... code is always printed too)"],
    ),
    (
        "--out <dir>",
        &["Directory to save into (receive only; default: current directory)"],
    ),
    (
        "--port <n>",
        &[
            "Port for the local web UI (web only; default 4173, 0 picks",
            "a free one)",
        ],
    ),
    (
        "--no-open",
        &["Don't open a browser; just print the URL (web only)"],
    ),
    (
        "--strategy <name>",
        &[
            "Pair over one signalling network only: nostr or torrent.",
            "Default races both and uses whichever connects first.",
        ],
    ),
    (
        "--relay <url>",
        &[
            "Pair over Nostr only, using these relays instead of the",
            "built-in list (repeatable; implies --strategy nostr)",
        ],
    ),
    (
        "--qr-url <base>",
        &[
            "Encode the QR as <base>#qrdrop:<code> so a phone camera can",
            "open the web app directly, instead of a code no camera app",
            "can follow. No default: that would silently point CLI users",
            "at a host they didn't choose -- see the code comment on",
            "--qr-url below.",
        ],
    ),
    (
        "--yes",
        &[
            "Skip the \"accept this file?\" prompt on receive.",
            "Never skips the code-match confirmation -- see below.",
        ],
    ),
    (
        "--no-lan",
        &[
            "Keep the file on WebRTC even when both devices could use a",
            "direct connection on the local network",
        ],
    ),
    (
        "--debug",
        &["Print stack traces instead of one-line error messages"],
    ),
    ("--help", &["Show this message"]),
    ("--version", &["Show the installed version"]),
];

/// `formatOptions`: the description column is two spaces past the longest
/// flag, computed rather than hand-aligned, as cli.js explains.
fn options() -> String {
    let col = 2 + OPTIONS.iter().map(|(f, _)| f.len()).max().unwrap_or(0) + 2;
    OPTIONS
        .iter()
        .map(|(flag, desc)| {
            desc.iter()
                .enumerate()
                .map(|(i, line)| {
                    if i == 0 {
                        format!("  {flag}{}{line}", " ".repeat(col - 2 - flag.len()))
                    } else {
                        format!("{}{line}", " ".repeat(col))
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

const USAGE_HEAD: &str = "qrdrop -- send a file peer-to-peer, keyed by a QR code

Usage:
  qrdrop send <file> [--no-qr] [--yes] [--no-lan] [--strategy <name>] [--relay <url>]... [--qr-url <base>] [--debug]
  qrdrop receive [code] [--out <dir>] [--yes] [--no-lan] [--strategy <name>] [--relay <url>]... [--debug]
  qrdrop web [--port <n>] [--no-open]
  qrdrop --help
  qrdrop --version

Options:
";

const USAGE_MIDDLE: &str = "

\"qrdrop web\" serves this project's browser UI from the copy you installed, on
http://127.0.0.1 \u{2014} nothing is uploaded, and no other device can reach it. It is
the way to run a transfer whose code you can read before trusting it with a file.

Beaming \u{2014} an unencrypted, no-network transfer shown as an animated QR code and
read back by a camera \u{2014} is a browser-only mode inside \"qrdrop web\". There is no
\"qrdrop beam\" command: it needs a screen to animate and a camera watching it,
and a terminal on the receiving end has neither.

A transfer that ends up going through a public TURN relay (rare \u{2014} only when a
direct connection cannot be made) is capped at ";

const USAGE_TAIL: &str = " MB.

When both devices run qrdrop natively (this CLI or the qrdrop app) and one of
them can accept a connection without a firewall prompt, the file itself moves
over a direct connection on the local network, several times faster than
WebRTC. It carries the same end-to-end encrypted frames, and only after the
emoji check. --no-lan turns it off.

Every transfer \u{2014} send or receive \u{2014} stops to show four emoji and asks you to
confirm they match on both devices before anything about the file moves. That
check is what stops a third party from slipping into the exchange; --yes does
not and cannot skip it.
";

/// `--help`, byte for byte what `node src/cli.js --help` prints.
pub fn usage() -> String {
    // Math.round(RELAYED_MAX_BYTES / (1024 * 1024)), in integers.
    let mib = (RELAYED_MAX_BYTES + 512 * 1024) / (1024 * 1024);
    format!("{USAGE_HEAD}{}{USAGE_MIDDLE}{mib}{USAGE_TAIL}", options())
}

pub const BEAM_REFUSED: &str = "There is no \"qrdrop beam\" command. Beaming \u{2014} an unencrypted, no-network transfer\n\
read by a camera \u{2014} is a browser-only mode: run \"qrdrop web\" and choose it on\n\
the page.\n";

pub const NO_WEB_UI: &str = "The web UI is not present in this install. It ships in published \
releases; from a source checkout, run `npm run build` first.";

pub const CODES_DID_NOT_MATCH: &str =
    "Codes did not match -- refusing to continue. This could mean a third party is in the room.";

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

    const CLI_JS: &str = include_str!("../../../src/cli.js");
    const MESSAGES_JS: &str = include_str!("../../../src/core/messages.js");

    /// A JS string literal's contents, in '…', "…" or `…` without
    /// interpolation: enough for the literals cli.js's OPTIONS holds.
    fn literal(s: &str) -> (String, &str) {
        let q = s.chars().next().unwrap();
        let mut out = String::new();
        let mut chars = s[1..].char_indices();
        while let Some((i, c)) = chars.next() {
            match c {
                '\\' => out.push(chars.next().unwrap().1),
                c if c == q => return (out, &s[1 + i + 1..]),
                c => out.push(c),
            }
        }
        panic!("unterminated literal");
    }

    /// cli.js's OPTIONS table, read out of the source.
    fn js_options() -> Vec<(String, Vec<String>)> {
        let start = CLI_JS.find("const OPTIONS = [").unwrap();
        let block = &CLI_JS[start..start + CLI_JS[start..].find("\n]\n").unwrap()];
        let mut out = vec![];
        for entry in block.split("{ flag: ").skip(1) {
            let (flag, rest) = literal(entry);
            let rest = &rest[rest.find("desc: [").unwrap() + "desc: [".len()..];
            let body = &rest[..rest.find("] }").unwrap()];
            let mut desc = vec![];
            let mut s = body.trim_start();
            while let Some(c) = s.chars().next() {
                if matches!(c, '\'' | '"' | '`') {
                    let (line, rest) = literal(s);
                    desc.push(line);
                    s = rest.trim_start().trim_start_matches(',').trim_start();
                } else {
                    break;
                }
            }
            out.push((flag, desc));
        }
        out
    }

    #[test]
    fn the_options_are_cli_js_options() {
        let ours: Vec<(String, Vec<String>)> = OPTIONS
            .iter()
            .map(|(f, d)| (f.to_string(), d.iter().map(|s| s.to_string()).collect()))
            .collect();
        assert_eq!(ours, js_options());
    }

    #[test]
    fn the_help_is_cli_js_help() {
        let start = CLI_JS.find("const USAGE = `").unwrap() + "const USAGE = `".len();
        let template = &CLI_JS[start..start + CLI_JS[start..].find("\n`\n").unwrap() + 1];
        let js = template
            .replace("${formatOptions(OPTIONS)}", &options())
            .replace(
                "${Math.round(RELAYED_MAX_BYTES / (1024 * 1024))}",
                &(RELAYED_MAX_BYTES / (1024 * 1024)).to_string(),
            );
        assert!(
            !js.contains("${"),
            "an interpolation this test does not know"
        );
        assert_eq!(usage(), js);
    }

    #[test]
    fn the_refusals_are_cli_js_refusals() {
        for (ours, js) in [
            (BEAM_REFUSED, "'There is no \"qrdrop beam\" command."),
            (CODES_DID_NOT_MATCH, "'Codes did not match -- refusing"),
            (
                OFFERED_WHILE_SENDING,
                "'Peer offered a file while we were sending one'",
            ),
        ] {
            assert!(CLI_JS.contains(js), "{js}");
            assert!(ours.starts_with(js.trim_start_matches('\'').trim_end_matches('\'')));
        }
        assert!(CLI_JS.contains(CODES_DID_NOT_MATCH));
        assert!(CLI_JS.contains("'The web UI is not present in this install. It ships in published ' +\n      'releases; from a source checkout, run `npm run build` first.'"));
        assert_eq!(
            BEAM_REFUSED,
            "There is no \"qrdrop beam\" command. Beaming \u{2014} an unencrypted, no-network transfer\nread by a camera \u{2014} is a browser-only mode: run \"qrdrop web\" and choose it on\nthe page.\n"
        );
        assert!(CLI_JS.contains(
            "'There is no \"qrdrop beam\" command. Beaming \u{2014} an unencrypted, no-network transfer\\n'\n      + 'read by a camera \u{2014} is a browser-only mode: run \"qrdrop web\" and choose it on\\n'\n      + 'the page.\\n',"
        ));
    }

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
