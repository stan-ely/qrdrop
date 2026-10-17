//! Every sentence the CLI prints that the Node CLI also prints, in one place,
//! and the tests that hold the two to the same words.
//!
//! The tests read `src/cli.js` itself for the help, for the reason
//! `qrdrop_session::networks` reads `room.js`: two copies of a string drift
//! the first time one is edited without the other, and a check against a
//! third copy here would only move the drift. The messages the app prints as
//! well -- sizes, the relay cap, the route -- are `qrdrop_session::messages`,
//! held to `src/core/messages.js` the same way.

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

pub use qrdrop_session::messages::OFFERED_WHILE_SENDING;

#[cfg(test)]
mod tests {
    use super::*;

    const CLI_JS: &str = include_str!("../../../src/cli.js");

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
}
