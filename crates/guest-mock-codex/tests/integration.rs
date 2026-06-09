//! Integration tests that spawn the real binary via Cargo's
//! `CARGO_BIN_EXE_guest-mock-codex` env var.
//!
//! Cover the contract guest-agent will rely on: stdout JSONL shape, the
//! on-disk session file path / format, and resume semantics.

use std::path::{Path, PathBuf};
use std::process::Command;

use chrono::{Datelike, Utc};
use guest_mock_codex::{
    build_events, build_session_path, find_session_file, read_session_file, session_artifacts,
    session_files, write_session_file,
};
use serde_json::Value;
use tempfile::TempDir;

const BIN: &str = env!("CARGO_BIN_EXE_guest-mock-codex");

#[derive(Debug)]
struct RunOutput {
    events: Vec<Value>,
    status: i32,
    stderr: String,
}

fn run(codex_home: &Path, args: &[&str]) -> std::io::Result<RunOutput> {
    run_with_env(codex_home, args, &[])
}

fn run_with_env(
    codex_home: &Path,
    args: &[&str],
    env: &[(&str, &str)],
) -> std::io::Result<RunOutput> {
    let mut cmd = Command::new(BIN);
    cmd.env("CODEX_HOME", codex_home).args(args);
    cmd.env_remove("MOCK_CODEX_FIXTURE");
    for (k, v) in env {
        cmd.env(k, v);
    }
    let output = cmd.output()?;

    let stdout = String::from_utf8(output.stdout)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let stderr = String::from_utf8(output.stderr)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let mut events = Vec::new();
    for line in stdout.lines() {
        if line.is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(line)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        events.push(v);
    }

    Ok(RunOutput {
        events,
        status: output.status.code().unwrap_or(-1),
        stderr,
    })
}

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

fn require_session_file(codex_home: &Path) -> std::io::Result<PathBuf> {
    find_session_file(codex_home)?.ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("session file not found under {codex_home:?}"),
        )
    })
}

fn session_year_candidates() -> [String; 2] {
    let year = Utc::now().date_naive().year();
    [format!("{year:04}"), format!("{:04}", year + 1)]
}

#[test]
fn happy_path_emits_three_events_and_persists_jsonl() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let out = run(dir.path(), &["exec", "--json", "--", "hello"])?;

    assert_eq!(out.status, 0);
    assert_eq!(out.events.len(), 3);
    assert_eq!(out.events[0]["type"], "thread.started");
    assert_eq!(out.events[1]["type"], "item.completed");
    assert_eq!(out.events[1]["item"]["type"], "agent_message");
    assert_eq!(out.events[1]["item"]["text"], "hello");
    assert_eq!(out.events[2]["type"], "turn.completed");
    assert_eq!(out.events[2]["usage"]["input_tokens"], 10);
    assert_eq!(out.events[2]["usage"]["output_tokens"], 20);

    let thread_id = out.events[0]["thread_id"].as_str().unwrap();
    let session_path = require_session_file(dir.path())?;
    assert!(
        session_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .starts_with(thread_id),
        "session filename should start with thread_id: {session_path:?}"
    );

    let events = read_session_file(&session_path)?;
    assert_eq!(events, out.events);
    Ok(())
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

#[test]
fn resume_echoes_thread_id_and_appends_events() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let first = run(dir.path(), &["exec", "--json", "--", "turn-1"])?;
    let thread_id = first.events[0]["thread_id"].as_str().unwrap().to_string();

    let second = run(dir.path(), &["exec", "resume", &thread_id, "--", "turn-2"])?;
    assert_eq!(second.status, 0);
    assert_eq!(second.events[0]["thread_id"], thread_id);
    assert_eq!(second.events[1]["item"]["text"], "turn-2");

    let session_path = require_session_file(dir.path())?;
    let events = read_session_file(&session_path)?;
    assert_eq!(events.len(), 6);
    assert_eq!(events[1]["item"]["text"], "turn-1");
    assert_eq!(events[4]["item"]["text"], "turn-2");
    Ok(())
}

