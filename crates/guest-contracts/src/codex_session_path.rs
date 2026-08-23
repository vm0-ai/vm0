//! Shared Codex session path layout.

use chrono::{DateTime, Utc};

use crate::codex_thread_id::CodexThreadId;

/// Build the canonical Codex rollout path relative to the Codex home.
///
/// The returned path has the form
/// `sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<thread-id>.jsonl`.
pub fn codex_rollout_relative_path(thread_id: &CodexThreadId, timestamp: DateTime<Utc>) -> String {
    format!(
        "sessions/{}/{}/{}/rollout-{}-{}.jsonl",
        timestamp.format("%Y"),
        timestamp.format("%m"),
        timestamp.format("%d"),
        timestamp.format("%Y-%m-%dT%H-%M-%S"),
        thread_id.as_str(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_canonical_rollout_relative_path() {
        let thread_id = CodexThreadId::parse("019e9154-c304-70f0-adde-36efb1be1701")
            .expect("valid Codex thread id");
        let timestamp = DateTime::parse_from_rfc3339("2026-06-04T07:18:08Z")
            .expect("valid timestamp")
            .with_timezone(&Utc);

        assert_eq!(
            codex_rollout_relative_path(&thread_id, timestamp),
            "sessions/2026/06/04/rollout-2026-06-04T07-18-08-019e9154-c304-70f0-adde-36efb1be1701.jsonl"
        );
    }
}
