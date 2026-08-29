# Security

## Reporting a vulnerability

Open a [private security advisory](https://github.com/stan-ely/qrdrop/security/advisories/new).

Not a public issue. [Issues](https://github.com/stan-ely/qrdrop/issues) is where
`bugs.url` points and is the right place for everything else, but it is a public
tracker, and a report there is a disclosure whether or not it was meant as one.

Expect an acknowledgement within a few days. This is a single-maintainer project
with no security team behind it and no bounty; that is worth knowing before you
spend a week on it. There is no PGP key — the advisory channel is private
end to end, which is what the key would have been for.

Useful in a report, roughly in order: what an attacker ends up able to do, the
smallest sequence that gets them there, and which of the two transports it
applies to. A proof of concept is welcome and not required.

## Scope

In scope is anything that breaks a claim the [README's threat
model](README.md#threat-model) makes. Concretely:

- Recovering file contents, or the session keys, without the QR code.
- Standing between two peers without both screens showing different emoji —
  that is what the SAS is for, and it failing is the worst bug this project
  could have.
- Making the receiver accept a file that was truncated, reordered, or altered.
- Decrypting a past transfer given the code afterwards. Each session uses
  ephemeral ECDH precisely so this fails.
- Reading anything but ciphertext, timing, and volume as a relay or TURN
  operator.
- Anything in `src/core/` reaching a DOM or an `fs`. It is enforced by two
  typecheck passes rather than by review, and a way around that is a finding.
- The usual web surface: XSS through a peer-supplied filename, CSP bypass,
  a way to get the fragment-carried key into a request.

## Not vulnerabilities

These are documented behaviour. Reporting them is welcome, but the answer will
be a link back here.

**Anyone holding the code can join.** The 32 bytes in the QR are the entire
credential — there is no second factor and no account. Showing the code to a
room means anyone in the room can pair. This is the design, and it is what makes
"no signup" possible.

**Beam is unencrypted, and cannot be encrypted.** Animated-QR transfers have no
handshake, therefore no key agreement, no forward secrecy, and no SAS: there is
no peer to authenticate, only photons, and a key shown on the same screen as the
data protects nothing. Anyone who can see the sending screen — including a
photograph of it, or a camera in the room — has the file. The UI says so on both
beam screens and the README carves it out of the threat model explicitly. Beam
exists for air-gapped machines, where the alternative is a USB stick.

**Both peers learn each other's IP address.** Inherent to a direct connection.
Forcing everything through TURN would hide the peers from each other and expose
both to the relay operator instead; it is left opt-in
(`iceTransportPolicy: 'relay'`).

**Relays and trackers see metadata** — that two throwaway keys met on a room,
when, and roughly how much moved.

**The host serving the page could serve modified code.** True of every web
application, and not solvable in a browser. It is mitigated by a strict CSP, no
inline scripts, a small surface, and shipped source maps so the deployed bundle
can be read against this repository. The CLI sidesteps it: a versioned tarball
you can pin and audit, published with `npm publish --provenance` so it is tied
to the workflow run and commit that built it. For genuinely sensitive material,
use the CLI.

## Supported versions

The latest published version. This is a young project; there are no backports.
