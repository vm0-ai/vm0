//! Pi hidden memory-citation transport normalization.
//!
//! Adapted from OpenAI Codex rust-v0.152.1 commit
//! 5adb68a49933ae446bf11935662c83dba55a0804 under Apache-2.0. vm0 also
//! suppresses stray complete delimiters before public projection.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use uuid::Uuid;

pub(super) const OPEN: &str = "<oai-mem-citation>";
pub(super) const CLOSE: &str = "</oai-mem-citation>";
const MAX_BODY_BYTES: usize = 64 * 1024;
const MAX_ENTRIES: usize = 64;
const MAX_ROLLOUT_IDS: usize = 64;
const MAX_PATH_BYTES: usize = 1024;
const MAX_NOTE_BYTES: usize = 2048;

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PiMemoryCitation {
    pub(super) entries: Vec<PiMemoryCitationEntry>,
    pub(super) rollout_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PiMemoryCitationEntry {
    pub(super) path: String,
    pub(super) line_start: u32,
    pub(super) line_end: u32,
    pub(super) note: String,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(super) struct CitationDiagnostics {
    pub(super) envelopes: usize,
    pub(super) valid_entries: usize,
    pub(super) valid_rollout_ids: usize,
    pub(super) invalid_entries: usize,
    pub(super) invalid_rollout_ids: usize,
    pub(super) oversized_bodies: usize,
    pub(super) incomplete_bodies: usize,
}

#[derive(Debug, Eq, PartialEq)]
pub(super) struct CitationProjection {
    pub(super) visible_segments: Vec<String>,
    pub(super) citation: Option<PiMemoryCitation>,
    pub(super) diagnostics: CitationDiagnostics,
}

#[derive(Clone, Copy)]
struct SourcedChar {
    value: char,
    source: usize,
}

pub(super) struct CitationParser {
    visible_segments: Vec<String>,
    citation: PiMemoryCitation,
    diagnostics: CitationDiagnostics,
    outside_pending: Vec<SourcedChar>,
    close_pending: Vec<SourcedChar>,
    inside: bool,
    body: String,
    body_oversized: bool,
}

impl CitationParser {
    pub(super) fn new(segment_count: usize) -> Self {
        Self {
            visible_segments: vec![String::new(); segment_count],
            citation: PiMemoryCitation::default(),
            diagnostics: CitationDiagnostics::default(),
            outside_pending: Vec::new(),
            close_pending: Vec::new(),
            inside: false,
            body: String::new(),
            body_oversized: false,
        }
    }

    pub(super) fn push(&mut self, chunk: &str, source: usize) {
        for value in chunk.chars() {
            self.push_character(SourcedChar { value, source });
        }
    }

    fn push_character(&mut self, character: SourcedChar) {
        if self.inside {
            self.close_pending.push(character);
            loop {
                let pending: String = self.close_pending.iter().map(|item| item.value).collect();
                if pending == CLOSE {
                    self.finish_body(false);
                    self.close_pending.clear();
                    self.inside = false;
                    return;
                }
                if CLOSE.starts_with(&pending) {
                    return;
                }
                if self.close_pending.is_empty() {
                    return;
                }
                let first = self.close_pending.remove(0);
                self.append_body(first.value);
            }
        }

        self.outside_pending.push(character);
        loop {
            let pending: String = self.outside_pending.iter().map(|item| item.value).collect();
            if pending == OPEN {
                self.outside_pending.clear();
                self.inside = true;
                self.body.clear();
                self.body_oversized = false;
                return;
            }
            if pending == CLOSE {
                self.outside_pending.clear();
                return;
            }
            if OPEN.starts_with(&pending) || CLOSE.starts_with(&pending) {
                return;
            }
            if self.outside_pending.is_empty() {
                return;
            }
            let first = self.outside_pending.remove(0);
            if let Some(output) = self.visible_segments.get_mut(first.source) {
                output.push(first.value);
            }
        }
    }

    fn append_body(&mut self, value: char) {
        if self.body_oversized {
            return;
        }
        if self.body.len() + value.len_utf8() > MAX_BODY_BYTES {
            self.body.clear();
            self.body_oversized = true;
            return;
        }
        self.body.push(value);
    }

    fn finish_body(&mut self, incomplete: bool) {
        self.diagnostics.envelopes += 1;
        if incomplete {
            self.diagnostics.incomplete_bodies += 1;
        }
        if self.body_oversized {
            self.diagnostics.oversized_bodies += 1;
            return;
        }
        append_body(&self.body, &mut self.citation, &mut self.diagnostics);
    }

    pub(super) fn finish(mut self) -> CitationProjection {
        if self.inside {
            let pending = std::mem::take(&mut self.close_pending);
            for character in pending {
                self.append_body(character.value);
            }
            self.finish_body(true);
        } else {
            for character in std::mem::take(&mut self.outside_pending) {
                if let Some(output) = self.visible_segments.get_mut(character.source) {
                    output.push(character.value);
                }
            }
        }
        let citation = (!self.citation.entries.is_empty() || !self.citation.rollout_ids.is_empty())
            .then_some(self.citation);
        CitationProjection {
            visible_segments: self.visible_segments,
            citation,
            diagnostics: self.diagnostics,
        }
    }
}

pub(super) fn project_segments(segments: &[&str]) -> CitationProjection {
    let mut parser = CitationParser::new(segments.len());
    for (index, segment) in segments.iter().enumerate() {
        parser.push(segment, index);
    }
    parser.finish()
}

fn section<'a>(body: &'a str, names: &[&str]) -> Option<&'a str> {
    names.iter().find_map(|name| {
        let open = format!("<{name}>");
        let close = format!("</{name}>");
        let start = body.find(&open)? + open.len();
        let end = body[start..].find(&close)? + start;
        Some(&body[start..end])
    })
}

