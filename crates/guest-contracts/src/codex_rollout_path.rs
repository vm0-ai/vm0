//! Canonical Codex rollout path shared by runner and guest code.
//!
//! The persisted value is relative to `~/.codex/sessions` and always uses the
//! logical `.jsonl` representation. A physical `.jsonl.zst` file has the same
//! logical path with only the trailing `.zst` removed.

use std::path::{Component, Path};

use crate::codex_thread_id::CodexThreadId;

const ROLLOUT_PREFIX: &str = "rollout-";
const LOGICAL_EXTENSION: &str = ".jsonl";
const COMPRESSED_EXTENSION: &str = ".jsonl.zst";
const TIMESTAMP_LEN: usize = 19;

/// Validated Codex rollout path relative to `~/.codex/sessions`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CodexRolloutPath {
    relative: String,
}

impl CodexRolloutPath {
    /// Parse a canonical logical rollout path bound to `thread_id`.
    pub fn parse(raw: &str, thread_id: &CodexThreadId) -> Option<Self> {
        let [year, month, day, file_name] = exact_path_components(raw)?;
        let timestamp_and_thread = file_name
            .strip_prefix(ROLLOUT_PREFIX)?
            .strip_suffix(LOGICAL_EXTENSION)?;
        if timestamp_and_thread.len() <= TIMESTAMP_LEN {
            return None;
        }
        let (timestamp, thread_suffix) = timestamp_and_thread.split_at(TIMESTAMP_LEN);
        let file_thread_id = CodexThreadId::parse(thread_suffix.strip_prefix('-')?)?;
        if &file_thread_id != thread_id
            || !valid_timestamp(timestamp)
            || timestamp.get(..10)? != format!("{year}-{month}-{day}")
        {
            return None;
        }

        Some(Self {
            relative: raw.to_owned(),
        })
    }

    /// Derive a canonical logical path from a physical Codex session file.
    pub fn from_session_file(
        sessions_dir: &Path,
        session_file: &Path,
        thread_id: &CodexThreadId,
    ) -> Option<Self> {
        let relative = session_file.strip_prefix(sessions_dir).ok()?.to_str()?;
        let logical = relative
            .strip_suffix(COMPRESSED_EXTENSION)
            .map(|prefix| format!("{prefix}{LOGICAL_EXTENSION}"))
            .unwrap_or_else(|| relative.to_owned());
        Self::parse(&logical, thread_id)
    }

    /// Return the canonical path relative to `~/.codex/sessions`.
    pub fn as_str(&self) -> &str {
        &self.relative
    }

    /// Consume the path and return its canonical relative text.
    pub fn into_string(self) -> String {
        self.relative
    }
}

fn exact_path_components(raw: &str) -> Option<[&str; 4]> {
    let components = Path::new(raw)
        .components()
        .map(|component| match component {
            Component::Normal(value) => value.to_str(),
            Component::Prefix(_)
            | Component::RootDir
            | Component::CurDir
            | Component::ParentDir => None,
        })
        .collect::<Option<Vec<_>>>()?;
    let [year, month, day, file_name] = components.as_slice() else {
        return None;
    };
    if raw != format!("{year}/{month}/{day}/{file_name}") {
        return None;
    }
    Some([year, month, day, file_name])
}

fn valid_timestamp(timestamp: &str) -> bool {
    let &[
        year_1,
        year_2,
        year_3,
        year_4,
        b'-',
        month_1,
        month_2,
        b'-',
        day_1,
        day_2,
        b'T',
        hour_1,
        hour_2,
        b'-',
        minute_1,
        minute_2,
        b'-',
        second_1,
        second_2,
    ] = timestamp.as_bytes()
    else {
        return false;
    };
    if ![
        year_1, year_2, year_3, year_4, month_1, month_2, day_1, day_2, hour_1, hour_2, minute_1,
        minute_2, second_1, second_2,
    ]
    .into_iter()
    .all(|byte| byte.is_ascii_digit())
    {
        return false;
    }

    let Some(year) = timestamp.get(0..4).and_then(parse_u32) else {
        return false;
    };
    let Some(month) = timestamp.get(5..7).and_then(parse_u32) else {
        return false;
    };
    let Some(day) = timestamp.get(8..10).and_then(parse_u32) else {
        return false;
    };
    let Some(hour) = timestamp.get(11..13).and_then(parse_u32) else {
        return false;
    };
    let Some(minute) = timestamp.get(14..16).and_then(parse_u32) else {
        return false;
    };
    let Some(second) = timestamp.get(17..19).and_then(parse_u32) else {
        return false;
    };
    let Some(max_day) = days_in_month(year, month) else {
        return false;
    };
    (1..=max_day).contains(&day) && hour < 24 && minute < 60 && second < 60
}

