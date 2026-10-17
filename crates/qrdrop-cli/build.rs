//! Two things the binary takes from the repository at build time:
//!
//! - **The version**, from package.json, so `qrdrop --version` says what the
//!   Node CLI it stands in for says. The crate's own version stays 0.0.0 until
//!   phase 8 decides how the binary ships.
//! - **site/dist**, behind the `web` feature, as a table of `include_bytes!`
//!   for `qrdrop web`. The Node CLI serves the same tree from its npm tarball.
//!   A tree that is not built yet is an empty table, and the command then says
//!   so at run time in the Node CLI's words, rather than failing the build of
//!   everything else.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::{env, fs};

fn main() {
    let root = Path::new(&env::var("CARGO_MANIFEST_DIR").unwrap()).join("../..");

    let package = root.join("package.json");
    println!("cargo:rerun-if-changed={}", package.display());
    let version = fs::read_to_string(&package)
        .ok()
        .and_then(|s| version_of(&s))
        .unwrap_or_else(|| "0.0.0".into());
    println!("cargo:rustc-env=QRDROP_VERSION={version}");

    let mut table = String::from("pub static ASSETS: &[(&str, &[u8])] = &[\n");
    if env::var_os("CARGO_FEATURE_WEB").is_some() {
        let dist = root.join("site/dist");
        println!("cargo:rerun-if-changed={}", dist.display());
        let mut files = vec![];
        walk(&dist, &mut files);
        files.sort();
        for file in files {
            let rel = file.strip_prefix(&dist).unwrap();
            let rel: Vec<_> = rel
                .iter()
                .map(|c| c.to_string_lossy().into_owned())
                .collect();
            let abs = std::path::absolute(&file).unwrap();
            writeln!(
                table,
                "    ({:?}, include_bytes!({:?})),",
                rel.join("/"),
                abs
            )
            .unwrap();
        }
    }
    table.push_str("];\n");
    let out = PathBuf::from(env::var("OUT_DIR").unwrap()).join("assets.rs");
    fs::write(out, table).unwrap();
}

/// The first `"version": "…"` in package.json, which is the package's own:
/// it is the third key, ahead of every dependency table.
fn version_of(json: &str) -> Option<String> {
    let at = json.find("\"version\"")?;
    let rest = &json[at + "\"version\"".len()..];
    let open = rest.find('"')? + 1;
    let close = open + rest[open..].find('"')?;
    Some(rest[open..close].to_owned())
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(&p, out);
        } else {
            out.push(p);
        }
    }
}
