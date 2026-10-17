//! Where a sent file's bytes come from and a received file's go.
//!
//! Both are blocking, and the driver runs each on a thread of its own, so a
//! slow disk -- or an Android content provider, where every read is a Binder
//! round trip -- never stalls the session loop. A slow sink still slows the
//! transfer, deliberately: the session counts bytes handed to the sink and
//! not yet written, and pauses the sender at 4 MiB of them.

use std::io;

/// A file to send, read front to back exactly once.
pub trait Source: Send + 'static {
    /// The name the peer is offered.
    fn name(&self) -> &str;
    fn size(&self) -> u64;
    /// Empty for unknown, which goes out as `application/octet-stream`.
    fn mime(&self) -> &str {
        ""
    }
    /// Fill `buf` from where the last read left off. A short read is the
    /// file changing under the sender, and fails the send.
    fn read_exact(&mut self, buf: &mut [u8]) -> io::Result<()>;
}

/// Where an accepted file goes. Opened before Accept is sent, so that a
/// failure to open is a failure the peer hears about and not a transfer
/// that dies at its first chunk.
pub trait Sink: Send + 'static {
    fn write(&mut self, data: &[u8]) -> io::Result<()>;
    /// Every byte is written and the digest matched. Returns where the file
    /// ended up, in words for the person -- which can differ from where it
    /// was opened, as on Android, where the provider settles a duplicate's
    /// name only when it publishes.
    fn close(self: Box<Self>) -> io::Result<String>;
    /// Throw the partial file away.
    fn abort(self: Box<Self>);
}

#[cfg(feature = "fs")]
pub use files::*;

#[cfg(feature = "fs")]
mod files {
    use std::fs::{self, File};
    use std::io::{self, Read, Write};
    use std::path::{Path, PathBuf};

    use super::{Sink, Source};

    /// A file on disk, sent under its own name.
    pub struct FileSource {
        name: String,
        size: u64,
        file: File,
    }

