//! Questions on stdout, answers from stdin, as `makePrompter` over readline.
//!
//! One thread reads stdin a line at a time for the life of the process and
//! hands each line over a channel. The SAS prompt has to read stdin whether
//! or not it is a terminal -- the interop suite answers it through a pipe --
//! and a blocking read on its own thread is the one form of that which
//! neither stalls the runtime nor needs stdin to be anything in particular.
//! The thread is never joined: the process exits with it parked on a read.

use std::io::{BufRead, Write};

use tokio::sync::{Mutex, mpsc};

pub struct Prompter {
    lines: Mutex<mpsc::UnboundedReceiver<String>>,
}

impl Prompter {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            for line in stdin.lock().lines() {
                let Ok(line) = line else { break };
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        Prompter {
            lines: Mutex::new(rx),
        }
    }

    /// Print `question` and wait for a line, trimmed. End of input is an
    /// empty answer.
    pub async fn ask(&self, question: &str) -> String {
        print!("{question}");
        let _ = std::io::stdout().flush();
        let line = self.lines.lock().await.recv().await.unwrap_or_default();
        line.trim().to_owned()
    }

    /// `confirm`: only an explicit y or yes is a yes. An empty answer --
    /// just pressing enter -- is a no, because a safety confirmation that
    /// reads "I didn't type anything" as consent is not one.
    pub async fn confirm(&self, question: &str) -> bool {
        let answer = self.ask(&format!("{question} [y/N] ")).await;
        answer.eq_ignore_ascii_case("y") || answer.eq_ignore_ascii_case("yes")
    }
}
