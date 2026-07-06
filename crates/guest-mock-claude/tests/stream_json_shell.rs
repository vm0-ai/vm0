mod support;

use std::collections::HashSet;
use std::fs;
use std::process::Stdio;

use serde_json::Value;
#[cfg(target_os = "linux")]
use support::kill_pid_file;
use support::{
    LARGE_MOCK_OUTPUT_BYTES, MOCK_CAPTURE_LIMIT_BYTES, STDERR_TRUNCATION_MARKER,
    STDOUT_TRUNCATION_MARKER, event_kind, expected_history_path, init_session_id, mock_claude,
    mock_stream_json_shell_output, parse_jsonl, result_content, run_mock_output,
    spawn_managed_mock_child, tool_result_content, wait_child_output,
};

#[test]
fn stream_json_shell_writes_matching_session_history() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;

    let mut command = mock_claude();
    command
        .env("HOME", home.path())
        .args(["--output-format", "stream-json", "--", "printf hello"]);
    let output = run_mock_output(&mut command)?;

    assert!(
        output.status.success(),
        "expected success, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());

    let events = parse_jsonl(&output.stdout)?;
    let session_id = init_session_id(&events)?;
    let stdout = String::from_utf8(output.stdout)?;
    let history = fs::read_to_string(expected_history_path(home.path(), &session_id))?;

    assert_eq!(history, stdout);
    assert_eq!(
        events.iter().map(event_kind).collect::<Vec<_>>(),
        [
            "system/init",
            "assistant/text",
            "assistant/tool_use",
            "user/tool_result",
            "result/success",
        ]
    );
    assert_eq!(
        events[2]
            .pointer("/message/content/0/input/command")
            .and_then(Value::as_str),
        Some("printf hello")
    );
    assert_eq!(
        events[3]
            .pointer("/message/content/0/content")
            .and_then(Value::as_str),
        Some("hello")
    );
    assert_eq!(
        events[4].get("result").and_then(Value::as_str),
        Some("hello")
    );
    assert_eq!(
        events[4].get("is_error").and_then(Value::as_bool),
        Some(false)
    );
    Ok(())
}

#[test]
fn stream_json_shell_background_child_does_not_hold_output_open()
-> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;

    let output = mock_stream_json_shell_output(home.path(), "sleep 30 & echo done")?;
    assert!(
        output.status.success(),
        "expected success, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());

    let events = parse_jsonl(&output.stdout)?;
    assert_eq!(
        events.iter().map(event_kind).collect::<Vec<_>>(),
        [
            "system/init",
            "assistant/text",
            "assistant/tool_use",
            "user/tool_result",
            "result/success",
        ]
    );
    assert!(tool_result_content(&events)?.contains("done"));
    assert!(result_content(&events)?.contains("done"));
    Ok(())
}

#[cfg(target_os = "linux")]
#[test]
fn stream_json_shell_escaped_child_does_not_hold_output_open()
-> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let ready = home.path().join("escaped-child-ready");
    let pid_file = home.path().join("escaped-child-pid");
    let ready_path = ready.to_string_lossy();
    let pid_path = pid_file.to_string_lossy();
    let prompt = format!(
        "setsid sh -c 'echo $$ > \"{pid_path}\"; echo ready > \"{ready_path}\"; exec sleep 30' & \
         while [ ! -f \"{ready_path}\" ]; do :; done; echo done"
    );

    let output = mock_stream_json_shell_output(home.path(), &prompt);
    kill_pid_file(&pid_file);
    let output = output?;
    assert!(
        output.status.success(),
        "expected success, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());

    let events = parse_jsonl(&output.stdout)?;
    assert_eq!(
        events.iter().map(event_kind).collect::<Vec<_>>(),
        [
            "system/init",
            "assistant/text",
            "assistant/tool_use",
            "user/tool_result",
            "result/success",
        ]
    );
    assert!(tool_result_content(&events)?.contains("done"));
    assert!(result_content(&events)?.contains("done"));
    Ok(())
}

