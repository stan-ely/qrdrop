# Vendored crates

Each directory here is a crates.io release with a patch on top, wired in
through `[patch.crates-io]` in the root `Cargo.toml`. It sits inside this tree
rather than in a scratch directory or a git dependency because a path outside
the workspace root is hashed by its absolute path into every symbol, which
makes the Android build differ between two checkouts
(`docs/notes/rust-session.md`, "Phase 1: what it found").

## str0m-rust-crypto 0.6.0

str0m's pure-Rust crypto backend turns on dimpl's `rcgen` feature, and in
dimpl that feature is `rcgen` **and** `aws-lc-rs`: the "pure Rust" backend
links aws-lc-sys, a cc and cmake build that f-droid.org would have to
reproduce byte for byte. The patch drops the feature from `Cargo.toml` and
makes `generate_certificate` return `None`. The caller passes a certificate in
through `RtcConfig::set_dtls_cert`; `tryst`'s `webrtc` module makes a
self-signed P-256 one with `p256` and `x509-cert`.

Two lines change, both marked `qrdrop patch`. The rest is the published crate
as `cargo package` normalised it, with its MIT OR Apache-2.0 licence.

It goes when str0m makes certificate generation an optional feature of the
backend; upstreaming that is an open item in the notes.
