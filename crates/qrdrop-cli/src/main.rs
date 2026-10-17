//! The qrdrop CLI, in Rust: `src/cli.js`'s commands, flags, exit codes and
//! stdout, over `qrdrop-session` instead of the JS core.
//!
//! Its contract is the Node CLI's, recorded under "The CLI's contract" in
//! docs/notes/rust-session.md, and e2e/interop.e2e.mjs runs the two against
//! each other in both directions. Where a sentence comes from the JS it lives
//! in `text`, whose tests read the JS source and fail on any difference.
//!
//! Exit codes: 0 on success and on a declined receive; 1 on an error and on a
//! declined send; 2 on a usage error; 130 on Ctrl-C, once the session has
//! been cancelled and the room left, bounded at 2 s.

#![forbid(unsafe_code)]

mod prompt;
#[cfg(feature = "qr")]
mod qr;
mod run;
mod style;
mod text;
mod web;

use std::io::Write;
use std::process::ExitCode;

use style::Style;

/// What the command line asked for.
#[derive(Debug, PartialEq, Eq)]
enum Command {
    Help,
    Version,
    Send(run::SendArgs),
    Receive(run::ReceiveArgs),
    Web { port: u16, open: bool, debug: bool },
}

/// A usage error: printed to stderr as it is, exit 2.
#[derive(Debug, PartialEq, Eq)]
struct Usage(String);

/// The options `parseArgs` is given in cli.js, and what each takes.
const STRINGS: &[&str] = &["out", "port", "relay", "strategy", "qr-url"];
const BOOLEANS: &[&str] = &["no-qr", "yes", "no-open", "no-lan", "debug", "help"];

#[derive(Default)]
struct Values {
    strings: Vec<(String, String)>,
    flags: Vec<String>,
    positionals: Vec<String>,
}

impl Values {
    fn flag(&self, name: &str) -> bool {
        self.flags.iter().any(|f| f == name)
    }
    /// The last value given, as parseArgs keeps for a single-valued option.
    fn string(&self, name: &str) -> Option<&str> {
        self.strings
            .iter()
            .rev()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
    fn all(&self, name: &str) -> Vec<String> {
        self.strings
            .iter()
            .filter(|(k, _)| k == name)
            .map(|(_, v)| v.clone())
            .collect()
    }
}

/// `parseArgs` with cli.js's option table: `--name value` and `--name=value`
/// for strings, bare booleans, positionals anywhere, `--` ending options.
///
/// One deliberate difference: an unknown option is a usage error, exit 2.
/// parseArgs throws a TypeError there that cli.js does not catch, so the
/// Node CLI exits 1 with a stack trace -- an accident, not a contract.
fn values(args: &[String]) -> Result<Values, Usage> {
    let mut v = Values::default();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--" {
            v.positionals.extend(it.by_ref().cloned());
            break;
        }
        let Some(opt) = a.strip_prefix("--") else {
            if a.len() > 1 && a.starts_with('-') {
                return Err(Usage(format!("Unknown option '{a}'")));
            }
            v.positionals.push(a.clone());
            continue;
        };
        let (name, inline) = match opt.split_once('=') {
            Some((n, val)) => (n, Some(val.to_owned())),
            None => (opt, None),
        };
        if STRINGS.contains(&name) {
            let value = match inline {
                Some(val) => val,
                None => it
                    .next()
                    .cloned()
                    .ok_or_else(|| Usage(format!("Option '--{name} <value>' argument missing")))?,
            };
            v.strings.push((name.to_owned(), value));
        } else if BOOLEANS.contains(&name) {
            if inline.is_some() {
                return Err(Usage(format!(
                    "Option '--{name}' does not take an argument"
                )));
            }
            v.flags.push(name.to_owned());
        } else {
            return Err(Usage(format!("Unknown option '--{name}'")));
        }
    }
    Ok(v)
}

/// `parseCliArgs`. `stdout_tty` is whether to draw the QR code: never into
/// a pipe, whatever the flags say.
fn parse(argv: &[String], stdout_tty: bool) -> Result<Command, Usage> {
    let usage = text::usage();
    let Some((command, rest)) = argv.split_first() else {
        return Ok(Command::Help);
    };
    match command.as_str() {
        "--help" | "-h" => return Ok(Command::Help),
        "--version" => return Ok(Command::Version),
        // A tailored miss: someone typing this has read about beaming.
        "beam" => return Err(Usage(text::BEAM_REFUSED.into())),
        "send" | "receive" | "web" => {}
        other => return Err(Usage(format!("Unknown command: {other}\n\n{usage}"))),
    }
    let v = values(rest)?;
    if v.flag("help") {
        return Ok(Command::Help);
    }
    let debug = v.flag("debug");
    let relays = v.all("relay");
    let relays = (!relays.is_empty()).then_some(relays);
    let strategy = v.string("strategy").map(str::to_owned);
    match command.as_str() {
        "web" => {
            // Number() in the JS, not parseInt(): a port that half-parses
            // ("4173x") is rejected, not truncated.
            let port = match v.string("port") {
                None => 4173,
                Some(p) => p.trim().parse::<u16>().map_err(|_| {
                    Usage(format!(
                        "--port must be a whole number from 0 to 65535, got: {p}\n\n{usage}"
                    ))
                })?,
            };
            Ok(Command::Web {
                port,
                open: !v.flag("no-open"),
                debug,
            })
        }
        "send" => {
            let Some(file) = v.positionals.first() else {
                return Err(Usage(format!("send requires a file path\n\n{usage}")));
            };
            Ok(Command::Send(run::SendArgs {
                file: file.into(),
                show_qr: !v.flag("no-qr") && stdout_tty,
                relays,
                strategy,
                qr_url: v.string("qr-url").map(str::to_owned),
                lan: !v.flag("no-lan"),
                debug,
            }))
        }
        _ => Ok(Command::Receive(run::ReceiveArgs {
            code: v.positionals.first().cloned(),
            out_dir: v.string("out").unwrap_or(".").into(),
            assume_yes: v.flag("yes"),
            relays,
            strategy,
            lan: !v.flag("no-lan"),
            debug,
        })),
    }
}

