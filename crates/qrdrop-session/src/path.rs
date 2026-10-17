//! Which route the bytes took: a port of `classifyPair`, `isPrivateAddress`,
//! `addressForm` and `combinePaths` in `src/transport/room.js`.
//!
//! The JS reads candidate types and addresses out of `getStats()`; here they
//! come from tryst's [`SelectedPair`], which knows the type of every candidate
//! it gathered and was sent. Two things the JS has to defend against cannot
//! happen on this side, and the rules stay anyway so the two classify alike:
//! an address is always a real IP here (str0m does not hide host addresses
//! behind mDNS names), and a peer-reflexive address is never withheld.

use std::net::{IpAddr, Ipv4Addr};

use qrdrop_protocol::NetworkPath;
use tryst::webrtc::{CandidateType, SelectedPair};

/// The ceiling on a transfer whose path runs through a free TURN relay, as
/// `RELAYED_MAX_BYTES` in room.js: free TURN is metered, and a multi-gigabyte
/// transfer over it would be throttled or cut. Only a `relay` verdict
/// enforces it; `unknown` fails open, because the cap is a courtesy to free
/// infrastructure and not a security boundary.
pub const RELAYED_MAX_BYTES: u64 = 100 * 1024 * 1024;

/// An address that only exists on a local network. Loopback and link-local
/// count, as in the JS: "private" means "not routed over the public
/// internet", which is the strongest claim available.
pub fn is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_private_v4(v4),
        IpAddr::V6(v6) => {
            // An IPv4-mapped address is judged by the IPv4 inside it; read as
            // IPv6 it looks global, which would call a LAN address public.
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_private_v4(v4);
            }
            let first = v6.segments()[0];
            v6.is_loopback() || first & 0xffc0 == 0xfe80 || first & 0xfe00 == 0xfc00
        }
    }
}

fn is_private_v4(ip: Ipv4Addr) -> bool {
    ip.is_private() || ip.is_loopback() || ip.is_link_local()
}

/// A coarse category for an address: enough to reason about a path, not
/// enough to identify anyone. The strings are the JS's, so a diagnostic from
/// either side reads the same.
pub fn address_form(ip: IpAddr) -> &'static str {
    match ip {
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return address_form(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            if v6.is_loopback() {
                "ipv6-loopback"
            } else if first & 0xffc0 == 0xfe80 {
                "ipv6-linklocal"
            } else if first & 0xfe00 == 0xfc00 {
                "ipv6-ula"
            } else {
                "ipv6-global"
            }
        }
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            if v4.is_loopback() {
                "ipv4-loopback"
            } else if v4.is_private() {
                "ipv4-rfc1918"
            } else if v4.is_link_local() {
                "ipv4-linklocal"
            } else if a == 100 && (64..=127).contains(&b) {
                // Carrier-grade NAT: not routable on the internet, but not a
                // LAN either -- a phone on mobile data, billed like one.
                "ipv4-cgnat"
            } else {
                "ipv4-public"
            }
        }
    }
}

/// The verdict for the pair a connection settled on, strongest evidence
/// first. See `classifyPair` for why each rule sits where it does.
///
/// The JS ends in `unknown` for a pair whose address Firefox withheld. Every
/// address here is a real IP, and every IP is private or an outside form, so
/// a pair always gets a verdict; `Unknown` is what the session reports when
/// str0m names no pair at all. The last line is kept so the rules read as the
/// JS's do.
pub fn classify(pair: &SelectedPair) -> NetworkPath {
    let types = [pair.local_type, pair.remote_type];
    let ips = [pair.local.ip(), pair.remote.ip()];
    if types.contains(&CandidateType::Relay) {
        return NetworkPath::Relay;
    }
    // A server-reflexive candidate is the address STUN saw from outside, so
    // a pair using one went out through NAT by construction.
    if types.contains(&CandidateType::Srflx) {
        return NetworkPath::Direct;
    }
    if types == [CandidateType::Host, CandidateType::Host] || ips.iter().all(|ip| is_private(*ip)) {
        return NetworkPath::Local;
    }
    if ips.iter().any(|ip| {
        matches!(
            address_form(*ip),
            "ipv4-public" | "ipv6-global" | "ipv4-cgnat"
        )
    }) {
        return NetworkPath::Direct;
    }
    NetworkPath::Unknown
}

/// One verdict from two: relay > direct > local > unknown. Evidence beats
/// absence, and where the two conflict the more expensive reading wins --
/// being wrongly warned about data cost is an annoyance, being wrongly told
/// a metered transfer is free is a bill.
pub fn combine(mine: NetworkPath, theirs: NetworkPath) -> NetworkPath {
    let both = [mine, theirs];
    for p in [NetworkPath::Relay, NetworkPath::Direct, NetworkPath::Local] {
        if both.contains(&p) {
            return p;
        }
    }
    NetworkPath::Unknown
}

