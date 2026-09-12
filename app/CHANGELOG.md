# Changelog — the qrdrop app

Notable changes to the desktop and mobile shell, newest first. This is a
different sequence from the root `CHANGELOG.md`: that one tracks the npm
package and moves on `v*` tags, this one tracks the app and moves on `app-v*`.
The two version numbers are deliberately unrelated — a webview-permission fix
should ship an app release without republishing an unchanged library.

Write the next entry under a `## Unreleased` heading. `cargo release` stamps it
with the version and the date at the moment the version is decided, and stops
if there is no such heading — the notes are written before the tag, never
generated from commit subjects afterwards.

## Unreleased

**Android receives files.** 1.0.0 could send from Android and could not receive at
all — and it said the wrong thing about why: pressing Save created an empty file and
then reported that the save dialog had been closed. Two things were wrong, and a phone
found them one after the other. The save dialog hands back a `content://` address
rather than a path, which the app could not open; it now opens it through Android's
own content resolver. And Android's bridge between the app's page and its native half
cannot carry raw bytes, so the file's blocks now cross it as base64 there, while
Windows, macOS and Linux keep the faster raw path. Measured on a Realme phone running
Android 16: a 64 MiB file received at about 3.4 MB/s, byte-identical to the original,
with the sender and the phone computing the same verification digest.

*Some Android phones may cut the connection while the save dialog is open.* ColorOS
(Oppo, Realme, OnePlus) closes a background app's network sockets within seconds,
and choosing where to save puts qrdrop in the background. On that phone one receive
failed exactly this way, with the connection gone before Save returned. The runs that
succeeded chose quickly with qrdrop allowed to run in the background, and those two
were not tested apart, so which one matters is not yet known. If a receive fails
straight after choosing where to save, try both.

**A transfer could fail before it started, with "Out-of-order frame: expected 0, got
1".** Seen once on that phone receiving from the command line, and gone on the retry.
Two short messages that set a transfer up could leave in the wrong order when they
were sent at the same moment, and the receiving side rightly refuses that. They now
always leave in order. The fault was in the transfer code the app shares with the
website and the command line, so all three get the fix.

**A receive that fails says why.** If the app could not write to the place you chose,
it said the save dialog had been closed without choosing a location — which is how
Android's receive bug above stayed hidden. It now shows the real error, and the
sending device is told the transfer failed and why, rather than that it was declined.
And when something went wrong partway through, every piece of the file still on its
way failed again and replaced the message, so the reason on screen was almost never
the reason. The first failure now ends the receive, and it is the one you see.

**Cancel abandons the partial file.** Cancelling a receive used to close the
connection and keep what had arrived under the name you saved it as: 15.9 MB of a
64 MiB file, on the phone above. On Windows, macOS and Linux it is now deleted. On
Android it is emptied rather than deleted — the save dialog creates that document and
the app is not allowed to remove it — so a cancelled receive leaves an empty file
behind.

**A send whose receiver leaves partway through says so, and stops.** When the other
device cancelled or went away mid-file, the send kept going to nobody and then waited
forever for a reply: a command-line sender printed "Sent 64 MB of 64 MB" after that
phone cancelled and was still running two minutes later, and the app showed the
disconnect while the send carried on underneath it. It now ends at the next piece of
the file with "The other device disconnected", in the app, the website and the
command line alike.

## 1.0.0 -- 2026-09-11

**Packaged for the Microsoft Store, and 1.0.0 because of it.** This is the first
release built as an MSIX for the Microsoft Store, where Microsoft signs the copy it
serves — the only Windows build of qrdrop signed by anyone. The listing appears once
the Store has certified it. Nothing on this page changes: the installer and the zip
are still unsigned, and still say so below. The version goes from 0.1.0 straight to
1.0.0 because the Store will not carry a version beginning with 0, and a listing
showing a different number from this page would be worse than the jump.

**"They don't match" is a button now.** The verify screen asked whether both devices
showed the same four symbols and offered only "They match" and Cancel, so a mismatch
had nothing to press that meant what you were seeing. It now ends the pairing, says
that something is relaying between the two devices and that nothing about the file
left yours, and asks for a fresh code. Deliberately no retry: four symbols is 24
bits, which holds only at one attempt per code. Sender side for now.

