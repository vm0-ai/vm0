use std::path::Path;

#[cfg(unix)]
use std::os::unix::fs::FileTypeExt;
#[cfg(unix)]
use std::path::PathBuf;

#[cfg(unix)]
use chrono::{Datelike, Utc};
use guest_mock_codex::{session_artifacts, session_files};
use serde_json::{Value, json};
use tempfile::TempDir;

use crate::app_server::{AppServerProcess, initialize_params, spawn_app_server, text_input};

const THREAD_ID: &str = "0199a213-81c0-7800-8aa1-bbab2a035a53";

fn spawn_resumed_app_server(codex_home: &Path) -> std::io::Result<AppServerProcess> {
    let mut server = spawn_app_server(codex_home, &["app-server", "--stdio"], None)?;
    server.request(1, "initialize", initialize_params())?;
    let resumed = server.request(
        2,
        "thread/resume",
        json!({
            "threadId": THREAD_ID,
        }),
    )?;
    assert_eq!(
        resumed.pointer("/result/thread/id").and_then(Value::as_str),
        Some(THREAD_ID)
    );
    Ok(server)
}

fn assert_turn_persistence_rejected(codex_home: &Path) -> std::io::Result<()> {
    let mut server = spawn_resumed_app_server(codex_home)?;
    let error = match server.request(
        3,
        "turn/start",
        json!({
            "threadId": THREAD_ID,
            "input": [text_input("must not persist")],
        }),
    ) {
        Ok(response) => {
            return Err(std::io::Error::other(format!(
                "invalid session storage unexpectedly accepted turn: {response}"
            )));
        }
        Err(error) => error,
    };
    assert!(
        matches!(
            error.kind(),
            std::io::ErrorKind::UnexpectedEof | std::io::ErrorKind::BrokenPipe
        ),
        "unexpected app-server failure: {error}"
    );
    assert_ne!(server.close_and_wait()?, 0);
    Ok(())
}

#[cfg(unix)]
fn current_session_path(codex_home: &Path) -> PathBuf {
    let today = Utc::now().date_naive();
    codex_home
        .join("sessions")
        .join(format!("{:04}", today.year()))
        .join(format!("{:02}", today.month()))
        .join(format!("{:02}", today.day()))
        .join(format!("{THREAD_ID}.jsonl"))
}

#[test]
fn app_server_rejects_sessions_file_root_without_artifacts() -> std::io::Result<()> {
    let dir = TempDir::new()?;
    std::fs::write(dir.path().join("sessions"), "not a directory")?;

    assert_turn_persistence_rejected(dir.path())?;

    assert!(session_artifacts(dir.path())?.is_empty());
    Ok(())
}

#[cfg(unix)]
#[test]
fn app_server_rejects_symlinked_codex_home_without_outside_writes() -> std::io::Result<()> {
    let dir = TempDir::new()?;
    let outside_home = dir.path().join("outside-home");
    let codex_home = dir.path().join("codex-home");
    std::fs::create_dir_all(&outside_home)?;
    std::os::unix::fs::symlink(&outside_home, &codex_home)?;

    assert_turn_persistence_rejected(&codex_home)?;

    assert!(codex_home.symlink_metadata()?.file_type().is_symlink());
    assert!(!outside_home.join(".session-locks").exists());
    assert!(!outside_home.join("sessions").exists());
    Ok(())
}

#[cfg(unix)]
#[test]
fn app_server_rejects_symlinked_sessions_root_without_outside_writes() -> std::io::Result<()> {
    let dir = TempDir::new()?;
    let outside_sessions = dir.path().join("outside-sessions");
    std::fs::create_dir_all(&outside_sessions)?;
    std::os::unix::fs::symlink(&outside_sessions, dir.path().join("sessions"))?;

    assert_turn_persistence_rejected(dir.path())?;

    assert!(outside_sessions.read_dir()?.next().is_none());
    Ok(())
}

#[cfg(unix)]
#[test]
fn app_server_rejects_symlinked_session_parent_without_outside_writes() -> std::io::Result<()> {
    let dir = TempDir::new()?;
    let sessions = dir.path().join("sessions");
    let outside_year = dir.path().join("outside-year");
    std::fs::create_dir_all(&sessions)?;
    std::fs::create_dir_all(&outside_year)?;
    let current_year = Utc::now().date_naive().year();
    for year in [current_year, current_year + 1] {
        std::os::unix::fs::symlink(&outside_year, sessions.join(format!("{year:04}")))?;
    }

    assert_turn_persistence_rejected(dir.path())?;

    assert!(outside_year.read_dir()?.next().is_none());
    Ok(())
}

#[cfg(unix)]
#[test]
fn app_server_rejects_special_lock_file_without_hanging() -> std::io::Result<()> {
    let dir = TempDir::new()?;
    let lock_dir = dir.path().join(".session-locks");
    std::fs::create_dir_all(&lock_dir)?;
    mkfifo(&lock_dir.join(format!("{THREAD_ID}.lock")))?;

    assert_turn_persistence_rejected(dir.path())?;

    assert!(session_artifacts(dir.path())?.is_empty());
    Ok(())
}