    impl FileSource {
        pub fn open(path: &Path) -> io::Result<Self> {
            let file = File::open(path)?;
            let meta = file.metadata()?;
            if !meta.is_file() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("{} is not a file", path.display()),
                ));
            }
            let name = path
                .file_name()
                .map_or_else(|| "file".into(), |n| n.to_string_lossy().into_owned());
            Ok(FileSource {
                name,
                size: meta.len(),
                file,
            })
        }
    }

    impl Source for FileSource {
        fn name(&self) -> &str {
            &self.name
        }

        fn size(&self) -> u64 {
            self.size
        }

        fn read_exact(&mut self, buf: &mut [u8]) -> io::Result<()> {
            self.file.read_exact(buf)
        }
    }

    /// A received file in `dir`, never over one that exists.
    pub struct FileSink {
        file: Option<File>,
        path: PathBuf,
    }

    impl FileSink {
        /// Creates `name`, cleaned to one safe path component, in `dir`, or
        /// the first free `name (n).ext`. `create_new` makes the check and
        /// the create one step, so a file appearing between them is not
        /// overwritten either.
        pub fn create(dir: &Path, name: &str) -> io::Result<Self> {
            Self::create_numbered(dir, name, 1)
        }

        /// [`FileSink::create`], with the second copy numbered `first`. The
        /// Node CLI's sink names it `name (2).ext`, and the Rust CLI keeps
        /// what a script already sorting the Node CLI's output expects.
        pub fn create_numbered(dir: &Path, name: &str, first: u32) -> io::Result<Self> {
            let name = safe_filename(name);
            let tries = std::iter::once(0).chain(first..=first + MAX_SUFFIX);
            for n in tries {
                let path = dir.join(candidate(&name, n));
                match fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&path)
                {
                    Ok(file) => {
                        return Ok(FileSink {
                            file: Some(file),
                            path,
                        });
                    }
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(e) => return Err(e),
                }
            }
            Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!(
                    "{} already holds {MAX_SUFFIX} copies of {name}",
                    dir.display()
                ),
            ))
        }

        pub fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Sink for FileSink {
        fn write(&mut self, data: &[u8]) -> io::Result<()> {
            self.file
                .as_mut()
                .expect("written only while open")
                .write_all(data)
        }

        fn close(mut self: Box<Self>) -> io::Result<String> {
            let file = self.file.take().expect("closed once");
            file.sync_all()?;
            Ok(self.path.display().to_string())
        }

        fn abort(mut self: Box<Self>) {
            drop(self.file.take());
            let _ = fs::remove_file(&self.path);
        }
    }

    impl Drop for FileSink {
        /// Neither closed nor aborted -- the driver dropped mid-file -- is a
        /// partial file, and a partial file under the sender's name looks
        /// complete. Deleted, as `abort` would.
        fn drop(&mut self) {
            if self.file.take().is_some() {
                let _ = fs::remove_file(&self.path);
            }
        }
    }

    const MAX_SUFFIX: u32 = 999;

    /// The `n`th name to try: the name itself, then `stem (n).ext` -- the
    /// scheme Android's providers use, so every route names a second copy
    /// alike. A leading dot is not an extension, and only the last dot
    /// counts, so `a.tar.gz` becomes `a.tar (1).gz`.
    fn candidate(name: &str, n: u32) -> String {
        if n == 0 {
            return name.into();
        }
        let (stem, ext) = match name.rfind('.') {
            None | Some(0) => (name, ""),
            Some(i) => name.split_at(i),
        };
        format!("{stem} ({n}){ext}")
    }

    /// `safeFilename` in `src/web/sink.js`: the last path component, without
    /// control characters, leading dots or characters Windows reserves, cut
    /// to 180 characters, and never a Windows device name. A name is about
    /// to become a path on this side of the boundary, and a separator
    /// surviving into `dir.join` would be a path traversal.
    pub fn safe_filename(name: &str) -> String {
        const FALLBACK: &str = "received.bin";
        let cleaned: String = name
            .chars()
            .filter(|c| !matches!(*c as u32, 0..=0x1f | 0x7f))
            .collect();
        let last = cleaned
            .split(['/', '\\'])
            .rfind(|s| !s.is_empty())
            .unwrap_or("");
        let last: String = last
            .trim_start_matches('.')
            .chars()
            .map(|c| {
                if matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') {
                    '_'
                } else {
                    c
                }
            })
            .collect();
        // The JS trims, then slices 180 UTF-16 units.
        let trimmed = last.trim();
        let mut out = String::new();
        let mut units = 0;
        for c in trimmed.chars() {
            units += c.len_utf16();
            if units > 180 {
                break;
            }
            out.push(c);
        }
        if out.is_empty() || windows_reserved(&out) {
            return FALLBACK.into();
        }
        out
    }

    /// `/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i`
    fn windows_reserved(name: &str) -> bool {
        let lower = name.to_ascii_lowercase();
        let stem = lower.split('.').next().unwrap_or("");
        let b = stem.as_bytes();
        matches!(stem, "con" | "prn" | "aux" | "nul")
            || (b.len() == 4
                && (stem.starts_with("com") || stem.starts_with("lpt"))
                && (b'1'..=b'9').contains(&b[3]))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn names_are_one_safe_component() {
            for (given, want) in [
                ("report.pdf", "report.pdf"),
                ("../../etc/passwd", "passwd"),
                ("C:\\Windows\\system.ini", "system.ini"),
                ("..", "received.bin"),
                (".bashrc", "bashrc"),
                ("a<b>c:d\"e|f?g*h", "a_b_c_d_e_f_g_h"),
                ("con", "received.bin"),
                ("CON.txt", "received.bin"),
                ("com1.log", "received.bin"),
                ("console.log", "console.log"),
                ("com0", "com0"),
                ("tab\tin", "tabin"),
                ("  spaced  ", "spaced"),
                ("", "received.bin"),
            ] {
                assert_eq!(safe_filename(given), want, "{given:?}");
            }
            assert_eq!(safe_filename(&"x".repeat(300)).len(), 180);
        }

        #[test]
        fn a_second_copy_never_overwrites_the_first() {
            let dir = std::env::temp_dir().join(format!("qrdrop-sink-{}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            let mut a = Box::new(FileSink::create(&dir, "a.tar.gz").unwrap());
            a.write(b"one").unwrap();
            let first = a.close().unwrap();
            let mut b = Box::new(FileSink::create(&dir, "a.tar.gz").unwrap());
            b.write(b"two").unwrap();
            let second = b.close().unwrap();
            assert!(second.ends_with("a.tar (1).gz"), "{second}");
            assert_eq!(fs::read(&first).unwrap(), b"one");
            let c = Box::new(FileSink::create(&dir, "a.tar.gz").unwrap());
            let partial = c.path().to_owned();
            c.abort();
            assert!(!partial.exists());
            {
                let _dropped = FileSink::create(&dir, "dropped.bin").unwrap();
            }
            assert!(!dir.join("dropped.bin").exists());
            fs::remove_dir_all(&dir).unwrap();
        }
    }
}
