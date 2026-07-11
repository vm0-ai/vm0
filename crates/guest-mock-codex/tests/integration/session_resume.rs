use std::collections::BTreeSet;

use guest_mock_codex::{build_events, read_session_file, session_files, write_session_file};
use serde_json::Value;
use tempfile::TempDir;

use crate::support::{require_session_file, run};

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

#[test]
fn resume_rejects_duplicate_matching_sessions_without_events() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    let first_path = dir
        .path()
        .join(format!("sessions/2001/01/01/{thread_id}.jsonl"));
    let second_path = dir.path().join(format!(
        "sessions/2001/01/02/rollout-restored-{thread_id}.jsonl"
    ));
    write_session_file(&first_path, &build_events(thread_id, "first"))?;
    write_session_file(&second_path, &build_events(thread_id, "second"))?;

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "turn-3"])?;

    assert_ne!(out.status, 0);
    assert!(
        out.events.is_empty(),
        "duplicate sessions should fail before emitting events: {:?}",
        out.events
    );
    assert!(
        out.stderr.contains("multiple session files found"),
        "resume should report duplicate session files: {:?}",
        out.stderr
    );
    assert_eq!(read_session_file(&first_path)?.len(), 3);
    assert_eq!(read_session_file(&second_path)?.len(), 3);
    Ok(())
}

#[test]
fn resume_rejects_duplicate_matching_session_in_non_layout_tree_without_events()
-> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let thread_id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    let layout_path = dir
        .path()
        .join(format!("sessions/2001/01/01/{thread_id}.jsonl"));
    let non_layout_path = dir.path().join(format!(
        "sessions/not-layout/deep/rollout-restored-{thread_id}.jsonl"
    ));
    write_session_file(&layout_path, &build_events(thread_id, "layout"))?;
    write_session_file(&non_layout_path, &build_events(thread_id, "non-layout"))?;

    let out = run(dir.path(), &["exec", "resume", thread_id, "--", "turn-3"])?;

    assert_ne!(out.status, 0);
    assert!(
        out.events.is_empty(),
        "non-layout duplicate should fail before emitting events: {:?}",
        out.events
    );
    assert!(
        out.stderr.contains("multiple session files found"),
        "resume should report duplicate session files: {:?}",
        out.stderr
    );
    assert_eq!(read_session_file(&layout_path)?.len(), 3);
    assert_eq!(read_session_file(&non_layout_path)?.len(), 3);
    Ok(())
}

#[test]
fn concurrent_resume_writes_preserve_all_turns() -> std::io::Result<()> {
    let dir = TempDir::new().unwrap();
    let first = run(dir.path(), &["exec", "--json", "--", "turn-0"])?;
    assert_eq!(first.status, 0);
    let thread_id = first.events[0]["thread_id"].as_str().unwrap();

    let mut handles = Vec::new();
    for prompt in ["turn-1", "turn-2", "turn-3", "turn-4", "turn-5"] {
        let codex_home = dir.path().to_path_buf();
        let thread_id = thread_id.to_string();
        handles.push((
            prompt,
            std::thread::spawn(move || {
                run(&codex_home, &["exec", "resume", &thread_id, "--", prompt])
            }),
        ));
    }

    let mut io_failures = Vec::new();
    let mut status_failures = Vec::new();
    let mut error_kind = None;
    for (prompt, handle) in handles {
        match handle.join() {
            Ok(Ok(out)) if out.status == 0 => {}
            Ok(Ok(out)) => {
                status_failures.push(format!(
                    "{prompt}: status={}; stderr={:?}",
                    out.status, out.stderr
                ));
            }
            Ok(Err(err)) => {
                if err.kind() == std::io::ErrorKind::TimedOut {
                    error_kind = Some(std::io::ErrorKind::TimedOut);
                } else {
                    error_kind.get_or_insert(err.kind());
                }
                io_failures.push(format!("{prompt}: {err}"));
            }
            Err(_) => {
                error_kind.get_or_insert(std::io::ErrorKind::Other);
                io_failures.push(format!("{prompt}: resume thread panicked"));
            }
        }
    }
    if !io_failures.is_empty() {
        let mut message = format!("resume child errors: {}", io_failures.join("; "));
        if !status_failures.is_empty() {
            message.push_str(&format!(
                "; resume child non-zero statuses: {}",
                status_failures.join("; ")
            ));
        }
        return Err(std::io::Error::new(
            error_kind.unwrap_or(std::io::ErrorKind::Other),
            message,
        ));
    }
    assert!(
        status_failures.is_empty(),
        "resume child non-zero statuses: {}",
        status_failures.join("; ")
    );

    let session_path = require_session_file(dir.path())?;
    let events = read_session_file(&session_path)?;
    let prompts: BTreeSet<&str> = events
        .iter()
        .filter_map(|event| event.pointer("/item/text").and_then(Value::as_str))
        .collect();
    assert_eq!(
        prompts,
        BTreeSet::from(["turn-0", "turn-1", "turn-2", "turn-3", "turn-4", "turn-5"])
    );
    assert_eq!(events.len(), 18);
    Ok(())
}
