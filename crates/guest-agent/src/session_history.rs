//! Session-history reader — abstracts over Claude (literal jsonl path) and
//! codex (`CODEX_SEARCH:{dir_len}:{dir}:{id}` marker → bounded layout scan +
//! optional zstd decode).
//!
//! The event metadata capture path writes one of two payloads to the
//! `GuestPaths::session_history_path_file()` runtime file:
//!
//! - Claude: a literal filesystem path to the `.jsonl` history file.
//! - Codex:  a length-prefixed
//!   `CODEX_SEARCH:{dir_len}:{sessions_dir}:{thread_id}` marker. The codex
//!   CLI only writes the session file out at turn-completion time, so we defer
//!   resolution until checkpoint time when the file is on disk.
//!
//! `read_session_history` is the file-backed entry point. Checkpoint resolves
//! missing marker payloads first, then calls `read_session_history_from_payload`.
//! Both paths return history bytes, decompressing legacy `.zst` files when
//! needed.
//!
//! See parent epic #11386, sub-issue #11419 for the design rationale.
//!
//! The codex sessions layout is `${CODEX_HOME}/sessions/YYYY/MM/DD/<file>.jsonl[.zst]`.
//! Filenames are not stably keyed to thread_id in the real codex CLI
//! (the `rollout-` prefix mangles dashes), so we match by dash-stripped
//! UUID substring. Lookup only scans the expected `YYYY/MM/DD` layout and is
//! budgeted so user-controlled session trees cannot make checkpoint perform an
//! unbounded filesystem walk. If no filename matches, we fail fast — silently
//! picking "the most recent file in the tree" would risk uploading an unrelated
//! session as the resume context, which is a multi-tenant correctness hazard.
//! The descriptive `Codex session file not found` error from
//! `read_session_history` surfaces the failure without logging the session id.

use crate::error::AgentError;
#[cfg(target_os = "linux")]
use crate::nofollow_fs::Dir;
use guest_contracts::codex_thread_id::codex_thread_id_filename_key;
use sha2::{Digest, Sha256};
use std::ffi::OsStr;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

#[cfg(target_os = "linux")]
use std::fs::File;

const CODEX_MARKER_PREFIX: &str = "CODEX_SEARCH:";
// Checkpoint must resolve Codex history from user-controlled guest-home state.
// Keep the budget comfortably above normal date-partitioned histories while
// preventing layout-shaped trees from turning session lookup into an
// unbounded synchronous walk.
const CODEX_SESSION_LOOKUP_SCAN_BUDGET: usize = 16_384;
const CODEX_SESSION_LOOKUP_SCAN_BUDGET_ERROR: &str = "Codex session lookup exceeded scan budget";

/// Build the persisted Codex session-history marker payload.
pub(crate) fn codex_marker_payload(sessions_dir: &Path, thread_id: &str) -> String {
    let sessions_dir = sessions_dir.display().to_string();
    format!(
        "{CODEX_MARKER_PREFIX}{}:{sessions_dir}:{thread_id}",
        sessions_dir.len()
    )
}

/// Return whether a persisted session-history payload is a Codex marker.
pub(crate) fn is_codex_marker(payload: &str) -> bool {
    payload.starts_with(CODEX_MARKER_PREFIX)
}

/// Read the session history bytes pointed to by `path_file`.
///
/// The file content is either a literal path (Claude) or a
/// codex marker. Returns the file contents, decompressed if the resolved path
/// ends in `.zst`.
pub fn read_session_history(path_file: &str) -> Result<Vec<u8>, AgentError> {
    let raw = std::fs::read_to_string(path_file).map_err(|e| {
        AgentError::Checkpoint(format!("Failed to read history-path file {path_file}: {e}"))
    })?;
    read_session_history_from_payload(raw.trim())
}

/// Read session history bytes from an already-resolved marker payload.
///
/// The payload is either a literal path (Claude) or a
/// codex marker.
pub(crate) fn read_session_history_from_payload(payload: &str) -> Result<Vec<u8>, AgentError> {
    read_session_history_from_payload_impl(payload, None)
}