#[test]
fn resume_with_unknown_id_starts_fresh_with_supplied_id() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let supplied = "0199a213-81c0-7800-8aa1-bbab2a035a53";

    let out = run(dir.path(), &["exec", "resume", supplied, "--", "hi"])?;
    assert_eq!(out.status, 0);
    assert_eq!(out.events[0]["thread_id"], supplied);

    let session_path = require_session_file(dir.path())?;
    assert!(
        session_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .starts_with(supplied)
    );
    Ok(())
}

#[test]
fn resume_appends_existing_session_from_previous_date() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    let existing_path = dir
        .path()
        .join(format!("sessions/2001/01/01/{thread_id}.jsonl"));
    write_session_file(&existing_path, &build_events(thread_id, "turn-1"))?;

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "turn-2"])?;
    assert_eq!(out.status, 0);
    assert_eq!(out.events[0]["thread_id"], thread_id);

    let events = read_session_file(&existing_path)?;
    assert_eq!(events.len(), 6);
    assert_eq!(events[1]["item"]["text"], "turn-1");
    assert_eq!(events[4]["item"]["text"], "turn-2");
    assert_eq!(session_files(dir.path())?, vec![existing_path]);
    Ok(())
}

#[test]
fn resume_appends_restored_rollout_session() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    let restored_path = dir.path().join(format!(
        "sessions/2001/01/01/rollout-2001-01-01T00-00-00-{thread_id}.jsonl"
    ));
    write_session_file(&restored_path, &build_events(thread_id, "turn-1"))?;

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "turn-2"])?;
    assert_eq!(out.status, 0);
    assert_eq!(out.events[0]["thread_id"], thread_id);

    let events = read_session_file(&restored_path)?;
    assert_eq!(events.len(), 6);
    assert_eq!(events[1]["item"]["text"], "turn-1");
    assert_eq!(events[4]["item"]["text"], "turn-2");
    assert_eq!(session_files(dir.path())?, vec![restored_path]);
    Ok(())
}

