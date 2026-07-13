use std::path::Path;

use chrono::{Datelike, Utc};
use guest_mock_codex::{
    build_events, build_session_path, read_session_file, session_artifacts, session_files,
    write_session_file,
};
use tempfile::TempDir;

use crate::support::{RunOutput, run, run_with_env};

fn assert_invalid_resume_rejected(codex_home: &Path, out: &RunOutput) -> std::io::Result<()> {
    assert_ne!(out.status, 0, "invalid resume id should fail");
    assert!(
        out.events.is_empty(),
        "invalid resume id should not emit JSONL events: {:?}",
        out.events
    );
    assert!(
        !out.stderr.is_empty(),
        "invalid resume id should report an error on stderr"
    );
    assert!(
        out.stderr.contains("invalid thread id"),
        "invalid resume id should report the validation failure: {:?}",
        out.stderr
    );
    assert!(
        out.stderr.contains("expected canonical UUID"),
        "invalid resume id should describe the expected format: {:?}",
        out.stderr
    );
    assert!(
        session_artifacts(codex_home)?.is_empty(),
        "invalid resume id should not write session artifacts"
    );
    Ok(())
}

fn session_year_candidates() -> [String; 2] {
    let year = Utc::now().date_naive().year();
    [format!("{year:04}"), format!("{:04}", year + 1)]
}

#[test]
fn new_rejects_sessions_file_root_without_events() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join("sessions"), b"not a directory")?;

    let out = run(dir.path(), &["exec", "--json", "--", "hi"])?;

    assert_ne!(out.status, 0);
    assert!(
        out.events.is_empty(),
        "unusable sessions root should fail before emitting events: {:?}",
        out.events
    );
    assert!(
        out.stderr.contains("sessions path is not a real directory"),
        "new run should report the unusable sessions root: {:?}",
        out.stderr
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn new_rejects_symlinked_session_parent_without_events() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let sessions = dir.path().join("sessions");
    let outside_year = dir.path().join("outside-year");
    std::fs::create_dir_all(&sessions)?;
    std::fs::create_dir_all(&outside_year)?;
    for year in session_year_candidates() {
        std::os::unix::fs::symlink(&outside_year, sessions.join(year))?;
    }

    let out = run(dir.path(), &["exec", "--json", "--", "hi"])?;

    assert_ne!(out.status, 0);
    assert!(
        out.events.is_empty(),
        "symlinked session parent should fail before emitting events: {:?}",
        out.events
    );
    assert!(
        out.stderr.contains("sessions path is not a real directory"),
        "new run should report the symlinked session parent: {:?}",
        out.stderr
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn new_rejects_symlinked_codex_home_without_lock_artifacts() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let outside_home = dir.path().join("outside-home");
    let codex_home = dir.path().join("codex-home");
    std::fs::create_dir_all(&outside_home)?;
    std::os::unix::fs::symlink(&outside_home, &codex_home)?;

    let out = run(&codex_home, &["exec", "--json", "--", "hi"])?;

    assert_ne!(out.status, 0);
    assert!(
        out.events.is_empty(),
        "symlinked codex home should fail before emitting events: {:?}",
        out.events
    );
    assert!(
        codex_home.symlink_metadata()?.file_type().is_symlink(),
        "mock should leave the CODEX_HOME symlink in place"
    );
    assert!(
        !outside_home.join(".session-locks").exists(),
        "mock should not create lock files through a symlinked CODEX_HOME"
    );
    assert!(
        !outside_home.join("sessions").exists(),
        "mock should not create session files through a symlinked CODEX_HOME"
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn resume_rejects_special_lock_file_without_events() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    let lock_dir = dir.path().join(".session-locks");
    std::fs::create_dir_all(&lock_dir)?;
    mkfifo(&lock_dir.join(format!("{thread_id}.lock")))?;

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "hi"])?;

    assert_ne!(out.status, 0);
    assert!(
        out.events.is_empty(),
        "special lock file should fail before emitting events: {:?}",
        out.events
    );
    assert!(
        session_artifacts(dir.path())?.is_empty(),
        "special lock file should prevent session writes"
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn resume_rejects_special_session_file_without_hanging() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    let session_path = build_session_path(dir.path(), Utc::now().date_naive(), thread_id)?;
    if let Some(parent) = session_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    mkfifo(&session_path)?;

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "hi"])?;

    assert_ne!(out.status, 0);
    assert!(
        out.events.is_empty(),
        "special session file should fail before emitting events: {:?}",
        out.events
    );
    assert!(
        out.stderr.contains("session path is not a regular file"),
        "special session file should be reported: {:?}",
        out.stderr
    );
    Ok(())
}

