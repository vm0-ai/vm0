//! Session-history reader — abstracts over Claude (literal jsonl path) and
//! codex (`CODEX_SEARCH:{dir}:{id}` marker → recursive scan + zstd decode).
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
//! It returns the decompressed bytes regardless of the source format.
//!
//! See parent epic #11386, sub-issue #11419 for the design rationale.
//!
//! The codex sessions layout is `${CODEX_HOME}/sessions/YYYY/MM/DD/<file>.jsonl[.zst]`.
//! Filenames are not stably keyed to thread_id in the real codex CLI
//! (the `rollout-` prefix mangles dashes), so we match by dash-stripped
//! UUID substring with a most-recent-mtime fallback.

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

/// Resolve a codex session file under `sessions_dir`. Prefers a filename
/// that contains the dash-stripped `thread_id`; falls back to the most
/// recently modified `*.jsonl[.zst]` if no id match exists.
fn find_codex_session_file(sessions_dir: &Path, thread_id: &str) -> Option<PathBuf> {
    let mut all_jsonl = Vec::new();
    walk_recursive(sessions_dir, &mut all_jsonl, |p| {
        let s = p.to_string_lossy();
        s.ends_with(".jsonl") || s.ends_with(".jsonl.zst")
    });

    let id_norm = thread_id.replace('-', "");
    for path in &all_jsonl {
        if let Some(name) = path.file_name() {
            let name_norm = name.to_string_lossy().replace('-', "");
            if name_norm.contains(&id_norm) {
                return Some(path.clone());
            }
        }
    }

    all_jsonl
        .into_iter()
        .max_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok())
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

