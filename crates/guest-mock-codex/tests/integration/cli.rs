use guest_mock_codex::read_session_file;
use tempfile::TempDir;

use crate::support::{
    require_session_file, run, run_with_env, run_with_stdin, run_with_stdin_and_env,
};

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
fn fresh_prompt_stdin_is_preserved_exactly() -> std::io::Result<()> {
    let dir = TempDir::new()?;
    let prompt = " \n--literal option-looking prompt\n中文 and emoji 🚀\n-\n ";
    let out = run_with_stdin(dir.path(), &["exec", "--json", "--", "-"], prompt)?;

    assert_eq!(out.status, 0);
    assert_eq!(out.events[1]["item"]["text"], prompt);
    let session_path = require_session_file(dir.path())?;
    let persisted = read_session_file(&session_path)?;
    assert_eq!(persisted[1]["item"]["text"], prompt);
    Ok(())
}

#[test]
fn fresh_prompt_stdin_preserves_literal_dash() -> std::io::Result<()> {
    let dir = TempDir::new()?;
    let out = run_with_stdin(dir.path(), &["exec", "--json", "--", "-"], "-")?;

    assert_eq!(out.status, 0);
    assert_eq!(out.events[1]["item"]["text"], "-");
    Ok(())
}

#[test]
fn fresh_prompt_stdin_rejects_whitespace_only_input() -> std::io::Result<()> {
    let dir = TempDir::new()?;
    let out = run_with_stdin(dir.path(), &["exec", "--json", "--", "-"], " \n\t")?;

    assert_ne!(out.status, 0);
    assert!(out.events.is_empty());
    assert!(out.stderr.contains("No prompt provided via stdin."));
    Ok(())
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
    let out = run_with_stdin_and_env(
        dir.path(),
        &["exec", "--json", "--", "-"],
        "ignored through stdin",
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
