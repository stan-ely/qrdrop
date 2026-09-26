# The app

A desktop and mobile shell around exactly the code the website runs. `src/` is
shared verbatim — the app is not a port, and there is no second protocol
implementation to keep in step. It exists for the three things a browser tab
cannot give: a file sink that writes straight to disk instead of through a
download, a camera the operating system trusts, and a `qrdrop:` link the system
knows how to open.

Releases are tagged `app-v*` and carry the installers; the npm package moves on
its own `v*` tags and its own version number, because a webview-permission fix
should not republish an unchanged library.

## Install

```bash
brew install --cask stan-ely/tap/qrdrop-app                        # macOS, Apple silicon
scoop bucket add stan-ely https://github.com/stan-ely/scoop-bucket  # Windows
scoop install stan-ely/qrdrop-app
```

On Windows the app is also in the [Microsoft Store](https://apps.microsoft.com/detail/9NWB4J802031).
That copy is the MSIX, which Microsoft re-signs when it certifies it — the one
build of qrdrop that anybody has vouched for. It is the same code as every other
Windows download here; what the Store adds is the signature, a per-app camera
switch in Settings, and updates without a SmartScreen warning. It needs Windows 10
21H2 or later, because an MSIX cannot fetch the WebView2 runtime the way the
installer can.

Both taps are updated by the release workflow and resolve to the files on the
[Releases page](https://github.com/stan-ely/qrdrop/releases), which is also where
the Android APK, the `.deb` and the AppImage live. Note `qrdrop-app` and not
`qrdrop`: the latter is the CLI, in the same tap and the same bucket. The cask is
Apple silicon only — one `.dmg` is built, on an arm64 runner — and it refuses to
install on Intel rather than leaving you a bundle that cannot launch.

On Android, add this project's own F-Droid repository once and every later
release arrives as an ordinary update:

```
https://share.stan-ely.com/fdroid/repo?fingerprint=889603b768cd2ca50f6c553086827880aa1aad5bbf0098a3028a7f1b7fd47582
```

It serves the same APK the Releases page does, signed with the same key — it is
not rebuilt and re-signed by F-Droid, and that is the point rather than a
convenience. An F-Droid-built app carries F-Droid's certificate, which is not the
one published at `.well-known/assetlinks.json` on this domain, so a scanned
pairing code would open a browser tab instead of the app with nothing anywhere
to explain why. Check the fingerprint in the URL against the one your client
shows when it adds the repository; it is what the client pins, and it will never
change. **Android could not receive at all in 1.0.0**; 1.1.0 fixed that, and if you
sideloaded the first release, update before trying to receive anything.

## What works where

| Platform | Send | Receive | Notes |
| --- | --- | --- | --- |
| **Windows** | yes | yes | signed: the Store copy only |
| **macOS** | yes | yes | signed: no |
| **Linux** | Beam only | Beam only | WebKitGTK has no `RTCPeerConnection` |
| **Android** | yes | yes, from 1.1.0 | F-Droid, or the APK on the Releases page |
| **iOS** | — | — | compiles on every change; shipping it needs an Apple Developer account |

Two of those are worth stating rather than burying. On Linux the webview ships
no WebRTC at all, so the network transfer cannot work there — Beam, which moves
a file as animated QR codes across a camera and needs no network by design, does,
and so does the CLI. On Android, 1.0.0 could send anything and could not receive,
for two reasons found in order on a phone: the Storage Access Framework hands back
a `content://` URI where its native sink expected a filesystem path, and Android's
app bridge has no raw request body for the file's bytes. Both were fixed in 1.1.0
and verified on a device — a 64 MiB file received byte-identical, and a Beam
receive through the camera on the same phone. So was a third fix found on the way:
every received file was listed as 0 B by the Files app, because Android indexed it
the moment it was opened for writing, before a byte had arrived, and was never
asked to look again. A cancelled receive on
Android leaves an empty file behind rather than none, because the app is not
allowed to delete a document the save dialog created.

## Android on ColorOS

**On ColorOS (Oppo, Realme, OnePlus), choose where to save within about 20
seconds**, or allow qrdrop to run in the background. The save dialog counts as
leaving the app, ColorOS freezes an app about 11 seconds after it leaves, and a
sender that hears nothing from a frozen phone for 30 seconds gives up. Measured on
a Realme phone: saving after 2 or 20 seconds received the file whole, saving after
45 lost the sender, and 45 seconds with background running allowed received it,
because a phone allowed that is woken briefly by each packet that arrives. This is
the vendor's scheduler, outside anything the app controls, and it is not worked
around. When it does happen the receive now ends on "Transfer failed" and says the
other device disconnected, instead of standing on "Receiving, 0%".

## Signing and provenance

**Only the Android APK and the Store copy are signed.** There is no Windows
code-signing certificate and no Apple Developer account behind this project, so
macOS will quarantine the `.dmg` and Windows SmartScreen will warn about the
installer — the Microsoft Store signature covers Store installs and nothing else,
and every Windows file on the Releases page is as unsigned as it was. Those
warnings are correct — nobody has vouched for those binaries — and the release
notes carry the incantation for each rather than pretending otherwise. Every file ships with a
build provenance attestation (`gh attestation verify <file> --repo
stan-ely/qrdrop`) and a `SHA256SUMS`: a verifiable claim about where the file came
from, which is not the same thing as a code signature and is not offered as one.

The shell's own story — what each platform's webview could actually do, and every
measurement behind the choices in it — is in
[`app/CAPABILITIES.md`](../app/CAPABILITIES.md).