#[test]
fn fixture_rejects_sessions_file_root_without_events() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join("sessions"), b"not a directory")?;

    let out = run_with_env(
        dir.path(),
        &["exec", "--json", "--", "ignored"],
        &[("MOCK_CODEX_FIXTURE", "event-mapping-rich")],
    )?;

    assert_ne!(out.status, 0);
    assert!(
        out.events.is_empty(),
        "fixture mode should fail before emitting events: {:?}",
        out.events
    );
    assert!(
        out.stderr.contains("sessions path is not a real directory"),
        "fixture mode should report the unusable sessions root: {:?}",
        out.stderr
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn resume_rejects_today_symlinked_fallback_without_events() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    let outside_path = dir.path().join("outside.jsonl");
    write_session_file(&outside_path, &build_events(thread_id, "outside-turn"))?;
    let session_path = build_session_path(dir.path(), Utc::now().date_naive(), thread_id)?;
    if let Some(parent) = session_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::os::unix::fs::symlink(&outside_path, &session_path)?;

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "turn-2"])?;

    assert_ne!(out.status, 0);
    assert!(
        out.events.is_empty(),
        "symlinked fallback should fail before emitting events: {:?}",
        out.events
    );
    assert!(
        out.stderr.contains("session path is not a regular file"),
        "resume should report the symlinked session path: {:?}",
        out.stderr
    );

    let outside_events = read_session_file(&outside_path)?;
    assert_eq!(outside_events.len(), 3);
    assert_eq!(outside_events[1]["item"]["text"], "outside-turn");
    assert!(
        session_path.symlink_metadata()?.file_type().is_symlink(),
        "resume should leave the symlink in place"
    );
    Ok(())
}

#[test]
fn resume_preserves_stale_fixed_temp_file() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    let session_path = build_session_path(dir.path(), Utc::now().date_naive(), thread_id)?;
    if let Some(parent) = session_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let stale_temp_path = session_path.with_extension("jsonl.tmp");
    std::fs::write(&stale_temp_path, "stale temp must survive")?;

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "turn-1"])?;

    assert_eq!(out.status, 0);
    assert_eq!(
        std::fs::read_to_string(&stale_temp_path)?,
        "stale temp must survive"
    );
    let events = read_session_file(&session_path)?;
    assert_eq!(events.len(), 3);
    assert_eq!(events[1]["item"]["text"], "turn-1");
    Ok(())
}

#[test]
fn resume_rejects_final_session_directory_without_events() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    let session_path = build_session_path(dir.path(), Utc::now().date_naive(), thread_id)?;
    std::fs::create_dir_all(&session_path)?;

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "hi"])?;

    assert_ne!(out.status, 0);
    assert!(
        out.events.is_empty(),
        "unusable final session path should fail before emitting events: {:?}",
        out.events
    );
    assert!(
        out.stderr.contains("session path is not a regular file"),
        "resume should report the unusable final session path: {:?}",
        out.stderr
    );
    Ok(())
}

