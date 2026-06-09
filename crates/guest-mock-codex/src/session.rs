use chrono::NaiveDate;
use serde_json::Value;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use uuid::Uuid;

#[cfg(unix)]
use std::ffi::CString;
#[cfg(unix)]
use std::io::Read;
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Resolve the Codex home directory, mirroring real Codex CLI precedence:
/// `$CODEX_HOME` > `$HOME/.codex` > `/home/user/.codex`.
pub fn codex_home() -> PathBuf {
    if let Ok(dir) = std::env::var("CODEX_HOME")
        && !dir.is_empty()
    {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| "/home/user".to_string());
    PathBuf::from(home).join(".codex")
}

/// Build the session file path, with `today` injected for testability.
///
/// Layout: `<codex_home>/sessions/YYYY/MM/DD/<thread_id>.jsonl`
pub fn build_session_path(
    codex_home: &Path,
    today: NaiveDate,
    thread_id: &str,
) -> io::Result<PathBuf> {
    validate_thread_id(thread_id)?;
    let yyyy = today.format("%Y").to_string();
    let mm = today.format("%m").to_string();
    let dd = today.format("%d").to_string();
    Ok(codex_home
        .join("sessions")
        .join(yyyy)
        .join(mm)
        .join(dd)
        .join(format!("{thread_id}.jsonl")))
}

pub(crate) fn persist_new_session(
    codex_home: &Path,
    today: NaiveDate,
    thread_id: &str,
    events: &[Value],
) -> io::Result<()> {
    validate_thread_id(thread_id)?;
    let _lock = lock_session(codex_home, thread_id)?;
    let path = build_session_path(codex_home, today, thread_id)?;
    let mut buf = Vec::new();
    append_events_to_jsonl_bytes(&mut buf, events)?;
    write_session_bytes_in_store(codex_home, &path, buf)
}

pub(crate) fn persist_resume_session(
    codex_home: &Path,
    today: NaiveDate,
    thread_id: &str,
    events: &[Value],
) -> io::Result<()> {
    validate_thread_id(thread_id)?;
    let _lock = lock_session(codex_home, thread_id)?;
    let path = if let Some(path) = find_session_file_for_thread(codex_home, thread_id)? {
        path
    } else {
        build_session_path(codex_home, today, thread_id)?
    };
    let mut existing = read_session_bytes_for_append_in_store(codex_home, &path)?;
    append_events_to_jsonl_bytes(&mut existing, events)?;
    write_session_bytes_in_store(codex_home, &path, existing)
}

fn validate_thread_id(thread_id: &str) -> io::Result<()> {
    let parsed = Uuid::parse_str(thread_id).map_err(|_| invalid_thread_id_error(thread_id))?;
    if parsed.to_string() != thread_id {
        return Err(invalid_thread_id_error(thread_id));
    }
    Ok(())
}

fn invalid_thread_id_error(thread_id: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        format!("invalid thread id {thread_id:?}: expected canonical UUID"),
    )
}

/// Write events as one JSON object per line to the writer, flushing at end.
pub fn emit_events<W: Write>(out: &mut W, events: &[Value]) -> io::Result<()> {
    for ev in events {
        writeln!(out, "{ev}")?;
    }
    out.flush()
}

/// Encode events as JSONL and atomically write to `path`, creating parent
/// directories as needed.
pub fn write_session_file(path: &Path, events: &[Value]) -> io::Result<()> {
    let mut buf = Vec::new();
    append_events_to_jsonl_bytes(&mut buf, events)?;
    write_session_bytes(path, buf)
}

fn write_session_bytes(path: &Path, buf: Vec<u8>) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    ensure_final_session_file_usable(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| invalid_session_file_error(path))?;
    let final_name = path
        .file_name()
        .ok_or_else(|| invalid_session_file_error(path))?;
    let (tmp, mut file) = create_unique_path_temp_file(parent, final_name)?;
    if let Err(err) = file.write_all(&buf) {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    drop(file);
    if let Err(err) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    Ok(())
}

