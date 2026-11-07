//! Bounded projection engine. Callers must supply the whole authorized segment
//! before paging, and split at actual gaps/streams. No service endpoint is wired here.
use crate::session::ErrorCode;
use std::{fmt, ops::Range};
use zeroize::{Zeroize, Zeroizing};

pub const MAX_LITERALS: usize = 32;
pub const MAX_LITERAL_BYTES: usize = 256;
pub const MAX_INPUT_BYTES: usize = 1024 * 1024;
pub const MAX_FRAGMENTS: usize = 256;

struct Literal {
    value: Zeroizing<String>,
    failure: Vec<usize>,
}
/// Immutable, memory-only. Literal values are neither Debug nor serializable.
pub struct Policy {
    literals: Vec<Literal>,
    sensitive_fields: bool,
}
impl fmt::Debug for Policy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RedactionPolicy")
            .field("literal_count", &self.literals.len())
            .field("sensitive_fields", &self.sensitive_fields)
            .finish()
    }
}
#[derive(Debug, Clone, Copy, Default)]
pub struct Boundaries {
    /// Earlier source is absent (coverage, time selection or a context gap).
    pub prefix_cut: bool,
    /// The end may cut a value/literal. True for live or caller-fixed cutoffs.
    pub suffix_cut: bool,
}
#[derive(Debug, PartialEq, Eq)]
pub struct Projection {
    /// Same fragment count and UTF-8 byte lengths. LF structure is retained;
    /// masked scalars become byte-count '*' and are not a cell-width renderer.
    pub fragments: Vec<String>,
    pub masked_ranges: Vec<Range<usize>>,
    pub literal_matches: usize,
    pub field_matches: usize,
    pub boundary_guard: bool,
    pub opaque_controls: bool,
}
impl Policy {
    pub fn new(mut literals: Vec<String>, sensitive_fields: bool) -> Result<Self, ErrorCode> {
        let invalid = literals.len() > MAX_LITERALS
            || (!sensitive_fields && literals.is_empty())
            || literals
                .iter()
                .any(|s| s.is_empty() || s.len() > MAX_LITERAL_BYTES)
            || literals
                .iter()
                .enumerate()
                .any(|(i, s)| literals[..i].contains(s));
        if invalid {
            literals.iter_mut().for_each(Zeroize::zeroize);
            return Err(ErrorCode::InvalidArgument);
        }
        let literals = literals
            .into_iter()
            .map(|value| {
                let value = Zeroizing::new(value);
                let bytes = value.as_bytes();
                let mut failure = vec![0; bytes.len()];
                let mut prefix = 0;
                for index in 1..bytes.len() {
                    while prefix > 0 && bytes[index] != bytes[prefix] {
                        prefix = failure[prefix - 1];
                    }
                    if bytes[index] == bytes[prefix] {
                        prefix += 1;
                    }
                    failure[index] = prefix;
                }
                Literal { value, failure }
            })
            .collect();
        Ok(Self {
            literals,
            sensitive_fields,
        })
    }

    pub fn project(
        &self,
        fragments: &[&str],
        boundaries: Boundaries,
    ) -> Result<Projection, ErrorCode> {
        if fragments.len() > MAX_FRAGMENTS {
            return Err(ErrorCode::InvalidArgument);
        }
        let length = fragments
            .iter()
            .try_fold(0usize, |total, s| total.checked_add(s.len()))
            .filter(|total| *total <= MAX_INPUT_BYTES)
            .ok_or(ErrorCode::InvalidArgument)?;
        let mut source = Zeroizing::new(String::with_capacity(length));
        for fragment in fragments {
            source.push_str(fragment);
        }
        let bytes = source.as_bytes();
        // Difference array: each overlapping match is O(1) to mark. At most
        // 32*256 literal overlaps are active; i32 does not depend on output rate.
        let mut delta = vec![0i32; length + 1];
        let mut mark = |from: usize, until: usize| {
            if from < until {
                delta[from] += 1;
                delta[until] -= 1;
            }
        };
        let mut literal_matches = 0;
        for literal in &self.literals {
            let needle = literal.value.as_bytes();
            let mut matched = 0;
            for (index, byte) in bytes.iter().enumerate() {
                while matched > 0 && *byte != needle[matched] {
                    matched = literal.failure[matched - 1];
                }
                if *byte == needle[matched] {
                    matched += 1;
                }
                if matched == needle.len() {
                    mark(index + 1 - needle.len(), index + 1);
                    literal_matches += 1;
                    matched = literal.failure[matched - 1];
                }
            }
        }
        let field_matches = if self.sensitive_fields {
            fields(bytes, &mut mark)
        } else {
            0
        };
        let guard = self
            .literals
            .iter()
            .map(|l| l.value.len() - 1)
            .max()
            .unwrap_or(0);
        let mut boundary_guard = false;
        if boundaries.prefix_cut && length > 0 {
            // A cut may begin inside a multiline quoted value or PEM body.
            // Without trusted prior lexical state no newline proves safety.
            let line_end = if self.sensitive_fields { length } else { 0 };
            let until = guard.max(line_end).min(length);
            mark(0, until);
            boundary_guard |= until > 0;
        }
        if boundaries.suffix_cut && length > 0 {
            let line_start = if self.sensitive_fields {
                bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1)
            } else {
                length
            };
            let from = length.saturating_sub(guard).min(line_start);
            mark(from, length);
            boundary_guard |= from < length;
        }
        // Do not let a caller obtain an ANSI/backspace/bidi-obfuscated alternative
        // from this plain-text engine. A future canonical terminal projection can
        // call us on its rendered text; passing opaque controls hides the segment.
        let opaque_controls = source.char_indices().any(|(i, c)| {
            (c.is_control() && !matches!(c, '\n' | '\t') && !(c == '\r' && bytes.get(i + 1) == Some(&b'\n')))
                || matches!(c, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        });
        if opaque_controls {
            mark(0, length);
        }
        let mut fragments_out = Vec::with_capacity(fragments.len());
        let mut ranges: Vec<Range<usize>> = Vec::new();
        let mut offset = 0;
        let mut active = 0;
        for fragment in fragments {
            let mut text = String::with_capacity(fragment.len());
            for c in fragment.chars() {
                let start = offset;
                let mut masked = false;
                for _ in 0..c.len_utf8() {
                    active += delta[offset];
                    masked |= active > 0;
                    offset += 1;
                }
                if masked && c != '\n' {
                    text.extend(std::iter::repeat_n('*', c.len_utf8()));
                    if let Some(last) = ranges.last_mut().filter(|last| last.end == start) {
                        last.end = offset;
                    } else {
                        ranges.push(start..offset);
                    }
                } else {
                    text.push(c);
                }
            }
            fragments_out.push(text);
        }
        Ok(Projection {
            fragments: fragments_out,
            masked_ranges: ranges,
            literal_matches,
            field_matches,
            boundary_guard,
            opaque_controls,
        })
    }
}