/// `reportError`: one line on stderr, or everything under `--debug`.
fn report(error: &run::Error, debug: bool) {
    if debug {
        eprintln!("{error:?}");
    } else {
        eprintln!("{} {error}", Style::stderr().bad("Error:"));
    }
}

fn main() -> ExitCode {
    use std::io::IsTerminal;
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let command = match parse(&argv, std::io::stdout().is_terminal()) {
        Ok(c) => c,
        Err(Usage(message)) => {
            eprintln!("{message}");
            return ExitCode::from(2);
        }
    };
    let code = match command {
        Command::Help => {
            print!("{}", text::usage());
            0
        }
        Command::Version => {
            println!("{}", env!("QRDROP_VERSION"));
            0
        }
        command => {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("a tokio runtime");
            runtime.block_on(async move {
                match command {
                    Command::Web { port, open, debug } => match run::web(port, open).await {
                        Ok(code) => code,
                        Err(e) => {
                            report(&e, debug);
                            1
                        }
                    },
                    Command::Send(args) => {
                        let debug = args.debug;
                        run::interruptible(debug, |hooks| run::send(args, hooks)).await
                    }
                    Command::Receive(args) => {
                        let debug = args.debug;
                        run::interruptible(debug, |hooks| run::receive(args, hooks)).await
                    }
                    _ => unreachable!(),
                }
            })
        }
    };
    let _ = std::io::stdout().flush();
    // An explicit exit, as cli.js makes one: the room's tasks, the stdin
    // reader and any relay socket still closing must not keep the process.
    std::process::exit(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(s: &str) -> Vec<String> {
        s.split_whitespace().map(str::to_owned).collect()
    }

    #[test]
    fn the_commands_parse_as_cli_js_parses_them() {
        assert_eq!(parse(&[], true), Ok(Command::Help));
        assert_eq!(parse(&args("-h"), true), Ok(Command::Help));
        assert_eq!(parse(&args("send x --help"), true), Ok(Command::Help));
        assert_eq!(parse(&args("--version"), true), Ok(Command::Version));
        let Ok(Command::Send(s)) = parse(
            &args("send a.bin --relay wss://x --relay=wss://y --no-lan"),
            true,
        ) else {
            panic!()
        };
        assert_eq!(s.file, std::path::PathBuf::from("a.bin"));
        assert_eq!(s.relays, Some(vec!["wss://x".into(), "wss://y".into()]));
        assert!(s.show_qr && !s.lan);
        let Ok(Command::Send(s)) = parse(&args("send a.bin"), false) else {
            panic!()
        };
        assert!(!s.show_qr, "never a QR into a pipe");
        let Ok(Command::Receive(r)) = parse(&args("receive qrdrop:abc --out d --yes"), true) else {
            panic!()
        };
        assert_eq!(r.code.as_deref(), Some("qrdrop:abc"));
        assert_eq!(r.out_dir, std::path::PathBuf::from("d"));
        assert!(r.assume_yes && r.lan);
        assert_eq!(
            parse(&args("web --port 0 --no-open"), true),
            Ok(Command::Web {
                port: 0,
                open: false,
                debug: false
            })
        );
    }

    #[test]
    fn usage_errors_say_what_cli_js_says() {
        let usage = text::usage();
        assert_eq!(
            parse(&args("beam"), true),
            Err(Usage(text::BEAM_REFUSED.into()))
        );
        assert_eq!(
            parse(&args("fetch"), true),
            Err(Usage(format!("Unknown command: fetch\n\n{usage}")))
        );
        assert_eq!(
            parse(&args("send"), true),
            Err(Usage(format!("send requires a file path\n\n{usage}")))
        );
        assert_eq!(
            parse(&args("web --port 4173x"), true),
            Err(Usage(format!(
                "--port must be a whole number from 0 to 65535, got: 4173x\n\n{usage}"
            )))
        );
        assert!(parse(&args("send a --nope"), true).is_err());
    }
}