/// Read decoded session history bytes without returning more than `max_bytes`.
///
/// The implementation reads one extra decoded byte to detect over-limit
/// histories without consuming an unbounded stream.
pub(crate) fn read_session_history_from_payload_bounded(
    payload: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, AgentError> {
    read_session_history_from_payload_impl(payload, Some(max_bytes))
}

fn session_history_exceeds_max_error(max_bytes: u64) -> AgentError {
    AgentError::Checkpoint(format!(
        "Session history exceeds maximum size of {max_bytes} bytes"
    ))
}

pub(crate) struct SessionHistoryDigest {
    pub(crate) size_bytes: u64,
    pub(crate) sha256_hex: String,
}

#[derive(Debug)]
pub(crate) enum SessionHistoryDigestError {
    Read(AgentError),
    ExceedsMaxBytes,
}

impl From<AgentError> for SessionHistoryDigestError {
    fn from(error: AgentError) -> Self {
        Self::Read(error)
    }
}

/// Compute decoded session-history size and hash without returning the bytes.
pub(crate) fn digest_session_history_from_payload_bounded(
    payload: &str,
    max_bytes: u64,
) -> Result<SessionHistoryDigest, SessionHistoryDigestError> {
    if is_codex_marker(payload) {
        let Some((sessions_dir, thread_id)) = decode_marker(payload) else {
            return Err(SessionHistoryDigestError::Read(AgentError::Checkpoint(
                "Invalid Codex session history marker".to_string(),
            )));
        };
        return digest_codex_session_history(&sessions_dir, thread_id, max_bytes)?.ok_or_else(
            || {
                SessionHistoryDigestError::Read(AgentError::Checkpoint(format!(
                    "Codex session file not found under {}",
                    sessions_dir.display()
                )))
            },
        );
    }

    let session_path = PathBuf::from(payload);
    digest_history_bytes(&session_path, max_bytes)
}

fn read_session_history_from_payload_impl(
    payload: &str,
    max_bytes: Option<u64>,
) -> Result<Vec<u8>, AgentError> {
    if is_codex_marker(payload) {
        let Some((sessions_dir, thread_id)) = decode_marker(payload) else {
            return Err(AgentError::Checkpoint(
                "Invalid Codex session history marker".to_string(),
            ));
        };
        return read_codex_session_history(&sessions_dir, thread_id, max_bytes)?.ok_or_else(|| {
            AgentError::Checkpoint(format!(
                "Codex session file not found under {}",
                sessions_dir.display()
            ))
        });
    }

    let session_path = PathBuf::from(payload);
    read_history_bytes(&session_path, max_bytes)
}

/// Parse a Codex marker into `(dir, thread_id)`. Markers are length-prefixed so
/// paths containing `:` cannot be confused with decorated thread IDs.
fn decode_marker(content: &str) -> Option<(PathBuf, &str)> {
    if let Some(rest) = content.strip_prefix(CODEX_MARKER_PREFIX) {
        return decode_len_prefixed_marker(rest);
    }

    None
}

fn decode_len_prefixed_marker(rest: &str) -> Option<(PathBuf, &str)> {
    let (dir_len, payload) = rest.split_once(':')?;
    let dir_len: usize = dir_len.parse().ok()?;
    if dir_len == 0 || payload.len() <= dir_len || !payload.is_char_boundary(dir_len) {
        return None;
    }

    let (dir, delimiter_and_thread_id) = payload.split_at(dir_len);
    let thread_id = delimiter_and_thread_id.strip_prefix(':')?;
    if thread_id.is_empty() {
        return None;
    }
    Some((PathBuf::from(dir), thread_id))
}

fn read_codex_session_history(
    sessions_dir: &Path,
    thread_id: &str,
    max_bytes: Option<u64>,
) -> Result<Option<Vec<u8>>, AgentError> {
    let Some(id_norm) = codex_thread_id_filename_key(thread_id) else {
        return Ok(None);
    };
    if !codex_sessions_parent_is_usable(sessions_dir)? {
        return Ok(None);
    }
    read_codex_session_history_impl(sessions_dir, &id_norm, max_bytes)
}

fn digest_codex_session_history(
    sessions_dir: &Path,
    thread_id: &str,
    max_bytes: u64,
) -> Result<Option<SessionHistoryDigest>, SessionHistoryDigestError> {
    let Some(id_norm) = codex_thread_id_filename_key(thread_id) else {
        return Ok(None);
    };
    if !codex_sessions_parent_is_usable(sessions_dir)? {
        return Ok(None);
    }
    digest_codex_session_history_impl(sessions_dir, &id_norm, max_bytes)
}

fn codex_sessions_parent_is_usable(sessions_dir: &Path) -> Result<bool, AgentError> {
    let Some(parent) = sessions_dir.parent() else {
        return Ok(true);
    };
    if parent.as_os_str().is_empty() {
        return Ok(true);
    }
    match std::fs::symlink_metadata(parent) {
        Ok(metadata) => Ok(metadata.file_type().is_dir()),
        Err(err) if should_skip_unusable_codex_entry(&err) => Ok(false),
        Err(err) => Err(read_history_error(parent, err)),
    }
}

fn read_codex_session_history_impl(
    sessions_dir: &Path,
    id_norm: &str,
    max_bytes: Option<u64>,
) -> Result<Option<Vec<u8>>, AgentError> {
    let Some(root) = CodexSessionDir::open_root(sessions_dir)? else {
        return Ok(None);
    };
    let mut found = None;
    let mut budget = CodexSessionLookupBudget::new();
    scan_codex_session_dirs(
        &root,
        root.path(),
        CodexSessionDateLevel::Year,
        id_norm,
        &mut found,
        &mut budget,
    )?;
    found.map(|session| session.read(max_bytes)).transpose()
}

fn digest_codex_session_history_impl(
    sessions_dir: &Path,
    id_norm: &str,
    max_bytes: u64,
) -> Result<Option<SessionHistoryDigest>, SessionHistoryDigestError> {
    let Some(root) = CodexSessionDir::open_root(sessions_dir)? else {
        return Ok(None);
    };
    let mut found = None;
    let mut budget = CodexSessionLookupBudget::new();
    scan_codex_session_dirs(
        &root,
        root.path(),
        CodexSessionDateLevel::Year,
        id_norm,
        &mut found,
        &mut budget,
    )?;
    found.map(|session| session.digest(max_bytes)).transpose()
}

fn scan_codex_session_dirs(
    dir: &CodexSessionDir,
    root_path: &Path,
    level: CodexSessionDateLevel,
    id_norm: &str,
    found: &mut Option<ResolvedCodexSession>,
    budget: &mut CodexSessionLookupBudget,
) -> Result<(), AgentError> {
    let entries = match dir.read_dir() {
        Ok(entries) => entries,
        Err(err) if should_skip_unusable_codex_entry(&err) => return Ok(()),
        Err(err) => return Err(read_history_error(dir.path(), err)),
    };

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) if should_skip_unusable_codex_entry(&err) => continue,
            Err(err) => return Err(read_history_error(dir.path(), err)),
        };
        budget.inspect_entry()?;

        let name = entry.file_name();
        let path = dir.child_path(&name);
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(err) if should_skip_unusable_codex_entry(&err) => continue,
            Err(err) => return Err(read_history_error(&path, err)),
        };
        if file_type.is_dir() && level.matches(&name) {
            let child = match dir.open_child_dir(&name) {
                Ok(child) => child,
                Err(err) if should_skip_unusable_codex_entry(&err) => continue,
                Err(err) => return Err(read_history_error(&path, err)),
            };
            match level.next() {
                Some(next_level) => {
                    scan_codex_session_dirs(&child, root_path, next_level, id_norm, found, budget)?;
                }
                None => scan_codex_session_leaf_files(&child, root_path, id_norm, found, budget)?,
            }
        }
    }

    Ok(())
}