#[test]
fn resume_appends_restored_rollout_session_without_parsing_history() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    let restored_path = dir.path().join(format!(
        "sessions/2001/01/01/rollout-2001-01-01T00-00-00-{thread_id}.jsonl"
    ));
    if let Some(parent) = restored_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&restored_path, "{not-json}")?;

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "turn-2"])?;
    assert_eq!(out.status, 0);
    assert_eq!(out.events[0]["thread_id"], thread_id);

    let raw = std::fs::read_to_string(&restored_path)?;
    assert!(
        raw.starts_with("{not-json}\n"),
        "resume should preserve existing raw history and add a line break: {raw:?}"
    );
    assert!(
        raw.contains("\"text\":\"turn-2\""),
        "resume should append the new turn events: {raw:?}"
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn resume_replaces_today_symlinked_fallback_without_reading_target() -> std::io::Result<()> {
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
    assert_eq!(out.status, 0);
    assert_eq!(out.events[0]["thread_id"], thread_id);

    let outside_events = read_session_file(&outside_path)?;
    assert_eq!(outside_events.len(), 3);
    assert_eq!(outside_events[1]["item"]["text"], "outside-turn");
    assert!(
        session_path.symlink_metadata()?.file_type().is_file(),
        "resume should replace the symlinked fallback path with a real file"
    );
    let resume_events = read_session_file(&session_path)?;
    assert_eq!(resume_events.len(), 3);
    assert_eq!(resume_events[1]["item"]["text"], "turn-2");
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
fn resume_rejects_temp_session_directory_without_events() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    let session_path = build_session_path(dir.path(), Utc::now().date_naive(), thread_id)?;
    std::fs::create_dir_all(session_path.with_extension("jsonl.tmp"))?;

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "hi"])?;

    assert_ne!(out.status, 0);
    assert!(
        out.events.is_empty(),
        "unusable temp session path should fail before emitting events: {:?}",
        out.events
    );
    assert!(
        out.stderr
            .contains("session temp path is not a regular file"),
        "resume should report the unusable temp session path: {:?}",
        out.stderr
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn resume_rejects_temp_session_symlink_without_events() -> std::io::Result<()> {
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

    assert_ne!(out.status, 0);
    assert!(
        out.events.is_empty(),
        "symlinked temp session path should fail before emitting events: {:?}",
        out.events
    );
    assert!(
        out.stderr
            .contains("session temp path is not a regular file"),
        "resume should report the symlinked temp session path: {:?}",
        out.stderr
    );
    assert_eq!(std::fs::read_to_string(&outside_path)?, "outside");
    assert!(temp_path.symlink_metadata()?.file_type().is_symlink());
    Ok(())
}

#[cfg(unix)]
#[test]
fn resume_replaces_hardlinked_temp_without_mutating_target() -> std::io::Result<()> {
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
        !temp_path.exists(),
        "temp path should be renamed away after successful session write"
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

#[test]
fn accepts_all_no_op_flags_without_failing() {
    let dir = TempDir::new().unwrap();
    let out = run(
        dir.path(),
        &[
            "exec",
            "--json",
            "--sandbox",
            "danger-full-access",
            "--skip-git-repo-check",
            "-C",
            "/tmp",
            "-m",
            "gpt-5",
            "-c",
            "features.memories=true",
            "--config",
            "developer_instructions=\"your name is Aria\"",
            "--append-system-prompt",
            "your name is Aria",
            "--",
            "hello",
        ],
    )
    .unwrap();

    assert_eq!(out.status, 0);
    assert_eq!(out.events.len(), 3);
    assert_eq!(out.events[1]["item"]["text"], "hello");
}

#[test]
fn prompt_without_double_dash_separator_works() {
    let dir = TempDir::new().unwrap();
    let out = run(dir.path(), &["exec", "--json", "hello world"]).unwrap();

    assert_eq!(out.status, 0);
    assert_eq!(out.events.len(), 3);
    assert_eq!(out.events[1]["item"]["text"], "hello world");
}

#[test]
fn config_flags_before_prompt_are_not_echoed() {
    let dir = TempDir::new().unwrap();
    let out = run(
        dir.path(),
        &[
            "exec",
            "--json",
            "-c",
            "features.memories=true",
            "hello from codex",
        ],
    )
    .unwrap();

    assert_eq!(out.status, 0);
    assert_eq!(out.events.len(), 3);
    assert_eq!(out.events[1]["item"]["text"], "hello from codex");
}

#[test]
fn config_flags_before_resume_are_not_echoed() {
    let dir = TempDir::new().unwrap();
    let first = run(dir.path(), &["exec", "--json", "--", "turn-1"]).unwrap();
    let thread_id = first.events[0]["thread_id"].as_str().unwrap().to_string();

    let second = run(
        dir.path(),
        &[
            "exec",
            "--json",
            "-c",
            "features.memories=true",
            "resume",
            &thread_id,
            "turn-2",
        ],
    )
    .unwrap();

    assert_eq!(second.status, 0);
    assert_eq!(second.events[0]["thread_id"], thread_id);
    assert_eq!(second.events[1]["item"]["text"], "turn-2");
}

#[test]
fn fixture_event_mapping_rich_emits_full_event_set() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let out = run_with_env(
        dir.path(),
        &["exec", "--json", "--", "ignored"],
        &[("MOCK_CODEX_FIXTURE", "event-mapping-rich")],
    )?;

    assert_eq!(out.status, 0);
    assert_eq!(out.events.len(), 11);
    assert_eq!(
        out.events[0]["thread_id"],
        "00000000-0000-0000-0000-000000000001"
    );

    let item_types: Vec<&str> = out
        .events
        .iter()
        .filter_map(|e| e["item"]["type"].as_str())
        .collect();
    for expected in [
        "command_execution",
        "file_edit",
        "file_read",
        "file_change",
        "reasoning",
        "agent_message",
    ] {
        assert!(
            item_types.contains(&expected),
            "fixture missing item type {expected}: got {item_types:?}"
        );
    }
    assert_eq!(out.events.last().unwrap()["type"], "turn.completed");

    let session_path = require_session_file(dir.path())?;
    let persisted = read_session_file(&session_path)?;
    assert_eq!(persisted, out.events);
    Ok(())
}

#[test]
fn fixture_turn_failed_ends_with_turn_failed() {
    let dir = TempDir::new().unwrap();
    let out = run_with_env(
        dir.path(),
        &["exec", "--json", "--", "ignored"],
        &[("MOCK_CODEX_FIXTURE", "turn-failed")],
    )
    .unwrap();

    assert_eq!(out.status, 0);
    assert_eq!(out.events.len(), 3);
    assert_eq!(
        out.events[0]["thread_id"],
        "00000000-0000-0000-0000-000000000002"
    );
    assert_eq!(out.events.last().unwrap()["type"], "turn.failed");
}

#[test]
fn fixture_error_event_emits_error_type() {
    let dir = TempDir::new().unwrap();
    let out = run_with_env(
        dir.path(),
        &["exec", "--json", "--", "ignored"],
        &[("MOCK_CODEX_FIXTURE", "error-event")],
    )
    .unwrap();

    assert_eq!(out.status, 0);
    assert_eq!(out.events.len(), 2);
    assert_eq!(
        out.events[0]["thread_id"],
        "00000000-0000-0000-0000-000000000003"
    );
    assert_eq!(out.events[1]["type"], "error");
}

#[test]
fn fixture_invalid_api_key_emits_error_code() {
    let dir = TempDir::new().unwrap();
    let out = run_with_env(
        dir.path(),
        &["exec", "--json", "--", "ignored"],
        &[("MOCK_CODEX_FIXTURE", "invalid-api-key")],
    )
    .unwrap();

    assert_eq!(out.status, 0);
    assert_eq!(out.events.len(), 2);
    assert_eq!(
        out.events[0]["thread_id"],
        "00000000-0000-0000-0000-000000000004"
    );
    assert_eq!(out.events[1]["type"], "error");
    assert_eq!(out.events[1]["code"], "invalid_api_key");
}

#[test]
fn fixture_unknown_name_falls_through_to_synthetic() {
    let dir = TempDir::new().unwrap();
    let out = run_with_env(
        dir.path(),
        &["exec", "--json", "--", "hello"],
        &[("MOCK_CODEX_FIXTURE", "no-such-fixture")],
    )
    .unwrap();

    assert_eq!(out.status, 0);
    assert_eq!(out.events.len(), 3);
    assert_eq!(out.events[0]["type"], "thread.started");
    assert_eq!(out.events[1]["item"]["text"], "hello");
    assert_eq!(out.events[2]["type"], "turn.completed");
}

#[test]
fn fixture_empty_env_var_uses_synthetic() {
    let dir = TempDir::new().unwrap();
    let out = run_with_env(
        dir.path(),
        &["exec", "--json", "--", "hello"],
        &[("MOCK_CODEX_FIXTURE", "")],
    )
    .unwrap();

    assert_eq!(out.status, 0);
    assert_eq!(out.events.len(), 3);
    assert_eq!(out.events[1]["item"]["text"], "hello");
}

#[test]
fn thread_id_is_uuid_v7_shape() {
    let dir = TempDir::new().unwrap();
    let out = run(dir.path(), &["exec", "--json", "--", "x"]).unwrap();
    let id = out.events[0]["thread_id"].as_str().unwrap();
    let parts: Vec<&str> = id.split('-').collect();
    assert_eq!(parts.len(), 5);
    assert_eq!(parts[0].len(), 8);
    assert_eq!(parts[1].len(), 4);
    assert_eq!(parts[2].len(), 4);
    assert_eq!(parts[3].len(), 4);
    assert_eq!(parts[4].len(), 12);
    assert!(
        parts[2].starts_with('7'),
        "expected uuid v7 (third group starts with '7'): {id}"
    );
}

#[cfg(unix)]
#[test]
fn session_files_include_symlinked_files_without_recursing_symlinked_dirs() -> std::io::Result<()> {
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
    assert_eq!(files, vec![real_file, linked_file]);
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