const KEYS: &[&[u8]] = &[
    b"password",
    b"passwd",
    b"passphrase",
    b"token",
    b"secret",
    b"api_key",
    b"api-key",
    b"apikey",
    b"access_token",
    b"refresh_token",
    b"authorization",
    b"private_key",
];
fn fields(bytes: &[u8], mark: &mut impl FnMut(usize, usize)) -> usize {
    let mut index = 0;
    let mut count = 0;
    while index < bytes.len() {
        // PEM body is hidden through the matching end line, or the current end
        // for unfinished keys. Headers alone do not claim a complete key.
        if bytes[index..].starts_with(b"-----BEGIN ") {
            let end = bytes[index..]
                .iter()
                .take(97)
                .position(|b| *b == b'\n')
                .map_or(bytes.len().min(index + 97), |n| index + n);
            if end - index <= 96
                && bytes[index..end]
                    .windows(16)
                    .any(|s| s == b"PRIVATE KEY-----")
            {
                let header = bytes[index..end]
                    .strip_suffix(b"\r")
                    .unwrap_or(&bytes[index..end]);
                let terminator = [b"-----END ".as_slice(), &header[11..]].concat();
                let mut until = bytes.len();
                let mut line_start = end;
                for line in bytes[end..].split_inclusive(|b| *b == b'\n') {
                    let content = if let Some(without_lf) = line.strip_suffix(b"\n") {
                        without_lf.strip_suffix(b"\r").unwrap_or(without_lf)
                    } else {
                        line
                    };
                    // An inline/suffixed marker cannot end the recognized block.
                    // Each line is visited once, including a possible EOF line.
                    if content == terminator {
                        until = line_start + line.len();
                        break;
                    }
                    line_start += line.len();
                }
                mark(index, until);
                count += 1;
                index = until;
                continue;
            }
        }
        let boundary = index == 0
            || !(bytes[index - 1].is_ascii_alphanumeric()
                || matches!(bytes[index - 1], b'_' | b'-'));
        let key = boundary
            .then(|| {
                KEYS.iter().find(|key| {
                    bytes
                        .get(index..index + key.len())
                        .is_some_and(|s| s.eq_ignore_ascii_case(key))
                })
            })
            .flatten();
        if let Some(key) = key {
            let mut cursor = index + key.len();
            if matches!(bytes.get(cursor), Some(b'\'' | b'"')) {
                cursor += 1;
            }
            while matches!(bytes.get(cursor), Some(b' ' | b'\t')) {
                cursor += 1;
            }
            if matches!(bytes.get(cursor), Some(b':' | b'=')) {
                cursor += 1;
                while matches!(bytes.get(cursor), Some(b' ' | b'\t')) {
                    cursor += 1;
                }
                let from = cursor;
                if let Some(quote @ (b'\'' | b'"')) = bytes.get(cursor).copied() {
                    cursor += 1;
                    while cursor < bytes.len() {
                        if bytes[cursor] == b'\\' {
                            cursor = (cursor + 2).min(bytes.len());
                        } else if bytes[cursor] == quote {
                            cursor += 1;
                            break;
                        } else {
                            cursor += 1;
                        }
                    }
                } else {
                    cursor = bytes[cursor..]
                        .iter()
                        .position(|b| *b == b'\n')
                        .map_or(bytes.len(), |n| cursor + n);
                }
                if cursor > from {
                    mark(from, cursor);
                    count += 1;
                    index = cursor;
                    continue;
                }
            }
        }
        index += 1;
    }
    count
}

#[cfg(test)]
mod tests;
