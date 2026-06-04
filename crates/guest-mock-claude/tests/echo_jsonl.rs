use std::fs;
use std::process::Command;

use serde_json::Value;

fn mock_claude() -> Command {
    Command::new(env!("CARGO_BIN_EXE_guest-mock-claude"))
}

fn expected_history_path(home: &std::path::Path, session_id: &str) -> std::path::PathBuf {
    let project_name = "home-user-workspace";
    home.join(".claude")
        .join("projects")
        .join(format!("-{project_name}"))
        .join(format!("{session_id}.jsonl"))
}

fn parse_jsonl(output: &[u8]) -> Result<Vec<Value>, Box<dyn std::error::Error>> {
    let stdout = String::from_utf8(output.to_vec())?;
    stdout
        .lines()
        .map(|line| Ok(serde_json::from_str::<Value>(line)?))
        .collect()
}

fn init_session_id(events: &[Value]) -> Result<String, Box<dyn std::error::Error>> {
    let session_id = events
        .iter()
        .find(|event| {
            event.get("type").and_then(Value::as_str) == Some("system")
                && event.get("subtype").and_then(Value::as_str) == Some("init")
        })
        .and_then(|event| event.get("session_id"))
        .and_then(Value::as_str)
        .ok_or("missing init session_id")?;
    Ok(session_id.to_string())
}

fn event_kind(event: &Value) -> String {
    let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
    match event_type {
        "system" | "result" => {
            let subtype = event.get("subtype").and_then(Value::as_str).unwrap_or("");
            format!("{event_type}/{subtype}")
        }
        "assistant" | "user" => {
            let content_type = event
                .pointer("/message/content/0/type")
                .and_then(Value::as_str)
                .unwrap_or("");
            format!("{event_type}/{content_type}")
        }
        _ => event_type.to_string(),
    }
}

#[test]
fn echo_jsonl_outputs_valid_payload_unchanged() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let payload = [
        r#"{"type":"system","subtype":"init","cwd":"/home/user/workspace","session_id":"preview-1","tools":["Bash"],"model":"mock-claude"}"#,
        r#"{"type":"assistant","session_id":"preview-1","message":{"role":"assistant","content":[{"type":"text","text":"fixture response"}]}}"#,
        r#"{"type":"result","subtype":"success","session_id":"preview-1","is_error":false,"duration_ms":100,"num_turns":1,"result":"Done.","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0}}"#,
    ]
    .join("\n");
    let prompt = format!("@ECHO@\n{payload}\n");

    let output = mock_claude()
        .env("HOME", home.path())
        .args(["--output-format", "stream-json", "--", &prompt])
        .output()?;

    assert!(
        output.status.success(),
        "expected success, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        format!("{payload}\n")
    );
    assert!(output.stderr.is_empty());

    let history = fs::read_to_string(expected_history_path(home.path(), "preview-1"))?;
    assert_eq!(history, format!("{payload}\n"));
    Ok(())
}

#[test]
fn echo_jsonl_without_init_skips_history() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let payload = r#"{"type":"assistant","session_id":"preview-no-init","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]}}"#;
    let prompt = format!("@ECHO@\n{payload}\n");

    let output = mock_claude()
        .env("HOME", home.path())
        .args(["--output-format", "stream-json", "--", &prompt])
        .output()?;

    assert!(
        output.status.success(),
        "expected success, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        format!("{payload}\n")
    );
    assert!(output.stderr.is_empty());
    assert!(!home.path().join(".claude").exists());
    Ok(())
}

#[test]
fn stream_json_shell_writes_matching_session_history() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;

    let output = mock_claude()
        .env("HOME", home.path())
        .args(["--output-format", "stream-json", "--", "printf hello"])
        .output()?;

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
fn stream_json_shell_failure_writes_error_history() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;

    let output = mock_claude()
        .env("HOME", home.path())
        .args([
            "--output-format",
            "stream-json",
            "--",
            "printf out; printf err >&2; exit 7",
        ])
        .output()?;

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
fn exit_after_result_writes_init_and_result_history() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;

    let output = mock_claude()
        .env("HOME", home.path())
        .args(["--output-format", "stream-json", "--", "@exit-after-result"])
        .output()?;

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

#[test]
fn echo_jsonl_rejects_path_like_session_id_without_writing_history() -> std::io::Result<()> {
    let home = tempfile::tempdir()?;
    let payload = r#"{"type":"system","subtype":"init","cwd":"/home/user/workspace","session_id":"../escape","tools":["Bash"],"model":"mock-claude"}"#;
    let prompt = format!("@ECHO@\n{payload}\n");

    let output = mock_claude()
        .env("HOME", home.path())
        .args(["--output-format", "stream-json", "--", &prompt])
        .output()?;

    assert!(!output.status.success());
    assert!(
        output.stdout.is_empty(),
        "expected empty stdout, got: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("invalid @ECHO@ session_id"));
    assert!(stderr.contains("../escape"));
    assert!(!expected_history_path(home.path(), "../escape").exists());
    assert!(
        !home
            .path()
            .join(".claude")
            .join("projects")
            .join("escape.jsonl")
            .exists()
    );
    Ok(())
}

#[test]
fn echo_jsonl_rejects_invalid_json_line() -> Result<(), Box<dyn std::error::Error>> {
    let output = mock_claude()
        .args(["--output-format", "stream-json", "--", "@ECHO@\n{\"type\""])
        .output()?;

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("invalid @ECHO@ JSONL line 2"));
    Ok(())
}

#[test]
fn echo_jsonl_rejects_empty_payload() -> Result<(), Box<dyn std::error::Error>> {
    let output = mock_claude()
        .args(["--output-format", "stream-json", "--", "@ECHO@\n\n"])
        .output()?;

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("@ECHO@ payload must contain at least one JSONL event")
    );
    Ok(())
}
