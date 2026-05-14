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
use std::ffi::OsStr;
use std::io;
use std::path::{Path, PathBuf};

#[cfg(target_os = "linux")]
use std::{fs::File, io::Read};

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

    if let Some((sessions_dir, thread_id)) = decode_marker(trimmed) {
        return read_codex_session_history(&sessions_dir, thread_id)?.ok_or_else(|| {
            AgentError::Checkpoint(format!(
                "Codex session file not found under {} for thread_id {thread_id}",
                sessions_dir.display()
            ))
        });
    }

    let session_path = PathBuf::from(trimmed);
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

fn read_codex_session_history(
    sessions_dir: &Path,
    thread_id: &str,
) -> Result<Option<Vec<u8>>, AgentError> {
    let Some(id_norm) = normalize_codex_thread_id(thread_id) else {
        return Ok(None);
    };
    read_codex_session_history_impl(sessions_dir, &id_norm)
}

pub(crate) fn normalize_codex_thread_id(thread_id: &str) -> Option<String> {
    let id_norm = thread_id.replace('-', "");
    if id_norm.len() != 32 || !id_norm.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some(id_norm.to_ascii_lowercase())
}

#[cfg(not(target_os = "linux"))]
fn read_codex_session_history_impl(
    sessions_dir: &Path,
    id_norm: &str,
) -> Result<Option<Vec<u8>>, AgentError> {
    if !std::fs::symlink_metadata(sessions_dir)
        .ok()
        .is_some_and(|metadata| metadata.file_type().is_dir())
    {
        return Ok(None);
    }

    let Some(path) = find_codex_session_file_recursive(sessions_dir, id_norm) else {
        return Ok(None);
    };
    read_history_bytes(&path).map(Some)
}

#[cfg(not(target_os = "linux"))]
/// DFS walk of `dir`, returning the first matching real file. Symlinks
/// are skipped because the Codex sessions tree is user-controlled
/// filesystem state and checkpoint lookup must not follow it outside the
/// expected history directory.
fn find_codex_session_file_recursive(dir: &Path, id_norm: &str) -> Option<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return None;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if file_type.is_dir() {
            if let Some(found) = find_codex_session_file_recursive(&path, id_norm) {
                return Some(found);
            }
        } else if file_type.is_file()
            && path
                .file_name()
                .is_some_and(|name| codex_session_filename_matches(name, id_norm))
        {
            return Some(path);
        }
    }

    None
}

#[cfg(target_os = "linux")]
fn read_codex_session_history_impl(
    sessions_dir: &Path,
    id_norm: &str,
) -> Result<Option<Vec<u8>>, AgentError> {
    let Ok(root) = open_codex_session_dir(sessions_dir) else {
        return Ok(None);
    };
    find_and_read_codex_session_file_recursive(&root, sessions_dir, id_norm)
}

#[cfg(target_os = "linux")]
fn find_and_read_codex_session_file_recursive(
    dir: &File,
    dir_path: &Path,
    id_norm: &str,
) -> Result<Option<Vec<u8>>, AgentError> {
    let Ok(entries) = read_dir_fd(dir) else {
        return Ok(None);
    };

    for entry in entries.flatten() {
        let name = entry.file_name();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = dir_path.join(&name);
        if file_type.is_dir() {
            let Ok(child) = open_codex_child_dir(dir, &name) else {
                continue;
            };
            if let Some(found) = find_and_read_codex_session_file_recursive(&child, &path, id_norm)?
            {
                return Ok(Some(found));
            }
        } else if file_type.is_file() && codex_session_filename_matches(&name, id_norm) {
            let file = match open_codex_child_file(dir, &name) {
                Ok(file) => file,
                Err(e) if should_skip_raced_codex_entry(&e) => continue,
                Err(e) => return Err(read_history_error(&path, e)),
            };
            if !file
                .metadata()
                .ok()
                .is_some_and(|metadata| metadata.file_type().is_file())
            {
                continue;
            }
            return read_history_bytes_from_file(&path, file).map(Some);
        }
    }

    Ok(None)
}

fn codex_session_filename_matches(name: &OsStr, id_norm: &str) -> bool {
    let name = name.to_string_lossy();
    if !(name.ends_with(".jsonl") || name.ends_with(".jsonl.zst")) {
        return false;
    }

    let name_norm = name.replace('-', "").to_ascii_lowercase();
    name_norm.contains(id_norm)
}

#[cfg(target_os = "linux")]
fn read_dir_fd(dir: &File) -> io::Result<std::fs::ReadDir> {
    use std::os::fd::AsRawFd;

    std::fs::read_dir(PathBuf::from(format!("/proc/self/fd/{}", dir.as_raw_fd())))
}

#[cfg(target_os = "linux")]
fn open_codex_session_dir(path: &Path) -> io::Result<File> {
    use std::fs::OpenOptions;
    use std::os::unix::fs::OpenOptionsExt;

    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
}

#[cfg(target_os = "linux")]
fn open_codex_child_dir(parent: &File, name: &OsStr) -> io::Result<File> {
    open_codex_child(
        parent,
        name,
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    )
}

#[cfg(target_os = "linux")]
fn open_codex_child_file(parent: &File, name: &OsStr) -> io::Result<File> {
    open_codex_child(
        parent,
        name,
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
    )
}

#[cfg(target_os = "linux")]
fn open_codex_child(parent: &File, name: &OsStr, flags: i32) -> io::Result<File> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;

    let name = CString::new(name.as_bytes())
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

#[cfg(target_os = "linux")]
fn should_skip_raced_codex_entry(err: &io::Error) -> bool {
    matches!(
        err.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
    ) || err.raw_os_error() == Some(libc::ELOOP)
}

/// Read the bytes at `path`, decompressing legacy zstd files if the extension is `.zst`.
fn read_history_bytes(path: &Path) -> Result<Vec<u8>, AgentError> {
    let raw = std::fs::read(path).map_err(|e| read_history_error(path, e))?;
    decode_history_bytes(path, raw)
}

#[cfg(target_os = "linux")]
fn read_history_bytes_from_file(path: &Path, mut file: File) -> Result<Vec<u8>, AgentError> {
    let mut raw = Vec::new();
    file.read_to_end(&mut raw)
        .map_err(|e| read_history_error(path, e))?;
    decode_history_bytes(path, raw)
}

fn read_history_error(path: &Path, source: io::Error) -> AgentError {
    AgentError::Checkpoint(format!(
        "Failed to read session history at {}: {source}",
        path.display()
    ))
}

fn decode_history_bytes(path: &Path, raw: Vec<u8>) -> Result<Vec<u8>, AgentError> {
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
// (`read_codex_session_history`, `codex_session_filename_matches`,
// `read_history_bytes`, `decode_marker`) are exercised transitively by
// those integration tests, in line with the project's "integration
// tests only" policy (`docs/testing.md`, `CLAUDE.md`).
//
// `decode_marker` is the one piece of non-trivial parsing logic; if it
// regresses, the integration tests will catch it because the codex flow
// can't resolve a session without a valid marker.
