//! `runSend`, `runReceive` and `runWeb`, over `qrdrop-session`.
//!
//! The two safety gestures are the JS's and are kept the same way:
//!
//! - **The SAS is confirmed before anything else, and `--yes` never skips
//!   it.** `establish` is the only way to a session on either side, and its
//!   question is asked whatever the flags say. The interop suite checks the
//!   prompt was shown.
//! - **Accept is the receiver's.** `--yes` answers it, and nothing else does.
//!
//! What the JS had to arrange around them with `receiver.settled()` and a
//! `sessionEnded` flag -- a leave racing the `done` in front of it -- the
//! session's one queue settles by construction, so it is absent here.

use std::fmt;
use std::future::Future;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use qrdrop_protocol::{CodeError, LanListen, NetworkPath, PEER_DISCONNECTED, Role, Secret};
use qrdrop_session::io::{FileSink, FileSource};
use qrdrop_session::path::{RELAYED_MAX_BYTES, combine};
use qrdrop_session::{
    LanConfig, Network, OpenConfig, OpenError, Paired, SessionEvent, SessionEvents, SessionHandle,
    SessionOptions, Source, Strategy, lan, open_room,
};
use tokio::sync::mpsc;

use crate::prompt::Prompter;
use crate::style::Style;
use crate::text;
use qrdrop_session::messages;

/// What every exit path prints: one line, in the JS's words where the JS
/// has words for it.
pub struct Error(String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl fmt::Debug for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Error: {}", self.0)
    }
}

impl From<String> for Error {
    fn from(s: String) -> Self {
        Error(s)
    }
}

impl From<&str> for Error {
    fn from(s: &str) -> Self {
        Error(s.to_owned())
    }
}

impl From<OpenError> for Error {
    fn from(e: OpenError) -> Self {
        Error(e.to_string())
    }
}

impl From<CodeError> for Error {
    fn from(e: CodeError) -> Self {
        Error(e.to_string())
    }
}

impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self {
        Error(e.to_string())
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct SendArgs {
    pub file: PathBuf,
    pub show_qr: bool,
    pub relays: Option<Vec<String>>,
    pub strategy: Option<String>,
    pub qr_url: Option<String>,
    pub lan: bool,
    pub debug: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ReceiveArgs {
    pub code: Option<String>,
    pub out_dir: PathBuf,
    pub assume_yes: bool,
    pub relays: Option<Vec<String>>,
    pub strategy: Option<String>,
    pub lan: bool,
    pub debug: bool,
}

/// `interruptHooks`: the session a Ctrl-C has to cancel and leave before the
/// process exits. Cancelling deletes a partial file; leaving tells the other
/// device now rather than when its connection times out -- measured in the
/// JS, a sender went on for 11 s before it noticed.
#[derive(Clone, Default)]
pub struct Hooks(Arc<Mutex<Option<SessionHandle>>>);

impl Hooks {
    fn set(&self, h: SessionHandle) {
        *self.0.lock().unwrap() = Some(h);
    }
    fn take(&self) -> Option<SessionHandle> {
        self.0.lock().unwrap().take()
    }
}

/// Run `work` until it finishes or Ctrl-C. On Ctrl-C: "Cancelled.", the
/// hooks, bounded at 2 s so a hook that hangs cannot stop the exit, and 130.
pub async fn interruptible<F, Fut>(debug: bool, work: F) -> i32
where
    F: FnOnce(Hooks) -> Fut,
    Fut: Future<Output = Result<i32, Error>>,
{
    let hooks = Hooks::default();
    let work = work(hooks.clone());
    tokio::select! {
        r = work => match r {
            Ok(code) => code,
            Err(e) => {
                crate::report(&e, debug);
                1
            }
        },
        _ = tokio::signal::ctrl_c() => {
            eprint!("\nCancelled.\n");
            let undo = async {
                if let Some(h) = hooks.take() {
                    h.cancel();
                    h.close().await;
                }
            };
            let _ = tokio::time::timeout(Duration::from_secs(2), undo).await;
            130
        }
    }
}

/// `resolveStrategies`: `--relay` pins Nostr to those URLs, `--strategy`
/// narrows to one network on its own list, and neither races both.
fn networks(
    relays: &Option<Vec<String>>,
    strategy: &Option<String>,
) -> Result<Option<Vec<Network>>, Error> {
    if let Some(relays) = relays {
        return Ok(Some(vec![Network {
            strategy: Strategy::Nostr,
            relays: relays.clone(),
        }]));
    }
    let Some(name) = strategy else {
        return Ok(None);
    };
    let picked: Vec<Network> = Network::all()
        .into_iter()
        .filter(|n| n.name() == name)
        .collect();
    if picked.is_empty() {
        let names: Vec<&str> = Network::all().iter().map(Network::name).collect();
        return Err(format!("Unknown --strategy: {name}. Options: {}", names.join(", ")).into());
    }
    Ok(Some(picked))
}

/// The session's LAN options: `--no-lan` is none at all, and
/// `QRDROP_LAN_LISTEN` overrides what this machine says about listening, for
/// testing two CLIs on one machine -- as `nodeLanPlatform` reads it.
fn session_options(use_lan: bool) -> SessionOptions {
    if !use_lan {
        return SessionOptions::default();
    }
    let listen = match std::env::var("QRDROP_LAN_LISTEN").as_deref() {
        Ok("quiet") => LanListen::Quiet,
        Ok("prompt") => LanListen::Prompt,
        Ok("none") => LanListen::None,
        _ => lan::default_listen(),
    };
    SessionOptions {
        lan: Some(LanConfig { listen }),
    }
}

/// `establish`: pair, then the SAS. The one gate that is never conditional
/// on `--yes`, because it is the whole defence against a third party in the
/// room instead of the intended peer.
async fn establish(
    secret: Secret,
    role: Role,
    relays: &Option<Vec<String>>,
    strategy: &Option<String>,
    prompter: &Prompter,
) -> Result<Paired, Error> {
    // The question goes to stdout, so its colour is stdout's.
    let style = Style::stdout();
    eprintln!("Waiting for the other device\u{2026}");
    let mut cfg = OpenConfig::new(secret, role);
    if let Some(n) = networks(relays, strategy)? {
        cfg.networks = n;
    }
    cfg.on_status = Some(Arc::new(|text: &str| eprintln!("{text}")));
    let paired = open_room(cfg).await?;
    let matched = prompter
        .confirm(&format!(
            "\nBoth devices should be showing:\n\n  {}\n\nDo they match?",
            style.bold(&paired.sas().cli_line())
        ))
        .await;
    if !matched {
        paired.reject().await;
        return Err(text::CODES_DID_NOT_MATCH.into());
    }
    Ok(paired)
}

/// `reportPath`'s announcement: the route, and the metered warning when a
/// large file is about to cross the internet. To stderr, as the JS has it:
/// the interop suite parses stdout, and this is commentary.
fn announce(path: NetworkPath, name: &str, size: u64) {
    let style = Style::stderr();
    let (label, detail) = messages::path_description(path);
    let label = match path {
        NetworkPath::Local => style.ok(label),
        NetworkPath::Direct => style.accent(label),
        NetworkPath::Relay => style.warn(label),
        NetworkPath::Unknown => style.dim(label),
    };
    eprintln!("{label} \u{2014} {detail}");
    if let Some(w) = messages::metered_warning(name, size, path) {
        eprintln!("{}", style.warn(&w));
    }
}

/// `makeProgressReporter`: one redrawn line on a terminal, sparse plain
/// lines into a pipe, at most every 200 ms but always the last.
struct Progress {
    verb: &'static str,
    tty: bool,
    last: Option<Instant>,
}

impl Progress {
    fn new(verb: &'static str) -> Self {
        use std::io::IsTerminal;
        Progress {
            verb,
            tty: io::stdout().is_terminal(),
            last: None,
        }
    }

    fn report(&mut self, moved: u64, total: u64) {
        let done = moved >= total;
        let now = Instant::now();
        if !done
            && self
                .last
                .is_some_and(|t| now - t < Duration::from_millis(200))
        {
            return;
        }
        self.last = Some(now);
        let line = format!(
            "{} {} of {}",
            self.verb,
            messages::bytes(moved),
            messages::bytes(total)
        );
        if self.tty {
            print!("\r\x1b[K{line}{}", if done { "\n" } else { "" });
            let _ = io::stdout().flush();
        } else {
            println!("{line}");
        }
    }
}

/// Node's words for a file that is not there, since that is what the JS CLI
/// prints for it; anything else in the OS's.
fn open_error(path: &Path, e: io::Error) -> Error {
    if e.kind() == io::ErrorKind::NotFound {
        format!(
            "ENOENT: no such file or directory, open '{}'",
            path.display()
        )
        .into()
    } else {
        e.into()
    }
}

fn render_qr(text: &str) -> Option<String> {
    #[cfg(feature = "qr")]
    return Some(crate::qr::render(text));
    #[cfg(not(feature = "qr"))]
    {
        let _ = text;
        None
    }
}

pub async fn send(a: SendArgs, hooks: Hooks) -> Result<i32, Error> {
    let source = FileSource::open(&a.file).map_err(|e| open_error(&a.file, e))?;
    let prompter = Prompter::new();
    let style = Style::stdout();
    let secret = Secret::generate();
    let code = secret.code();

    // --qr-url changes what the QR encodes and nothing else: the bare code is
    // printed either way, and everything that types a code in by hand, the
    // interop suite included, reads it from that line.
    let qr_text = match &a.qr_url {
        Some(base) => secret.url(base)?,
        None => code.clone(),
    };
    if a.show_qr
        && let Some(qr) = render_qr(&qr_text)
    {
        print!("\n{qr}\n\n");
    }
    if a.qr_url.is_some() {
        println!("URL: {}", style.accent(&qr_text));
    }
    println!("Transfer code: {}", style.accent(&code));

    let paired = establish(secret, Role::Host, &a.relays, &a.strategy, &prompter).await?;
    let (handle, mut events) = paired.confirm(Role::Host, session_options(a.lan)).await;
    hooks.set(handle.clone());
    let result = send_on(&handle, &mut events, source).await;
    hooks.take();
    handle.close().await;
    result
}

async fn send_on(
    handle: &SessionHandle,
    events: &mut SessionEvents,
    source: FileSource,
) -> Result<i32, Error> {
    let style = Style::stdout();
    let (name, size) = (source.name().to_owned(), source.size());

    // Free TURN is metered: refuse before the manifest goes out rather than
    // fail partway through.
    if size > RELAYED_MAX_BYTES && handle.path().await == NetworkPath::Relay {
        return Err(messages::relay_cap(&name, size).into());
    }

    // A file big enough to warn about waits for the route before it starts;
    // a small one goes now and the route is said whenever it is known.
    let mut announced = false;
    if size > messages::METERED_WARN_BYTES {
        loop {
            match events.next().await {
                Some(SessionEvent::Path { combined, .. }) => {
                    announce(combined, &name, size);
                    announced = true;
                    break;
                }
                Some(SessionEvent::Failed(m)) => return Err(m.into()),
                Some(SessionEvent::Offer(_)) => return Err(text::OFFERED_WHILE_SENDING.into()),
                Some(_) => {}
                None => return Err(PEER_DISCONNECTED.into()),
            }
        }
    }

    println!("\nSending {name} ({})\u{2026}", messages::bytes(size));
    let mut progress = Progress::new("Sent");
    handle.send_file(Box::new(source));
    loop {
        match events.next().await {
            Some(SessionEvent::Path { combined, .. }) if !announced => {
                announce(combined, &name, size);
                announced = true;
            }
            Some(SessionEvent::Lan) => println!("Using a direct connection on the local network."),
            Some(SessionEvent::SendProgress { sent, total }) => progress.report(sent, total),
            Some(SessionEvent::Sent { digest }) => {
                println!("{} digest={digest}", style.ok("Sent."));
                return Ok(0);
            }
            Some(SessionEvent::Declined) => {
                println!("{}", style.warn("The other device declined the file."));
                return Ok(1);
            }
            Some(SessionEvent::Offer(_)) => return Err(text::OFFERED_WHILE_SENDING.into()),
            Some(SessionEvent::Failed(m)) => return Err(m.into()),
            Some(_) => {}
            None => return Err(PEER_DISCONNECTED.into()),
        }
    }
}

pub async fn receive(a: ReceiveArgs, hooks: Hooks) -> Result<i32, Error> {
    let prompter = Arc::new(Prompter::new());
    let raw = match a.code {
        Some(c) => c,
        None => prompter.ask("Code (or paste a shared link): ").await,
    };
    let secret = Secret::decode(&raw)?;
    // Said before the wait rather than after the file has landed, so where
    // it goes is a question answerable in advance.
    let out_dir = std::path::absolute(&a.out_dir)?;

    let paired = establish(secret, Role::Guest, &a.relays, &a.strategy, &prompter).await?;
    let (handle, mut events) = paired.confirm(Role::Guest, session_options(a.lan)).await;
    hooks.set(handle.clone());
    println!("\nSaving into {}", out_dir.display());
    println!("Waiting for the sender to offer a file\u{2026}");
    let result = receive_on(&handle, &mut events, prompter, out_dir, a.assume_yes).await;
    hooks.take();
    handle.close().await;
    result
}

/// What the person did with an offer.
enum Decision {
    Accepted,
    Declined,
}

async fn receive_on(
    handle: &SessionHandle,
    events: &mut SessionEvents,
    prompter: Arc<Prompter>,
    out_dir: PathBuf,
    assume_yes: bool,
) -> Result<i32, Error> {
    let style = Style::stdout();
    let mut theirs = NetworkPath::Unknown;
    let mut progress = Progress::new("Received");
    // The offer is answered on a task of its own, so the session's events
    // -- the sender leaving while the question is up -- are still read.
    let (decided_tx, mut decided) = mpsc::unbounded_channel();
    loop {
        tokio::select! {
            e = events.next() => match e {
                Some(SessionEvent::Path { theirs: t, .. }) => theirs = t,
                Some(SessionEvent::Offer(m)) => {
                    let (handle, prompter, out_dir, tx) =
                        (handle.clone(), prompter.clone(), out_dir.clone(), decided_tx.clone());
                    tokio::spawn(async move {
                        let r = decide(&handle, &prompter, m.name, m.size, theirs, &out_dir, assume_yes).await;
                        let _ = tx.send(r);
                    });
                }
                Some(SessionEvent::ReceiveProgress { received, total }) => progress.report(received, total),
                Some(SessionEvent::Received { digest, location, .. }) => {
                    let name = Path::new(&location)
                        .file_name()
                        .map_or_else(|| location.clone(), |n| n.to_string_lossy().into_owned());
                    println!(
                        "{} Saved to {location}\ndigest={digest}",
                        style.ok(&format!("Received {name}."))
                    );
                    return Ok(0);
                }
                Some(SessionEvent::Failed(m)) => return Err(m.into()),
                Some(_) => {}
                None => return Err(PEER_DISCONNECTED.into()),
            },
            Some(r) = decided.recv() => match r? {
                Decision::Accepted => {}
                Decision::Declined => {
                    println!("{}", style.warn("Declined."));
                    return Ok(0);
                }
            },
        }
    }
}

/// The relay cap, the route, then the person's Accept -- or `--yes`'s.
async fn decide(
    handle: &SessionHandle,
    prompter: &Prompter,
    name: String,
    size: u64,
    theirs: NetworkPath,
    out_dir: &Path,
    assume_yes: bool,
) -> Result<Decision, Error> {
    let style = Style::stdout();
    let describe = format!("{name} ({})", messages::bytes(size));
    let mine = handle.path().await;
    if size > RELAYED_MAX_BYTES && mine == NetworkPath::Relay {
        let refusal = messages::relay_cap_decline(&name, size);
        println!("\n{}", style.warn(&format!("Refused: {refusal}")));
        handle.decline();
        return Ok(Decision::Declined);
    }
    announce(combine(mine, theirs), &name, size);
    let ok = assume_yes
        || prompter
            .confirm(&format!("\nIncoming: {describe}. Accept?"))
            .await;
    if !ok {
        handle.decline();
        return Ok(Decision::Declined);
    }
    println!("Receiving {describe}\u{2026}");
    // Opened before Accept goes out, so a folder that cannot be written is
    // an error said here and not a transfer that dies at its first chunk.
    // `(2)` for a second copy, as the Node CLI's sink names it.
    let sink = FileSink::create_numbered(out_dir, &name, 2)?;
    handle.accept(Box::new(sink));
    Ok(Decision::Accepted)
}

/// `runWeb`.
pub async fn web(port: u16, open: bool) -> Result<i32, Error> {
    if !crate::web::present() {
        return Err(text::NO_WEB_UI.into());
    }
    let (listener, url) = crate::web::bind(port).await?;
    let style = Style::stdout();
    print!("\nqrdrop web UI: {}\n", style.accent(&url));
    println!("Localhost only -- nothing is uploaded, and no other device can reach it.");
    println!("Press Ctrl-C to stop.");
    if open && !crate::web::open(&url) {
        println!("Could not open a browser automatically; open the URL above yourself.");
    }
    tokio::select! {
        _ = crate::web::serve(listener) => {}
        _ = tokio::signal::ctrl_c() => print!("\nStopping.\n"),
    }
    Ok(0)
}
