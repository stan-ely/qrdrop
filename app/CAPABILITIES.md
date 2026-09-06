# Phase 0 capability spike

What `app/spike/index.html` found when loaded in a real Tauri window on each
target. This is the gate for Phase 1: it exists to answer "does the webview on
this platform actually have what `src/web/` needs" before any of the real
frontend is wired in, not to be a permanent report -- once Phase 1 replaces
`app/spike/` with the built site, this file stops being generated and stands
as a record of what was true when the app was onboarded.

Every check and its rationale is commented in `app/spike/index.html`; this
file only records outcomes.

## Summary

| | Windows (WebView2) | Linux (WebKitGTK) | macOS (WKWebView) | Android | iOS |
| --- | --- | --- | --- | --- | --- |
| secure context | pass | pass | pass | not run | not run |
| WebCrypto | pass | pass | pass | not run | not run |
| `showSaveFilePicker` | pass | fail (expected) | fail (expected) | not run | not run |
| `BarcodeDetector` | fail | fail | fail | not run | not run |
| `getUserMedia` (API present) | pass | pass | pass | not run | not run |
| `RTCPeerConnection` + ICE | pass | **FAIL -- absent** | pass | not run | not run |
| `wss://` connect | pass | pass | pass | not run | not run |

The one result that changes the shape of the project: **Linux/WebKitGTK has no
WebRTC at all**, confirming the risk the onboarding brief called out by name.
See the Linux section below for what that does and does not rule out. Android
and iOS are not run yet -- see their sections for why.

## Windows (WebView2 / Chromium, run locally)

Built with `npx tauri build --debug --no-bundle` from `app/`, run directly as
`qrdrop.exe`. WebView2's UA reports Chrome/152 (Edg/152) -- current Chromium,
as expected for WebView2's evergreen runtime.

