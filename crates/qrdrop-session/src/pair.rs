//! Pairing: `openRoom` and `joinVia` in `src/transport/room.js`, on tryst.
//!
//! Every network is joined at once, and the pairing is made on whichever
//! completes the key exchange first; the others leave. Both devices are on
//! every network at the same time, so they meet on the fastest one they
//! share, with no agreement needed on which.
//!
//! Over the winning room, each side sends its public key on the `ecdh`
//! action to every peer that joins, and pairs with the first peer whose key
//! arrives. A third party holding the code could join too; the SAS is what
//! surfaces a wrong partner, and the person is the one who reads it.

use std::fmt;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use qrdrop_protocol::{Keypair, Pairing, Role, Sas, Secret};
use tokio::sync::{oneshot, watch};
use tokio::task::JoinSet;
use tryst::join::{JoinConfig, RoomEvent, RoomHandle, TurnServer, join};
use tryst::signal::Strategy;
use tryst::wire::Payload;

use crate::networks::{Network, STUN_SERVERS};

/// The app ID every qrdrop room is joined under.
pub const APP_ID: &str = "qrdrop";

/// How long [`open_room`] waits for the other device, as room.js's
/// `DEFAULT_TIMEOUT_MS`.
pub const PAIR_TIMEOUT: Duration = Duration::from_secs(60);

/// Frames from the paired peer held while this side has not yet confirmed
/// its SAS: room.js's `EARLY_FRAME_LIMIT`. The peer does not wait for us --
/// it starts sending the moment its own person confirms, and the first thing
/// it sends is a path verdict at control index 0, so dropping these made the
/// next control frame fatal (`Out-of-order frame: expected 0, got 1`, live
/// between two CLIs). A legitimate peer sends two at most before it hears
/// back; this is headroom, and the bound on what a peer can make a waiting
/// room hold.
pub const EARLY_FRAME_LIMIT: usize = 16;

/// The action a peer's public key travels on.
pub const KEY_ACTION: &str = "ecdh";
/// The action every sealed frame travels on.
pub const FRAME_ACTION: &str = "frame";

/// A sink for the status lines [`open_room`] reports.
pub type StatusFn = Arc<dyn Fn(&str) + Send + Sync>;

pub struct OpenConfig {
    pub secret: Secret,
    pub role: Role,
    pub networks: Vec<Network>,
    /// STUN servers as `host:port`.
    pub stun: Vec<String>,
    pub turn: Vec<TurnServer>,
    /// The address to bind each room's UDP socket to; `None` picks the
    /// default route's interface.
    pub bind: Option<IpAddr>,
    pub timeout: Duration,
    /// Progress for the person, in room.js's words: "Waiting for the other
    /// device (nostr, torrent)…", "Found the other device via nostr, agreeing
    /// keys…", "Paired over nostr".
    pub on_status: Option<StatusFn>,
}

impl OpenConfig {
    /// Every network, qrdrop's STUN servers, a minute to pair.
    pub fn new(secret: Secret, role: Role) -> Self {
        OpenConfig {
            secret,
            role,
            networks: Network::all(),
            stun: STUN_SERVERS.iter().map(|s| s.to_string()).collect(),
            turn: crate::networks::turn_servers(),
            bind: None,
            timeout: PAIR_TIMEOUT,
            on_status: None,
        }
    }

    fn status(&self, text: &str) {
        if let Some(f) = &self.on_status {
            f(text);
        }
    }
}

impl fmt::Debug for OpenConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OpenConfig")
            .field("role", &self.role)
            .field("networks", &self.networks)
            .field("timeout", &self.timeout)
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
pub enum OpenError {
    /// Nobody arrived in time on any network.
    Timeout,
    /// Every network failed, each for the reason given.
    NoNetwork(Vec<(Strategy, String)>),
}

impl fmt::Display for OpenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            // room.js's sentences, which the CLI prints as they are.
            OpenError::Timeout => f.write_str("Timed out waiting for the other device"),
            OpenError::NoNetwork(_) => f.write_str("Could not pair on any signalling network"),
        }
    }
}

impl std::error::Error for OpenError {}

