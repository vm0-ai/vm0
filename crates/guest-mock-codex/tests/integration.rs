//! Integration tests that spawn the real binary via Cargo's
//! `CARGO_BIN_EXE_guest-mock-codex` env var.
//!
//! Cover the contract guest-agent will rely on: stdout JSONL shape, the
//! on-disk session file path / format, and resume semantics.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;
use tempfile::TempDir;

const BIN: &str = env!("CARGO_BIN_EXE_guest-mock-codex");

#[derive(Debug)]
struct RunOutput {
    events: Vec<Value>,
    status: i32,
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
    for (k, v) in env {
        cmd.env(k, v);
    }
    let output = cmd.output()?;

    let stdout = String::from_utf8(output.stdout)
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
    })
}

fn read_session_file(path: &Path) -> std::io::Result<Vec<Value>> {
    let decoded = std::fs::read_to_string(path)?;
    let mut out = Vec::new();
    for line in decoded.lines() {
        if line.is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(line)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        out.push(v);
    }
    Ok(out)
}

fn find_session_file(codex_home: &Path) -> Option<PathBuf> {
    let mut found = None;
    walk(&codex_home.join("sessions"), &mut |p| {
        if p.extension().and_then(|s| s.to_str()) == Some("jsonl") {
            found = Some(p.to_path_buf());
        }
    });
    found
}

fn walk(dir: &Path, f: &mut dyn FnMut(&Path)) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk(&path, f);
        } else {
            f(&path);
        }
    }
}

#[test]
fn happy_path_emits_three_events_and_persists_jsonl() {
    let dir = TempDir::new().unwrap();
    let out = run(dir.path(), &["exec", "--json", "--", "hello"]).unwrap();

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
    let session_path = find_session_file(dir.path()).unwrap();
    assert!(
        session_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .starts_with(thread_id),
        "session filename should start with thread_id: {session_path:?}"
    );

    let events = read_session_file(&session_path).unwrap();
    assert_eq!(events, out.events);
}

#[test]
fn resume_echoes_thread_id_and_appends_events() {
    let dir = TempDir::new().unwrap();
    let first = run(dir.path(), &["exec", "--json", "--", "turn-1"]).unwrap();
    let thread_id = first.events[0]["thread_id"].as_str().unwrap().to_string();

    let second = run(dir.path(), &["exec", "resume", &thread_id, "--", "turn-2"]).unwrap();
    assert_eq!(second.status, 0);
    assert_eq!(second.events[0]["thread_id"], thread_id);
    assert_eq!(second.events[1]["item"]["text"], "turn-2");

    let session_path = find_session_file(dir.path()).unwrap();
    let events = read_session_file(&session_path).unwrap();
    assert_eq!(events.len(), 6);
    assert_eq!(events[1]["item"]["text"], "turn-1");
    assert_eq!(events[4]["item"]["text"], "turn-2");
}

#[test]
fn resume_with_unknown_id_starts_fresh_with_supplied_id() {
    let dir = TempDir::new().unwrap();
    let supplied = "0199a213-81c0-7800-8aa1-bbab2a035a53";

    let out = run(dir.path(), &["exec", "resume", supplied, "--", "hi"]).unwrap();
    assert_eq!(out.status, 0);
    assert_eq!(out.events[0]["thread_id"], supplied);

    let session_path = find_session_file(dir.path()).unwrap();
    assert!(
        session_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .starts_with(supplied)
    );
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
fn fixture_event_mapping_rich_emits_full_event_set() {
    let dir = TempDir::new().unwrap();
    let out = run_with_env(
        dir.path(),
        &["exec", "--json", "--", "ignored"],
        &[("MOCK_CODEX_FIXTURE", "event-mapping-rich")],
    )
    .unwrap();

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

    let session_path = find_session_file(dir.path()).unwrap();
    let persisted = read_session_file(&session_path).unwrap();
    assert_eq!(persisted, out.events);
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