fn scan_codex_session_leaf_files(
    dir: &CodexSessionDir,
    root_path: &Path,
    id_norm: &str,
    found: &mut Option<ResolvedCodexSession>,
    budget: &mut CodexSessionLookupBudget,
) -> Result<(), AgentError> {
    let entries = match dir.read_dir() {
        Ok(entries) => entries,
        Err(err) if should_skip_unusable_codex_entry(&err) => return Ok(()),
        Err(err) => return Err(read_history_error(dir.path(), err)),
    };

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) if should_skip_unusable_codex_entry(&err) => continue,
            Err(err) => return Err(read_history_error(dir.path(), err)),
        };
        budget.inspect_entry()?;

        let name = entry.file_name();
        let path = dir.child_path(&name);
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(err) if should_skip_unusable_codex_entry(&err) => continue,
            Err(err) => return Err(read_history_error(&path, err)),
        };
        if file_type.is_file() && codex_session_filename_matches(&name, id_norm) {
            let Some(session) = dir.resolve_leaf_file(&name, path)? else {
                continue;
            };
            if found.is_some() {
                return Err(duplicate_codex_session_error(root_path));
            }
            *found = Some(session);
        }
    }

    Ok(())
}

struct CodexSessionDir {
    path: PathBuf,
    #[cfg(target_os = "linux")]
    dir: Dir,
}