/// A pairing whose SAS the person has not yet confirmed. Nothing is sent to
/// the peer from here but the key exchange that made it; the session, and
/// every frame it sends, starts at [`Paired::confirm`].
pub struct Paired {
    pub(crate) pairing: Pairing,
    pub(crate) strategy: Strategy,
    pub(crate) peer: String,
    pub(crate) hold: Hold,
}

impl fmt::Debug for Paired {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Paired")
            .field("strategy", &self.strategy)
            .field("peer", &self.peer)
            .finish_non_exhaustive()
    }
}

impl Paired {
    /// What both screens must show alike.
    pub fn sas(&self) -> &Sas {
        self.pairing.sas()
    }

    /// Which network won the race.
    pub fn strategy(&self) -> Strategy {
        self.strategy
    }

    pub fn peer_id(&self) -> &str {
        &self.peer
    }

    /// The codes did not match, or the person walked away. Leaves the room
    /// and waits for the leave to go out, bounded as every exit is.
    ///
    /// There is no way back to a pairing from here on the same secret, and
    /// there must not be one: four symbols are 24 bits only if an attacker
    /// gets a single roll at them.
    pub async fn reject(self) {
        let (room, ..) = self.hold.release().await;
        crate::session::leave_bounded(room).await;
    }
}

/// What the paired peer sent while the SAS was on screen.
pub(crate) struct Early {
    pub frames: Vec<Vec<u8>>,
    pub left: bool,
}

/// The room, read by a task until the person confirms, so the room's event
/// queue cannot grow without bound while a prompt waits: the paired peer's
/// frames are kept up to [`EARLY_FRAME_LIMIT`], a stranger's are dropped,
/// and a leave is remembered.
pub(crate) struct Hold {
    stop: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<(RoomHandle, Early)>,
}

impl Hold {
    fn start(mut room: RoomHandle, peer: String) -> Hold {
        let (stop, mut stopped) = oneshot::channel();
        let task = tokio::spawn(async move {
            let mut early = Early {
                frames: vec![],
                left: false,
            };
            loop {
                tokio::select! {
                    biased;
                    _ = &mut stopped => break,
                    e = room.next_event() => match e {
                        None => {
                            early.left = true;
                            break;
                        }
                        Some(RoomEvent::Left(p)) if p == peer => early.left = true,
                        Some(RoomEvent::Message { peer: p, message }) if p == peer && message.action == FRAME_ACTION => {
                            if let Payload::Binary(b) = message.payload
                                && early.frames.len() < EARLY_FRAME_LIMIT
                            {
                                early.frames.push(b);
                            }
                        }
                        Some(_) => {}
                    },
                }
            }
            (room, early)
        });
        Hold {
            stop: Some(stop),
            task,
        }
    }

    /// Stop reading and hand back the room and what was held, in order.
    pub(crate) async fn release(mut self) -> (RoomHandle, Early) {
        if let Some(s) = self.stop.take() {
            let _ = s.send(());
        }
        self.task.await.expect("the hold task does not panic")
    }
}

struct Won {
    network: Strategy,
    room: RoomHandle,
    peer: String,
    pairing: Pairing,
}

/// Join every network in `cfg`, pair on the first to complete the key
/// exchange, and leave the rest.
pub async fn open_room(cfg: OpenConfig) -> Result<Paired, OpenError> {
    let topic = cfg.secret.topic();
    let password = cfg.secret.password();
    let names: Vec<&str> = cfg.networks.iter().map(Network::name).collect();
    cfg.status(&format!(
        "Waiting for the other device ({})…",
        names.join(", ")
    ));

    // `true` once a winner is chosen or the wait is over: every attempt still
    // running leaves its room and returns.
    let (cancel, cancelled) = watch::channel(false);
    let mut attempts = JoinSet::new();
    for net in &cfg.networks {
        let mut jc = JoinConfig::new(net.strategy, APP_ID, &topic, &password, &[]);
        jc.relays = net.relays.clone();
        jc.stun = cfg.stun.clone();
        jc.turn = cfg.turn.clone();
        jc.bind = cfg.bind;
        let ctx = Attempt {
            name: net.name(),
            strategy: net.strategy,
            join: jc,
            secret: Secret::from_bytes(*cfg.secret.as_bytes()),
            role: cfg.role,
            cancelled: cancelled.clone(),
            on_status: cfg.on_status.clone(),
        };
        attempts.spawn(ctx.run());
    }

    let deadline = tokio::time::sleep(cfg.timeout);
    tokio::pin!(deadline);
    let mut failures = vec![];
    let won = loop {
        tokio::select! {
            _ = &mut deadline => break None,
            r = attempts.join_next() => match r {
                None => break None,
                Some(Ok(Ok(w))) => break Some(w),
                Some(Ok(Err(f))) => failures.push(f),
                Some(Err(e)) => std::panic::resume_unwind(e.into_panic()),
            },
        }
    };
    let _ = cancel.send(true);
    // The rest leave in the background. One that won in the same instant as
    // the winner is left here too, rather than being forgotten open.
    tokio::spawn(async move {
        while let Some(r) = attempts.join_next().await {
            if let Ok(Ok(w)) = r {
                w.room.leave().await;
            }
        }
    });
    let Some(w) = won else {
        return Err(if failures.len() == cfg.networks.len() {
            OpenError::NoNetwork(failures)
        } else {
            OpenError::Timeout
        });
    };
    cfg.status(&format!("Paired over {}", strategy_name(w.network)));
    Ok(Paired {
        pairing: w.pairing,
        strategy: w.network,
        hold: Hold::start(w.room, w.peer.clone()),
        peer: w.peer,
    })
}

