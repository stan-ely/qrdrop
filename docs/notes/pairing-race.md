# The pairing network race

Found 2026-11-03, while chasing a CI flake. Nothing here is built yet beyond the stopgap.
This file is the design and its tracking document. When the fix ships, the behaviour moves
into `docs/protocol.md` and the invariant into CLAUDE.md, and this file records only how it
was found.

## Status

| Step | State | Notes |
|---|---|---|
| Stopgap: session tests on one network | done | `config` in `crates/qrdrop-session/tests/session.rs` pins Nostr; `config_race` keeps one test on both |
| Reproduction | done | `both_sides_of_a_raced_pairing_keep_the_same_network`, ignored; fails in its first round |
| 1. Hosts send a pick | not started | harmless to every older guest |
| 2. Guests follow the pick | not started | a release after 1, for the reason under **Compatibility** |
| 3. Unpin the tests, docs | not started | |

## The bug

`open_room` (`crates/qrdrop-session/src/pair.rs`) and `openRoom` (`src/transport/room.js`,
`Promise.any`) join every network at once, Nostr and BitTorrent. Each attempt makes its own
ECDH keypair, sends its public key when a peer joins, and wins on the first key it receives.
Each side then keeps **its own** first winner and leaves the rest.

Nothing makes the two sides agree. When both networks finish within a few milliseconds of
each other, the host can keep Nostr while the guest keeps BitTorrent. Then:

- **The SASes differ.** They are derived from the session keys, and each network's attempt
  had its own keypair. Both people see a mismatch that no attacker caused.
- **The transfer goes nowhere.** Each side sends into a room the other has just left, and
  the session hangs until a timeout.

The first is the worse one. A mismatch caused by nothing teaches people that a mismatch is
flakiness, which is the lesson the SAS rules (CLAUDE.md, "the SAS gets one roll per
secret") exist to prevent.

## How it was found and measured

The `rust` job failed in 3 of the last 60 `ci` runs, each time in a different session test,
and each time as a timeout or a SAS assertion. Under WSL the whole of `tests/session.rs`
failed 3 runs in 20. A probe that printed which network each side kept found, over 25 runs
(275 pairings), exactly one pairing where host and guest kept different networks. That was
the only run that failed.

It needs load. The stand-in relay serves both networks from one socket, so both finish
almost together, and the order then depends on scheduling. 1000 pairings one after another
on an idle Windows machine never showed it; 24 at once show it in the first round, on
Windows and under WSL. In the field the two networks are separate services with very
different latencies, so it should be much rarer. It is not impossible, and it applies to
every pairing between any two implementations, because the JS and the Rust have the same
design.

## The fix: the host picks, and says so

The host keeps its first winner, as today, and then sends a **pick** on that room: a
message that says "this network". The guest keeps every attempt that completes until a pick
arrives on one of them, then keeps that one and leaves the rest. A guest that sees its own
first winner picked behaves exactly as it does now.

Three properties the pick needs:

- **It arrives before the SAS is shown.** The guest's `open_room` returns only once it
  knows which room it is in, so the SAS it shows comes from the session the host is in.
- **It is authenticated by the session it names.** It is keyed from that attempt's session
  key, so a stranger with the code can name only a session they hold themselves. A stranger
  who keyed in is a man in the middle, and the SAS already catches that. A pick that fails
  its check is dropped, never fatal, for the reason "authenticate, then trust" gives.
- **It stays outside the control index space.** Control index 0 is the first frame after
  the confirm, and both ends rely on it. The pick is its own tryst action, sent before
  either side's session starts.

**Rejected: one keypair per `open_room` instead of one per network.** It makes the SAS agree
whichever network each side kept, because the ECDH would then not depend on the network.
It leaves the delivery half broken: the sides would still be in different rooms. Fixing
that half without a pick means the guest sending on every room it holds, and a room it
adopts late misses the frames it already sent elsewhere, which the host would read as a
fatal out-of-order frame. It would also change an invariant (CLAUDE.md, "one keypair per
`joinVia` call") for no gain once the pick exists.

**Rejected: pinning everyone to one network.** It removes the reason the race exists, which
is that one network or the other is often down or blocked.

## Compatibility

- **A new host and an old guest.** The old guest has no handler for the pick and ignores
  it, so it behaves as it does today. This is why step 1 can ship alone.
- **An old host and a new guest.** The old host never sends a pick, so the guest needs a
  fallback: after a short wait with no pick, keep the first winner, as today. That wait
  makes every pairing with an old host slower, so step 2 ships a release after step 1, when
  most hosts already send picks. This is the same order offline pairing's phase A and B
  follow.

Open: how long that wait is, and whether the key message can carry a capability flag so a
guest knows at once that no pick is coming. Trystero's key payload is fixed bytes on both
ends, so a flag means a second action rather than a field. Settle this before step 2.

## What changes where

- `crates/qrdrop-session/src/pair.rs`: the host sends the pick after its winner; the guest's
  loop waits for one. Losers still leave in the background.
- `src/transport/room.js`: the same in `openRoom`. Its `Promise.any` becomes a loop that
  keeps settled attempts until the pick.
- `test/room.test.mjs` and `tests/session.rs`: the ignored reproduction comes back on, and
  `config` goes back to racing both networks.
- `docs/protocol.md`: the pick, under pairing.
