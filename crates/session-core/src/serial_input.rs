//! Bounded serial send preparation; no transport or terminal decoding.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Format {
    Text,
    Hex,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Ending {
    None,
    Cr,
    Lf,
    CrLf,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Pace {
    pub chunk_bytes: usize,
    pub interval_ms: u64,
}
impl Default for Pace {
    fn default() -> Self {
        Self {
            chunk_bytes: 1024,
            interval_ms: 0,
        }
    }
}
impl Pace {
    pub fn valid(self, bytes: usize) -> bool {
        (1..=1024).contains(&self.chunk_bytes)
            && self.interval_ms <= 1000
            && self
                .interval_ms
                .saturating_mul(bytes.div_ceil(self.chunk_bytes).saturating_sub(1) as u64)
                <= 60000
    }
}
pub fn prepare(
    content: &str,
    format: Format,
    ending: Ending,
    encoding: &str,
) -> Result<Vec<u8>, &'static str> {
    if content.len() > 196608 {
        return Err("input too large");
    }
    let mut bytes = match format {
        Format::Text => {
            let encoding = match encoding {
                "utf8" => encoding_rs::UTF_8,
                "gbk" => encoding_rs::GBK,
                "gb18030" => encoding_rs::GB18030,
                _ => return Err("unsupported encoding"),
            };
            let (bytes, _, errors) = encoding.encode(content);
            if errors {
                return Err("text not representable");
            }
            bytes.into_owned()
        }
        Format::Hex => {
            let mut bytes = Vec::new();
            let mut high = None;
            for ch in content.bytes().filter(|ch| !ch.is_ascii_whitespace()) {
                let digit = (ch as char).to_digit(16).ok_or("invalid hex")? as u8;
                if let Some(hi) = high.take() {
                    bytes.push(hi * 16 + digit);
                    if bytes.len() > 65536 {
                        return Err("input too large");
                    }
                } else {
                    high = Some(digit);
                }
            }
            if high.is_some() {
                return Err("odd hex digits");
            }
            bytes
        }
    };
    bytes.extend_from_slice(match ending {
        Ending::None => b"",
        Ending::Cr => b"\r",
        Ending::Lf => b"\n",
        Ending::CrLf => b"\r\n",
    });
    if bytes.is_empty() || bytes.len() > 65536 {
        return Err("invalid byte count");
    }
    Ok(bytes)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn text_encodings_endings_and_hex_preserve_explicit_bytes() {
        assert_eq!(
            prepare("中", Format::Text, Ending::CrLf, "gbk").unwrap(),
            [0xd6, 0xd0, 13, 10]
        );
        assert_eq!(
            prepare("中", Format::Text, Ending::None, "utf8").unwrap(),
            "中".as_bytes()
        );
        assert!(prepare("😀", Format::Text, Ending::None, "gbk").is_err());
        let wide = prepare("😀", Format::Text, Ending::Lf, "gb18030").unwrap();
        assert_eq!(wide.len(), 5);
        assert_eq!(wide[4], 10);
        assert_eq!(
            prepare("00 ff 0D\n0a", Format::Hex, Ending::Cr, "utf8").unwrap(),
            [0, 255, 13, 10, 13]
        );
    }
    #[test]
    fn invalid_text_hex_byte_bounds_and_total_pacing_are_rejected() {
        for text in ["0", "GG", "é", "0x11", ""] {
            assert!(prepare(text, Format::Hex, Ending::None, "utf8").is_err());
        }
        assert!(prepare(&"a".repeat(65536), Format::Text, Ending::Cr, "utf8").is_err());
        assert!(
            Pace {
                chunk_bytes: 1,
                interval_ms: 1000
            }
            .valid(61)
        );
        assert!(
            !Pace {
                chunk_bytes: 1,
                interval_ms: 1000
            }
            .valid(62)
        );
        assert!(
            !Pace {
                chunk_bytes: 0,
                interval_ms: 0
            }
            .valid(1)
        );
        assert!(
            !Pace {
                chunk_bytes: 1025,
                interval_ms: 0
            }
            .valid(1)
        );
    }
}
