# Changelog — the qrdrop app

Notable changes to the desktop and mobile shell, newest first. This is a
different sequence from the root `CHANGELOG.md`: that one tracks the npm
package and moves on `v*` tags, this one tracks the app and moves on `app-v*`.
The two version numbers are deliberately unrelated — a webview-permission fix
should ship an app release without republishing an unchanged library.

## 0.1.0

The first release of the app. It is a shell around the same code the website
runs, which is the point: `src/` is shared verbatim, and the app exists to add
the three things a browser cannot give — a native file sink that is not bounded
by a download, a camera the OS trusts, and a `qrdrop:` link the system knows how
to open.

**What works, measured on real hardware rather than expected.** Windows and
macOS send and receive. A 3 MiB transfer from the Windows app to a phone browser
over one WiFi network went device to device with matching digests at both ends
and a "Local network" badge, so the bytes never left the LAN. The native sink
writes at ~40 MB/s where the obvious `plugin-fs` implementation managed ~2, and
a 1 GiB transfer now costs ~72 MB of heap rather than growing by the whole file.
Android sends: a 64 MiB file at 4.03 MB/s, after a read-ahead that took the same
transfer from about eleven minutes to 16.8 seconds.

**What does not work, stated plainly rather than left to be discovered.**

*Android cannot receive.* Its save dialog returns a `content://` URI from the
Storage Access Framework and the sink opens a filesystem path, so the write
fails immediately. Android can send to anything; receiving needs the browser or
another device for now.

*Linux has no WebRTC transfer.* WebKitGTK ships no `RTCPeerConnection`, so the
Linux build pairs and then cannot open a peer connection. Beam — the offline
mode that moves a file as a sequence of QR codes across a camera, with no
network at all — works there, and so does the CLI.

*iOS is not here.* It compiles on every change and is proven to link, but
shipping it needs an Apple Developer account, which this project does not have.

**Signing, and what it means for these files.** The Android APK is signed with a
release key. Everything else is not: macOS will refuse the `.dmg` until it is
released from quarantine, and Windows SmartScreen will warn about the installer.
Those warnings are correct and you should read them — an unsigned build is one
whose publisher no one has checked, and a tool that asks you to trust a peer is
the wrong place to learn to click through that dialog. The release notes carry
the exact incantation for each, and the checksums to verify against.

Signing the APK does one further thing worth naming: its certificate fingerprint
is what `.well-known/assetlinks.json` has been waiting for since deep links were
added, so a scanned pairing code can open the installed app rather than bouncing
into a browser.