/// Resolves once `cancelled` reads true. A helper rather than `wait_for`
/// inline, whose guard is not `Send` and would be held across the select.
async fn until(cancelled: &mut watch::Receiver<bool>) {
    let _ = cancelled.wait_for(|c| *c).await;
}

fn strategy_name(s: Strategy) -> &'static str {
    match s {
        Strategy::Nostr => "nostr",
        Strategy::Torrent => "torrent",
    }
}

struct Attempt {
    name: &'static str,
    strategy: Strategy,
    join: JoinConfig,
    secret: Secret,
    role: Role,
    cancelled: watch::Receiver<bool>,
    on_status: Option<StatusFn>,
}

impl Attempt {
    async fn run(mut self) -> Result<Won, (Strategy, String)> {
        // Generated before joining, so no peer can arrive in a gap between
        // the join and having a key to answer it with; and generated per
        // attempt, which is the forward-secrecy boundary. Racing two networks
        // costs two keypairs and uses one. Sharing one across them looks like
        // a free saving, and is every session this process runs sharing one
        // ECDH secret -- a code photographed off a screen would then open
        // transfers made before it leaked. `Keypair` is consumed by
        // `establish`, so a second use does not compile.
        let keypair = Keypair::generate();
        let public = keypair.public_key_b64url();
        let mut keypair = Some(keypair);

        let mut room = tokio::select! {
            r = join(self.join.clone()) => r.map_err(|e| (self.strategy, e.to_string()))?,
            _ = until(&mut self.cancelled) => return Err((self.strategy, "superseded".into())),
        };
        let fail = |room: RoomHandle, why: String| async move {
            room.leave().await;
            Err((self.strategy, why))
        };
        loop {
            let e = tokio::select! {
                e = room.next_event() => e,
                _ = until(&mut self.cancelled) => return fail(room, "superseded".into()).await,
            };
            match e {
                None => return Err((self.strategy, "the room closed".into())),
                Some(RoomEvent::Joined(peer)) => {
                    if let Some(f) = &self.on_status {
                        f(&format!(
                            "Found the other device via {}, agreeing keys…",
                            self.name
                        ));
                    }
                    // Both sides send on join, so both send and both receive.
                    let _ = room
                        .send(KEY_ACTION, Payload::Text(public.clone()), None, Some(&peer))
                        .await;
                }
                Some(RoomEvent::Message { peer, message }) if message.action == KEY_ACTION => {
                    let Some(kp) = keypair.take() else { continue };
                    // A string only by the peer's convention; checked, as
                    // room.js checks it, rather than assumed.
                    let Payload::Text(theirs) = message.payload else {
                        return fail(room, "the other device sent a malformed public key".into())
                            .await;
                    };
                    return match kp.establish_b64url(&theirs, &self.secret, self.role) {
                        Ok(pairing) => Ok(Won {
                            network: self.strategy,
                            room,
                            peer,
                            pairing,
                        }),
                        Err(e) => fail(room, e.to_string()).await,
                    };
                }
                Some(_) => {}
            }
        }
    }
}
