//! The qrdrop CLI, in Rust. A placeholder until phase 6.

#![forbid(unsafe_code)]

use std::process::ExitCode;

fn main() -> ExitCode {
    // Exit 1, the CLI's code for an error, so nothing that runs this by
    // accident mistakes a placeholder for a transfer that worked.
    eprintln!("qrdrop (Rust): not implemented yet; use `npx qrdrop`");
    ExitCode::FAILURE
}