#[cfg(unix)]
#[test]
fn app_server_rejects_special_session_file_without_hanging() -> std::io::Result<()> {
    let dir = TempDir::new()?;
    let session_path = current_session_path(dir.path());
    if let Some(parent) = session_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    mkfifo(&session_path)?;

    assert_turn_persistence_rejected(dir.path())?;

    assert!(session_path.symlink_metadata()?.file_type().is_fifo());
    Ok(())
}

#[cfg(unix)]
#[test]
fn app_server_rejects_symlinked_fallback_without_overwriting_target() -> std::io::Result<()> {
    let dir = TempDir::new()?;
    let outside_path = dir.path().join("outside.jsonl");
    std::fs::write(&outside_path, "outside must survive")?;
    let session_path = current_session_path(dir.path());
    if let Some(parent) = session_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::os::unix::fs::symlink(&outside_path, &session_path)?;

    assert_turn_persistence_rejected(dir.path())?;

    assert_eq!(
        std::fs::read_to_string(&outside_path)?,
        "outside must survive"
    );
    assert!(session_path.symlink_metadata()?.file_type().is_symlink());
    Ok(())
}

#[test]
fn app_server_rejects_duplicate_matching_sessions_without_modifying_them() -> std::io::Result<()> {
    let dir = TempDir::new()?;
    let first_path = dir
        .path()
        .join(format!("sessions/2001/01/01/{THREAD_ID}.jsonl"));
    let second_path = dir.path().join(format!(
        "sessions/2001/01/02/rollout-restored-{THREAD_ID}.jsonl"
    ));
    for (path, contents) in [(&first_path, "first\n"), (&second_path, "second\n")] {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, contents)?;
    }

    assert_turn_persistence_rejected(dir.path())?;

    assert_eq!(std::fs::read_to_string(first_path)?, "first\n");
    assert_eq!(std::fs::read_to_string(second_path)?, "second\n");
    Ok(())
}

#[test]
fn session_files_skip_symlinked_files_and_dirs() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let sessions = dir.path().join("sessions");
    let day_dir = sessions.join("2026/06/09");
    std::fs::create_dir_all(&day_dir)?;
    let real_file = day_dir.join("00000000-0000-0000-0000-000000000001.jsonl");
    std::fs::write(&real_file, "{}\n")?;
    let linked_file = day_dir.join("00000000-0000-0000-0000-000000000002.jsonl");
    std::os::unix::fs::symlink(&real_file, &linked_file)?;
    std::os::unix::fs::symlink(&sessions, sessions.join("loop"))?;

    let files = session_files(dir.path())?;
    assert_eq!(files, vec![real_file]);
    assert!(linked_file.symlink_metadata()?.file_type().is_symlink());
    Ok(())
}

#[cfg(unix)]
#[test]
fn session_files_skip_dangling_jsonl_symlinks() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let sessions = dir.path().join("sessions");
    let day_dir = sessions.join("2026/06/09");
    std::fs::create_dir_all(&day_dir)?;
    let real_file = day_dir.join("00000000-0000-0000-0000-000000000001.jsonl");
    std::fs::write(&real_file, "{}\n")?;
    let missing_target = dir.path().join("missing/codex-session.jsonl");
    std::os::unix::fs::symlink(
        missing_target,
        day_dir.join("00000000-0000-0000-0000-000000000002.jsonl"),
    )?;

    let files = session_files(dir.path())?;
    assert_eq!(files, vec![real_file]);
    Ok(())
}

#[cfg(unix)]
#[test]
fn session_files_skip_jsonl_symlink_loops() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let sessions = dir.path().join("sessions");
    let day_dir = sessions.join("2026/06/09");
    std::fs::create_dir_all(&day_dir)?;
    let real_file = day_dir.join("00000000-0000-0000-0000-000000000001.jsonl");
    std::fs::write(&real_file, "{}\n")?;
    let looped_file = day_dir.join("00000000-0000-0000-0000-000000000002.jsonl");
    std::os::unix::fs::symlink(&looped_file, &looped_file)?;

    let files = session_files(dir.path())?;
    assert_eq!(files, vec![real_file]);
    Ok(())
}

#[cfg(unix)]
#[test]
fn session_artifacts_skip_root_symlink_loop() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let sessions = dir.path().join("sessions");
    std::os::unix::fs::symlink(&sessions, &sessions)?;

    assert!(session_artifacts(dir.path())?.is_empty());
    assert!(session_files(dir.path())?.is_empty());
    Ok(())
}

#[cfg(unix)]
#[test]
fn session_artifacts_skip_symlinked_root_dir() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let real_sessions = dir.path().join("real-sessions");
    let real_day_dir = real_sessions.join("2026/06/09");
    std::fs::create_dir_all(&real_day_dir)?;
    std::fs::write(
        real_day_dir.join("00000000-0000-0000-0000-000000000001.jsonl"),
        "{}\n",
    )?;
    std::os::unix::fs::symlink(&real_sessions, dir.path().join("sessions"))?;

    assert!(session_artifacts(dir.path())?.is_empty());
    assert!(session_files(dir.path())?.is_empty());
    Ok(())
}

#[cfg(unix)]
fn mkfifo(path: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let path = CString::new(path.as_os_str().as_bytes())
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    // SAFETY: `path` is a valid NUL-terminated path and `mkfifo` does not
    // retain the pointer after returning.
    let result = unsafe { libc::mkfifo(path.as_ptr(), 0o600) };
    if result < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}