#[test]
fn resume_ignores_stale_fixed_temp_directory() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    let session_path = build_session_path(dir.path(), Utc::now().date_naive(), thread_id)?;
    let stale_temp_path = session_path.with_extension("jsonl.tmp");
    std::fs::create_dir_all(&stale_temp_path)?;

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "hi"])?;

    assert_eq!(out.status, 0);
    assert!(stale_temp_path.is_dir());
    let resume_events = read_session_file(&session_path)?;
    assert_eq!(resume_events.len(), 3);
    assert_eq!(resume_events[1]["item"]["text"], "hi");
    Ok(())
}

#[cfg(unix)]
#[test]
fn resume_ignores_stale_fixed_temp_symlink() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    let session_path = build_session_path(dir.path(), Utc::now().date_naive(), thread_id)?;
    let temp_path = session_path.with_extension("jsonl.tmp");
    if let Some(parent) = temp_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let outside_path = dir.path().join("outside.tmp");
    std::fs::write(&outside_path, "outside")?;
    std::os::unix::fs::symlink(&outside_path, &temp_path)?;

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "hi"])?;

    assert_eq!(out.status, 0);
    assert_eq!(std::fs::read_to_string(&outside_path)?, "outside");
    assert!(temp_path.symlink_metadata()?.file_type().is_symlink());
    let resume_events = read_session_file(&session_path)?;
    assert_eq!(resume_events.len(), 3);
    assert_eq!(resume_events[1]["item"]["text"], "hi");
    Ok(())
}

#[cfg(unix)]
#[test]
fn resume_ignores_stale_fixed_temp_hardlink() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    let session_path = build_session_path(dir.path(), Utc::now().date_naive(), thread_id)?;
    let temp_path = session_path.with_extension("jsonl.tmp");
    if let Some(parent) = temp_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let outside_path = dir.path().join("outside.tmp");
    std::fs::write(&outside_path, "outside")?;
    std::fs::hard_link(&outside_path, &temp_path)?;

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "turn-2"])?;
    assert_eq!(out.status, 0);
    assert_eq!(out.events[0]["thread_id"], thread_id);

    assert_eq!(std::fs::read_to_string(&outside_path)?, "outside");
    assert!(
        temp_path.exists(),
        "stale fixed temp path should not be renamed away"
    );
    let resume_events = read_session_file(&session_path)?;
    assert_eq!(resume_events.len(), 3);
    assert_eq!(resume_events[1]["item"]["text"], "turn-2");
    Ok(())
}

#[cfg(unix)]
#[test]
fn resume_ignores_symlinked_existing_session() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    let outside_path = dir.path().join("outside.jsonl");
    write_session_file(&outside_path, &build_events(thread_id, "outside-turn"))?;

    let linked_path = dir
        .path()
        .join(format!("sessions/2001/01/01/{thread_id}.jsonl"));
    if let Some(parent) = linked_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::os::unix::fs::symlink(&outside_path, &linked_path)?;

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "turn-2"])?;
    assert_eq!(out.status, 0);
    assert_eq!(out.events[0]["thread_id"], thread_id);

    let outside_events = read_session_file(&outside_path)?;
    assert_eq!(outside_events.len(), 3);
    assert_eq!(outside_events[1]["item"]["text"], "outside-turn");
    assert!(
        linked_path.symlink_metadata()?.file_type().is_symlink(),
        "resume should not replace the existing symlink"
    );

    let session_files = session_files(dir.path())?;
    let real_resume_path = session_files
        .into_iter()
        .find(|path| {
            path != &linked_path
                && path.file_stem().and_then(|value| value.to_str()) == Some(thread_id)
        })
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "real resume session file not found",
            )
        })?;
    let resume_events = read_session_file(&real_resume_path)?;
    assert_eq!(resume_events.len(), 3);
    assert_eq!(resume_events[1]["item"]["text"], "turn-2");
    Ok(())
}

