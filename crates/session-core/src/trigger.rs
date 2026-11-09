//! Finite-span, bounded stream matching. No transport, actions or persistent state.
use regex::{Regex, RegexBuilder};
use regex_syntax::{ParserBuilder, hir::HirKind};
use serde::{Deserialize, Serialize};

pub const MAX_TEXT: usize = 16 * 1024;
const MAX_SPAN: usize = 1024;
const MAX_MATCHES: usize = 32;
const MAX_SEARCHES: usize = 64;

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Literal,
    Regex,
}
#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    Pattern,
    Unsupported,
    Text,
    Sequence,
    Capacity,
}
#[derive(Clone, Serialize)]
pub struct Hit {
    pub first_seq: u64,
    pub last_seq: u64,
    pub text: String,
}
enum Pattern {
    Literal(String),
    Regex(Regex),
}
pub struct Matcher {
    pattern: Pattern,
    span: usize,
    carry: String,
    origins: Vec<u64>,
    base: u64,
    through: u64,
    expected: u64,
    ended: bool,
}
impl Matcher {
    pub fn new(kind: Kind, pattern: &str, next_seq: u64) -> Result<Self, Error> {
        if pattern.is_empty() || pattern.len() > MAX_SPAN || next_seq == 0 {
            return Err(Error::Pattern);
        }
        let (pattern, span) = match kind {
            Kind::Literal => (Pattern::Literal(pattern.into()), pattern.len()),
            Kind::Regex => {
                let hir = ParserBuilder::new()
                    .nest_limit(32)
                    .build()
                    .parse(pattern)
                    .map_err(|_| Error::Pattern)?;
                let span = hir.properties().maximum_len().ok_or(Error::Unsupported)?;
                if hir.properties().minimum_len().is_none_or(|n| n == 0) || span > MAX_SPAN {
                    return Err(Error::Unsupported);
                }
                let mut stack = vec![&hir];
                while let Some(node) = stack.pop() {
                    if matches!(node.kind(), HirKind::Look(_)) {
                        return Err(Error::Unsupported);
                    }
                    stack.extend(node.kind().subs());
                }
                let regex = RegexBuilder::new(pattern)
                    .nest_limit(32)
                    .size_limit(256 * 1024)
                    .dfa_size_limit(128 * 1024)
                    .build()
                    .map_err(|_| Error::Pattern)?;
                (Pattern::Regex(regex), span)
            }
        };
        Ok(Self {
            pattern,
            span,
            carry: String::new(),
            origins: Vec::new(),
            base: 0,
            through: 0,
            expected: next_seq,
            ended: false,
        })
    }
    pub fn span(&self) -> usize {
        self.span
    }
    pub fn reset(&mut self, next_seq: u64) -> Result<(), Error> {
        if next_seq == 0 {
            return Err(Error::Sequence);
        }
        self.carry.clear();
        self.origins.clear();
        self.base = 0;
        self.through = 0;
        self.expected = next_seq;
        self.ended = false;
        Ok(())
    }
    pub fn push(
        &mut self,
        seq: u64,
        text: &str,
        broken: bool,
        finished: bool,
    ) -> Result<Vec<Hit>, Error> {
        if self.ended || seq != self.expected {
            return Err(Error::Sequence);
        }
        if text.len() > MAX_TEXT {
            return Err(Error::Text);
        }
        self.expected = seq.checked_add(1).ok_or(Error::Capacity)?;
        if broken {
            self.carry.clear();
            self.origins.clear();
            self.base = 0;
            self.through = 0;
            return Ok(Vec::new());
        }
        self.ended = finished;
        let mut text_all = std::mem::take(&mut self.carry);
        text_all.push_str(text);
        let mut origins = std::mem::take(&mut self.origins);
        origins.extend(std::iter::repeat_n(seq, text.len()));
        let stable = if finished {
            Some(text_all.len())
        } else {
            text_all.len().checked_sub(self.span)
        };
        let mut hits = Vec::new();
        if let Some(stable) = stable {
            let mut from = self.through.saturating_sub(self.base) as usize;
            let mut searches = 0;
            while from <= stable && from < text_all.len() {
                while from < text_all.len() && !text_all.is_char_boundary(from) {
                    from += 1;
                }
                searches += 1;
                if searches > MAX_SEARCHES {
                    return Err(Error::Capacity);
                }
                let found = match &self.pattern {
                    Pattern::Literal(needle) => text_all[from..]
                        .find(needle)
                        .map(|n| (from + n, from + n + needle.len())),
                    Pattern::Regex(regex) => {
                        regex.find_at(&text_all, from).map(|m| (m.start(), m.end()))
                    }
                };
                let Some((start, end)) = found else { break };
                if start > stable {
                    break;
                }
                if start == end {
                    return Err(Error::Unsupported);
                }
                if hits.len() == MAX_MATCHES {
                    return Err(Error::Capacity);
                }
                hits.push(Hit {
                    first_seq: origins[start],
                    last_seq: origins[end - 1],
                    text: text_all[start..end].into(),
                });
                from = end;
                self.through = self.base.checked_add(end as u64).ok_or(Error::Capacity)?;
            }
            self.through = self.through.max(
                self.base
                    .checked_add(stable as u64 + 1)
                    .ok_or(Error::Capacity)?,
            );
        }
        let mut keep_from = text_all.len().saturating_sub(self.span - 1);
        while !text_all.is_char_boundary(keep_from) {
            keep_from -= 1;
        }
        self.base = self
            .base
            .checked_add(keep_from as u64)
            .ok_or(Error::Capacity)?;
        self.carry = text_all[keep_from..].into();
        self.origins = origins[keep_from..].to_vec();
        Ok(hits)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn literal_cross_blocks_unicode_origin_and_nonoverlap() {
        let mut m = Matcher::new(Kind::Literal, "中😀ERROR", 7).unwrap();
        assert!(m.push(7, "before 中", false, false).unwrap().is_empty());
        let hits = m.push(8, "😀ERROR after", false, false).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!((hits[0].first_seq, hits[0].last_seq), (7, 8));
        assert_eq!(hits[0].text, "中😀ERROR");
        assert!(m.push(9, " tail", false, false).unwrap().is_empty());
    }
    #[test]
    fn finite_regex_defers_ambiguous_tail_until_span_or_finish() {
        let mut m = Matcher::new(Kind::Regex, r"ERR[0-9]{1,3}", 1).unwrap();
        assert_eq!(m.span(), 6);
        assert!(m.push(1, "ERR1", false, false).unwrap().is_empty());
        let hits = m.push(2, "23 ", false, false).unwrap();
        assert_eq!(hits[0].text, "ERR123");
        assert!(m.push(3, "ERR2", false, false).unwrap().is_empty());
        let hits = m.push(4, "", false, true).unwrap();
        assert_eq!(hits[0].text, "ERR2");
        assert!(m.push(5, "later", false, false).is_err());
    }
    #[test]
    fn segmentation_matches_full_finite_scan_for_every_split() {
        let text = "中ERR123--ERR4--😀ERR99!";
        for split in (0..=text.len()).filter(|&i| text.is_char_boundary(i)) {
            let mut m = Matcher::new(Kind::Regex, r"ERR[0-9]{1,3}", 1).unwrap();
            let mut hits = m.push(1, &text[..split], false, false).unwrap();
            hits.extend(m.push(2, &text[split..], false, true).unwrap());
            assert_eq!(
                hits.iter().map(|h| h.text.as_str()).collect::<Vec<_>>(),
                ["ERR123", "ERR4", "ERR99"]
            );
        }
    }
    #[test]
    fn gaps_reset_without_joining_and_duplicates_fail() {
        let mut m = Matcher::new(Kind::Literal, "ERROR", 1).unwrap();
        m.push(1, "ERR", false, false).unwrap();
        assert!(m.push(2, "", true, false).unwrap().is_empty());
        assert!(m.push(3, "OR", false, false).unwrap().is_empty());
        assert_eq!(
            m.push(3, "ERROR", false, false).err(),
            Some(Error::Sequence)
        );
        m.reset(10).unwrap();
        assert_eq!(m.push(10, "ERROR", false, false).unwrap().len(), 1);
    }
    #[test]
    fn rejects_unbounded_empty_anchors_lookaround_and_resource_overflow() {
        for pattern in [
            "(a+)+$",
            "a*",
            "a{1,1025}",
            "a?",
            "^a",
            "a$",
            r"\ba",
            r"(?=a)",
            r"(a)\1",
        ] {
            assert!(Matcher::new(Kind::Regex, pattern, 1).is_err(), "{pattern}");
        }
        assert!(Matcher::new(Kind::Literal, &"x".repeat(1025), 1).is_err());
        let mut m = Matcher::new(Kind::Literal, "x", 1).unwrap();
        assert_eq!(
            m.push(1, &"x".repeat(33), false, false).err(),
            Some(Error::Capacity)
        );
        let mut m = Matcher::new(Kind::Literal, "x", 1).unwrap();
        assert_eq!(
            m.push(1, &"x".repeat(MAX_TEXT + 1), false, false).err(),
            Some(Error::Text)
        );
    }
}