fn append_events_to_jsonl_bytes(buf: &mut Vec<u8>, events: &[Value]) -> io::Result<()> {
    if !buf.is_empty() && !buf.ends_with(b"\n") {
        buf.push(b'\n');
    }
    for ev in events {
        writeln!(buf, "{ev}")?;
    }
    Ok(())
}

/// Read a JSONL session file into parsed `Value` events.
pub fn read_session_file(path: &Path) -> io::Result<Vec<Value>> {
    let decoded = fs::read_to_string(path)?;
    let mut out = Vec::new();
    for line in decoded.lines() {
        if line.is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(line)
            .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
        out.push(value);
    }
    Ok(out)
}

/// Append `new_events` to an existing session file by preserving existing bytes
/// and atomically renaming. If the file does not exist, falls back to a fresh
/// write so the resume call does not fail.
pub fn append_session_file(path: &Path, new_events: &[Value]) -> io::Result<()> {
    let mut existing = read_session_bytes_for_append(path)?;
    append_events_to_jsonl_bytes(&mut existing, new_events)?;
    write_session_bytes(path, existing)
}

fn read_session_bytes_for_append(path: &Path) -> io::Result<Vec<u8>> {
    match path.symlink_metadata() {
        Ok(metadata) if metadata.file_type().is_file() => fs::read(path),
        Ok(_) => Err(invalid_session_file_error(path)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(err) => Err(err),
    }
}

#[cfg(unix)]
fn read_session_bytes_for_append_in_store(codex_home: &Path, path: &Path) -> io::Result<Vec<u8>> {
    let parent = StoreDir::open_or_create_parent(codex_home, path)?;
    let final_name = path
        .file_name()
        .ok_or_else(|| invalid_session_file_error(path))?;
    let mut file = match parent.open_child_file(final_name) {
        Ok(file) => file,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) if is_filesystem_loop_error(&err) => return Err(invalid_session_file_error(path)),
        Err(err) => return Err(err),
    };
    if !file.metadata()?.file_type().is_file() {
        return Err(invalid_session_file_error(path));
    }
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;
    Ok(buf)
}

#[cfg(not(unix))]
fn read_session_bytes_for_append_in_store(_codex_home: &Path, path: &Path) -> io::Result<Vec<u8>> {
    read_session_bytes_for_append(path)
}

#[cfg(unix)]
fn write_session_bytes_in_store(codex_home: &Path, path: &Path, buf: Vec<u8>) -> io::Result<()> {
    let parent = StoreDir::open_or_create_parent(codex_home, path)?;
    let final_name = path
        .file_name()
        .ok_or_else(|| invalid_session_file_error(path))?;
    parent.ensure_child_file_usable(final_name, path)?;
    let (tmp_name, mut file) = parent.create_unique_temp_file(final_name)?;
    if let Err(err) = file.write_all(&buf) {
        let _ = parent.unlink_child_file(&tmp_name);
        return Err(err);
    }
    drop(file);
    if let Err(err) = parent.rename_child(&tmp_name, final_name) {
        let _ = parent.unlink_child_file(&tmp_name);
        return Err(err);
    }
    Ok(())
}

#[cfg(not(unix))]
fn write_session_bytes_in_store(_codex_home: &Path, path: &Path, buf: Vec<u8>) -> io::Result<()> {
    write_session_bytes(path, buf)
}