fn parse_entry(line: &str) -> Option<PiMemoryCitationEntry> {
    let (location, note_with_close) = line.rsplit_once("|note=[")?;
    let note = note_with_close.strip_suffix(']')?.trim();
    let (path, range) = location.rsplit_once(':')?;
    let (line_start, line_end) = range.split_once('-')?;
    let path = path.trim();
    let line_start = line_start.trim().parse::<u32>().ok()?;
    let line_end = line_end.trim().parse::<u32>().ok()?;
    if path.is_empty()
        || note.is_empty()
        || path.len() > MAX_PATH_BYTES
        || note.len() > MAX_NOTE_BYTES
        || line_start == 0
        || line_end < line_start
    {
        return None;
    }
    Some(PiMemoryCitationEntry {
        path: path.to_string(),
        line_start,
        line_end,
        note: note.to_string(),
    })
}

fn append_body(body: &str, citation: &mut PiMemoryCitation, diagnostics: &mut CitationDiagnostics) {
    if let Some(entries) = section(body, &["citation_entries"]) {
        for line in entries
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
        {
            if let Some(entry) = parse_entry(line).filter(|_| citation.entries.len() < MAX_ENTRIES)
            {
                citation.entries.push(entry);
                diagnostics.valid_entries += 1;
            } else {
                diagnostics.invalid_entries += 1;
            }
        }
    }

    let Some(ids) = section(body, &["rollout_ids", "thread_ids"]) else {
        return;
    };
    let mut known: HashSet<String> = citation.rollout_ids.iter().cloned().collect();
    for id in ids.lines().map(str::trim).filter(|id| !id.is_empty()) {
        let Some(canonical) = canonical_uuid(id) else {
            diagnostics.invalid_rollout_ids += 1;
            continue;
        };
        if known.contains(&canonical) {
            continue;
        }
        if citation.rollout_ids.len() >= MAX_ROLLOUT_IDS {
            diagnostics.invalid_rollout_ids += 1;
            continue;
        }
        known.insert(canonical.clone());
        citation.rollout_ids.push(canonical);
        diagnostics.valid_rollout_ids += 1;
    }
}

fn canonical_uuid(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    if bytes.len() != 36
        || [8, 13, 18, 23]
            .into_iter()
            .any(|index| bytes.get(index) != Some(&b'-'))
        || !matches!(
            bytes.get(14).copied().map(|byte| byte.to_ascii_lowercase()),
            Some(b'1'..=b'8')
        )
        || !matches!(
            bytes.get(19).copied().map(|byte| byte.to_ascii_lowercase()),
            Some(b'8' | b'9' | b'a' | b'b')
        )
    {
        return None;
    }
    Uuid::parse_str(value)
        .ok()
        .map(|parsed| parsed.hyphenated().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FixtureCase {
        name: String,
        chunks: Vec<String>,
        visible_text: String,
        entries: Vec<PiMemoryCitationEntry>,
        rollout_ids: Vec<String>,
    }

    #[derive(Deserialize)]
    struct Fixture {
        cases: Vec<FixtureCase>,
    }

    fn fixture() -> Fixture {
        serde_json::from_str(include_str!(
            "../../../../fixtures/pi-memory-citations.json"
        ))
        .expect("shared citation fixture must parse")
    }

    #[test]
    fn matches_shared_cross_language_fixtures() {
        for case in fixture().cases {
            let chunks: Vec<&str> = case.chunks.iter().map(String::as_str).collect();
            let projection = project_segments(&chunks);
            assert_eq!(
                projection.visible_segments.concat(),
                case.visible_text,
                "{}",
                case.name
            );
            let citation = projection.citation.unwrap_or_default();
            assert_eq!(citation.entries, case.entries, "{}", case.name);
            assert_eq!(citation.rollout_ids, case.rollout_ids, "{}", case.name);
        }
    }

    #[test]
    fn handles_every_delimiter_split() {
        let envelope = format!("{OPEN}<citation_entries>x:1-1|note=[n]</citation_entries>{CLOSE}");
        for delimiter in [OPEN, CLOSE] {
            let start = envelope.find(delimiter).expect("delimiter exists");
            for index in 1..delimiter.len() {
                let boundary = start + index;
                let first = format!("before{}", &envelope[..boundary]);
                let second = format!("{}after", &envelope[boundary..]);
                let projection = project_segments(&[first.as_str(), second.as_str()]);
                assert_eq!(projection.visible_segments.concat(), "beforeafter");
                assert_eq!(projection.citation.expect("citation").entries.len(), 1);
            }
        }
    }

    #[test]
    fn hides_oversized_body() {
        let body = "界".repeat(MAX_BODY_BYTES);
        let projection = project_segments(&[&format!("{OPEN}{body}{CLOSE}ok")]);
        assert_eq!(projection.visible_segments.concat(), "ok");
        assert!(projection.citation.is_none());
        assert_eq!(projection.diagnostics.oversized_bodies, 1);
    }

    #[test]
    fn bounds_entry_counts_and_field_bytes() {
        let mut entries = (0..65)
            .map(|index| format!("p{index}:1-1|note=[n]"))
            .collect::<Vec<_>>();
        entries.push(format!("{}:1-1|note=[n]", "界".repeat(342)));
        entries.push(format!("x:1-1|note=[{}]", "界".repeat(683)));
        let envelope = format!(
            "{OPEN}<citation_entries>{}</citation_entries>{CLOSE}",
            entries.join("\n")
        );
        let projection = project_segments(&[&envelope]);
        assert_eq!(
            projection.citation.expect("citation").entries.len(),
            MAX_ENTRIES
        );
        assert_eq!(projection.diagnostics.invalid_entries, 3);
    }
}