#[cfg(target_os = "linux")]
#[test]
fn stream_json_shell_truncated_escaped_stderr_writer_does_not_hold_output_open()
-> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let ready = home.path().join("escaped-stderr-ready");
    let pid_file = home.path().join("escaped-stderr-pid");
    let ready_path = ready.to_string_lossy();
    let pid_path = pid_file.to_string_lossy();
    let prompt = format!(
        "setsid sh -c 'echo $$ > \"{pid_path}\"; yes escaped-stderr | head -c {LARGE_MOCK_OUTPUT_BYTES} >&2; echo ready > \"{ready_path}\"; exec yes escaped-stderr >&2' & \
         while [ ! -f \"{ready_path}\" ]; do :; done; echo done"
    );

    let output = mock_stream_json_shell_output(home.path(), &prompt);
    kill_pid_file(&pid_file);
    let output = output?;
    assert!(
        output.status.success(),
        "expected success, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());

    let events = parse_jsonl(&output.stdout)?;
    assert_eq!(
        events.iter().map(event_kind).collect::<Vec<_>>(),
        [
            "system/init",
            "assistant/text",
            "assistant/tool_use",
            "user/tool_result",
            "result/success",
        ]
    );
    assert!(tool_result_content(&events)?.contains("done"));
    assert!(result_content(&events)?.contains("done"));
    assert!(!tool_result_content(&events)?.contains("escaped-stderr"));
    assert!(!result_content(&events)?.contains("escaped-stderr"));
    Ok(())
}

#[test]
fn concurrent_stream_json_ids_are_unique() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let children = (0..16)
        .map(|_| {
            let mut command = mock_claude();
            command
                .env("HOME", home.path())
                .args(["--output-format", "stream-json", "--", "true"])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            spawn_managed_mock_child(&mut command)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut session_ids = HashSet::new();

    for child in children {
        let output = wait_child_output(child)?;
        assert!(
            output.status.success(),
            "expected success, stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.stderr.is_empty());

        let events = parse_jsonl(&output.stdout)?;
        let session_id = init_session_id(&events)?;
        assert!(
            session_ids.insert(session_id.clone()),
            "duplicate session id: {session_id}"
        );
        assert!(expected_history_path(home.path(), &session_id).exists());
    }

    Ok(())
}

#[test]
fn stream_json_shell_failure_writes_error_history() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;

    let mut command = mock_claude();
    command.env("HOME", home.path()).args([
        "--output-format",
        "stream-json",
        "--",
        "printf out; printf err >&2; exit 7",
    ]);
    let output = run_mock_output(&mut command)?;

    assert_eq!(output.status.code(), Some(7));
    assert!(output.stderr.is_empty());

    let events = parse_jsonl(&output.stdout)?;
    let session_id = init_session_id(&events)?;
    let stdout = String::from_utf8(output.stdout)?;
    let history = fs::read_to_string(expected_history_path(home.path(), &session_id))?;

    assert_eq!(history, stdout);
    assert_eq!(
        events.iter().map(event_kind).collect::<Vec<_>>(),
        [
            "system/init",
            "assistant/text",
            "assistant/tool_use",
            "user/tool_result",
            "result/error",
        ]
    );
    assert_eq!(
        events[3]
            .pointer("/message/content/0/content")
            .and_then(Value::as_str),
        Some("outerr")
    );
    assert_eq!(
        events[3]
            .pointer("/message/content/0/is_error")
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        events[4].get("result").and_then(Value::as_str),
        Some("outerr")
    );
    assert_eq!(
        events[4].get("is_error").and_then(Value::as_bool),
        Some(true)
    );
    Ok(())
}

#[test]
fn stream_json_shell_large_stdout_is_bounded() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let prompt = format!("yes A | head -c {LARGE_MOCK_OUTPUT_BYTES}");

    let output = mock_stream_json_shell_output(home.path(), &prompt)?;

    assert!(
        output.status.success(),
        "expected success, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());

    let events = parse_jsonl(&output.stdout)?;
    let session_id = init_session_id(&events)?;
    let stdout = String::from_utf8(output.stdout)?;
    let history = fs::read_to_string(expected_history_path(home.path(), &session_id))?;
    let tool_output = tool_result_content(&events)?;
    let result_output = result_content(&events)?;

    assert_eq!(history, stdout);
    assert_eq!(tool_output, result_output);
    assert!(tool_output.contains(STDOUT_TRUNCATION_MARKER));
    assert!(!tool_output.contains(STDERR_TRUNCATION_MARKER));
    assert!(tool_output.len() <= MOCK_CAPTURE_LIMIT_BYTES + 128);
    Ok(())
}

#[test]
fn stream_json_shell_large_stderr_failure_is_bounded() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let prompt = format!("printf out; yes E | head -c {LARGE_MOCK_OUTPUT_BYTES} >&2; exit 7");

    let output = mock_stream_json_shell_output(home.path(), &prompt)?;

    assert_eq!(output.status.code(), Some(7));
    assert!(output.stderr.is_empty());

    let events = parse_jsonl(&output.stdout)?;
    let tool_output = tool_result_content(&events)?;
    let result_output = result_content(&events)?;

    assert_eq!(tool_output, result_output);
    assert!(tool_output.starts_with("out"));
    assert!(tool_output.contains(STDERR_TRUNCATION_MARKER));
    assert!(!tool_output.contains(STDOUT_TRUNCATION_MARKER));
    assert!(tool_output.len() <= MOCK_CAPTURE_LIMIT_BYTES + 128);
    Ok(())
}