fn ensure_final_session_file_usable(path: &Path) -> io::Result<()> {
    match path.symlink_metadata() {
        Ok(metadata) if metadata.file_type().is_file() => Ok(()),
        Ok(_) => Err(invalid_session_file_error(path)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

fn create_unique_path_temp_file(
    parent: &Path,
    final_name: &OsStr,
) -> io::Result<(PathBuf, fs::File)> {
    for _ in 0..100 {
        let tmp = parent.join(unique_session_temp_name(final_name));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
        {
            Ok(file) => return Ok((tmp, file)),
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        format!(
            "failed to create unique session temp file in {}",
            parent.display()
        ),
    ))
}

fn unique_session_temp_name(final_name: &OsStr) -> OsString {
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut name = OsString::from(".");
    name.push(final_name);
    name.push(format!(".{}.{}.tmp", std::process::id(), counter));
    name
}

fn invalid_session_file_error(path: &Path) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        format!("session path is not a regular file: {}", path.display()),
    )
}

/// Return the first persisted JSONL session file under the Codex home.
pub fn find_session_file(codex_home: &Path) -> io::Result<Option<PathBuf>> {
    Ok(session_files(codex_home)?.into_iter().next())
}

fn find_session_file_for_thread(codex_home: &Path, thread_id: &str) -> io::Result<Option<PathBuf>> {
    validate_thread_id(thread_id)?;
    let id_norm = thread_id.replace('-', "");
    let matches = session_artifacts_for_resume(codex_home)?
        .into_iter()
        .filter(|path| {
            path.file_name()
                .is_some_and(|name| codex_jsonl_session_filename_matches(name, &id_norm))
        })
        .filter_map(|path| match is_real_jsonl_file_candidate(&path) {
            Ok(true) => Some(Ok(path)),
            Ok(false) => None,
            Err(err) => Some(Err(err)),
        })
        .collect::<io::Result<Vec<_>>>()?;
    if matches.len() > 1 {
        return Err(ambiguous_session_files_error(thread_id, &matches));
    }
    Ok(matches.into_iter().next())
}

fn codex_jsonl_session_filename_matches(name: &OsStr, id_norm: &str) -> bool {
    let name = name.to_string_lossy();
    if !name.ends_with(".jsonl") {
        return false;
    }
    let name_norm = name.replace('-', "").to_ascii_lowercase();
    name_norm.contains(id_norm)
}

fn is_real_jsonl_file_candidate(path: &Path) -> io::Result<bool> {
    match path.symlink_metadata() {
        Ok(metadata) => Ok(metadata.file_type().is_file()),
        Err(err) if should_skip_unusable_session_entry(&err) => Ok(false),
        Err(err) => Err(err),
    }
}

/// Return persisted JSONL session files under the Codex home.
pub fn session_files(codex_home: &Path) -> io::Result<Vec<PathBuf>> {
    let mut found = Vec::new();
    for path in session_artifacts(codex_home)? {
        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }
        if is_jsonl_file_candidate(&path)? {
            found.push(path);
        }
    }
    Ok(found)
}

fn is_jsonl_file_candidate(path: &Path) -> io::Result<bool> {
    match path.symlink_metadata() {
        Ok(metadata) => Ok(metadata.file_type().is_file()),
        Err(err) if should_skip_unusable_session_entry(&err) => Ok(false),
        Err(err) => Err(err),
    }
}

fn ambiguous_session_files_error(thread_id: &str, matches: &[PathBuf]) -> io::Error {
    let paths = matches
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("multiple session files found for thread id {thread_id}: {paths}"),
    )
}

fn session_artifacts_for_resume(codex_home: &Path) -> io::Result<Vec<PathBuf>> {
    let root = codex_home.join("sessions");
    let mut found = Vec::new();
    if !ensure_existing_real_session_dir(&root)? {
        return Ok(found);
    }
    found.push(root.clone());
    walk_existing_root(&root, &mut |path| {
        found.push(path.to_path_buf());
    })?;
    found.sort();
    Ok(found)
}

fn ensure_existing_real_session_dir(path: &Path) -> io::Result<bool> {
    let metadata = match path.symlink_metadata() {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(err),
    };
    if !metadata.file_type().is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotADirectory,
            format!("sessions path is not a real directory: {}", path.display()),
        ));
    }
    Ok(true)
}

