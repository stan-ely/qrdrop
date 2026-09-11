# Privacy policy

This covers qrdrop in every form it ships in: the app (Microsoft Store, the
Releases page, Homebrew, Scoop, winget, F-Droid), the website at
share.stan-ely.com, and the `qrdrop` command-line tool.

**The short version:** qrdrop has no accounts, no analytics and no server of its
own that stores anything. Your file is encrypted on your device and decrypted on
the device you send it to. Nobody operating qrdrop ever holds a readable copy,
because there is no qrdrop server for it to pass through.

## What qrdrop does not collect

- No account, name, email address or phone number.
- No analytics, telemetry, crash reports or advertising identifiers.
- No copy of your files, their names or their contents on any server run for
  qrdrop.
- No contacts, location or browsing history.

## What other parties can see when you send a file

A network transfer needs two devices to find each other, and the parties that
help them do so can see some things. None of them can see your file.

- **Public signalling services** (Nostr relays and WebTorrent trackers) carry
  the first messages two devices use to find each other. Each one sees your IP
  address, that two
  throwaway keys met in a room whose name is derived from the pairing code, when
  that happened, and roughly how much was exchanged. It does not see the pairing
  code, the file or its name.
- **STUN servers** (operated by Google, Twilio, Cloudflare and Metered) tell your
  device its public IP address so a direct connection can be made. They see your
  IP address.
- **A TURN relay** (the Open Relay Project, operated by Metered) is used only
  when a direct connection is impossible. It then carries the encrypted
  transfer, and sees both devices' IP addresses, the timing and the volume, but
  only ciphertext.
- **The other device** learns your IP address, as any direct connection requires,
  and receives the file you chose to send.

These services are run by third parties under their own policies. qrdrop sends
them nothing beyond what establishing the connection requires.

## The camera

The camera is used only to read a pairing QR code, or to receive a file by Beam.
Frames are processed on your device and are never recorded, stored or sent
anywhere. The camera is optional: a pairing code can be typed in instead.

## Beam

Beam moves a file as QR codes shown on one screen and read by another camera. It
uses no network at all, and it is **not encrypted**: anyone who can see the
sending screen, or a photograph or recording of it, can read the file.

## Files you receive

A received file is saved where you choose and nowhere else. qrdrop keeps no copy
and no record of it.

## Where qrdrop is installed from

The Microsoft Store, GitHub, Homebrew, Scoop, winget, F-Droid and GitHub Pages
(which serves the website) each handle downloads under their own privacy
policies. qrdrop receives no information about who installed it.

## Children

qrdrop collects no personal information from anyone, including children.

## Changes and contact

Changes to this policy are made in this file, and its history is public at
https://github.com/stan-ely/qrdrop/commits/main/PRIVACY.md. Questions go to
https://github.com/stan-ely/qrdrop/issues.

Effective 11 September 2026.
