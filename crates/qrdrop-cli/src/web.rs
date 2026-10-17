//! `qrdrop web`: the built browser UI, served on 127.0.0.1, as
//! `src/node/serve.js` serves it.
//!
//! The tree is embedded at build time (build.rs) rather than read from disk,
//! because a binary has no install directory to find `site/dist/` beside the
//! way the npm package does. So "the copy you installed", which the help
//! promises, is exactly the bytes inside this executable.
//!
//! HTTP/1.1 by hand rather than through hyper: GET and HEAD of a fixed table,
//! one response per connection, to one browser on loopback. A server crate
//! would be the largest dependency in the binary for the smallest job in it.

use std::io;
use std::net::{Ipv4Addr, SocketAddr};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

include!(concat!(env!("OUT_DIR"), "/assets.rs"));

/// serve.js's `MIME`, the same extensions, the same types. A manifest served
/// as octet-stream under `nosniff` is a page that silently cannot install.
fn mime(path: &str) -> &'static str {
    let ext = path.rsplit_once('.').map_or("", |(_, e)| e);
    match ext {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "map" | "json" => "application/json; charset=utf-8",
        "webmanifest" => "application/manifest+json; charset=utf-8",
        "png" => "image/png",
        _ => "application/octet-stream",
    }
}

pub fn present() -> bool {
    ASSETS.iter().any(|(p, _)| *p == "index.html")
}

/// Bind 127.0.0.1:`port` (0 picks one) and serve forever.
pub async fn bind(port: u16) -> io::Result<(TcpListener, String)> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let listener = TcpListener::bind(addr).await.map_err(|e| {
        if e.kind() == io::ErrorKind::AddrInUse {
            // Node's own words for it, which is what the JS CLI prints.
            io::Error::new(
                e.kind(),
                format!("listen EADDRINUSE: address already in use {addr}"),
            )
        } else {
            e
        }
    })?;
    let port = listener.local_addr()?.port();
    Ok((listener, format!("http://127.0.0.1:{port}/")))
}

pub async fn serve(listener: TcpListener) {
    loop {
        if let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(answer(stream));
        }
    }
}

async fn answer(mut stream: TcpStream) {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    // The request line is all that is read; the headers only need to end.
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
        if buf.len() > 16 * 1024 {
            return;
        }
    }
    let head = String::from_utf8_lossy(&buf);
    let mut parts = head.lines().next().unwrap_or("").split(' ');
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or("/"));
    let (status, kind, body): (&str, &str, &[u8]) = match lookup(target) {
        _ if method != "GET" && method != "HEAD" => (
            "405 Method Not Allowed",
            "text/plain",
            b"Method not allowed",
        ),
        Some((path, bytes)) => ("200 OK", mime(path), bytes),
        None => ("404 Not Found", "text/plain", b"Not found"),
    };
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes()).await;
    if method != "HEAD" {
        let _ = stream.write_all(body).await;
    }
    let _ = stream.shutdown().await;
}

/// serve.js's routing: the path decoded, `/` meaning `index.html`, and
/// confined to the tree. A `..` that stays inside it resolves, as
/// `path.join` resolves it; one that would leave it is a 404.
fn lookup(target: &str) -> Option<(&'static str, &'static [u8])> {
    let path = target.split(['?', '#']).next().unwrap_or("/");
    let mut path = percent_decode(path)?;
    if path.ends_with('/') {
        path.push_str("index.html");
    }
    let mut segs: Vec<&str> = vec![];
    for s in path.split(['/', '\\']) {
        match s {
            "" | "." => {}
            ".." => {
                segs.pop()?;
            }
            s => segs.push(s),
        }
    }
    let want = segs.join("/");
    ASSETS.iter().find(|(p, _)| *p == want).copied()
}

/// `decodeURIComponent`, which throws on a malformed escape or invalid
/// UTF-8 -- serve.js answers that with a 500; a 404 says as much here.
fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `openURL`: the platform's opener, detached. False when it could not be
/// started, so the caller can say to open the URL by hand.
pub fn open(url: &str) -> bool {
    use std::process::{Command, Stdio};
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = Command::new("open");
        c.arg(url);
        c
    } else if cfg!(windows) {
        // `start` is a cmd builtin, and its first quoted argument is a
        // window title, hence the empty one.
        let mut c = Command::new("cmd");
        c.args(["/c", "start", "\"\"", url]);
        c
    } else {
        let mut c = Command::new("xdg-open");
        c.arg(url);
        c
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoding_is_decode_uri_component() {
        assert_eq!(percent_decode("/a%20b").as_deref(), Some("/a b"));
        assert_eq!(percent_decode("/%E2%80%94").as_deref(), Some("/\u{2014}"));
        assert_eq!(percent_decode("/%zz"), None);
        assert_eq!(percent_decode("/%ff"), None);
    }

    #[test]
    fn nothing_outside_the_tree_is_reachable() {
        // Whatever the build embedded, a path above the root is never in it.
        assert_eq!(lookup("/../Cargo.toml"), None);
        assert_eq!(lookup("/%2e%2e/%2e%2e/package.json"), None);
        assert_eq!(lookup("/..\\..\\package.json"), None);
    }

    #[test]
    fn types_are_serve_js_types() {
        assert_eq!(
            mime("a/manifest.webmanifest"),
            "application/manifest+json; charset=utf-8"
        );
        assert_eq!(mime("og.png"), "image/png");
        assert_eq!(mime("noext"), "application/octet-stream");
    }
}
