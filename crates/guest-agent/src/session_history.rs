//! Session-history reader — abstracts over Claude (literal jsonl path) and
//! codex (`CODEX_SEARCH:{dir}:{id}` marker → recursive scan + optional zstd decode).
//!
//! `events::extract_session_id` writes one of two payloads to
//! `paths::session_history_path_file()`:
//!
//! - Claude: a literal filesystem path to the `.jsonl` history file.
//! - Codex:  a `CODEX_SEARCH:{sessions_dir}:{thread_id}` marker. The codex
//!   CLI only writes the session file out at turn-completion time, so we
//!   defer resolution until checkpoint time when the file is on disk.
//!
//! `read_session_history` is the single entry point used by `checkpoint.rs`.
//! It returns the history bytes, decompressing legacy `.zst` files when needed.
//!
//! See parent epic #11386, sub-issue #11419 for the design rationale.
//!
//! The codex sessions layout is `${CODEX_HOME}/sessions/YYYY/MM/DD/<file>.jsonl[.zst]`.
//! Filenames are not stably keyed to thread_id in the real codex CLI
//! (the `rollout-` prefix mangles dashes), so we match by dash-stripped
//! UUID substring. If no filename matches, we fail fast — silently picking
//! "the most recent file in the tree" would risk uploading an unrelated
//! session as the resume context, which is a multi-tenant correctness
//! hazard. The descriptive `Codex session file not found` error from
//! `read_session_history` surfaces the failure instead.

use crate::error::AgentError;
use std::path::{Path, PathBuf};

const CODEX_MARKER_PREFIX: &str = "CODEX_SEARCH:";

/// Read the session history bytes pointed to by `path_file`.
///
/// The file content is either a literal path (Claude) or a
/// `CODEX_SEARCH:{dir}:{id}` marker (codex). Returns the file contents,
/// decompressed if the resolved path ends in `.zst`.
pub fn read_session_history(path_file: &str) -> Result<Vec<u8>, AgentError> {
    let raw = std::fs::read_to_string(path_file).map_err(|e| {
        AgentError::Checkpoint(format!("Failed to read history-path file {path_file}: {e}"))
    })?;
    let trimmed = raw.trim();

    let session_path = if let Some((sessions_dir, thread_id)) = decode_marker(trimmed) {
        find_codex_session_file(&sessions_dir, thread_id).ok_or_else(|| {
            AgentError::Checkpoint(format!(
                "Codex session file not found under {} for thread_id {thread_id}",
                sessions_dir.display()
            ))
        })?
    } else {
        PathBuf::from(trimmed)
    };

    read_history_bytes(&session_path)
}

/// Parse `CODEX_SEARCH:{dir}:{thread_id}` into `(dir, thread_id)`. Returns
/// `None` for any input that doesn't carry the prefix (Claude path).
fn decode_marker(content: &str) -> Option<(PathBuf, &str)> {
    let rest = content.strip_prefix(CODEX_MARKER_PREFIX)?;
    let last_colon = rest.rfind(':')?;
    let (dir, id_with_colon) = rest.split_at(last_colon);
    let thread_id = &id_with_colon[1..];
    if dir.is_empty() || thread_id.is_empty() {
        return None;
    }
    Some((PathBuf::from(dir), thread_id))
}

/// Resolve a codex session file under `sessions_dir` by matching the
/// dash-stripped `thread_id` substring against filenames. Returns `None`
/// if no file matches — callers should propagate this as
/// "session file not found" rather than guessing at an alternative,
/// because picking the wrong session would corrupt resume state.
fn find_codex_session_file(sessions_dir: &Path, thread_id: &str) -> Option<PathBuf> {
    let mut all_jsonl = Vec::new();
    walk_recursive(sessions_dir, &mut all_jsonl, |p| {
        let s = p.to_string_lossy();
        s.ends_with(".jsonl") || s.ends_with(".jsonl.zst")
    });

    let id_norm = thread_id.replace('-', "");
    for path in all_jsonl {
        if let Some(name) = path.file_name() {
            let name_norm = name.to_string_lossy().replace('-', "");
            if name_norm.contains(&id_norm) {
                return Some(path);
            }
        }
    }

    None
}

/// DFS walk of `dir`, pushing matching paths into `sink`. Silently skips
/// directories that fail to open — codex's date-based layout means most
/// `YYYY/MM/DD/` subtrees won't exist on a given run, and an io error here
/// would mask the real lookup failure (no matching file) downstream.
fn walk_recursive<F>(dir: &Path, sink: &mut Vec<PathBuf>, predicate: F)
where
    F: Fn(&Path) -> bool + Copy,
{
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_recursive(&path, sink, predicate);
        } else if predicate(&path) {
            sink.push(path);
        }
    }
}

/// Read the bytes at `path`, decompressing legacy zstd files if the extension is `.zst`.
fn read_history_bytes(path: &Path) -> Result<Vec<u8>, AgentError> {
    let raw = std::fs::read(path).map_err(|e| {
        AgentError::Checkpoint(format!(
            "Failed to read session history at {}: {e}",
            path.display()
        ))
    })?;
    if path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("zst"))
    {
        zstd::decode_all(raw.as_slice()).map_err(|e| {
            AgentError::Checkpoint(format!(
                "Failed to decompress zstd session history at {}: {e}",
                path.display()
            ))
        })
    } else {
        Ok(raw)
    }
}

// Note: integration coverage for the public `read_session_history` entry
// (both Claude literal-path and codex marker → recursive scan + zstd
// decode) lives in `crates/guest-agent/tests/codex_session_resume.rs`,
// driven via the `send_event` → checkpoint flow. The internal helpers
// (`find_codex_session_file`, `walk_recursive`, `read_history_bytes`,
// `decode_marker`) are exercised transitively by those integration
// tests, in line with the project's "integration tests only" policy
// (`docs/testing.md`, `CLAUDE.md`).
//
// `decode_marker` is the one piece of non-trivial parsing logic; if it
// regresses, the integration tests will catch it because the codex flow
// can't resolve a session without a valid marker.
