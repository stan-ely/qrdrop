mod sink;

use tauri::Manager;

/// The app shell. `run()` is the mobile entry point too -- Android and iOS
/// load this crate as a library rather than exec'ing a binary, so this
/// function (not main.rs) is where anything shared across all five targets
/// belongs.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Windows and Linux hand a deep link to the app by launching a second
    // process with the URL in argv. single-instance (its `deep-link` feature
    // links it to tauri-plugin-deep-link) forwards that argv to the already
    // running instance and drops the duplicate; without it a scanned
    // `qrdrop:` link would spawn a second window instead of acting on the
    // first. macOS and mobile deliver the URL to the live process directly,
    // so this plugin is desktop-Windows/Linux only (see Cargo.toml's cfg).
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }));
    }

    builder
        // plugin-dialog's save() picks the destination for the native sink
        // (app/src/tauri-sink.js). The bytes go through this crate's own
        // sink_* commands instead of plugin-fs -- see src/sink.rs for the
        // measured reason. plugin-fs is still registered because the
        // throwaway app/bench/ harness uses it; the sink itself no longer
        // touches it.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // The `qrdrop` custom scheme and the share.stan-ely.com app-link
        // domain (both declared in tauri.conf.json's plugins.deep-link). The
        // JS side subscribes via @tauri-apps/plugin-deep-link in
        // app/src/main.js.
        .plugin(tauri_plugin_deep_link::init())
        .manage(sink::SinkState::default())
        .invoke_handler(tauri::generate_handler![
            sink::sink_open,
            sink::sink_write,
            sink::sink_close,
            sink::sink_abort,
        ])
        .setup(|app| {
            // Desktop dev has no installer to have registered the `qrdrop`
            // scheme, so do it at runtime. Harmless when an installed build
            // already registered it (it rewrites the same HKCU / .desktop
            // entry); a no-op on macOS, where schemes come from Info.plist.
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
            }

            // WebView2 refuses getUserMedia outright, with no OS prompt, until
            // the host grants camera to our origin (app/CAPABILITIES.md, Windows
            // section). The QR scanner and Beam both need it, and the user has
            // already chosen Receive / Scan by the time it matters, so grant it
            // up front and let the OS camera-privacy setting be the real gate.
            // macOS/iOS route through Info.plist instead; Linux/WebKitGTK has no
            // exposed hook yet (and no WebRTC either -- see CAPABILITIES.md).
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                windows_camera::allow(&window);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running qrdrop");
}

/// WebView2's camera / microphone permission gate. Isolated in its own module
/// so the COM-heavy imports do not leak into `run()` and so a non-Windows
/// build never names any of it.
#[cfg(target_os = "windows")]
mod windows_camera {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Profile4, ICoreWebView2_13, ICoreWebView2PermissionRequestedEventArgs,
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_CAMERA,
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::{PermissionRequestedEventHandler, SetPermissionStateCompletedHandler};
    use windows::core::{Interface, HSTRING};

    /// The web content's origin inside the WebView2 window. Tauri serves the
    /// bundle from the `http://tauri.localhost` custom-scheme origin on Windows
    /// -- macOS and Linux differ, but this module is Windows-only. If a future
    /// `tauri.conf.json` opts into the https scheme this string has to change
    /// with it.
    const ORIGIN: &str = "http://tauri.localhost";

    /// Grants camera + microphone to our origin in the window's WebView2.
    ///
    /// The obvious approach -- a `PermissionRequested` handler that answers
    /// ALLOW -- does **not** work here: WebView2's default content setting for
    /// camera on this origin is "deny", and a denied default is resolved
    /// *without* raising `PermissionRequested` at all (only the "ask" state
    /// routes through the event). Verified from the field: with a correctly
    /// installed handler the event never fired and `getUserMedia` still threw
    /// `NotAllowedError`. `ICoreWebView2Profile4::SetPermissionState` writes the
    /// content setting directly, which is what actually unblocks the call.
    ///
    /// The reactive handler is still installed as a forward-compatible
    /// fallback: if a later runtime moves the default to "ask", the event will
    /// start firing and we answer it rather than regressing to a silent deny.
    ///
    /// Best effort throughout -- every failure degrades to "the scanner does
    /// not work on Windows", logged, never fatal.
    pub fn allow(window: &tauri::WebviewWindow) {
        let reached = window.with_webview(|webview| unsafe {
            let Ok(core) = webview.controller().CoreWebView2() else {
                eprintln!("qrdrop: no CoreWebView2 to grant camera permission on");
                return;
            };

            // Proactive grant. Needs ICoreWebView2Profile4 (WebView2 Runtime
            // >= 1.0.2210, mid-2023); an older runtime falls through to the
            // reactive handler below.
            match core
                .cast::<ICoreWebView2_13>()
                .and_then(|w| w.Profile())
                .and_then(|p| p.cast::<ICoreWebView2Profile4>())
            {
                Ok(profile) => {
                    let origin = HSTRING::from(ORIGIN);
                    for kind in [
                        COREWEBVIEW2_PERMISSION_KIND_CAMERA,
                        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
                    ] {
                        let done = SetPermissionStateCompletedHandler::create(Box::new(
                            |hr: windows::core::Result<()>| {
                                if let Err(e) = hr {
                                    eprintln!("qrdrop: SetPermissionState reported {e}");
                                }
                                Ok(())
                            },
                        ));
                        if let Err(e) = profile.SetPermissionState(
                            kind,
                            &origin,
                            COREWEBVIEW2_PERMISSION_STATE_ALLOW,
                            &done,
                        ) {
                            eprintln!("qrdrop: SetPermissionState call failed: {e}");
                        }
                    }
                }
                Err(e) => eprintln!("qrdrop: no ICoreWebView2Profile4 for camera permission: {e}"),
            }

            let mut token = Default::default();
            let handler = PermissionRequestedEventHandler::create(Box::new(
                |_sender, args: Option<ICoreWebView2PermissionRequestedEventArgs>| {
                    let Some(args) = args else { return Ok(()) };
                    let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                    args.PermissionKind(&mut kind)?;
                    if kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA
                        || kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
                    {
                        args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                    }
                    Ok(())
                },
            ));
            if let Err(e) = core.add_PermissionRequested(&handler, &mut token) {
                eprintln!("qrdrop: add_PermissionRequested failed: {e}");
            }
        });
        if let Err(e) = reached {
            eprintln!("qrdrop: could not reach the platform webview for camera permission: {e}");
        }
    }
}