/// Return session directories and files under the Codex home.
pub fn session_artifacts(codex_home: &Path) -> io::Result<Vec<PathBuf>> {
    let root = codex_home.join("sessions");
    let mut found = Vec::new();
    match root.symlink_metadata() {
        Ok(metadata) if metadata.file_type().is_dir() => {}
        Ok(_) => return Ok(found),
        Err(err) if should_skip_unusable_session_entry(&err) => return Ok(found),
        Err(err) => return Err(err),
    }
    found.push(root.clone());
    walk(&root, &mut |path| {
        found.push(path.to_path_buf());
    })?;
    found.sort();
    Ok(found)
}

fn walk_existing_root(dir: &Path, f: &mut dyn FnMut(&Path)) -> io::Result<()> {
    walk(dir, f)
}

fn walk(dir: &Path, f: &mut dyn FnMut(&Path)) -> io::Result<()> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if should_skip_unusable_session_entry(&err) => return Ok(()),
        Err(err) => return Err(err),
    };
    walk_entries(entries, f)
}

fn walk_entries(entries: fs::ReadDir, f: &mut dyn FnMut(&Path)) -> io::Result<()> {
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) if should_skip_unusable_session_entry(&err) => continue,
            Err(err) => return Err(err),
        };
        let path = entry.path();
        f(&path);
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(err) if should_skip_unusable_session_entry(&err) => continue,
            Err(err) => return Err(err),
        };
        if file_type.is_dir() {
            walk(&path, f)?;
        }
    }
    Ok(())
}

fn should_skip_unusable_session_entry(err: &io::Error) -> bool {
    matches!(
        err.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
    ) || is_filesystem_loop_error(err)
}

#[cfg(unix)]
fn is_filesystem_loop_error(err: &io::Error) -> bool {
    err.raw_os_error() == Some(libc::ELOOP)
}

#[cfg(not(unix))]
fn is_filesystem_loop_error(_: &io::Error) -> bool {
    false
}

#[cfg(unix)]
struct StoreDir {
    file: fs::File,
}

#[cfg(unix)]
impl StoreDir {
    fn open_or_create_parent(codex_home: &Path, path: &Path) -> io::Result<Self> {
        fs::create_dir_all(codex_home)?;
        let mut dir = Self::open_existing(codex_home)?;
        let mut current = codex_home.to_path_buf();
        let parent = path
            .parent()
            .ok_or_else(|| invalid_session_file_error(path))?;
        let relative = parent
            .strip_prefix(codex_home)
            .map_err(|_| invalid_session_file_error(path))?;
        for component in relative.components() {
            let std::path::Component::Normal(name) = component else {
                return Err(invalid_child_name_error(component.as_os_str()));
            };
            current.push(name);
            dir = dir
                .open_or_create_child_dir(name)
                .map_err(|err| map_session_dir_open_error(err, &current))?;
        }
        Ok(dir)
    }

    fn open_existing(path: &Path) -> io::Result<Self> {
        fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
            .map(|file| Self { file })
    }

    fn open_or_create_child_dir(&self, name: &OsStr) -> io::Result<Self> {
        let name = cstring_child_name(name)?;
        // SAFETY: `self.file` is an open directory fd, `name` is a validated
        // NUL-terminated basename, and `mkdirat` does not retain pointers.
        let mkdir_result = unsafe { libc::mkdirat(self.file.as_raw_fd(), name.as_ptr(), 0o700) };
        if mkdir_result < 0 {
            let err = io::Error::last_os_error();
            if err.kind() != io::ErrorKind::AlreadyExists {
                return Err(err);
            }
        }
        self.open_child_dir_by_cstr(&name)
    }

