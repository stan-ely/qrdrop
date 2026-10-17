# tryst

Rooms that interoperate with [Trystero](https://github.com/dmotz/trystero) 0.25
peers, in Rust: the Nostr and BitTorrent-tracker signalling, the signal
encryption, the action wire, the room frame and the password handshake, with a
sans-IO core and an async shell.

**Work in progress, and empty for now.** This release only holds the name. The
crate is being written inside [qrdrop](https://github.com/stan-ely/qrdrop),
whose Rust session needs to speak the same wire as Trystero's JavaScript peers;
the plan and its progress are in that repository's
`docs/notes/rust-session.md`. It is not affiliated with the Trystero project.

Licensed under MIT.