impl CodexSessionDir {
    fn open_root(path: &Path) -> Result<Option<Self>, AgentError> {
        Self::open_root_impl(path)
    }

    #[cfg(target_os = "linux")]
    fn open_root_impl(path: &Path) -> Result<Option<Self>, AgentError> {
        match Dir::open(path) {
            Ok(dir) => Ok(Some(Self {
                path: path.to_path_buf(),
                dir,
            })),
            Err(err) if should_skip_unusable_codex_entry(&err) => Ok(None),
            Err(err) => Err(read_history_error(path, err)),
        }
    }

    #[cfg(not(target_os = "linux"))]
    fn open_root_impl(path: &Path) -> Result<Option<Self>, AgentError> {
        match std::fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_dir() => Ok(Some(Self {
                path: path.to_path_buf(),
            })),
            Ok(_) => Ok(None),
            Err(err) if should_skip_unusable_codex_entry(&err) => Ok(None),
            Err(err) => Err(read_history_error(path, err)),
        }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn child_path(&self, name: &OsStr) -> PathBuf {
        self.path.join(Path::new(name))
    }

    #[cfg(target_os = "linux")]
    fn read_dir(&self) -> io::Result<std::fs::ReadDir> {
        self.dir.read_dir()
    }

    #[cfg(not(target_os = "linux"))]
    fn read_dir(&self) -> io::Result<std::fs::ReadDir> {
        std::fs::read_dir(&self.path)
    }

    #[cfg(target_os = "linux")]
    fn open_child_dir(&self, name: &OsStr) -> io::Result<Self> {
        let dir = self.dir.open_child_dir(name)?;
        Ok(Self {
            path: self.child_path(name),
            dir,
        })
    }

    #[cfg(not(target_os = "linux"))]
    fn open_child_dir(&self, name: &OsStr) -> io::Result<Self> {
        Ok(Self {
            path: self.child_path(name),
        })
    }

    #[cfg(target_os = "linux")]
    fn resolve_leaf_file(
        &self,
        name: &OsStr,
        path: PathBuf,
    ) -> Result<Option<ResolvedCodexSession>, AgentError> {
        let file = match self.dir.open_child_file(name) {
            Ok(file) => file,
            Err(err) if should_skip_unusable_codex_entry(&err) => return Ok(None),
            Err(err) => return Err(read_history_error(&path, err)),
        };
        let metadata = file
            .metadata()
            .map_err(|err| read_history_error(&path, err))?;
        if !metadata.file_type().is_file() {
            return Ok(None);
        }
        Ok(Some(ResolvedCodexSession { path, file }))
    }