| Check | Result |
| --- | --- |
| `isSecureContext` | **pass** -- `true` |
| `crypto.subtle` | **pass** -- present |
| `showSaveFilePicker` | **pass** -- present (Chromium) |
| `BarcodeDetector` | **fail** -- not present. Chromium ships the Shape Detection API behind a component that WebView2 does not carry; the jsQR fallback (`src/web/qr.js`) is load-bearing on Windows, not a Firefox-only path. |
| `getUserMedia` | **pass** (API present) -- but the call itself rejects `NotAllowedError: Permission denied`, immediately, with no OS permission prompt shown. WebView2 does not surface a camera-permission dialog on its own; Phase 3 needs an explicit permission handler (`WebView2`'s `PermissionRequested` event, exposed through `tauri-plugin-*` or a custom listener) or every camera use on Windows silently fails closed. |
| `RTCPeerConnection` + ICE gather | **pass** -- a host candidate arrived immediately. Note: `iceGatheringState` never reached `complete` within 15s even after STUN produced three `srflx` candidates in one run -- see below. |
| `wss://` connect | **pass** -- connected to `wss://nos.lol` |

**Finding, not a failure:** the first version of this probe waited for
`iceGatheringState === 'complete'` and reported ICE as failing after 15s, even
though host and three `srflx` candidates had already arrived -- a fully usable
ICE setup. `complete` appears to hang indefinitely on this machine, most
likely on the two `openrelay.metered.ca` TURN entries in `ICE_SERVERS`. The
probe was rewritten to resolve on the *first usable candidate*, which is what
real signalling actually waits for (Trystero negotiates over trickle ICE, not
after `complete`) -- see the comment in `app/spike/index.html`. Left as
recorded here because the same trap is easy to reintroduce in Phase 1/2 code
that assumes `complete` fires: it may not, on this platform, in this
environment.

## Linux (WebKitGTK, CI: ubuntu-latest, run under Xvfb)

UA reports WebKitGTK's Safari/605.1.15 (`Version/60.5`).

| Check | Result |
| --- | --- |
| `isSecureContext` | **pass** -- `true` |
| `crypto.subtle` | **pass** -- present |
| `showSaveFilePicker` | **fail** -- absent, as expected: this is a Chromium-only API and Phase 2's platform seam exists precisely to route around it here. |
| `BarcodeDetector` | **fail** -- absent. jsQR (`src/web/qr.js`) is the only working path on this platform. |
| `getUserMedia` | **pass** (API present), call rejects `OverconstrainedError: Invalid constraint` for `{ video: true }` with no camera attached. Distinct from Windows' immediate `NotAllowedError` -- worth re-testing against a real device before drawing a permission-flow conclusion from a headless runner with no camera at all. **Also:** the very first run of this job used a 30s process budget and never got a result at all, because WebKitGTK's native media-capture negotiation ("Video capture was requested but no device was found amongst 0 devices") blocks past this page's 5s JS-level `getUserMedia` timeout before the promise rejects -- the timeout does not preempt it. The job now waits 75s; Phase 3's real camera-permission flow needs to budget for the same thing rather than assuming a 5s JS timeout actually bounds the call. |
| `RTCPeerConnection` + ICE gather | **FAIL -- `RTCPeerConnection is not defined`.** This is the named risk in the onboarding brief, confirmed: the WebKitGTK build on ubuntu-latest ships with no WebRTC support at all. Not "gathers no candidates" -- the constructor itself does not exist. |
| `wss://` connect | **pass** -- connected to `wss://nos.lol` |

**This is the Phase 0 result that gates everything downstream of it.** qrdrop's
entire WebRTC transfer path -- the thing the app exists to do -- cannot run in
this webview as built. Two honest paths forward, neither attempted here
because the decision belongs to whoever reviews this phase, not to the spike:

1. Ship Linux WITHOUT the WebRTC transfer mode. Beam (camera + animated QR,
   no networking) does not depend on `RTCPeerConnection` and could still work
   -- pending its own camera-permission verification. CLI-over-stdin already
   works regardless of the webview. A Linux desktop build would then be a
   materially smaller feature set than Windows/macOS, and the UI would need
   to say so rather than offer a WebRTC send/receive screen that silently
   cannot connect.
2. Investigate whether WebRTC can be enabled on this WebKitGTK build --
   distribution packaging, a `WEBKIT_DISABLE_COMPOSITING_MODE` or feature-flag
   equivalent, or a newer WebKitGTK version than what ubuntu-latest carries by
   default. Not explored here; it is exactly the kind of "work around it
   silently" the onboarding brief said not to do without saying so.

**Decision: option 1.** Cross-checked outside the CI runner before deciding,
since ubuntu-latest's image is one specific build a real user is not
guaranteed to have. The real, built Phase 1 app (`app/dist`, not the Phase 0
spike page) was compiled and run under WSL2 (Ubuntu 24.04.2,
`libwebkit2gtk-4.1` 2.52.3 -- newer than ubuntu-latest's CI image) against a
real WSLg display, both directly and via `npx tauri dev`. `RTCPeerConnection`
is `undefined` there too, confirming the CI result was not an artifact of that
one runner image. (One dead end on the way there, noted so it is not repeated:
forcing `GDK_BACKEND=x11` and relaunching the raw binary repeatedly, rather
than through `tauri dev`, put the webview into a state where every navigation
failed with WebKit's own "Operation was cancelled" error page before any
content loaded -- unrelated to WebRTC, and it went away on a clean relaunch
through `tauri dev` with no backend override.)

Option 2 was also checked against public sources rather than left as a guess:
[tauri-apps/tauri discussion #8426](https://github.com/tauri-apps/tauri/discussions/8426)
gets WebRTC working in WebKitGTK on Linux, but only by compiling WebKit itself
from source with `-DENABLE_MEDIA_STREAM=ON -DENABLE_WEB_RTC=ON`, patching Wry
to enable the corresponding WebKitSettings and handle permission requests, and
running it on NixOS with a custom flake. That is not a packaging gap Ubuntu or
Debian will close upstream on their own schedule -- it is a from-source
WebKit build this project would have to compile and maintain itself, on every
target distro, indefinitely. Weighed against that cost, shipping Linux without
WebRTC transfer (Beam and the CLI still work) is the honest option, not the
lazy one.

## macOS (WKWebView, CI: macos-latest)

UA reports WebKit's Safari/605.1.15 (WKWebView, no numbered Safari version --
normal for an embedded webview).

| Check | Result |
| --- | --- |
| `isSecureContext` | **pass** -- `true` |
| `crypto.subtle` | **pass** -- present |
| `showSaveFilePicker` | **fail** -- absent, same reasoning as Linux. |
| `BarcodeDetector` | **fail** -- absent. |
| `getUserMedia` | **pass** (API present), same `OverconstrainedError: Invalid constraint` as Linux against a runner with no camera. |
| `RTCPeerConnection` + ICE gather | **pass** -- a host candidate arrived immediately, same as Windows and the same `iceGatheringState` never reaching `complete` within this run's window. WebRTC is present and at least partially functional on WKWebView, unlike WebKitGTK -- the two WebKit-family webviews are NOT equivalent here. |
| `wss://` connect | **pass** -- connected to `wss://nos.lol` |

Encouraging relative to Linux: the transfer path has a real chance of working
on macOS as-is. Still needs a from-a-real-device check of `getUserMedia`
against an actual camera and its OS permission prompt (Beam depends on this),
and of a full peer-to-peer connection rather than just "a host candidate
exists" -- this spike never completes an actual handshake, by design (there is
no peer in a CI job).

## Android

**Not run in Phase 0.** No Android SDK/NDK was installed on this machine, and
acquiring one is a multi-gigabyte download plus emulator or device setup --
deliberately not done without confirming first. Phase 4 builds the toolchain
config and leaves the on-device run to whoever has the phone; the checklist to
fill in is in "Phase 4" below.

## iOS

**Not run in Phase 0.** Per the onboarding brief this is a CI-only,
build-only target from Phase 4 onward (`macos-latest`, unsigned, ships
nothing) -- there is no local iOS capability check to run from a Windows
machine at any phase. Phase 4 adds that CI job; see below.

## Phase 2: platform seam and native sink

Built on the findings above rather than repeating them. `src/web/platform.js`
is a new, dependency-free registry -- `element.js` now asks it for
`createSink`/`canStreamToDisk` instead of importing `web/sink.js` directly,
and it defaults to exactly that import until something calls
`registerPlatform()`. Nothing about the deployed website changes: site/main.js
never calls it.

`app/src/main.js` does, and it is a new, second esbuild entry point
(`scripts/build-site.mjs`'s `channel === 'app'` branch points there instead of
at `site/main.js`) rather than a runtime `if (isTauri)` branch inside
`src/web/`, so the website's bundle carries no Tauri-only code at all. It
registers `app/src/tauri-sink.js`: `@tauri-apps/plugin-dialog`'s `save()` picks
the destination, and this crate's own `sink_open` / `sink_write` / `sink_close`
/ `sink_abort` commands (`app/src-tauri/src/sink.rs`) stream the bytes to it.

### The sink does not use plugin-fs, and the throughput number is why

`tauri-sink.js` shipped first on `@tauri-apps/plugin-fs`'s `create()` /
`write()` / `close()`, on the stated belief that `write()` "crosses the
JS<->Rust boundary as raw bytes, not a JSON-stringified array of numbers".
**That is true on paper and false on WebView2.** Measured with a throwaway
two-peer harness (a Node guest sending through the real `sendFile`, the app as
host + receiver, the sink writing a fixed path):

| write path | block size | throughput |
| --- | --- | --- |
| plugin-fs `write()` | 16 KiB … 4 MiB | **~2 MB/s, flat** |
| raw-body `invoke` | 16 KiB | 5.4 MB/s |
| raw-body `invoke` | 256 KiB | 33.8 MB/s |
| raw-body `invoke` | 1 MiB | 41.5 MB/s |

plugin-fs is bandwidth-bound at ~2 MB/s no matter how the bytes are chunked --
its argument is not travelling the raw IPC path on this webview. A command that
takes the bytes in the invoke request's **raw body** (`tauri::ipc::InvokeBody::Raw`)
does, and reaches ~40 MB/s once the caller coalesces the 16 KiB transfer frames
into >=256 KiB blocks (below that, ~3 ms of per-invoke cost dominates). So
`sink.rs` is a dumb open/append/close over the raw body, and `tauri-sink.js`
buffers to 1 MiB before each `invoke`.

### End-to-end, 1 GiB, real two-peer transfer

| | plugin-fs sink | raw-invoke sink + 1 MiB coalescing |
| --- | --- | --- |
| wall time | 716 s | **113 s** |
| throughput | 1.5 MB/s | **9.5 MB/s (76 Mbps)** |
| peak JS-heap growth | **~1.01 GiB** (the whole file) | **72 MB** |
| digest match | yes | yes |

Two things came out of this:

1. **The old sink defeated its own purpose.** It streamed to disk, but it
   drained so much slower than frames arrived that `src/core/receiver.js`'s
   serialised `handleFrame` queue accumulated the entire 1 GiB in RAM -- the
   exact whole-file-in-memory behaviour the native sink exists to avoid. The
   faster sink keeps the queue bounded (~72 MB) on its own.
2. **The 9.5 MB/s ceiling is now the transport, not the sink** (which does ~40
   MB/s in isolation): `node-datachannel` <-> WebView2 WebRTC plus per-16 KiB
   AEAD on both ends, over loopback. A real network is slower still, so on a
   real transfer the sink is never the bottleneck and memory stays flat by
   construction. There is still no explicit backpressure from a slow sink to
   the transport -- see the CLAUDE.md invariant added for this phase.

The harness itself is gone, like `app/spike/` before it; this table is the
record. `cargo build` is clean, `mise run typecheck` and `mise run test` pass,
and the built window renders today's UI unchanged (Windows still shows
Send/Receive, matching Phase 0's `RTCPeerConnection` pass on WebView2).

## Phase 3: camera permission and deep links

### The pairing QR is now a universal / app link

`app/src/main.js` sets `base-url` to `https://share.stan-ely.com/`, so the app's
QR encodes `https://share.stan-ely.com/#qrdrop:<code>` instead of the bare
`qrdrop:` form. One string, two audiences: the OS opens the installed app (it
matches the registered app-link domain), and a device without the app loads
share.stan-ely.com, where `site/main.js`'s `location.hash` path reads the same
code. The manual-entry field still shows the bare form for a human to read
aloud -- `element.js` keeps the two independent.

`qrdrop:` stays registered as a custom URI scheme (`tauri.conf.json`'s
`plugins.deep-link.desktop.schemes`), because that is what the CLI emits and
what a person types by hand; a `qrdrop:` link anywhere on the device now opens
the app too.

### The fragment-only rule survives the deep-link path

`decodeSecret` accepts the code only from a URL fragment -- the one part of a
URL a browser never sends to a server, which is the whole reason a link may
carry a key. A deep link is an attacker-influenced string arriving from
outside the app, so `app/src/deep-link.js` (`secretFromDeepLink`) funnels every
shape through `decodeSecret` and re-encodes to the bare form before the caller
ever writes it anywhere -- and the only place it is written is `location.hash`.
A `?code=` app link therefore throws exactly as a `?code=` paste does.
`test/deeplink.test.mjs` pins that across the universal-link form, the bare
scheme form, a scheme handed back with an `//` authority, and the query /
path rejections.

`element.js` grew a `hashchange` listener (`_consumeHashCode`) so the shell can
hand a scanned link to an already-running window by setting `location.hash` --
there is no fresh page load for the old `connectedCallback` read to catch. It
is guarded to the choose screen, so it cannot interrupt a live transfer, and
removed in `disconnectedCallback` like the paste listener. On the deployed site
this also means a link pasted into the address bar mid-use is now honoured.

### Camera permission, per platform, from Phase 0's findings

| Platform | What Phase 0 found | What Phase 3 does |
| --- | --- | --- |
| Windows / WebView2 | `getUserMedia` rejected `NotAllowedError` immediately, no OS prompt | `src/lib.rs`'s `windows_camera::allow` **grants camera + microphone up front** via `ICoreWebView2Profile4::SetPermissionState` for the `http://tauri.localhost` origin, and leaves the OS privacy toggle as the real gate. A `PermissionRequested` handler is also installed but only as a forward-compat fallback -- see below for why it is not the mechanism. `webview2-com` / `windows` are pinned to what `wry 0.55` already resolves. |
| macOS / WKWebView | API present; needs a TCC usage string or the process is killed on first camera use | `app/src-tauri/Info.plist` carries `NSCameraUsageDescription`; Tauri merges it into the `.app` bundle. |
| iOS / WKWebView | same as macOS (not run -- Phase 4) | `app/src-tauri/Info.ios.plist` carries the same string, committed now so it exists the first time `tauri ios init` runs. |
| Linux / WebKitGTK | no `RTCPeerConnection` at all; camera path untested | no hook exposed by Tauri/wry today, and WebRTC is absent anyway -- left as a known gap, consistent with the Linux decision above. |
| Android | not run -- Phase 4 | `<uses-permission android:name="android.permission.CAMERA"/>` plus a runtime request belong in `gen/android`'s manifest, which does not exist until `tauri android init` -- deferred to Phase 4. |

#### Why a `PermissionRequested` handler is not enough on Windows

The first cut of `windows_camera::allow` did only the obvious thing: attach a
`PermissionRequested` handler that answers `ALLOW` for camera and microphone.
It compiles, the handler installs with no error -- and `getUserMedia` still
throws `NotAllowedError` with no prompt, exactly as Phase 0 found with no
handler at all. Traced with the WebView2 devtools protocol
(`--remote-debugging-port`, `Runtime.evaluate`) plus temporary `eprintln`
tracing inside the closure: the handler is reached, `add_PermissionRequested`
returns `S_OK`, and **the event never fires**. `navigator.permissions.query`
reports camera as `denied`, not `prompt`.

WebView2's default content setting for camera on this origin is *deny*, and a
denied default is resolved synchronously without ever raising
`PermissionRequested` -- only the `prompt` ("ask") state routes through the
event. So a reactive handler has nothing to react to; it can never move the
setting off `deny`. Confirmed from the other direction: a CDP
`Browser.grantPermissions(['videoCapture'])` -- which writes the Chromium
content setting directly -- makes `getUserMedia` return a live `HD Camera`
track on the same build, proving the OS privacy toggle and the hardware were
never the blocker.

`ICoreWebView2Profile4::SetPermissionState(kind, origin, ALLOW, handler)` is
the write that the CDP call was doing, exposed as a real API. `allow()` now
calls it for `CAMERA` and `MICROPHONE` against `http://tauri.localhost` in the
`with_webview` closure, reached by `cast`-ing the `ICoreWebView2` up to
`ICoreWebView2_13` for `Profile()` and the profile to `ICoreWebView2Profile4`.
An older WebView2 runtime without `Profile4` (< 1.0.2210, mid-2023) falls
through to the reactive handler, which is kept for that case and in case a
future runtime moves the default to `ask`. The origin string is hardcoded and
assumes the Windows-default `http://` custom scheme; a `tauri.conf.json` that
opts into the https scheme has to change it.

Verified on a real build: `permissions.query` -> `granted`, `getUserMedia` ->
live `HD Camera` track, viewfinder painting in the Receive screen, and a full
3 MiB transfer from this app to a phone browser over the LAN with matching
verification digests on both ends.

### Gate

`mise run typecheck` and `mise run test` pass (including the new
`test/deeplink.test.mjs` and the `wellKnownFiles` cases in
`test/build-site.test.mjs`). `cargo check` on `app/src-tauri` is clean --
deep-link, single-instance and the Windows COM permission handler all compile.

**`cargo build` / `mise run app:dev` could NOT be completed at first:** the
disk filled during LLVM codegen (`rustc-LLVM ERROR: IO failure on output
stream: no space on device`, ~1 GB free of 390 GB). `cargo check` -- which
runs the full front end, macro expansion and borrow check over the crate and
every dependency -- was clean, so this was an environment limit, not a code
defect.

**Resolved on a later pass.** Disk was freed, but the same cleanup had removed
the MSVC C++ toolchain (only the VC++ *runtime* redists were left), so the
first build then failed with `error: linker link.exe not found`. Installing
**Build Tools for Visual Studio 2026** (the current line -- there is no VS
newer than what the "2022" download page now serves; MSVC 14.51 + Windows SDK
10.0.26100) fixed it. `npx tauri build --debug --no-bundle`, run from a
`vcvars64.bat` shell, then built clean in ~5 min cold. The running app renders
today's UI, the `qrdrop:` scheme registers itself in `HKCU` and a
`qrdrop:<code>` link routes to the running instance via single-instance, the
camera works (see the Windows row above), and a 3 MiB transfer to a phone
browser over the LAN completed with matching digests. The only Phase 3 item
still unverified is universal-link **association** -- the OS opening the
installed app for an `https://share.stan-ely.com/#qrdrop:...` link -- which
needs a signing identity and is deferred with the association files below.

### The association files are inert until signing exists

`scripts/build-site.mjs` now writes `apple-app-site-association` (root and
`.well-known/`) and `.well-known/assetlinks.json` for every channel except
`app`. Both are structurally complete and deliberately dead until a signing
identity is fed in: `APPLE_TEAM_ID` defaults to the placeholder `TEAMID`, and
`ANDROID_CERT_FINGERPRINT` defaults to an empty fingerprint list. "Unsigned
artefacts only" (onboarding brief) means neither identity exists yet; the
generator takes them as environment inputs so turning association on later is a
workflow secret, not a code change. `wellKnownFiles` is pure and tested.

## Phase 4: Android and iOS

Everything below the toolchain notes is **expectation, not measurement**.
Phase 4 lands the build configuration and the CI that compiles it; the
on-device capability run is deliberately left open, and the checklists here
are the form it gets filled into. Nothing in this section should be quoted as
a finding until a result column says so -- the Phase 0 sections above are what
measured results look like in this file.

### The toolchain: mise pins the tools, `android sdk` pulls the packages

`mise.toml` pins the Android **command-line tools** (`android-sdk = "23.0"`)
alongside node, rust and the JDK. An earlier pass in this phase left them out,
arguing that mise auto-installs on any task so a bare `mise run test` could
drag gigabytes down. That was wrong about what the plugin does: it unpacks
cmdline-tools (~170 MB) and exports `ANDROID_HOME`, `ANDROID_SDK_ROOT` and the
bin directories, and nothing more. The multi-gigabyte parts are pulled
separately, by the tools it just installed, into the same directory.

One consequence of that layout to know before running `mise uninstall
android-sdk`: the NDK lives inside mise's install dir, so removing the tool
takes several gigabytes of NDK with it.

`JAVA_HOME` comes from mise's own `java` (Temurin 21) and deliberately wins
over any system JDK. `NDK_HOME` has to be set by hand because the plugin does
not provide it, and the way it is set is worth recording: the obvious
`{{env.ANDROID_HOME}}` **fails**, because a tool's own exports are not in
scope while `[env]` is evaluated — mise errors with "Field ANDROID_HOME is not
defined". The documented `tools["android-sdk"].path` is out of scope there for
the same ordering reason. `xdg_data_home` is in scope, and resolves to
`AppData\Local` on Windows and `~/.local/share` elsewhere, which is where mise
installs on both.

One-time package install is `mise run app:android:sdk`, which expands to

```
android sdk install platform-tools ndk/29.0.14206865 \
                    build-tools/37.0.0 platforms/android-36
```

from `mise.toml`'s `[vars]`. Those four versions live there once and are read
by both this task and `NDK_HOME`, so a build cannot link against an NDK that
was never fetched — the same reasoning that gives design tokens one home and
derives the CSP from `SIGNALING_URLS`. Change the version there, re-run the
task, done.

Two things about that line are easy to get wrong. **`sdkmanager` is
deprecated** — it prints a notice and defers to the new `android` CLI, whose
subcommand is `android sdk install` and whose package separator is `/`, not
the `;` every older instruction on the internet uses. And **NDK 29 is
deliberate, not conservative**: every 30.x build in the repository is still a
release candidate, which the package path does not reveal — only the version
field's `-rc.N` suffix does, so a naive "pick the highest" lands on an RC.
29.0.14206865 is the newest stable, and NDK 28+ is also what produces the
16 KB page alignment Google Play now requires of new submissions.

Version numbers rot. These were current in September 2026, taken from
`android sdk list --all` rather than from memory: cmdline-tools 23.0,
platform-tools 37.0.1, build-tools 37.0.0, NDK 29.0.14206865, and platforms up
to android-37.2. Re-check rather than trusting this paragraph.

The tasks are `app:android:init` (one-time scaffold), `app:android:dev`,
`app:android:build`, and the `app:ios:*` equivalents. The `:targets` tasks add
the Rust triples explicitly, before `tauri android init` would add them
itself, so a missing target fails saying so instead of surfacing later as a
linker error against a std that was never installed.

### `gen/` is committed source now

`app/src-tauri/gen/` was ignored whole, on the argument that
`tauri android init` regenerates it in one command and a committed copy would
be a second source of truth. That reasoning held while `gen/` contained only
generated schemas. It does not survive Android: the build needs
`<uses-permission android:name="android.permission.CAMERA"/>` in
`gen/android`'s `AndroidManifest.xml`, and **`tauri.conf.json` has no field
that can express it**. The delta exists only in `gen/`, so an ignored `gen/`
means every re-init silently drops the camera permission and the scanner stops
working with no diff to point at.

A script that re-applied the delta after each init was the alternative
considered, and rejected twice over: it moves the second source of truth into
`scripts/` rather than removing it, and it cannot carry a Kotlin file -- which
the open question below may well require. `gen/schemas/` stays ignored,
because that part really is regenerated every build and never hand-edited.

The manifest also gets
`<uses-feature android:name="android.hardware.camera" android:required="false"/>`.
`required="false"` is deliberate: a device with no camera can still send a
file and still use the network transfer, and the UI already degrades honestly
(`src/web/view.js` shows `NO_CAMERA_BEAM` and hides the scan path when
`cameraAvailable()` is false). Marking the camera required would make the app
uninstallable there to protect a path that already declines itself.

### Open question: does the Android camera actually prompt?

**This is the most likely thing to be wrong.** `getUserMedia` in the Android
System WebView needs the app to hold `android.permission.CAMERA` at the OS
level. The manifest entry is necessary and, on Android 6+, *not sufficient* --
`CAMERA` is a "dangerous" permission requiring a runtime request
(`ActivityCompat.requestPermissions`). Whether wry/Tauri 2.11 bridges the
webview's `onPermissionRequest` to that OS request automatically is
version-dependent and not reliably documented; historically wry granted the
webview-level resource without raising the OS dialog.

Phase 4 does not assume it works. If the device run shows `getUserMedia`
failing with no prompt, the two forks are a small Kotlin runtime-permission
request in `gen/android`'s `MainActivity`, or a community Tauri
Android-permissions plugin added to `app/src-tauri/Cargo.toml` and
`app/package.json` (both app-directory files -- the "no new runtime
dependencies" rule is a root-package rule). This mirrors Windows exactly:
there too the reactive, obvious mechanism turned out not to fire, and the fix
was to grant up front.

### Open question: the native sink on a `content://` URI

`app/src-tauri/src/sink.rs`'s `sink_open` does `File::create(path)`. On
Android, `@tauri-apps/plugin-dialog`'s `save()` goes through the Storage
Access Framework and returns a **`content://` URI, not a filesystem path** --
which `File::create` cannot open. The Phase 2 sink may therefore fail on the
first real transfer, and the throughput measured there was WebView2-specific
and says nothing about Android.

Two fallbacks, to be chosen on evidence rather than in advance: write into the
app's own documents directory and surface the path, or route mobile writes
through `plugin-fs`, which is content-URI aware. Either belongs behind the
existing platform seam (`src/web/platform.js`, `app/src/tauri-sink.js`), never
as an `if (isAndroid)` inside `src/web/`.

### What CI compiles

`.github/workflows/app.yml` is build-only and ships nothing: a desktop
`tauri build --debug --no-bundle` matrix over Linux/Windows/macOS, an unsigned
Android debug APK, and an iOS simulator build. It has no tag trigger -- `v*`
belongs to npm's `publish.yml` and to `pages.yml`, and app release plumbing is
Phase 5.

The iOS job does **not** run `tauri ios build`. That drives an archive and
export, which wants a development team even for the `debugging` export method,
so on a runner with no signing identity it fails for reasons that say nothing
about the code. Building the simulator SDK with `CODE_SIGNING_ALLOWED=NO`
compiles the Rust staticlib and links the Swift shell, which is the entire
question the job exists to ask.

Until this ran, nothing compiled the Rust crate on a pull request at all:
`ci.yml` is Node-only and Phase 3's `cargo check` was a local habit. On a
project with no Mac and no Android device in CI reach, that meant iOS and
Android regressions surfaced never.

### The first Android build, and what it did and did not prove

`mise run app:android:build` produces a 144 MB unsigned debug APK at
`gen/android/app/build/outputs/apk/universal/debug/`. The toolchain that
worked: NDK 29.0.14206865, Rust 1.98.1, Tauri CLI 2.11.4, Gradle 8.14.3,
Temurin 21, `compileSdk`/`targetSdk` 36 and `minSdk` 24 (the last matching the
`bundle.android.minSdkVersion` in `tauri.conf.json`, which is where it comes
from). That answers the one question that could not be answered by reading:
**the Rust cross-compile links against NDK 29**, so choosing the newest stable
NDK over the RC-only 30.x line cost nothing.

`aapt2 dump badging` on the built APK, which is the check that matters because
it reads the packaged artifact rather than the source manifest:

```
uses-permission: name='android.permission.CAMERA'
uses-feature-not-required: name='android.hardware.camera'
```

So the manifest edit survives into the APK and `required="false"` took effect.

**A trap worth writing down, because it cost a build and the error does not
name it.** This repository's prose style uses `--` as an em dash, and XML
forbids that sequence *inside a comment*. A house-style comment in
`AndroidManifest.xml` therefore fails the manifest merger with

```
ManifestMerger2$MergeFailureException: Error parsing .../AndroidManifest.xml
```

and no line number, no column, and no mention of hyphens. The comment in that
file now says so in place.

None of this is a capability result. The APK builds; whether it *runs*, and
whether the camera opens, is the checklist below and needs a device.

### On-device checklist -- Android: MEASURED

Run 2026-09-06 on a Realme RMX3868, **Android 16 (API 36), arm64-v8a** --
the same API level the app targets, so this is the strictest current runtime
permission behaviour rather than a lenient old one. Driven over `adb` plus
the WebView's own DevTools socket
(`adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>`), which a
Tauri debug build exposes; the same CDP technique used on Windows in Phase 3.

| Check | Expected | Result |
| --- | --- | --- |
| app installs and launches | pass | **pass** -- no crash, real UI renders |
| `isSecureContext` | pass | **pass**, origin `http://tauri.localhost` as documented |
| `crypto.subtle` | pass | **pass** |
| `RTCPeerConnection` present | pass | **pass** -- UA is Chrome/151, evergreen |
| ICE gather -> host candidate | pass | **pass** -- `192.168.1.2 ... typ host` |
| `wss://` connect to a relay | pass | **pass** -- connected to `wss://nos.lol` |
| choose screen shows the network buttons | pass | **pass** -- so `rtcAvailable` is true and `choose()` did not degrade |
| `getUserMedia` API present | pass | **pass** |
| `getUserMedia` real-camera call | open question | **pass** -- live track, `camera 0, facing back` |
| OS camera prompt appears | **the decider** | **pass** -- see below |
| `BarcodeDetector` | likely absent | **PRESENT** -- expectation was wrong |
| `showSaveFilePicker` | absent | **PRESENT** -- expectation was wrong |
| `plugin-dialog` `save()` | returns a `content://` URI | **confirmed** -- `content://com.android.providers.downloads.documents/document/1512` |
| native sink accepts that path (Android as *receiver*) | suspected failure | **FAIL** -- `sink_open` -> `No such file or directory (os error 2)` |
| full LAN transfer, Android as *sender* -> Windows | pass | **pass** -- 3.0 MB, digest `cf7dc838...380747`, identical to the Phase 3 value for the same file. Direct LAN path: TURN never allocated once (every request 400'd), so nothing was relayed. |
| Beam send / Beam receive at ~10 Hz | pass | **not run** |
| deep link `qrdrop:<code>` -> verify screen | record | **not run** |
| `https://share.stan-ely.com/#qrdrop:<code>` opens the app | no, needs signing | **not run** -- association still inert |

#### The camera question is answered: wry raises the OS prompt

This was the item flagged as most likely to be wrong, and it is not.
`navigator.permissions.query({name:'camera'})` reports **`prompt`** on Android,
not the `denied` that WebView2 returns, so the reactive path that failed on
Windows is live here. Calling `getUserMedia` produced a real Android runtime
permission dialog, and after it was granted the call returned a live rear
camera track. `dumpsys package` confirms the OS-level grant:

```
android.permission.CAMERA: granted=true,
  flags=[ USER_SET|USER_SENSITIVE_WHEN_GRANTED|USER_SENSITIVE_WHEN_DENIED|ONE_TIME ]
```

`USER_SET` and `ONE_TIME` are the tell: a human answered a dialog, and chose a
one-time grant. So the manifest `<uses-permission>` plus wry's own bridging is
sufficient, and **neither fork contemplated for this phase is needed** -- no
Kotlin `requestPermissions` shim, no third-party permissions plugin. Note that
because `ONE_TIME` grants lapse, `permissions.query` reads `prompt` again
afterwards; that is correct Android behaviour, not a regression.

#### Two expectations this file got wrong

Recorded because the reasoning that produced them is still in the file above
and should not be trusted the next time it is reused.

**`BarcodeDetector` is present.** The prediction reasoned by analogy from
WebView2, where the Shape Detection API is missing because WebView2 does not
carry the component that provides it. The Android System WebView does carry
it. jsQR is therefore a fallback on Android rather than the only path, and
Beam's decode budget is the fast one, not the 50-100 ms jsQR case that set the
10 Hz default.

**`showSaveFilePicker` is present.** `app/src/tauri-sink.js`'s header states it
is "absent from every webview Tauri embeds", and that is now false for this
one. It changes nothing in practice -- `app/src/main.js` calls
`registerPlatform()` unconditionally, so the Tauri sink is used regardless, and
that is the right outcome given the sink is the fast path on desktop. But the
comment overstates its case and the platform seam is load-bearing for a reason
that is no longer "the API does not exist here".

#### The first real transfer found a CSP bug, not an Android bug

The phone-to-desktop transfer failed twice before it worked, and the cause was
on the **Windows** side and had nothing to do with Android: the generated CSP
did not allow `http://ipc.localhost`, so Tauri's invoke fetch was refused,
Tauri silently fell back to a JSON body, and `sink_write` rejected the first
chunk. Fixed in `buildCSP(..., { ipc: true })`; the reasoning is in that
function's comment and the commit.

It is recorded here because of *how* it presented, which is the transferable
lesson. The visible error was "the two devices lost track of each other" -- a
message about the network, produced by a CSP directive, three layers from the
cause. `receiver.js`'s `abortActive` nulls `active` on the first failure, and
every chunk still in flight then throws `Chunk arrived with no accepted file`,
each one overwriting the displayed message. The real error appeared once, four
milliseconds before a storm of thirteen. It was recovered by hooking the
element's `_fail` over CDP and reading the whole ordered sequence.

`receiver.js` already anticipated the storm -- its comment names it -- but the
fix made stray frames non-fatal without making the *first* error the one the
user sees. That reporting gap is a real finding and is not addressed here.

Throughput measured on the same debug binary, writing 32 MiB per block size:
4.0 MB/s at 16 KiB, 20.7 at 256 KiB, 24.1 at 1 MiB. The shape matches the
Phase 2 curve (small blocks starve on per-invoke cost, and it flattens after
256 KiB), and the absolute numbers are below Phase 2's 34/42 because this is an
unoptimized debug build. At 24 MB/s the sink moves a 3 MB file in about a
tenth of a second, so it is not what makes a transfer feel slow.

#### The sink is broken on Android as a receiver, and this is what blocks that direction

Confirmed rather than suspected. `save()` opens the Storage Access Framework
picker and returns a **`content://` URI**, and `sink.rs`'s `sink_open` does
`File::create(path)` on it:

```
sink_open FAILED -> No such file or directory (os error 2)
```

A receiver on Android therefore cannot write a file, which is why the LAN
transfer row above is "not run" rather than failed: there is no point running
it until this is fixed. Sending is unaffected, since the sender never opens a
sink.

The two candidate fixes are unchanged (write into the app's own documents
directory and surface the path, or resolve the content URI Rust-side through
Android's `ContentResolver`, which is what `plugin-fs` does). Choosing between
them is a real decision about where files land on a phone, and belongs behind
the existing platform seam either way.

That last row is worth stating plainly rather than discovering: until
`assetlinks.json` carries a real signing-certificate fingerprint, a scanned QR
on Android opens `share.stan-ely.com` in the browser rather than the installed
app. That is exactly the behaviour Phase 3 verified end to end and is fine --
but it means "receive by scanning into the native app" is not testable on
Android this phase. Sending, and receiving via a pasted code, are.

#### The transfer was slow for a reason that had nothing to do with the network

The first working Android send moved 3 MB in 30.2 s -- 102 KB/s, against the
9.5 MB/s Phase 2 measured over loopback. It felt like a slow link and was not.

Instrumenting the sender's inner loop at prototype level over CDP
(`Blob.prototype.arrayBuffer`, `crypto.subtle.encrypt`,
`RTCDataChannel.prototype.send`) split the 30.3 s window cleanly:

| stage | calls | total | avg | share |
| --- | --- | --- | --- | --- |
| `slice().arrayBuffer()` | 192 | **29,723 ms** | 154.81 ms | **98.2%** |
| `crypto.subtle.encrypt` | 202 | 21 ms | 0.10 ms | 0.07% |
| `RTCDataChannel.send` | 393 | 9 ms | 0.02 ms | 0.03% |

A `File` the Storage Access Framework returns is backed by a `content://`
provider, so each read is a Binder round-trip. The control that settles it: the
same page, the same 16 KiB read pattern, the same instrumentation, against an
in-memory `Blob` instead -- **0.98 ms** a read against **154.81 ms**, a factor
of 157. It is the backing store, not `Blob.slice`, not `arrayBuffer()`, and not
the probe.

The cost is dominated by the call, not the byte count. Sweeping block size on a
real picked file, reading 32 MiB per row out of 64 MB:

| block | ms per read | throughput | reads for 64 MiB | read time |
| --- | --- | --- | --- | --- |
| 256 KiB | 80.2 | 3.12 MB/s | 256 | 20.5 s |
| 1 MiB | 87.4 | 11.44 MB/s | 64 | 5.6 s |
| **2 MiB** | 97.6 | 20.49 MB/s | 32 | **3.1 s** |
| 4 MiB | 114.2 | 35.03 MB/s | 16 | 1.8 s |
| 8 MiB | 126.3 | 63.33 MB/s | 8 | 1.0 s |
| 16 MiB | 138.3 | 115.69 MB/s | 4 | 0.6 s |

That fits **~79 ms fixed + ~3.7 ms per MiB**. An earlier pass measured this
against the 3 MB file only and read the curve as perfectly flat -- which is how
it looks at that size, because the fixed term dominates until around 21 MiB. The
flat reading argues for any block size at all; the real curve does not. Measure
the sweep on a file big enough to show the slope before touching the constant.

`fromFile` now reads 2 MiB blocks and serves frames out of them. 2 MiB is where
the fixed term still dominates (81% of a 2 MiB read is overhead, so the block is
bought cheaply) while halving the read count against 1 MiB, and the payoff is
largest on SMALL transfers -- the common case here.

| | before | 3 MB | 64 MiB |
| --- | --- | --- | --- |
| transfer time | 30.2 s (3 MB) | **3.34 s** | **23.56 s** |
| throughput | 102 KB/s | 0.9 MB/s | **2.72 MB/s** |
| `arrayBuffer()` calls | 192 | 4 | **33** |
| time in reads | 29,723 ms (98%) | 1,306 ms (38%) | 5,988 ms (25%) |

The 64 MiB run would have taken about **eleven minutes** on the per-frame read.
Digest verified both times.

Three wrong turns are worth recording, because each was taken with confidence.
The first hypothesis was that unthrottled `_setState` per frame was the
bottleneck; measuring it returned 1.2 ms a render, 0.2 s of 27.9 s, and it was
abandoned. The second was that 1 MiB would take reads out of contention
entirely, on the strength of an idle sweep's 98 ms -- under concurrent load the
same read costs ~181-326 ms, so the idle benchmark understated it two- to
threefold. The third was reading a 3 MB sweep as proof the cost was purely
per-call.

The ~25% still spent reading is **not** a case for a bigger block. `sender.js`
awaits `slice()` before it seals, so the channel is idle for every read; raising
BLOCK_BYTES makes those gaps fewer and longer for double the memory each time.
Prefetching the next block while the current one transmits is what removes them,
and is the next thing worth doing here.

#### It was not a Tauri bug: the website had it too

Worth running before concluding this was about wry, and the answer changes who
was affected. The deployed site was served to the same phone over
`adb reverse` and opened in **Chrome 152**, and the same file was picked
through the same SAF dialog and swept the same way:

| block | Chrome ms/read | Chrome | wry ms/read |
| --- | --- | --- | --- |
| **16 KiB** | **71.72** | **0.22 MB/s** | ~86 |
| 256 KiB | 77.85 | 3.21 MB/s | 80.2 |
| 1 MiB | 80.68 | 12.40 MB/s | 87.4 |
| 2 MiB | 85.37 | 23.43 MB/s | 97.6 |
| 4 MiB | 86.38 | 46.31 MB/s | 114.2 |
| 8 MiB | 98.10 | 81.55 MB/s | 126.3 |
| 16 MiB | 100.90 | 158.57 MB/s | 138.3 |

Chrome fits ~72 ms fixed + ~1.8 ms per MiB against wry's ~79 + ~3.7 -- slightly
better on both terms, identical in kind. **Chrome does not copy the picked file
into its own cache**; it passes the `content://` through exactly as wry does.

So `share.stan-ely.com` had this for every Android user who ever sent a file,
at **0.22 MB/s** on the 16 KiB frame it actually used -- a 64 MiB send would
have spent about nine minutes in reads alone. Desktop browsers were unaffected
because a `File` there is backed by a real filesystem.

That is also the whole explanation for how it survived this long. The sender
was always a desktop browser, WebView2, or the Node CLI -- and the CLI uses
`src/node/source.js`, a different adapter with a file descriptor and a reused
buffer, so it could not have shown this even in principle. No test in the suite
uses a real picked file, because there is no way to; the unit tests read
in-memory `Blob`s at 0.98 ms. An Android device as *sender* was the one
configuration nobody had run, and it is the only one that could have caught it.
The fix lives in `src/web/source.js` and so ships to the site and to
`qrdrop/web`, not only to the app.

Two suspects were cleared in the process. Trystero's backpressure gate never
fired at all (`bufferedAmount` peaked at 16,620 against a 65,535 threshold, and
`waitForBufferedAmountLow` was reached zero times -- still true at 64 MiB, where
it peaked at 49,353). And the transport *was* splitting every frame into two
SCTP messages -- 393 sends for 192 frames, confirming a 66-byte overshoot of the
action wire's 16348-byte budget -- but that cost 9 ms and was fixed on its own
merits, not as a remedy for this. After the fix the ratio is 1.00 across 4,122
sends.

Everything else is now noise: at 64 MiB, AEAD is 344 ms over 4,123 seals (1.5%)
and `RTCDataChannel.send` is 97 ms over 4,122 calls (0.4%).

#### The read-ahead, and what it is not yet proven to be worth

The blocks left reads at **25% of the 64 MiB window**, and that residue is a
different problem from the one they solved. It is not that the reads are
expensive -- 33 of them is already near the floor -- it is that they are
*serialised against the sends*. `sender.js` awaits `slice()` before it seals,
so at each block boundary the data channel goes quiet for a whole Binder
round-trip and then resumes. Making the block bigger does not fix that shape;
it makes the silences fewer and longer and doubles the buffer each time.

`fromFile` now issues the next block's read as soon as the current one lands,
so the round-trip runs alongside the ~128 frames the current block still has to
transmit. Two structural changes came with it, and both are the kind that would
be quietly undone by someone tidying:

- **A frame straddling a boundary is stitched from both blocks** rather than
  refilling from its own offset. This looks like a micro-optimisation and is
  not. `CHUNK_SIZE` (16318) divides no power of two, so *every* boundary lands
  mid-frame; the previous refill-from-here behaviour therefore meant the
  prefetched window -- aligned to the block -- was never the window asked for.
  A read-ahead discarded at every boundary is not a read-ahead, and the
  straddle is what makes the whole thing work rather than a tidy extra.
- **Peak memory is two blocks, 4 MiB, not one.** That is the price, it is paid
  on the device least able to afford it, and it is the reason `BLOCK_BYTES`
  stays at 2 MiB rather than growing.

`test/web-source.test.mjs` pins it from Node: eight tests over a File-shaped
stub that counts reads and records their offsets, asserting one read per block
(not one per frame, and not one per block plus a straddle), that the read for
block N+1 is already in flight after the first frame of block N, and that a
read-ahead which *fails* is retried by the call that eventually wants those
bytes rather than rejecting into nowhere.

Measured on the device, same rig as the baseline in every respect that could
move the number: the same 64 MiB `qrdrop-large.bin`, the same phone, the same
debug APK and debug Windows receiver, both sides rebuilt from the same commit.

| | blocks only | + read-ahead |
| --- | --- | --- |
| chunk-loop window | 23.56 s | **16.80 s** |
| throughput | 2.72 MB/s | **4.03 MB/s** |
| reads | 33 | 32 |
| frames per read | ~125 | 128.6 |
| AEAD | 344 ms (1.5%) | 350 ms (2.1%) |
| `dc.send` | 97 ms (0.4%) | 100 ms (0.6%) |

**29% off the wall time, 1.48x the throughput**, digests matching both ends.
The window is the chunk loop, not the session: the manifest goes out long
before the receiver's human has accepted and chosen a destination, and this run
spent 31 s and 10 s on exactly those two waits. Both baselines were taken the
same way, so they compare.

Two things about that result are worth more than the headline, and both cut
against the obvious reading.

**Total read time went UP, and that is the mechanism working.** 7,475 ms over
32 reads (234 ms each) against 5,988 ms over 33 (181 ms each) -- a read now
runs against a busy main thread and a full send buffer instead of in the
silence it used to create for itself. Per-read wall time rising while the
transfer gets a third faster is what overlap looks like from outside. It also
means "time in reads as a share of the window" -- the 25% this section quoted
before -- is no longer a cost at all, and quoting it as one after this change
would be wrong: it is now 44.5%, on a transfer that finished sooner.

**The split underneath the total needed no new instrumentation after all, and
the answer is that reads now cost the transfer nothing.** The first pass here
said the split was unmeasurable from outside `fromFile`, because the probe
attributes any send-silence overlapping a read to that read while `drain()`
and a read are concurrent by design -- giving 5,638 ms as an upper bound that
counts backpressure as read cost. That was true of the *attribution*, and
wrong as a conclusion about the data, which already contained the answer.

`sender.js` walks the file in order, so block k is first wanted at the instant
the last frame of block k-1 goes out, and both timestamps are in the timeline:
the read intervals, and the send that precedes each boundary. Waiting time is
therefore `max(0, readEnd - needAt)` per block, and it comes out as:

| blocks | read-ahead late | time blocked on a read |
| --- | --- | --- |
| 31 boundaries | **0** | **0 ms (0.0%)** |

Every read-ahead finished before it was wanted, with 160-440 ms of margin on
every one of the 31 boundaries. The margins are an order of magnitude larger
than the estimator's own error (control frames shift `needAt` by a few frames
at ~4 ms each), so the conclusion is not delicate. The 5,638 ms "read stall"
was backpressure that happened to coincide with a read, exactly as the caveat
suspected -- and the loose bound was 5,638 ms against a true value of zero,
which is a fair warning about how far an upper bound of that shape can sit
from the answer.

**The transport is the bottleneck now.** 7,275 ms of the window is silence
with no read outstanding at all; `bufferedAmount` peaked at 58,734 against the
65,535 threshold; and the sustained rate is 4.03 MB/s against a p95 of 4.89
over 500 ms buckets. Even a read path that cost literally nothing -- which is
what it now costs -- leaves the transfer where it is.

One incidental note in the result's favour: the Windows receiver spent this
entire transfer decoding a live camera stream, because of the bug below. That
can only have cost throughput, so 16.80 s is if anything pessimistic.

**A correction to the CHUNK_SIZE story, from the same data.** The frame budget
in `src/core/frame.js` is built on "one SCTP message is 16 KiB and the action
wire spends 36 bytes of it", and the second half of that is not what the wire
does. This run sent 67,657,281 bytes over 4,122 calls: **16,413.7 bytes per
message against a 16,348-byte sealed frame, so the per-message overhead is
~66 bytes, not 36.** The emitted message is therefore ~16,414 bytes -- over
16 KiB, and accepted, because the negotiated SCTP `maxMessageSize` is far
larger than the 16 KiB the comment treats as a hard ceiling.

The fix's *goal* is untouched and confirmed: 4,122 sends for 4,113 chunks is
1.002 per frame, so a sealed frame still travels as exactly one message, which
is the whole point of the constant. What is wrong is the stated mechanism --
36 is trystero's payload-chunking constant, not its header size, and the two
were conflated. Anyone re-deriving CHUNK_SIZE from the comment would get the
right answer for a reason that does not hold.

#### The webcam stayed on, and only a human could have caught it

Found by the light on the receiving laptop, not by any check in this
repository: the Windows receiver held its camera open for the whole 64 MiB
transfer and after it, long after the scanner screen was gone.

The cause is a lifecycle gap in `src/web/qr.js`, and it is a webview-agnostic
bug in shared code rather than anything about Tauri or Android.
`scanQRStream` checks `signal.aborted` before opening the camera, then
registers its abort listener three awaits later -- after `getUserMedia`,
`video.play()` and `createDetector()`. An abort landing in that window finds
no listener, and since a signal that has already fired never fires again, the
scan promise never settles, its `finally` never runs, and the track is never
stopped.

The path in is ordinary. The hand-entered code field lives *on* the scanner
screen, and `element.js`'s `_submitManualCode` calls `_teardown()`, which
aborts that very signal -- so pairing by pasted code rather than by scanning
aborts mid-open every time. `getUserMedia` also spans the OS permission prompt
on a first run, which widens the window from milliseconds to however long the
person takes to decide.

Two lessons, both about what a test suite can see. The function's own doc
comment already promised the camera is "always" stopped "including on error
and on cancel", so the contract was stated and the code silently disagreed
with it -- prose is not a check. And nothing headless can observe a camera
that was never released: the transfer completed, the digests matched, and
every assertion in the suite passed while the hardware stayed on.
`test/qr.test.mjs` now asserts the release directly, including that the call
*settles* -- the old failure was a promise that hung forever, so a test
checking only the track would have hung with it rather than failing. Verified
against the unfixed file, where it fails.

### On-device checklist -- iOS

No Apple hardware exists on this project, so this table stays empty until
someone with a device runs it. CI proves the target links; it cannot prove any
row below.

| Check | Expectation | Result |
| --- | --- | --- |
| `isSecureContext` | pass -- `tauri://localhost` | |
| `crypto.subtle` | pass | |
| `showSaveFilePicker` | **absent** -- native sink | |
| `BarcodeDetector` | present on iOS 17+ | |
| `getUserMedia` + TCC prompt | pass -- `Info.ios.plist` carries `NSCameraUsageDescription`, staged in Phase 3 and merged natively by Tauri, so no `gen/apple` edit is needed | |
| `RTCPeerConnection` + ICE | pass -- Phase 0's macOS row found WKWebView has it, unlike WebKitGTK | |
| full LAN transfer, digests match | pass | |
| Beam send / receive at ~10 Hz | pass | |

### The verdict on mobile Beam and WebRTC, stated as expectation

The onboarding brief asks Phase 4 to decide honestly whether mobile Beam is
achievable. The honest answer today is **"expected on both platforms, proven
on neither"**, and the two platforms are expected for different reasons.

**Android is now measured, not expected, and the answer is yes on capability.**
Every primitive Beam and the WebRTC transfer need is present and working on a
real device: `RTCPeerConnection` with a host candidate, `wss://` to a relay,
WebCrypto, a live camera behind a real OS permission prompt, and a native
`BarcodeDetector` that makes decode cheaper than the jsQR budget the 10 Hz
default was sized against. Nothing here is capped by the webview.

What is *not* yet demonstrated is a completed transfer, and the reason is a
bug in this project rather than a limit of the platform: the native sink
cannot open the `content://` URI Android hands back (above). Beam send, Beam
receive and the deep-link paths are simply not run yet. So the honest status
is "capability confirmed, end-to-end unproven", and the gap is work, not a
platform decision like the Linux one.

**iOS** inherits Phase 0's macOS finding: WKWebView has WebRTC with an
immediate host candidate, and the two WebKit-family webviews are not
equivalent. With `BarcodeDetector` present on iOS 17+, Beam should decode
faster there than anywhere else.

If Android's camera cannot be made to prompt and neither fork above is worth
its cost, the fallback needs no code: `choose()` in `src/web/view.js` already
hides the network buttons when `!rtcAvailable` and refuses Beam receive when
`!cameraAvailable()`. The UI already tells the truth about a platform that
cannot do something, which is why that seam was built before it was needed.
Record which mode Android actually ships in.


## Phase 5: releasing the app

The shell worked and there was no way to get it. No release workflow, no
changelog, no version -- the crate was still `0.0.0` -- and no icon anyone had
chosen: the desktop bundle carried a placeholder that commit `85cfe27` names as
such in its own subject, and the Android launcher showed Tauri's scaffold logo.

### `app.yml`'s first real run, which is what the Phase 4 gate was waiting for

Item 5 below was "the workflow is committed but unpushed, so all three jobs are
unproven". Pushed, and two of them were wrong. Both failures are worth keeping,
because both were invisible to every local check.

**The iOS job could not have worked as written.** It drove `xcodebuild` against
the generated Xcode project, and that project's "Build Rust Code" phase shells
out to `tauri ios xcode-script`, which panics:

```
failed to read missing addr file $TMPDIR/com.stan-ely.qrdrop-server-addr
```

The tauri CLI writes that file just before *it* invokes xcodebuild. Running
xcodebuild ourselves skips the step that creates it, so the path can never
exist, and the whole thing surfaces as a bare `exit 65` with nothing in it that
points at a cause.

The first fix guessed that `debug` was what put the script into dev mode and
switched to `release`. It failed identically -- which is the useful part of the
attempt: the configuration is not the variable, and a plausible reading of that
panic was simply wrong. The supported route is `tauri ios build`, which archives
and exports and wants a development team even for the `debugging` export method,
which is exactly why the job avoided it in the first place.

So the job now runs `cargo build --lib --target aarch64-apple-ios-sim`, and the
claim it makes is smaller and true: the crate, its plugins and both mobile crate
types still compile and link for an Apple target. It does not cover the Swift
shell -- generated code nothing in this repo edits, and which the `tauri ios
init` step above it already proves regenerates. Claiming less and passing is
worth more than claiming to link the whole app and failing on every push.

**The Android job broke on a lesson already written down here.** XML forbids the
two-hyphen sequence inside a comment; the house prose style reaches for it as an
em dash constantly; and the new adaptive-icon background file carried two.
Android's resource merger reports it with a line number this time, but the
manifest merger's version of the same failure has none. Second occurrence. The
comment in that file now says so, in prose containing no such sequence.

Everything else was green first time: three desktop bundles, and the Android APK
including the camera-permission assertion.

### The app mark

`scripts/make-icon.mjs` renders a 1024px source from `tokensCSS(':root')`, and
`npx tauri icon` fans it out. Hand-run and committed, for the reason
`make-og.mjs` states: `npm run build` runs in CI and in `prepublishOnly`, and
neither may download a browser.

The mark is the three finder patterns of a QR code. The wordmark could not be
it -- it is pure CSS type with no logo file behind it, and type at the 48px an
Android launcher draws is mud. The finder patterns are the part of a code that
survives being shrunk, which is why a scanner looks for them first. It is not a
scannable code: `make-og.mjs` argues a decorative fake QR is a small lie, and
that argument is about something *claiming* to be scannable. Three eyes claim
nothing.

**One measurement rather than a taste judgement.** The mark occupies the middle
47% of the canvas. `tauri icon` emits the same image as Android's adaptive-icon
foreground, a launcher masks that to the central 72 of 108 dp -- 66.7% -- and
the largest square inside that circle is 0.667 / sqrt(2) = 47.1% of the width.
The first render used 64%, which looks correct in a file browser and puts the
top-left eye's corner outside the mask on any phone with round icons.

Two hand-edits to the committed `gen/` tree came with it, which is the second
and third use of the arrangement Phase 4 set up: the adaptive background colour,
which `tauri icon` rewrites to `#fff` on every run, and the deletion of the two
scaffold drawables the new `anydpi-v26` icon no longer references.

The site had no favicon at all -- no `<link rel="icon">` in `index.html` -- so a
tab, a bookmark and a phone home screen all showed a blank sheet for a tool
whose subject is a recognisable square. It is the same mark from the same
script, drawn at 512 rather than downsampled from 1024, because a border and two
nested radii round differently when the layout engine resolves them at the
target size than when a resampler averages them down.

### Signing, and assetlinks finally going live

A 4096-bit RSA release keystore now exists. It is not in the repository and
never will be: its base64 is a repository secret, and `app-release.yml` writes
it and a `keystore.properties` into the runner for the length of one job.
`gen/android/app/build.gradle.kts` reads that file *if it exists* and leaves the
release build unsigned if it does not, which is what keeps a keyless local
`mise run app:android:build` working -- and is also precisely how an unsigned
APK could reach a Release with nothing failing, so the workflow runs `apksigner
verify --print-certs` rather than trusting the arrangement.

It deliberately does not fall back to the debug key. A release APK signed with a
per-machine debug certificate installs, looks fine, and attests to nothing, and
its fingerprint can never go in `assetlinks.json`.

The certificate's SHA-256 is a repository **variable**, not a secret: a
fingerprint is published by design at a well-known URL on the very domain it
describes, and storing a public value as a secret teaches that the secret list
is where things go to feel safe. `build-site.mjs`'s `wellKnownFiles` has read
`ANDROID_CERT_FINGERPRINT` since Phase 3 and has been emitting an empty array --
which Android reads as "no app claims this domain" -- because no key existed.
Setting the variable turns it on with no code change, which is the seam that
function was written for.

**One thing that does not follow from that, and would have been assumed.**
`pages.yml` builds both trees, but the stable one at `/` comes from the latest
`v*` tag, and a tag cut before `wellKnownFiles` existed emits no association
files at all. Android fetches them from the domain root. So association goes
live at `/edge/` immediately and at `/` only on the next npm release -- setting
the variable is necessary and, for the stable site, not yet sufficient.

### What the release ships, and what it admits

`app-release.yml` on `app-v*`. The tag prefix is load-bearing: a workflow's
`tags:` glob is anchored at the start, so `v*` matches `v0.3.1` and does not
match `app-v0.1.0`, which is what lets the npm release and the app release share
a repository without racing. `0.1.0-app` would not have.

The version gate and the changelog check run first and cost seconds, so a tag
that disagrees with `Cargo.toml` fails while it can still be deleted rather than
after a Release page exists. `cargo-release` (`app/src-tauri/release.toml`)
produces the tag with `push = false`, so a human looks at it first.

Only the APK is signed. macOS will quarantine the `.dmg` and SmartScreen will
warn about the installer, and the Release body says so with the incantation for
each rather than letting someone meet it cold. That is not politeness: a tool
whose entire subject is authenticating the other end is the worst possible place
to train people to click through a publisher warning. Build provenance
attestations go on every file, which is a verifiable claim about origin and not
a code signature, and the notes do not offer it as one.

### Gate

**Config-lands gate (this phase):** `.github/workflows/app.yml` green on all
three jobs, `mise run typecheck` and `mise run test` clean, and
`mise run app:config` producing no unexpected `tauri.conf.json` diff.

**On-device verification is explicitly open and does not block Phase 5.** It
completes when the checklists above are filled in from a real phone, including
a full LAN transfer with matching digests and a Beam receive, and when the
`gen/android` re-init cycle (`init` over a committed tree must not silently
drop the camera permission -- CI asserts this once the tree is tracked) has
been exercised once by hand.

### Open work carried forward

Named here so it is a list rather than a set of remarks buried in the sections
above. None of it blocks the config gate.

1. **The transport, which is now the bottleneck.** Reads are settled and cost
   zero (above); the send path is not. 7,275 ms of a 16.80 s window is silence
   with nothing outstanding but the channel, `bufferedAmount` peaks at 58,734
   against a 65,535 threshold, and the sustained 4.03 MB/s sits under a 4.89
   p95. Nothing further on the read side can move this. Before treating it as
   a qrdrop problem, establish what a bare `RTCDataChannel` does between these
   two devices with no framing, sealing or sink in the path -- Phase 2's
   9.5 MB/s was loopback on one machine and is not that number.
2. **The `content://` sink**, so Android can receive at all. Two candidate
   fixes, both behind the existing platform seam; see the section above.
3. **First-error-versus-last-error reporting.** `abortActive` nulls `active` on
   the first failure and the in-flight chunks then overwrite the message the
   user sees with `Chunk arrived with no accepted file`. The real cause showed
   for four milliseconds. Not addressed.
4. **The unrun checklist rows**: Beam send, Beam receive at ~10 Hz, and the
   deep-link `qrdrop:<code>` path on Android.
5. ~~**`app.yml` has never run.**~~ **Closed.** Pushed and green on all five
   jobs (run `34038984977`): three desktop bundles, the Android APK with its
   camera-permission assertion, and iOS. It took three runs to get there and
   the two failures are written up in the Phase 5 section above -- the iOS job
   could not have worked as written, and the Android one broke on the
   two-hyphen XML rule this file had already recorded once.
6. **`app-release.yml` has never run either**, which is the same shape of gap
   one level up. It is committed, its secrets exist, and no `app-v*` tag has
   been pushed -- so the desktop bundle step, the keystore restore and the
   Release assembly are all unproven. Cutting `app-v0.1.0` is what proves them.
7. **App-link association: fixed twice, and still not live at the root.**
   Setting the fingerprint was necessary and, it turned out, nowhere near
   sufficient. Checking the served URL rather than the built tree found two
   independent faults, either of which alone would have produced the same
   symptom -- a scanned link opening the browser, with no diagnostic anywhere.

   (a) **The deploy was not serving the file.** `upload-pages-artifact` v4
   stopped including hidden files, and `.well-known/` is one. Measured live,
   from a single build: `/edge/apple-app-site-association` returned 200 and
   `/edge/.well-known/assetlinks.json` returned 404. Android reads assetlinks
   only from the dotted path and has no root fallback. The comment directly
   above that upload step had predicted this exact failure, named
   `.well-known/` as the likely cause, and named `include-hidden-files: true`
   as the fix -- and it sat there for two phases, because a prediction in a
   comment is not a check.

   (b) **The package name was wrong.** The file published
   `com.stan-ely.qrdrop`; the APK is `com.stan_ely.qrdrop`, because an Android
   package name is a Java package name and cannot contain a hyphen. The test
   covering it asserted the hyphenated value, so the suite agreed with the
   bug -- it pinned `build-site.mjs` against a constant in `build-site.mjs`.
   It now reads `applicationId` out of `build.gradle.kts` instead.

   Both fixed and verified on the live site. What remains is not a fault:
   `/` is built from the latest `v*` tag, which predates `wellKnownFiles`
   entirely, so association works from `/edge/` and reaches the domain root
   on the next npm release. Until then, do not read a failed app link on a
   device as evidence that the fingerprint or the signature is wrong.