fn parse_u32(value: &str) -> Option<u32> {
    value.parse().ok()
}

fn days_in_month(year: u32, month: u32) -> Option<u32> {
    if !(1..=9999).contains(&year) {
        return None;
    }
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => Some(31),
        4 | 6 | 9 | 11 => Some(30),
        2 if is_leap_year(year) => Some(29),
        2 => Some(28),
        _ => None,
    }
}

fn is_leap_year(year: u32) -> bool {
    year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400))
}

#[cfg(test)]
mod tests {
    use super::*;

    const THREAD_ID: &str = "019e9154-c304-70f0-adde-36efb1be1701";
    const COMPACT_THREAD_ID: &str = "019e9154c30470f0adde36efb1be1701";
    const LOGICAL_PATH: &str = concat!(
        "2026/06/04/rollout-2026-06-04T07-18-08-",
        "019e9154-c304-70f0-adde-36efb1be1701.jsonl"
    );

    fn thread_id() -> CodexThreadId {
        CodexThreadId::parse(THREAD_ID).expect("valid test thread id")
    }

    #[test]
    fn parses_canonical_logical_path() {
        let path = CodexRolloutPath::parse(LOGICAL_PATH, &thread_id())
            .expect("valid logical rollout path");

        assert_eq!(path.as_str(), LOGICAL_PATH);
    }

    #[test]
    fn accepts_compact_thread_id_in_filename() {
        let raw = format!("2026/06/04/rollout-2026-06-04T07-18-08-{COMPACT_THREAD_ID}.jsonl");

        let path = CodexRolloutPath::parse(&raw, &thread_id()).expect("valid compact filename id");

        assert_eq!(path.as_str(), raw);
    }

    #[test]
    fn normalizes_physical_zstd_file_to_logical_path() {
        let sessions_dir = Path::new("/home/user/.codex/sessions");
        let physical_path = sessions_dir.join(format!("{LOGICAL_PATH}.zst"));

        let path = CodexRolloutPath::from_session_file(sessions_dir, &physical_path, &thread_id())
            .expect("valid compressed rollout path");

        assert_eq!(path.as_str(), LOGICAL_PATH);
    }

    #[test]
    fn rejects_unsafe_or_mismatched_paths() {
        for raw in [
            "/home/user/.codex/sessions/2026/06/04/rollout.jsonl",
            "../2026/06/04/rollout.jsonl",
            "2026//06/04/rollout-2026-06-04T07-18-08-019e9154-c304-70f0-adde-36efb1be1701.jsonl",
            "2026/06/04/rollout-2026-06-05T07-18-08-019e9154-c304-70f0-adde-36efb1be1701.jsonl",
            "2026/02/29/rollout-2026-02-29T07-18-08-019e9154-c304-70f0-adde-36efb1be1701.jsonl",
            "2026/06/04/rollout-2026-06-04T24-18-08-019e9154-c304-70f0-adde-36efb1be1701.jsonl",
            "2026/06/04/rollout-2026-06-04T07-18-08-019e9154-c304-70f0-adde-36efb1be1702.jsonl",
            "2026/06/04/rollout-2026-06-04T07-18-08-019e9154-c304-70f0-adde-36efb1be1701.jsonl.zst",
        ] {
            assert!(
                CodexRolloutPath::parse(raw, &thread_id()).is_none(),
                "expected rejection for {raw:?}"
            );
        }
    }
}
