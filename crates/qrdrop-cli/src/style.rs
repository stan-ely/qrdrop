//! `src/cli/style.js`: ANSI colour decided once per stream, and the identity
//! function when off.
//!
//! The identity is the contract, not a nicety: e2e/interop.e2e.mjs and any
//! shell pipe parse stdout, and with colour off the output must be
//! byte-for-byte what it would be with colour compiled out. stdout and stderr
//! decide separately, because a script can redirect one and not the other.

use std::io::IsTerminal;

#[derive(Clone, Copy, Debug)]
pub struct Style {
    on: bool,
}

impl Style {
    pub fn stdout() -> Self {
        Style {
            on: should_colour(std::io::stdout().is_terminal()),
        }
    }

    pub fn stderr() -> Self {
        Style {
            on: should_colour(std::io::stderr().is_terminal()),
        }
    }

    fn paint(self, code: &str, s: &str) -> String {
        if self.on {
            format!("\x1b[{code}m{s}\x1b[0m")
        } else {
            s.to_owned()
        }
    }

    pub fn bold(self, s: &str) -> String {
        self.paint("1", s)
    }
    pub fn dim(self, s: &str) -> String {
        self.paint("2", s)
    }
    /// Cyan: the code and the URL, informational rather than a verdict.
    pub fn accent(self, s: &str) -> String {
        self.paint("36", s)
    }
    pub fn ok(self, s: &str) -> String {
        self.paint("32", s)
    }
    pub fn bad(self, s: &str) -> String {
        self.paint("31", s)
    }
    pub fn warn(self, s: &str) -> String {
        self.paint("33", s)
    }
}

/// `shouldColour`: `FORCE_COLOR` wins in either direction, then `NO_COLOR`,
/// then `TERM=dumb`, then whether the stream is a terminal. An empty value
/// counts as unset, as JS truthiness has it.
fn should_colour(tty: bool) -> bool {
    let set = |k: &str| std::env::var_os(k).is_some_and(|v| !v.is_empty());
    if set("FORCE_COLOR") {
        return true;
    }
    if set("NO_COLOR") {
        return false;
    }
    if std::env::var_os("TERM").is_some_and(|t| t == "dumb") {
        return false;
    }
    tty
}