/// Read the bytes at `path`, decompressing zstd if the extension is `.zst`.
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{File, create_dir_all, write};
    use std::io::Write as _;
    use tempfile::TempDir;

    /// Build a `YYYY/MM/DD/` style nested path under `root` and write a file.
    fn write_session_file(root: &Path, sub: &[&str], filename: &str, content: &[u8]) -> PathBuf {
        let mut dir = root.to_path_buf();
        for s in sub {
            dir.push(s);
        }
        create_dir_all(&dir).unwrap();
        let path = dir.join(filename);
        let mut f = File::create(&path).unwrap();
        f.write_all(content).unwrap();
        path
    }

    #[test]
    fn find_codex_session_by_id_in_filename() {
        let tmp = TempDir::new().unwrap();
        let thread_id = "0193abcd-ef01-7234-89ab-cdef01234567";
        let p = write_session_file(
            tmp.path(),
            &["2026", "04", "28"],
            &format!("{thread_id}.jsonl.zst"),
            b"x",
        );
        let found = find_codex_session_file(tmp.path(), thread_id).unwrap();
        assert_eq!(found, p);
    }

    #[test]
    fn find_codex_session_by_id_with_dashes_stripped() {
        let tmp = TempDir::new().unwrap();
        let thread_id = "0193abcd-ef01-7234-89ab-cdef01234567";
        let id_no_dashes = thread_id.replace('-', "");
        // Real codex CLI prefixes filenames with `rollout-`; the prefix
        // strips the UUID's dashes when concatenated.
        let p = write_session_file(
            tmp.path(),
            &["2026", "04", "28"],
            &format!("rollout-2026-04-28T11-22-37-{id_no_dashes}.jsonl.zst"),
            b"x",
        );
        let found = find_codex_session_file(tmp.path(), thread_id).unwrap();
        assert_eq!(found, p);
    }

    #[test]
    fn find_codex_session_falls_back_to_most_recent() {
        let tmp = TempDir::new().unwrap();
        write_session_file(
            tmp.path(),
            &["2026", "04", "27"],
            "rollout-old.jsonl.zst",
            b"a",
        );
        // Sleep so the second file gets a strictly later mtime. fs mtime
        // resolution on Linux ext4/tmpfs is typically nanosecond, but
        // CI filesystems vary — 50ms is a safe floor.
        std::thread::sleep(std::time::Duration::from_millis(50));
        let newer = write_session_file(
            tmp.path(),
            &["2026", "04", "28"],
            "rollout-new.jsonl.zst",
            b"b",
        );
        let unknown_id = "ffffffff-ffff-7fff-bfff-ffffffffffff";
        let found = find_codex_session_file(tmp.path(), unknown_id).unwrap();
        assert_eq!(found, newer);
    }

    #[test]
    fn find_codex_session_empty_dir() {
        let tmp = TempDir::new().unwrap();
        let id = "0193abcd-ef01-7234-89ab-cdef01234567";
        assert!(find_codex_session_file(tmp.path(), id).is_none());
    }

    #[test]
    fn find_jsonl_files_recursive() {
        let tmp = TempDir::new().unwrap();
        write_session_file(tmp.path(), &["2026", "04", "27"], "a.jsonl.zst", b"a");
        write_session_file(tmp.path(), &["2026", "04", "28"], "b.jsonl", b"b");
        // Should be ignored (wrong extension).
        write_session_file(tmp.path(), &["2026", "04", "28"], "c.txt", b"c");
        let mut found = Vec::new();
        walk_recursive(tmp.path(), &mut found, |p| {
            let s = p.to_string_lossy();
            s.ends_with(".jsonl") || s.ends_with(".jsonl.zst")
        });
        assert_eq!(found.len(), 2);
        let names: Vec<String> = found
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert!(names.contains(&"a.jsonl.zst".to_string()));
        assert!(names.contains(&"b.jsonl".to_string()));
    }

    #[test]
    fn decompress_jsonl_zst_round_trip() {
        let tmp = TempDir::new().unwrap();
        let original = b"{\"type\":\"thread.started\",\"thread_id\":\"abc\"}\n".to_vec();
        let compressed = zstd::encode_all(original.as_slice(), 0).unwrap();
        let path = tmp.path().join("session.jsonl.zst");
        write(&path, &compressed).unwrap();
        let bytes = read_history_bytes(&path).unwrap();
        assert_eq!(bytes, original);
    }

    #[test]
    fn decode_marker_round_trip() {
        let (dir, id) =
            decode_marker("CODEX_SEARCH:/home/user/.codex/sessions:0193abcd-ef01-7234-89ab")
                .unwrap();
        assert_eq!(dir, PathBuf::from("/home/user/.codex/sessions"));
        assert_eq!(id, "0193abcd-ef01-7234-89ab");
    }

    #[test]
    fn decode_marker_returns_none_for_literal_path() {
        assert!(decode_marker("/home/user/.claude/projects/-foo/abc.jsonl").is_none());
    }

    #[test]
    fn read_session_history_claude_literal_path() {
        let tmp = TempDir::new().unwrap();
        let history = tmp.path().join("session.jsonl");
        write(&history, b"line1\nline2\n").unwrap();
        let path_file = tmp.path().join("path.txt");
        write(&path_file, history.to_string_lossy().as_bytes()).unwrap();
        let bytes = read_session_history(path_file.to_str().unwrap()).unwrap();
        assert_eq!(bytes, b"line1\nline2\n");
    }

    #[test]
    fn read_session_history_codex_marker() {
        let tmp = TempDir::new().unwrap();
        let sessions_dir = tmp.path().join("sessions");
        let thread_id = "0193abcd-ef01-7234-89ab-cdef01234567";
        let history = b"{\"type\":\"thread.started\"}\n";
        let compressed = zstd::encode_all(history.as_slice(), 0).unwrap();
        write_session_file(
            &sessions_dir,
            &["2026", "04", "28"],
            &format!("{thread_id}.jsonl.zst"),
            &compressed,
        );
        let path_file = tmp.path().join("path.txt");
        let marker = format!(
            "CODEX_SEARCH:{}:{thread_id}",
            sessions_dir.to_string_lossy()
        );
        write(&path_file, marker.as_bytes()).unwrap();
        let bytes = read_session_history(path_file.to_str().unwrap()).unwrap();
        assert_eq!(bytes, history);
    }
}