    fn open_child_dir_by_cstr(&self, name: &CString) -> io::Result<Self> {
        let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        // SAFETY: `self.file` is an open directory fd, `name` is a validated
        // NUL-terminated child basename, and the flags do not require a mode.
        let fd = unsafe { libc::openat(self.file.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: a non-negative `openat` return is a newly owned fd.
        let file = unsafe { fs::File::from_raw_fd(fd) };
        Ok(Self { file })
    }

    fn open_child_file(&self, name: &OsStr) -> io::Result<fs::File> {
        let name = cstring_child_name(name)?;
        let flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK;
        // SAFETY: `self.file` is an open directory fd, `name` is a validated
        // NUL-terminated child basename, and the flags do not require a mode.
        let fd = unsafe { libc::openat(self.file.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: a non-negative `openat` return is a newly owned fd.
        Ok(unsafe { fs::File::from_raw_fd(fd) })
    }

    fn open_or_create_child_file(&self, name: &OsStr) -> io::Result<fs::File> {
        let name = cstring_child_name(name)?;
        let flags =
            libc::O_RDWR | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK;
        // SAFETY: `self.file` is an open directory fd, `name` is a validated
        // NUL-terminated child basename, and a mode is supplied because
        // `O_CREAT` is set.
        let fd = unsafe { libc::openat(self.file.as_raw_fd(), name.as_ptr(), flags, 0o600) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: a non-negative `openat` return is a newly owned fd.
        Ok(unsafe { fs::File::from_raw_fd(fd) })
    }

    fn ensure_child_file_usable(&self, name: &OsStr, path: &Path) -> io::Result<()> {
        let file = match self.open_child_file(name) {
            Ok(file) => file,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(err) if is_filesystem_loop_error(&err) => {
                return Err(invalid_session_file_error(path));
            }
            Err(err) => return Err(err),
        };
        if file.metadata()?.file_type().is_file() {
            Ok(())
        } else {
            Err(invalid_session_file_error(path))
        }
    }

    fn create_unique_temp_file(&self, final_name: &OsStr) -> io::Result<(OsString, fs::File)> {
        for _ in 0..100 {
            let tmp_name = unique_session_temp_name(final_name);
            match self.create_child_file_exclusive(&tmp_name) {
                Ok(file) => return Ok((tmp_name, file)),
                Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(err) => return Err(err),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "failed to create unique session temp file",
        ))
    }

    fn create_child_file_exclusive(&self, name: &OsStr) -> io::Result<fs::File> {
        let name = cstring_child_name(name)?;
        let flags = libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC;
        // SAFETY: `self.file` is an open directory fd, `name` is a validated
        // NUL-terminated child basename, and a mode is supplied because
        // `O_CREAT` is set.
        let fd = unsafe { libc::openat(self.file.as_raw_fd(), name.as_ptr(), flags, 0o600) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: a non-negative `openat` return is a newly owned fd.
        Ok(unsafe { fs::File::from_raw_fd(fd) })
    }

    fn rename_child(&self, from: &OsStr, to: &OsStr) -> io::Result<()> {
        let from = cstring_child_name(from)?;
        let to = cstring_child_name(to)?;
        // SAFETY: both directory fds are the same open directory fd, and both
        // names are validated NUL-terminated child basenames.
        let result = unsafe {
            libc::renameat(
                self.file.as_raw_fd(),
                from.as_ptr(),
                self.file.as_raw_fd(),
                to.as_ptr(),
            )
        };
        if result < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn unlink_child_file(&self, name: &OsStr) -> io::Result<()> {
        let name = cstring_child_name(name)?;
        // SAFETY: `self.file` is an open directory fd and `name` is a validated
        // NUL-terminated child basename.
        let result = unsafe { libc::unlinkat(self.file.as_raw_fd(), name.as_ptr(), 0) };
        if result < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(unix)]
fn cstring_child_name(name: &OsStr) -> io::Result<CString> {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes == b"." || bytes == b".." || bytes.contains(&b'/') {
        return Err(invalid_child_name_error(name));
    }
    CString::new(bytes).map_err(|err| io::Error::new(io::ErrorKind::InvalidInput, err))
}

#[cfg(unix)]
fn invalid_child_name_error(name: &OsStr) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        format!(
            "session child name is not a basename: {}",
            name.to_string_lossy()
        ),
    )
}

#[cfg(unix)]
fn invalid_session_dir_error(path: &Path) -> io::Error {
    io::Error::new(
        io::ErrorKind::NotADirectory,
        format!("sessions path is not a real directory: {}", path.display()),
    )
}

#[cfg(unix)]
fn map_session_dir_open_error(err: io::Error, path: &Path) -> io::Error {
    if err.kind() == io::ErrorKind::NotADirectory || is_filesystem_loop_error(&err) {
        invalid_session_dir_error(path)
    } else {
        err
    }
}

#[cfg(unix)]
struct SessionLock {
    _file: fs::File,
}

#[cfg(not(unix))]
struct SessionLock;

#[cfg(unix)]
fn lock_session(codex_home: &Path, thread_id: &str) -> io::Result<SessionLock> {
    let lock_path = codex_home
        .join(".session-locks")
        .join(format!("{thread_id}.lock"));
    let lock_dir = StoreDir::open_or_create_parent(codex_home, &lock_path)?;
    let lock_name = lock_path
        .file_name()
        .ok_or_else(|| invalid_session_file_error(&lock_path))?;
    let file = lock_dir.open_or_create_child_file(lock_name)?;
    if !file.metadata()?.file_type().is_file() {
        return Err(invalid_session_file_error(&lock_path));
    }
    // SAFETY: `file.as_raw_fd()` is an open fd owned by `file`, and `flock`
    // only affects the advisory lock associated with that fd.
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(SessionLock { _file: file })
}

#[cfg(not(unix))]
fn lock_session(_codex_home: &Path, _thread_id: &str) -> io::Result<SessionLock> {
    Ok(SessionLock)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build_events;

    #[test]
    fn build_session_path_zero_pads() {
        let home = Path::new("/tmp/.codex");
        let day = NaiveDate::from_ymd_opt(2026, 1, 5).unwrap();
        let thread_id = "00000000-0000-0000-0000-000000000001";
        let p = build_session_path(home, day, thread_id).unwrap();
        assert_eq!(
            p,
            PathBuf::from(format!("/tmp/.codex/sessions/2026/01/05/{thread_id}.jsonl"))
        );
    }

    #[test]
    fn build_session_path_typical() {
        let home = Path::new("/var/codex");
        let day = NaiveDate::from_ymd_opt(2026, 12, 31).unwrap();
        let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
        let p = build_session_path(home, day, thread_id).unwrap();
        assert_eq!(
            p,
            PathBuf::from(format!("/var/codex/sessions/2026/12/31/{thread_id}.jsonl"))
        );
    }

    #[test]
    fn emit_events_writes_jsonl() {
        let mut buf = Vec::new();
        let evs = build_events("id-1", "echo");
        emit_events(&mut buf, &evs).unwrap();
        let text = String::from_utf8(buf).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 3);
        for line in lines {
            let _: Value = serde_json::from_str(line).unwrap();
        }
    }

    #[test]
    fn write_then_read_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/deep/file.jsonl");
        let evs = build_events("rt-1", "hi");
        write_session_file(&path, &evs).unwrap();
        let read_back = read_session_file(&path).unwrap();
        assert_eq!(read_back.len(), 3);
        assert_eq!(read_back[0]["thread_id"], "rt-1");
    }

    #[test]
    fn append_to_missing_file_creates_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("appended.jsonl");
        let evs = build_events("a-1", "first");
        append_session_file(&path, &evs).unwrap();
        let read_back = read_session_file(&path).unwrap();
        assert_eq!(read_back.len(), 3);
    }

    #[test]
    fn append_to_existing_file_extends() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("extend.jsonl");
        let first = build_events("e-1", "turn-1");
        write_session_file(&path, &first).unwrap();
        let second = build_events("e-1", "turn-2");
        append_session_file(&path, &second).unwrap();
        let read_back = read_session_file(&path).unwrap();
        assert_eq!(read_back.len(), 6);
        assert_eq!(read_back[1]["item"]["text"], "turn-1");
        assert_eq!(read_back[4]["item"]["text"], "turn-2");
    }
}
