//! The integration tests' stand-in Nostr relay and tracker, as a process:
//! prints `{"url": "ws://127.0.0.1:<port>"}` and serves until killed.
//! e2e/tryst.e2e.mjs points a Node Trystero peer and a Rust one at it.

#[path = "../tests/standin/mod.rs"]
mod standin;

#[tokio::main]
async fn main() {
    let addr = standin::start().await;
    println!("{}", serde_json::json!({ "url": format!("ws://{addr}") }));
    std::future::pending::<()>().await;
}
