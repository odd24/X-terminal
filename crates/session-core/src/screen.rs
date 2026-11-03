//! P02 candidate screen/decoder. This is not an IPC or transport implementation.
use encoding_rs::{CoderResult, Decoder, Encoding};
use std::num::NonZeroU16;

pub const MAX_CHUNK: usize = 64 * 1024;

pub struct Screen {
    parser: vt100::Parser,
}

impl Screen {
    pub fn new(rows: u16, cols: u16) -> Result<Self, &'static str> {
        if !(1..=200).contains(&rows) || !(2..=500).contains(&cols) {
            return Err("screen dimensions out of bounds");
        }
        Ok(Self {
            parser: vt100::Parser::new(
                NonZeroU16::new(rows).unwrap(),
                NonZeroU16::new(cols).unwrap(),
                512,
            ),
        })
    }

    pub fn push(&mut self, utf8: &[u8]) -> Result<(), &'static str> {
        if utf8.len() > MAX_CHUNK {
            return Err("screen chunk exceeds bound");
        }
        self.parser.process(utf8);
        Ok(())
    }

    pub fn contents(&self) -> String {
        self.parser.screen().contents()
    }

    pub fn resize(&mut self, rows: u16, cols: u16) -> Result<(), &'static str> {
        if !(1..=200).contains(&rows) || !(2..=500).contains(&cols) {
            return Err("screen dimensions out of bounds");
        }
        self.parser.set_size(
            NonZeroU16::new(rows).unwrap(),
            NonZeroU16::new(cols).unwrap(),
        );
        Ok(())
    }

    pub fn cursor(&self) -> (u16, u16) {
        self.parser.screen().cursor_position()
    }

    pub fn alternate(&self) -> bool {
        self.parser.screen().alternate_screen()
    }
}

pub struct StreamDecoder {
    decoder: Decoder,
    finished: bool,
}

impl StreamDecoder {
    pub fn new(label: &str) -> Result<Self, &'static str> {
        let encoding = match label {
            "utf-8" | "gbk" | "gb18030" => Encoding::for_label(label.as_bytes()).unwrap(),
            _ => return Err("unsupported encoding"),
        };
        Ok(Self {
            decoder: encoding.new_decoder_without_bom_handling(),
            finished: false,
        })
    }

    /// Returns UTF-8 display text and an explicit replacement/error flag.
    /// Raw bytes must be retained by the caller separately.
    pub fn decode(&mut self, bytes: &[u8], last: bool) -> Result<(String, bool), &'static str> {
        if self.finished {
            return Err("decoder already finished");
        }
        if bytes.len() > MAX_CHUNK {
            return Err("decoder chunk exceeds bound");
        }
        let mut text = String::with_capacity(bytes.len() * 4 + 32);
        let (result, read, errors) = self.decoder.decode_to_string(bytes, &mut text, last);
        if result != CoderResult::InputEmpty || read != bytes.len() {
            return Err("decoder output exceeded reserved bound");
        }
        self.finished = last;
        Ok((text, errors))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_utf8_and_ansi_preserve_screen() {
        let mut screen = Screen::new(8, 40).unwrap();
        for byte in "\x1b[31m中文\x1b[0m".as_bytes() {
            screen.push(&[*byte]).unwrap();
        }
        assert_eq!(screen.contents(), "中文");
        assert_eq!(screen.cursor(), (0, 4));
        screen.push(b"\x1b[?1049h\x1b[2J\x1b[Halt").unwrap();
        assert!(screen.alternate());
        assert_eq!(screen.contents(), "alt");
        screen.push(b"\x1b[?1049l").unwrap();
        assert!(!screen.alternate());
        assert_eq!(screen.contents(), "中文");
    }

    #[test]
    fn legacy_decode_is_incremental_and_raw_is_unchanged() {
        for label in ["gbk", "gb18030"] {
            let raw = [0xd6, 0xd0, 0xce, 0xc4, 13, 10];
            let mut decoder = StreamDecoder::new(label).unwrap();
            let mut text = String::new();
            for byte in raw {
                let (chunk, errors) = decoder.decode(&[byte], false).unwrap();
                assert!(!errors);
                text.push_str(&chunk);
            }
            text.push_str(&decoder.decode(&[], true).unwrap().0);
            assert_eq!(text, "中文\r\n");
            assert_eq!(raw, [0xd6, 0xd0, 0xce, 0xc4, 13, 10]);
            assert!(decoder.decode(b"x", false).is_err());
        }
    }

    #[test]
    fn invalid_sequences_and_limits_are_explicit() {
        let mut decoder = StreamDecoder::new("utf-8").unwrap();
        assert_eq!(
            decoder.decode(&[0xe4], false).unwrap(),
            (String::new(), false)
        );
        assert_eq!(decoder.decode(&[], true).unwrap(), ("�".into(), true));
        assert!(StreamDecoder::new("auto").is_err());
        assert!(Screen::new(0, 80).is_err());
        assert!(Screen::new(24, 501).is_err());
        assert!(
            Screen::new(24, 80)
                .unwrap()
                .push(&vec![0; MAX_CHUNK + 1])
                .is_err()
        );
    }

    #[test]
    fn gb18030_four_byte_character_survives_every_boundary() {
        let mut decoder = StreamDecoder::new("gb18030").unwrap();
        let mut text = String::new();
        for byte in [0x90, 0x30, 0x81, 0x30] {
            let (chunk, errors) = decoder.decode(&[byte], false).unwrap();
            assert!(!errors);
            text.push_str(&chunk);
        }
        text.push_str(&decoder.decode(&[], true).unwrap().0);
        assert_eq!(text, "\u{10000}");
    }

    #[test]
    fn oversized_osc_does_not_prevent_following_output() {
        let mut screen = Screen::new(8, 40).unwrap();
        screen.push(b"\x1b]0;").unwrap();
        for _ in 0..100 {
            screen.push(&[b'x'; MAX_CHUNK]).unwrap();
        }
        screen.push(b"\x07safe").unwrap();
        assert_eq!(screen.contents(), "safe");
    }
}
