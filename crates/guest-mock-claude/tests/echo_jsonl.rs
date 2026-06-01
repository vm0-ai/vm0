use std::fs;
use std::process::Command;

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