**qrdrop is on F-Droid — this project's own repository, not f-droid.org.** Add
`https://share.stan-ely.com/fdroid/repo?fingerprint=889603b768cd2ca50f6c553086827880aa1aad5bbf0098a3028a7f1b7fd47582`
in F-Droid, Neo Store or Droid-ify once, and every later release turns up as an
ordinary update instead of an APK to find and sideload. It serves the same file
this Release does, signed with the same key: an app rebuilt by F-Droid would carry
F-Droid's certificate instead, which is not the one this site publishes for app
links, and a scanned pairing code would then open a browser tab rather than the
app with nothing anywhere to explain why. The fingerprint in that URL is what your
client pins, and it will not change. Android can still send and not yet receive.

**Shortcuts and the Quick Settings tile now work while the app is already open.**
They worked from cold and did nothing at all warm — the intent was recorded and then
sat there, unread, with the app in front of you. The web layer had been waiting for
the window to regain focus, and this webview never reports that it lost it: measured
on a device, a background-and-return produces no focus event, no visibility change,
and a page that believes it was visible the entire time. It checks on a short timer
instead. A shortcut arriving mid-transfer is still declined with a word about why,
rather than being saved up and sprung on you when the transfer ends.

**The app works in landscape, and now uses it.** Turning the phone sideways used to
draw the scanner panel and the camera frame over the top of the buttons, and cut the
heading and the encryption warning off the beam screen entirely. That is fixed — and
beyond fixed: the page title, "How it works" and the security disclosure share one
line instead of three, the card puts the camera or the code down the left at full
height with the words and buttons beside it, and beam's speed control sits next to
Cancel. The viewfinder went from 128 pixels to 258 on a 360-pixel-tall screen.
Nothing is hidden and nothing moved behind a tap. "Take a photo" is the one thing
that steps out of the way while the phone is sideways, and it comes straight back.

**Long-press the icon, or pull down the shade.** Two launcher shortcuts, "Scan a
code" and "Send a file", and a Quick Settings tile that opens straight onto the
scanner. Receiving starts with a code already on someone else's screen and a person
waiting, so the taps before the camera opens are spent while they wait; from the
shade it is one pull and one tap without leaving the app you were in.

Both travel the share sheet's own chain, carrying an action string where a share
carries a file — the activity writes a small file into the app cache, Rust takes and
deletes it, and the web layer starts the screen it names. One mechanism for both
entry points rather than a second one to keep in step. A shortcut that arrives while
a transfer is running is declined and says so, exactly as a share is.

**The back gesture no longer closes the app mid-transfer.** It did, silently, and
that was never a feature this app added — the gesture is the platform's and the
generated activity forwards it. The first press now says what a second one will do.
It cannot dismiss the SAS confirmation or beam's Accept.

**The screen stays awake while a transfer or a beam is running**, which matters most
on the mode where the phone is held up to another camera for minutes with nothing
touching it.

**The Android share sheet opens qrdrop.** Tapping Share in Photos or Files and
choosing qrdrop lands the file on the send screen with its own name on it, instead
of opening the app and picking the same file again by hand. It handles a share into
an app that is already running as well as a cold start — the activity is
`singleTask`, so a warm share never calls `onCreate`, and handling only the cold
path would have worked exactly once per launch.

The file is read through Tauri's asset protocol rather than `plugin-fs`, so it stays
disk-backed and the sender's existing 2 MiB block reads work on it unchanged. Going
through `plugin-fs` would have pulled the whole file into memory at ~2 MB/s first,
which is eight minutes and a gigabyte of heap for a 1 GB share before the first
frame goes out.

**The app installs from Homebrew and Scoop.** `brew install --cask
stan-ely/tap/qrdrop-app` on Apple silicon, `scoop install stan-ely/qrdrop-app` on
Windows; both are written by the release workflow and point at the same files the
Releases page carries. The name is `qrdrop-app` rather than `qrdrop` because the CLI
already holds that name in both places, and a formula and a cask sharing one token
makes `brew install qrdrop` resolve to the formula with only a warning.

The cask is Apple silicon only and refuses to install on Intel. One `.dmg` is built,
on an arm64 runner, so the alternative was not an Intel install but a broken one.
Its caveats repeat the unsigned-binary warning and the `xattr` line, because
`brew install --cask` quarantines what it installs and that dialog should not arrive
without explanation.

Windows releases now also carry `qrdrop-<version>-x86_64-windows.zip`, the same
binary the installer contains with no installer around it. It is what Scoop
installs, and it is a reasonable direct download for anyone who would rather not run
an unsigned setup program. Unlike the `.exe` it cannot fetch the Evergreen WebView2
runtime, which matters only on Windows older than 10 21H2.

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