#[test]
fn stream_json_shell_large_stdout_and_stderr_do_not_deadlock()
-> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let prompt = format!(
        "yes O | head -c {LARGE_MOCK_OUTPUT_BYTES}; \
         yes E | head -c {LARGE_MOCK_OUTPUT_BYTES} >&2; \
         exit 8"
    );

    let output = mock_stream_json_shell_output(home.path(), &prompt)?;

    assert_eq!(output.status.code(), Some(8));
    assert!(output.stderr.is_empty());

    let events = parse_jsonl(&output.stdout)?;
    let tool_output = tool_result_content(&events)?;
    let result_output = result_content(&events)?;

    assert_eq!(tool_output, result_output);
    assert!(tool_output.contains(STDOUT_TRUNCATION_MARKER));
    assert!(tool_output.contains(STDERR_TRUNCATION_MARKER));
    assert!(tool_output.len() <= (MOCK_CAPTURE_LIMIT_BYTES * 2) + 256);
    Ok(())
}

#[test]
fn stream_json_shell_success_drains_stderr_without_exposing_it()
-> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let prompt = format!("yes hidden-stderr | head -c {LARGE_MOCK_OUTPUT_BYTES} >&2; printf ok");

    let output = mock_stream_json_shell_output(home.path(), &prompt)?;

    assert!(
        output.status.success(),
        "expected success, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());

    let events = parse_jsonl(&output.stdout)?;
    let tool_output = tool_result_content(&events)?;
    let result_output = result_content(&events)?;

    assert_eq!(tool_output, "ok");
    assert_eq!(result_output, "ok");
    Ok(())
}

#[test]
fn stream_json_shell_invalid_utf8_output_remains_valid_jsonl()
-> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;

    let output = mock_stream_json_shell_output(home.path(), "printf '\\377'")?;

    assert!(
        output.status.success(),
        "expected success, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());

    let events = parse_jsonl(&output.stdout)?;
    let tool_output = tool_result_content(&events)?;
    let result_output = result_content(&events)?;

    assert_eq!(tool_output, "\u{fffd}");
    assert_eq!(result_output, "\u{fffd}");
    Ok(())
}

#[test]
fn exit_after_result_writes_init_and_result_history() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;

    let mut command = mock_claude();
    command.env("HOME", home.path()).args([
        "--output-format",
        "stream-json",
        "--",
        "@exit-after-result",
    ]);
    let output = run_mock_output(&mut command)?;

    assert!(
        output.status.success(),
        "expected success, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());

    let events = parse_jsonl(&output.stdout)?;
    let session_id = init_session_id(&events)?;
    let stdout = String::from_utf8(output.stdout)?;
    let history = fs::read_to_string(expected_history_path(home.path(), &session_id))?;

    assert_eq!(history, stdout);
    assert_eq!(
        events.iter().map(event_kind).collect::<Vec<_>>(),
        ["system/init", "result/success"]
    );
    assert_eq!(
        events[0].get("model").and_then(Value::as_str),
        Some("mock-claude")
    );
    assert_eq!(
        events[0]
            .get("tools")
            .and_then(Value::as_array)
            .and_then(|tools| tools.first())
            .and_then(Value::as_str),
        Some("Bash")
    );
    assert_eq!(
        events[1].get("result").and_then(Value::as_str),
        Some("Done.")
    );
    assert_eq!(
        events[1].get("is_error").and_then(Value::as_bool),
        Some(false)
    );
    Ok(())
}

#[cfg(any(
    target_os = "linux",
    target_vendor = "apple",
    target_os = "freebsd",
    target_os = "dragonfly",
    target_os = "openbsd",
    target_os = "netbsd",
    target_os = "solaris",
    target_os = "illumos",
    target_os = "aix",
    target_os = "haiku",
    target_os = "hurd",
    target_os = "nto",
))]
#[test]
fn orphan_pipe_does_not_block_output_wait() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;

    let mut command = mock_claude();
    command
        .env("HOME", home.path())
        .args(["--output-format", "stream-json", "--", "@orphan-pipe"]);
    let output = run_mock_output(&mut command)?;

    assert!(
        output.status.success(),
        "expected success, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());

    let events = parse_jsonl(&output.stdout)?;
    assert_eq!(
        events.iter().map(event_kind).collect::<Vec<_>>(),
        ["system/init", "result/success"]
    );
    Ok(())
}