    #[cfg(not(target_os = "linux"))]
    fn resolve_leaf_file(
        &self,
        _name: &OsStr,
        path: PathBuf,
    ) -> Result<Option<ResolvedCodexSession>, AgentError> {
        Ok(Some(ResolvedCodexSession { path }))
    }
}

#[derive(Clone, Copy)]
enum CodexSessionDateLevel {
    Year,
    Month,
    Day,
}

impl CodexSessionDateLevel {
    fn matches(self, name: &OsStr) -> bool {
        match self {
            Self::Year => is_codex_session_year_dir_name(name),
            Self::Month => is_codex_session_month_dir_name(name),
            Self::Day => is_codex_session_day_dir_name(name),
        }
    }

    fn next(self) -> Option<Self> {
        match self {
            Self::Year => Some(Self::Month),
            Self::Month => Some(Self::Day),
            Self::Day => None,
        }
    }
}

struct ResolvedCodexSession {
    path: PathBuf,
    #[cfg(target_os = "linux")]
    file: File,
}

impl ResolvedCodexSession {
    fn read(self, max_bytes: Option<u64>) -> Result<Vec<u8>, AgentError> {
        #[cfg(target_os = "linux")]
        {
            read_history_bytes_from_file(&self.path, self.file, max_bytes)
        }

        #[cfg(not(target_os = "linux"))]
        {
            read_history_bytes(&self.path, max_bytes)
        }
    }

    fn digest(self, max_bytes: u64) -> Result<SessionHistoryDigest, SessionHistoryDigestError> {
        #[cfg(target_os = "linux")]
        {
            digest_history_bytes_from_file(&self.path, self.file, max_bytes)
        }

        #[cfg(not(target_os = "linux"))]
        {
            digest_history_bytes(&self.path, max_bytes)
        }
    }
}

struct CodexSessionLookupBudget {
    inspected_entries: usize,
}

impl CodexSessionLookupBudget {
    fn new() -> Self {
        Self {
            inspected_entries: 0,
        }
    }

    fn inspect_entry(&mut self) -> Result<(), AgentError> {
        self.inspected_entries += 1;
        if self.inspected_entries > CODEX_SESSION_LOOKUP_SCAN_BUDGET {
            return Err(AgentError::Checkpoint(
                CODEX_SESSION_LOOKUP_SCAN_BUDGET_ERROR.to_string(),
            ));
        }
        Ok(())
    }
}

fn duplicate_codex_session_error(root: &Path) -> AgentError {
    AgentError::Checkpoint(format!(
        "Multiple Codex session files found under {}",
        root.display()
    ))
}

fn codex_session_filename_matches(name: &OsStr, id_norm: &str) -> bool {
    let name = name.to_string_lossy();
    if !(name.ends_with(".jsonl") || name.ends_with(".jsonl.zst")) {
        return false;
    }

    let name_norm = name.replace('-', "").to_ascii_lowercase();
    name_norm.contains(id_norm)
}

fn is_codex_session_year_dir_name(name: &OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    name.len() == 4 && name.bytes().all(|byte| byte.is_ascii_digit())
}

fn is_codex_session_month_dir_name(name: &OsStr) -> bool {
    is_numeric_codex_session_date_component(name, 2, 1, 12)
}

fn is_codex_session_day_dir_name(name: &OsStr) -> bool {
    is_numeric_codex_session_date_component(name, 2, 1, 31)
}

fn is_numeric_codex_session_date_component(name: &OsStr, len: usize, min: u8, max: u8) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    if name.len() != len || !name.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    let Ok(value) = name.parse::<u8>() else {
        return false;
    };
    (min..=max).contains(&value)
}

fn should_skip_unusable_codex_entry(err: &io::Error) -> bool {
    matches!(
        err.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
    ) || is_filesystem_loop_error(err)
}

#[cfg(target_os = "linux")]
fn is_filesystem_loop_error(err: &io::Error) -> bool {
    err.raw_os_error() == Some(libc::ELOOP)
}

