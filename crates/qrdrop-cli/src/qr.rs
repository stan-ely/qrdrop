//! The terminal QR code, drawn as `src/node/qr.js` draws it:
//! qrcode-generator's `createASCII(1, 2)`, which packs two modules into one
//! cell with half blocks so a module comes out square in a font twice as tall
//! as it is wide, with a two-module margin, at error correction M.
//!
//! Inverted, as that function is: a dark module is a blank cell and a light
//! one a block, which is what reads correctly on the dark background most
//! terminals have.
//!
//! The encoder is Nayuki's, where the Node CLI's is qrcode-generator, and the
//! two draw different pictures of the same code. Measured on three texts (a
//! bare code, an odd one, a `--qr-url` link): forcing each of qrcodegen's
//! eight masks, one reproduces the Node CLI's output exactly every time, so
//! the version, data and error correction are identical and only the mask
//! differs. qrcode-generator picks its mask with a penalty of its own, scored
//! with the format bits blanked, not the standard's. Porting that would make
//! the art byte-identical for nothing: no test or person parses it, and
//! every mask is a valid code for the same text.

use qrcodegen::{QrCode, QrCodeEcc, QrSegment, Version};

const MARGIN: i32 = 2;

pub fn render(text: &str) -> String {
    // No ECC boost: qrcode-generator keeps the level asked for, and a boost
    // would only make the two pick different versions for the same text.
    let segs = QrSegment::make_segments(text);
    let qr = QrCode::encode_segments_advanced(
        &segs,
        QrCodeEcc::Medium,
        Version::MIN,
        Version::MAX,
        None,
        false,
    )
    .expect("a qrdrop code is far inside a QR code's capacity");
    half_blocks(qr.size(), |x, y| qr.get_module(x, y))
}

/// `_createHalfASCII(margin)`, for a `size`-module code whose dark modules
/// `dark(x, y)` says.
fn half_blocks(modules: i32, dark: impl Fn(i32, i32) -> bool) -> String {
    let size = modules + MARGIN * 2;
    let (min, max) = (MARGIN, size - MARGIN);
    let inside = |x: i32, y: i32| min <= x && x < max && min <= y && y < max;
    let mut lines = vec![];
    for y in (0..size).step_by(2) {
        let mut line = String::new();
        for x in 0..size {
            let top = !(inside(x, y) && dark(x - min, y - min));
            let bottom = !(inside(x, y + 1) && dark(x - min, y + 1 - min));
            line.push(match (top, bottom) {
                (true, true) => '\u{2588}',
                (true, false) => '\u{2580}',
                (false, true) => '\u{2584}',
                (false, false) => ' ',
            });
        }
        lines.push(line);
    }
    // An odd size leaves the last row's bottom half outside the code, so the
    // JS replaces that row with a full row of upper halves.
    if size % 2 == 1 {
        lines.pop();
        lines.push("\u{2580}".repeat(size as usize));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_qrdrop_code_is_a_version_4_symbol_in_a_37_column_block() {
        let code = format!("qrdrop:{}", "A".repeat(43));
        let out = render(&code);
        let lines: Vec<&str> = out.lines().collect();
        // 50 bytes at M is version 4, 33 modules, so 33 + 2 * 2 columns and
        // 37 rows packed two to a line.
        assert!(lines.iter().all(|l| l.chars().count() == 37));
        assert_eq!(lines.len(), 19);
        // The margin is light, so drawn as blocks, and the odd last row is
        // all upper halves.
        assert!(lines[0].chars().all(|c| c == '\u{2588}'));
        assert!(lines[18].chars().all(|c| c == '\u{2580}'));
    }

    #[test]
    fn the_cells_are_qrcode_generators() {
        // A 2x2 code, dark on its diagonal, inside the two-module margin. The
        // middle line holds the code's two rows: column 0 is dark above and
        // light below, so a lower half; column 1 the other way round.
        let out = half_blocks(2, |x, y| x == y);
        let full = "\u{2588}".repeat(6);
        let middle = "\u{2588}\u{2588}\u{2584}\u{2580}\u{2588}\u{2588}";
        assert_eq!(out, format!("{full}\n{middle}\n{full}"));
    }
}
