//! The one STUN exchange the runtime needs: a Binding request, and the
//! XOR-MAPPED-ADDRESS in its success response (RFC 8489). That is a server-
//! reflexive candidate, which is what lets two peers behind ordinary NATs
//! reach each other; str0m gathers none of its own.
//!
//! Sixty lines rather than a crate: nothing else of STUN is used, and the
//! ICE checks themselves are str0m's.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use rand_core::{OsRng, RngCore};

const MAGIC: u32 = 0x2112_A442;
const BINDING_REQUEST: u16 = 0x0001;
const BINDING_SUCCESS: u16 = 0x0101;
const XOR_MAPPED_ADDRESS: u16 = 0x0020;

/// A Binding request and its transaction ID.
pub fn request() -> ([u8; 12], [u8; 20]) {
    let mut tid = [0u8; 12];
    OsRng.fill_bytes(&mut tid);
    let mut m = [0u8; 20];
    m[0..2].copy_from_slice(&BINDING_REQUEST.to_be_bytes());
    // Length 0: no attributes.
    m[4..8].copy_from_slice(&MAGIC.to_be_bytes());
    m[8..20].copy_from_slice(&tid);
    (tid, m)
}

/// The mapped address in a success response to `tid`, or `None` for
/// anything else -- including every datagram that is not STUN at all.
pub fn mapped_address(msg: &[u8], tid: &[u8; 12]) -> Option<SocketAddr> {
    if msg.len() < 20
        || u16::from_be_bytes([msg[0], msg[1]]) != BINDING_SUCCESS
        || u32::from_be_bytes([msg[4], msg[5], msg[6], msg[7]]) != MAGIC
        || &msg[8..20] != tid
    {
        return None;
    }
    let len = u16::from_be_bytes([msg[2], msg[3]]) as usize;
    let body = msg.get(20..20 + len)?;
    let mut i = 0;
    while i + 4 <= body.len() {
        let kind = u16::from_be_bytes([body[i], body[i + 1]]);
        let alen = u16::from_be_bytes([body[i + 2], body[i + 3]]) as usize;
        let v = body.get(i + 4..i + 4 + alen)?;
        if kind == XOR_MAPPED_ADDRESS && v.len() >= 8 {
            let port = u16::from_be_bytes([v[2], v[3]]) ^ (MAGIC >> 16) as u16;
            let ip = match v[1] {
                1 => IpAddr::V4(Ipv4Addr::from(
                    u32::from_be_bytes([v[4], v[5], v[6], v[7]]) ^ MAGIC,
                )),
                2 if v.len() >= 20 => {
                    let mut key = [0u8; 16];
                    key[..4].copy_from_slice(&MAGIC.to_be_bytes());
                    key[4..].copy_from_slice(tid);
                    let mut a = [0u8; 16];
                    for (j, b) in a.iter_mut().enumerate() {
                        *b = v[4 + j] ^ key[j];
                    }
                    IpAddr::V6(Ipv6Addr::from(a))
                }
                _ => return None,
            };
            return Some(SocketAddr::new(ip, port));
        }
        // Attributes are padded to four bytes.
        i += 4 + alen.div_ceil(4) * 4;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_success_response_yields_its_mapped_address() {
        // RFC 5769 section 2.2, the IPv4 sample response.
        let msg = crate::vectors::unhex(concat!(
            "0101003c2112a442b7e7a701bc34d686fa87dfae",
            "8022000b7465737420766563746f7220",
            "002000080001a147e112a643",
            "000800142b91f599fd9e90c38c7489f92af9ba53f06be7d7",
            "80280004c07d4c96"
        ));
        let tid: [u8; 12] = msg[8..20].try_into().unwrap();
        assert_eq!(mapped_address(&msg, &tid), "192.0.2.1:32853".parse().ok());
        assert_eq!(mapped_address(&msg, &[0; 12]), None);
        assert_eq!(mapped_address(&msg[..19], &tid), None);
        let (tid, req) = request();
        assert_eq!(&req[8..], &tid);
        assert_eq!(mapped_address(&req, &tid), None);
    }
}