#[cfg(not(target_os = "linux"))]
fn is_filesystem_loop_error(_: &io::Error) -> bool {
    false
}

/// Read the bytes at `path`, decompressing legacy zstd files if the extension is `.zst`.
fn read_history_bytes(path: &Path, max_bytes: Option<u64>) -> Result<Vec<u8>, AgentError> {
    let file = std::fs::File::open(path).map_err(|e| read_history_error(path, e))?;
    read_history_bytes_from_reader(path, file, max_bytes)
}

fn digest_history_bytes(
    path: &Path,
    max_bytes: u64,
) -> Result<SessionHistoryDigest, SessionHistoryDigestError> {
    let file = std::fs::File::open(path).map_err(|e| read_history_error(path, e))?;
    digest_history_bytes_from_reader(path, file, max_bytes)
}

#[cfg(target_os = "linux")]
fn read_history_bytes_from_file(
    path: &Path,
    file: File,
    max_bytes: Option<u64>,
) -> Result<Vec<u8>, AgentError> {
    read_history_bytes_from_reader(path, file, max_bytes)
}

#[cfg(target_os = "linux")]
fn digest_history_bytes_from_file(
    path: &Path,
    file: File,
    max_bytes: u64,
) -> Result<SessionHistoryDigest, SessionHistoryDigestError> {
    digest_history_bytes_from_reader(path, file, max_bytes)
}

fn read_history_error(_path: &Path, source: io::Error) -> AgentError {
    AgentError::Checkpoint(format!("Failed to read session history: {source}"))
}

fn read_history_bytes_from_reader(
    path: &Path,
    reader: impl Read,
    max_bytes: Option<u64>,
) -> Result<Vec<u8>, AgentError> {
    if path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("zst"))
    {
        let decoder = zstd::stream::read::Decoder::new(reader).map_err(|e| {
            AgentError::Checkpoint(format!("Failed to decompress zstd session history: {e}"))
        })?;
        return read_zstd_history_reader(decoder, max_bytes);
    }
    read_history_reader(path, reader, max_bytes)
}

fn digest_history_bytes_from_reader(
    path: &Path,
    reader: impl Read,
    max_bytes: u64,
) -> Result<SessionHistoryDigest, SessionHistoryDigestError> {
    if path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("zst"))
    {
        let decoder = zstd::stream::read::Decoder::new(reader).map_err(|e| {
            SessionHistoryDigestError::Read(AgentError::Checkpoint(format!(
                "Failed to decompress zstd session history: {e}"
            )))
        })?;
        return digest_history_reader(decoder, max_bytes, |e| {
            AgentError::Checkpoint(format!("Failed to decompress zstd session history: {e}"))
        });
    }
    digest_history_reader(reader, max_bytes, |e| read_history_error(path, e))
}

fn read_zstd_history_reader(
    mut reader: impl Read,
    max_bytes: Option<u64>,
) -> Result<Vec<u8>, AgentError> {
    let mut bytes = Vec::new();
    match decoded_read_limit(max_bytes) {
        Some(limit) => reader.by_ref().take(limit).read_to_end(&mut bytes),
        None => reader.read_to_end(&mut bytes),
    }
    .map_err(|e| {
        AgentError::Checkpoint(format!("Failed to decompress zstd session history: {e}"))
    })?;
    if let Some(max_bytes) = max_bytes
        && bytes.len() as u64 > max_bytes
    {
        return Err(session_history_exceeds_max_error(max_bytes));
    }
    Ok(bytes)
}

fn read_history_reader(
    path: &Path,
    mut reader: impl Read,
    max_bytes: Option<u64>,
) -> Result<Vec<u8>, AgentError> {
    let mut bytes = Vec::new();
    match decoded_read_limit(max_bytes) {
        Some(limit) => {
            reader
                .by_ref()
                .take(limit)
                .read_to_end(&mut bytes)
                .map_err(|e| read_history_error(path, e))?;
        }
        None => {
            reader
                .read_to_end(&mut bytes)
                .map_err(|e| read_history_error(path, e))?;
        }
    }
    if let Some(max_bytes) = max_bytes
        && bytes.len() as u64 > max_bytes
    {
        return Err(session_history_exceeds_max_error(max_bytes));
    }
    Ok(bytes)
}

