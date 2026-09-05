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

**Not run.** No Android SDK/NDK is installed on this machine yet, and
acquiring one is a multi-gigabyte download plus emulator or device setup --
deliberately not done without confirming first, even though `mise.toml` will
pin the toolchain per the onboarding brief once Phase 4 starts. This section
gets filled in as part of that phase, run against either a physical device
over `adb` or a local AVD emulator, whichever is available at the time.

## iOS

**Not run in Phase 0.** Per the onboarding brief this is a CI-only,
build-only target from Phase 4 onward (`macos-latest`, unsigned, ships
nothing) -- there is no local iOS capability check to run from a Windows
machine at any phase.

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
registers `app/src/tauri-sink.js`: `@tauri-apps/plugin-dialog`'s `save()` for
the destination, `@tauri-apps/plugin-fs`'s `create()`/`write()`/`close()` to
stream bytes there. Deliberately not a hand-rolled `invoke('save_chunk', {
data: [...] })` command -- plugin-fs's `write()` crosses the JS<->Rust
boundary as raw bytes, not a JSON-stringified array of numbers, which is the
difference between this scaling to a large file and not.

Verified so far: `cargo check` compiles clean with `tauri-plugin-dialog` and
`tauri-plugin-fs` added, and a real `npx tauri dev` build launches the actual
window with the new entry point wired in -- confirmed by screenshot, both
that the UI renders (Windows still shows Send/Receive, matching Phase 0's
`RTCPeerConnection` pass on WebView2) and that Linux's now-conditional choose
screen logic (`view.js`, gated on `rtcAvailable`) does not accidentally fire
on a platform that has WebRTC. **Not yet verified**: an actual end-to-end
transfer through the native sink (save dialog appearing, bytes landing
correctly on disk, a large-file throughput measurement) -- that needs a real
two-peer transfer, not a single-window smoke test, and is the next thing to
run before calling Phase 2 done rather than "wired up."