#[cfg(unix)]
#[test]
fn resume_rejects_symlinked_session_parent_without_events() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let sessions = dir.path().join("sessions");
    let outside_year = dir.path().join("outside-year");
    std::fs::create_dir_all(&sessions)?;
    std::fs::create_dir_all(&outside_year)?;
    for year in session_year_candidates() {
        std::os::unix::fs::symlink(&outside_year, sessions.join(year))?;
    }
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "hi"])?;

    assert_ne!(out.status, 0);
    assert!(
        out.events.is_empty(),
        "symlinked session parent should fail before emitting events: {:?}",
        out.events
    );
    assert!(
        out.stderr.contains("sessions path is not a real directory"),
        "resume should report the symlinked session parent: {:?}",
        out.stderr
    );
    Ok(())
}

#[test]
fn resume_rejects_sessions_file_root_without_events() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join("sessions"), b"not a directory")?;
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "hi"])?;

    assert_ne!(out.status, 0);
    assert!(
        out.events.is_empty(),
        "unusable sessions root should fail before emitting events: {:?}",
        out.events
    );
    assert!(
        out.stderr.contains("sessions path is not a real directory"),
        "resume should report the unusable sessions root: {:?}",
        out.stderr
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn resume_rejects_sessions_symlink_loop_without_events() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let sessions = dir.path().join("sessions");
    std::os::unix::fs::symlink(&sessions, &sessions)?;
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "hi"])?;

    assert_ne!(out.status, 0);
    assert!(
        out.events.is_empty(),
        "unusable sessions root should fail before emitting events: {:?}",
        out.events
    );
    assert!(
        !out.stderr.is_empty(),
        "resume should report the filesystem error"
    );
    Ok(())
}

#[test]
fn resume_rejects_absolute_thread_id_without_events_or_artifacts() -> std::io::Result<()> {
    let codex_dir = TempDir::new().unwrap();
    let outside_dir = TempDir::new().unwrap();
    let outside_target = outside_dir.path().join("escape");
    let supplied = outside_target.to_str().unwrap();

    let out = run(codex_dir.path(), &["exec", "resume", supplied, "--", "hi"])?;
    assert_invalid_resume_rejected(codex_dir.path(), &out)?;

    assert!(
        !outside_target.with_extension("jsonl").exists(),
        "invalid absolute id should not create an outside session file"
    );
    assert!(
        !outside_target.with_extension("jsonl.tmp").exists(),
        "invalid absolute id should not leave an outside temp file"
    );
    Ok(())
}

#[test]
fn resume_rejects_traversal_thread_id_without_events_or_artifacts() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();

    let out = run(dir.path(), &["exec", "resume", "../escape", "--", "hi"])?;
    assert_invalid_resume_rejected(dir.path(), &out)
}

#[test]
fn resume_rejects_nested_thread_id_without_events_or_artifacts() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();

    let out = run(dir.path(), &["exec", "resume", "nested/id", "--", "hi"])?;
    assert_invalid_resume_rejected(dir.path(), &out)
}

#[test]
fn resume_rejects_non_uuid_thread_id_without_events_or_artifacts() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();

    let out = run(dir.path(), &["exec", "resume", "xyz-uuid", "--", "hi"])?;
    assert_invalid_resume_rejected(dir.path(), &out)
}

#[test]
fn resume_rejects_uppercase_uuid_thread_id_without_events_or_artifacts() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();

    let out = run(
        dir.path(),
        &[
            "exec",
            "resume",
            "0199A213-81C0-7800-8AA1-BBAB2A035A53",
            "--",
            "hi",
        ],
    )?;
    assert_invalid_resume_rejected(dir.path(), &out)
}

#[test]
fn resume_rejects_simple_uuid_thread_id_without_events_or_artifacts() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();

    let out = run(
        dir.path(),
        &[
            "exec",
            "resume",
            "0199a21381c078008aa1bbab2a035a53",
            "--",
            "hi",
        ],
    )?;
    assert_invalid_resume_rejected(dir.path(), &out)
}

#[cfg(unix)]
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

    let c_path = CString::new(path.as_os_str().as_bytes())
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidInput, err))?;
    // SAFETY: `c_path` is a valid NUL-terminated path and `mkfifo` does not
    // retain the pointer after returning.
    let result = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
    if result < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}