#[cfg(test)]
mod tests {
    use super::*;
    use CandidateType::*;

    fn pair(local: CandidateType, remote: CandidateType, la: &str, ra: &str) -> SelectedPair {
        SelectedPair {
            local: format!("{la}:1").parse().unwrap(),
            local_type: local,
            remote: format!("{ra}:2").parse().unwrap(),
            remote_type: remote,
        }
    }

    /// Public addresses unless a test says otherwise, as path.test.mjs's
    /// fakePC: a test that names no address is asking about types alone.
    fn types(local: CandidateType, remote: CandidateType) -> NetworkPath {
        classify(&pair(local, remote, "203.0.113.7", "198.51.100.9"))
    }

    #[test]
    fn the_rows_of_path_test_mjs() {
        assert_eq!(types(Host, Host), NetworkPath::Local);
        assert_eq!(types(Relay, Host), NetworkPath::Relay);
        assert_eq!(types(Host, Relay), NetworkPath::Relay);
        assert_eq!(types(Relay, Srflx), NetworkPath::Relay);
        assert_eq!(types(Srflx, Srflx), NetworkPath::Direct);
        assert_eq!(types(Prflx, Srflx), NetworkPath::Direct);
        assert_eq!(types(Host, Srflx), NetworkPath::Direct);
        assert_eq!(types(Srflx, Host), NetworkPath::Direct);
        // A LAN pair is local even when one side saw peer-reflexive, so a
        // laptop and a phone on one Wi-Fi agree.
        let p = |a, b| classify(&pair(Host, Prflx, a, b));
        assert_eq!(p("192.168.1.42", "192.168.1.17"), NetworkPath::Local);
        assert_eq!(
            classify(&pair(Prflx, Host, "10.0.0.8", "10.0.0.31")),
            NetworkPath::Local
        );
        assert_eq!(p("192.168.1.42", "203.0.113.55"), NetworkPath::Direct);
        assert_eq!(p("192.168.1.42", "100.64.3.4"), NetworkPath::Direct);
    }

    #[test]
    fn private_means_off_the_public_internet() {
        for a in [
            "10.0.0.1",
            "192.168.1.42",
            "172.16.0.1",
            "172.31.255.254",
            "169.254.1.1",
            "127.0.0.1",
            "::1",
            "fe80::1",
            "fd12:3456::1",
            "::ffff:192.168.1.34",
            "::ffff:10.0.0.1",
        ] {
            assert!(is_private(a.parse().unwrap()), "{a}");
        }
        // 172.15 and 172.32 sit just outside the /12.
        for a in [
            "203.0.113.7",
            "8.8.8.8",
            "172.15.0.1",
            "172.32.0.1",
            "2001:db8::1",
            "::ffff:103.74.136.124",
        ] {
            assert!(!is_private(a.parse().unwrap()), "{a}");
        }
    }

    #[test]
    fn address_forms_are_the_js_categories() {
        for (a, f) in [
            ("192.168.1.34", "ipv4-rfc1918"),
            ("10.1.2.3", "ipv4-rfc1918"),
            ("172.20.0.1", "ipv4-rfc1918"),
            ("169.254.5.5", "ipv4-linklocal"),
            ("127.0.0.1", "ipv4-loopback"),
            ("103.74.136.124", "ipv4-public"),
            ("fe80::1", "ipv6-linklocal"),
            ("fd00::1", "ipv6-ula"),
            ("2401:4900::1", "ipv6-global"),
            ("100.64.0.1", "ipv4-cgnat"),
            ("100.127.255.254", "ipv4-cgnat"),
            ("100.63.0.1", "ipv4-public"),
            ("100.128.0.1", "ipv4-public"),
            ("::ffff:192.168.1.34", "ipv4-rfc1918"),
            ("::ffff:103.74.136.124", "ipv4-public"),
        ] {
            assert_eq!(address_form(a.parse().unwrap()), f, "{a}");
        }
    }

    #[test]
    fn combining_takes_evidence_over_absence_and_cost_over_comfort() {
        use NetworkPath::*;
        assert_eq!(combine(Local, Unknown), Local);
        assert_eq!(combine(Unknown, Local), Local);
        assert_eq!(combine(Local, Direct), Direct);
        assert_eq!(combine(Direct, Relay), Relay);
        assert_eq!(combine(Unknown, Unknown), Unknown);
    }
}