fn decoded_read_limit(max_bytes: Option<u64>) -> Option<u64> {
    // `u64::MAX` cannot be exceeded by an in-memory Vec on supported targets,
    // so there is no extra probe byte to read for that cap.
    max_bytes.and_then(|max_bytes| max_bytes.checked_add(1))
}

fn digest_history_reader(
    mut reader: impl Read,
    max_bytes: u64,
    map_error: impl Fn(io::Error) -> AgentError,
) -> Result<SessionHistoryDigest, SessionHistoryDigestError> {
    let mut hasher = Sha256::new();
    let mut size_bytes = 0u64;
    let mut buffer = [0u8; 8192];

    loop {
        let bytes_read = reader
            .read(&mut buffer)
            .map_err(|error| SessionHistoryDigestError::Read(map_error(error)))?;
        if bytes_read == 0 {
            break;
        }
        size_bytes = size_bytes
            .checked_add(bytes_read as u64)
            .ok_or(SessionHistoryDigestError::ExceedsMaxBytes)?;
        if size_bytes > max_bytes {
            return Err(SessionHistoryDigestError::ExceedsMaxBytes);
        }
        let chunk = buffer
            .get(..bytes_read)
            .ok_or(SessionHistoryDigestError::ExceedsMaxBytes)?;
        hasher.update(chunk);
    }

    Ok(SessionHistoryDigest {
        size_bytes,
        sha256_hex: hex::encode(hasher.finalize()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_history_file(dir: &tempfile::TempDir, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.path().join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    fn assert_over_limit(error: AgentError, max_bytes: u64) {
        let message = error.to_string();
        assert!(
            message.contains(&format!(
                "Session history exceeds maximum size of {max_bytes} bytes"
            )),
            "expected over-limit error for cap {max_bytes}, got: {message}"
        );
    }

    #[test]
    fn bounded_read_allows_literal_history_at_limit() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_history_file(&dir, "history.jsonl", b"abcd");

        let bytes = read_session_history_from_payload_bounded(path.to_str().unwrap(), 4).unwrap();

        assert_eq!(bytes, b"abcd");
    }

    #[test]
    fn bounded_read_allows_empty_literal_history_with_zero_limit() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_history_file(&dir, "history.jsonl", b"");

        let bytes = read_session_history_from_payload_bounded(path.to_str().unwrap(), 0).unwrap();

        assert_eq!(bytes, b"");
    }

    #[test]
    fn bounded_read_rejects_nonempty_literal_history_with_zero_limit() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_history_file(&dir, "history.jsonl", b"a");

        let err = read_session_history_from_payload_bounded(path.to_str().unwrap(), 0)
            .expect_err("bounded literal read must reject nonempty history when cap is zero");

        assert_over_limit(err, 0);
    }

    #[test]
    fn bounded_read_rejects_nonempty_zstd_history_with_zero_limit() {
        let dir = tempfile::tempdir().unwrap();
        let compressed = zstd::encode_all(b"a".as_slice(), 0).unwrap();
        let path = write_history_file(&dir, "history.jsonl.zst", &compressed);

        let err = read_session_history_from_payload_bounded(path.to_str().unwrap(), 0)
            .expect_err("bounded zstd read must reject nonempty history when cap is zero");

        assert_over_limit(err, 0);
    }

    #[test]
    fn bounded_read_rejects_literal_history_over_limit() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_history_file(&dir, "history.jsonl", b"abcde");

        let err = read_session_history_from_payload_bounded(path.to_str().unwrap(), 4)
            .expect_err("bounded literal read must reject over-limit history");

        assert_over_limit(err, 4);
    }

    #[test]
    fn bounded_read_rejects_codex_marker_history_over_limit() {
        let dir = tempfile::tempdir().unwrap();
        let sessions_dir = dir.path().join("sessions");
        let day_dir = sessions_dir.join("2026").join("07").join("02");
        std::fs::create_dir_all(&day_dir).unwrap();
        let thread_id = "019e9154-c304-70f0-adde-36efb1be1701";
        let path = day_dir.join("rollout-019e9154c30470f0adde36efb1be1701.jsonl");
        std::fs::write(path, b"abcde").unwrap();
        let payload = codex_marker_payload(&sessions_dir, thread_id);

        let err = read_session_history_from_payload_bounded(&payload, 4)
            .expect_err("bounded codex marker read must reject over-limit history");

        assert_over_limit(err, 4);
    }

    #[test]
    fn bounded_read_allows_literal_history_with_u64_max_limit() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_history_file(&dir, "history.jsonl", b"abcde");

        let bytes =
            read_session_history_from_payload_bounded(path.to_str().unwrap(), u64::MAX).unwrap();

        assert_eq!(bytes, b"abcde");
    }

    #[test]
    fn bounded_read_allows_zstd_history_at_decoded_limit() {
        let dir = tempfile::tempdir().unwrap();
        let max_bytes = 1024;
        let history = vec![b'a'; max_bytes as usize];
        let compressed = zstd::encode_all(history.as_slice(), 0).unwrap();
        let path = write_history_file(&dir, "history.jsonl.zst", &compressed);

        let bytes = read_session_history_from_payload_bounded(path.to_str().unwrap(), max_bytes)
            .expect("bounded zstd read must allow history exactly at the decoded cap");

        assert_eq!(bytes, history);
    }

    #[test]
    fn bounded_read_rejects_truncated_zstd_history_at_decoded_limit() {
        let dir = tempfile::tempdir().unwrap();
        let max_bytes = 1024;
        let history = vec![b'a'; max_bytes as usize];
        let mut compressed = zstd::encode_all(history.as_slice(), 0).unwrap();
        compressed.pop().expect("encoded fixture must not be empty");
        let path = write_history_file(&dir, "history.jsonl.zst", &compressed);

        let err = read_session_history_from_payload_bounded(path.to_str().unwrap(), max_bytes)
            .expect_err("bounded zstd read must reject truncated history at the decoded cap");

        let message = err.to_string();
        assert!(
            message.contains("Failed to decompress zstd session history"),
            "expected decompression error for truncated zstd history, got: {message}"
        );
    }

    #[test]
    fn bounded_read_rejects_zstd_history_over_decoded_limit() {
        let dir = tempfile::tempdir().unwrap();
        let max_bytes = 1024;
        let history = vec![b'a'; max_bytes as usize + 1];
        let compressed = zstd::encode_all(history.as_slice(), 0).unwrap();
        assert!(
            compressed.len() <= max_bytes as usize,
            "test fixture should be smaller than the decoded cap"
        );
        let path = write_history_file(&dir, "history.jsonl.zst", &compressed);

        let err = read_session_history_from_payload_bounded(path.to_str().unwrap(), max_bytes)
            .expect_err("bounded zstd read must reject over-limit decoded history");

        assert_over_limit(err, max_bytes);
    }
}

// Note: integration coverage for the public `read_session_history` entry
// (both Claude literal-path and codex marker -> bounded layout scan + zstd
// decode) lives in `crates/guest-agent/tests/session_history_read.rs`.
// The internal helpers
// (`read_codex_session_history`, `codex_session_filename_matches`,
// `read_history_bytes`, `decode_marker`) are exercised transitively by
// those integration tests. Inline coverage above is limited to the
// `read_session_history_from_payload_bounded` cap contract because the public
// entry point cannot pass a small test cap.
//
// `decode_marker` is the one piece of non-trivial parsing logic; if it
// regresses, the integration tests will catch it because the codex flow
// can't resolve a session without a valid marker.
