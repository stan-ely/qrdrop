# tryst

Rooms that interoperate with [Trystero](https://github.com/dmotz/trystero) 0.25
peers, in Rust: the Nostr and BitTorrent-tracker signalling, the signal
encryption, the action wire, the room frame and the password handshake, with a
sans-IO core and an async shell.

**Work in progress.** The published 0.0.1 is empty and only holds the name. In
this tree the sans-IO core (topics, signal crypto, the action wire, the room
handshake and the signalling state machine) and a str0m peer behind it are
written and tested against recorded Trystero traffic, and the Nostr and tracker
clients on tokio pair with Node Trystero peers over the public relays. TURN is
not yet supported. The crate is being written inside [qrdrop](https://github.com/stan-ely/qrdrop),
whose Rust session needs to speak the same wire as Trystero's JavaScript peers;
the plan and its progress are in that repository's
`docs/notes/rust-session.md`. It is not affiliated with the Trystero project.

Licensed under MIT.
