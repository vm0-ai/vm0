use chrono::NaiveDate;
use serde_json::Value;
use std::ffi::OsStr;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

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

pub(crate) fn build_resume_session_path(
    codex_home: &Path,
    today: NaiveDate,
    thread_id: &str,
) -> io::Result<PathBuf> {
    if let Some(path) = find_session_file_for_thread(codex_home, thread_id)? {
        return Ok(path);
    }
    build_session_path(codex_home, today, thread_id)
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
    let tmp = session_temp_path(path);
    remove_existing_session_temp_file(&tmp)?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)?;
    file.write_all(&buf)?;
    drop(file);
    fs::rename(&tmp, path)
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
        Ok(metadata) if metadata.file_type().is_symlink() => Ok(Vec::new()),
        Ok(_) => Err(invalid_session_file_error(path)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(err) => Err(err),
    }
}

pub(crate) fn ensure_runtime_session_path_usable(codex_home: &Path, path: &Path) -> io::Result<()> {
    let root = codex_home.join("sessions");
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    let Ok(relative_parent) = parent.strip_prefix(&root) else {
        return Ok(());
    };

    if !ensure_existing_real_session_dir(&root)? {
        return Ok(());
    }

    let mut current = root;
    for component in relative_parent.components() {
        current.push(component.as_os_str());
        if !ensure_existing_real_session_dir(&current)? {
            return Ok(());
        }
    }

    ensure_final_session_file_usable(path)?;
    ensure_session_temp_file_usable(&session_temp_path(path))?;

    Ok(())
}

fn session_temp_path(path: &Path) -> PathBuf {
    path.with_extension("jsonl.tmp")
}

fn ensure_final_session_file_usable(path: &Path) -> io::Result<()> {
    match path.symlink_metadata() {
        Ok(metadata) if metadata.file_type().is_file() || metadata.file_type().is_symlink() => {
            Ok(())
        }
        Ok(_) => Err(invalid_session_file_error(path)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

fn ensure_session_temp_file_usable(path: &Path) -> io::Result<()> {
    match path.symlink_metadata() {
        Ok(metadata) if metadata.file_type().is_file() => Ok(()),
        Ok(_) => Err(invalid_session_temp_file_error(path)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

fn remove_existing_session_temp_file(path: &Path) -> io::Result<()> {
    match path.symlink_metadata() {
        Ok(metadata) if metadata.file_type().is_file() => fs::remove_file(path),
        Ok(_) => Err(invalid_session_temp_file_error(path)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

fn invalid_session_file_error(path: &Path) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        format!("session path is not a regular file: {}", path.display()),
    )
}

fn invalid_session_temp_file_error(path: &Path) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        format!(
            "session temp path is not a regular file: {}",
            path.display()
        ),
    )
}

/// Return the first persisted JSONL session file under the Codex home.
pub fn find_session_file(codex_home: &Path) -> io::Result<Option<PathBuf>> {
    Ok(session_files(codex_home)?.into_iter().next())
}

fn find_session_file_for_thread(codex_home: &Path, thread_id: &str) -> io::Result<Option<PathBuf>> {
    validate_thread_id(thread_id)?;
    let id_norm = thread_id.replace('-', "");
    let mut matches = session_artifacts_for_resume(codex_home)?
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
    Ok(matches.pop())
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
    match fs::metadata(path) {
        Ok(metadata) => Ok(metadata.is_file()),
        Err(err) if should_skip_unusable_session_entry(&err) => Ok(false),
        Err(err) => Err(err),
    }
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
    walk_entries(fs::read_dir(dir)?, f)
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
