//! The signalling networks and ICE servers a session uses by default: the
//! same lists `src/transport/room.js` dials, so a Rust peer and a JS peer meet
//! on the same relays. The test below reads room.js itself, which is what
//! keeps the two from drifting: a relay added there and not here fails it.

use tryst::join::TurnServer;
use tryst::signal::Strategy;

/// `RELAYS` in room.js. Chosen there by publishing to each, not by opening a
/// socket; re-test the same way before editing either list.
pub const NOSTR_RELAYS: &[&str] = &[
    "wss://nos.lol",
    "wss://relay.primal.net",
    "wss://relay.ditto.pub",
    "wss://purplerelay.com",
    "wss://nostr.data.haus",
    "wss://nostr-01.yakihonne.com",
    "wss://bucket.coracle.social",
];

/// `TORRENT_TRACKERS` in room.js.
pub const TRACKERS: &[&str] = &[
    "wss://tracker.openwebtorrent.com",
    "wss://tracker.webtorrent.dev",
];

/// The STUN half of `ICE_SERVERS` in room.js, spread across operators
/// because one provider is a single point of failure and blocked on some
/// networks.
pub const STUN_SERVERS: &[&str] = &[
    "stun.l.google.com:19302",
    "stun1.l.google.com:19302",
    "global.stun.twilio.com:3478",
    "stun.cloudflare.com:3478",
    "stun.relay.metered.ca:80",
];

/// The UDP TURN entries of `ICE_SERVERS` in room.js: `(host:port, username,
/// credential)`. The `?transport=tcp` one is left out, since tryst speaks
/// TURN over UDP only.
///
/// **They do not work.** On 2026-10-18 `openrelay.metered.ca` resolved to
/// 192.0.2.1 and 100::1 -- a documentation range and a discard prefix -- on
/// two public resolvers, so the JS has no working TURN either. They are kept
/// so the two sides stay the same list, and so whatever replaces them
/// replaces them in both; see "Phase 5: what it found".
pub const TURN_SERVERS: &[(&str, &str, &str)] = &[
    (
        "openrelay.metered.ca:80",
        "openrelayproject",
        "openrelayproject",
    ),
    (
        "openrelay.metered.ca:443",
        "openrelayproject",
        "openrelayproject",
    ),
];

/// [`TURN_SERVERS`] as tryst takes them.
pub fn turn_servers() -> Vec<TurnServer> {
    TURN_SERVERS
        .iter()
        .map(|(url, username, credential)| TurnServer {
            url: url.to_string(),
            username: username.to_string(),
            credential: credential.to_string(),
        })
        .collect()
}

/// One strategy and the URLs it may dial.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Network {
    pub strategy: Strategy,
    pub relays: Vec<String>,
}

impl Network {
    pub fn nostr() -> Self {
        Network {
            strategy: Strategy::Nostr,
            relays: NOSTR_RELAYS.iter().map(|s| s.to_string()).collect(),
        }
    }

    pub fn torrent() -> Self {
        Network {
            strategy: Strategy::Torrent,
            relays: TRACKERS.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// Both, raced, as `STRATEGIES` in room.js.
    pub fn all() -> Vec<Network> {
        vec![Network::nostr(), Network::torrent()]
    }

    /// The name room.js gives it, for status lines.
    pub fn name(&self) -> &'static str {
        match self.strategy {
            Strategy::Nostr => "nostr",
            Strategy::Torrent => "torrent",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOM_JS: &str = include_str!("../../../src/transport/room.js");

    /// Every quoted `wss://` and `stun:` URL in one `const NAME = [ ... ]`
    /// block of room.js.
    fn listed(name: &str, scheme: &str) -> Vec<String> {
        let start = ROOM_JS
            .find(&format!("const {name} = ["))
            .unwrap_or_else(|| panic!("{name} not in room.js"));
        let block = &ROOM_JS[start..start + ROOM_JS[start..].find("\n]").unwrap()];
        block
            .split('\'')
            .filter(|s| s.starts_with(scheme))
            .map(|s| s.trim_start_matches("stun:").to_owned())
            .collect()
    }

    #[test]
    fn the_lists_are_room_js_lists() {
        assert_eq!(listed("RELAYS", "wss://"), NOSTR_RELAYS);
        assert_eq!(listed("TORRENT_TRACKERS", "wss://"), TRACKERS);
        assert_eq!(listed("ICE_SERVERS", "stun:"), STUN_SERVERS);
    }

    #[test]
    fn the_turn_servers_are_room_js_udp_ones() {
        let start = ROOM_JS.find("const ICE_SERVERS = [").unwrap();
        let block = &ROOM_JS[start..start + ROOM_JS[start..].find("\n]").unwrap()];
        let mut theirs = vec![];
        for line in block.lines().filter(|l| l.contains("'turn:")) {
            let q: Vec<&str> = line.split('\'').collect();
            // { urls: 'turn:…', username: '…', credential: '…' }
            let url = q[1].trim_start_matches("turn:");
            if url.contains("transport=tcp") {
                continue;
            }
            theirs.push((url.to_owned(), q[3].to_owned(), q[5].to_owned()));
        }
        let ours: Vec<_> = TURN_SERVERS
            .iter()
            .map(|(a, b, c)| (a.to_string(), b.to_string(), c.to_string()))
            .collect();
        assert_eq!(ours, theirs);
    }
}
