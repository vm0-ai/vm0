//! Mock Claude CLI for testing.
//!
//! Executes the prompt as a bash command and outputs Claude-compatible JSONL.
//! This is the Rust equivalent of `mock-claude.ts` for Firecracker VMs.
//!
//! Usage: mock-claude [options] <prompt>
//!
//! Special test prefixes:
//!   @fail:<message> - Output message to stderr and exit with code 1

use serde_json::{Value, json};
use std::io::Write;
use std::process::{Command, ExitCode, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

/// Parsed command-line arguments.
struct ParsedArgs {
    output_format: String,
    prompt: String,
}

/// Parse command-line arguments (matching the real Claude CLI interface).
fn parse_args(args: &[String]) -> ParsedArgs {
    let mut output_format = "text".to_string();
    let mut remaining: Vec<String> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        let arg = args.get(i).map(String::as_str).unwrap_or_default();

        match arg {
            "--output-format" => {
                if let Some(val) = args.get(i + 1) {
                    output_format = val.clone();
                    i += 2;
                } else {
                    i += 1;
                }
            }
            "--resume" => {
                // Parsed for CLI compat but not used by mock-claude
                if args.get(i + 1).is_some() {
                    i += 2;
                } else {
                    i += 1;
                }
            }
            "--print" | "--verbose" | "--dangerously-skip-permissions" => {
                i += 1;
            }
            _ => {
                if !arg.is_empty() {
                    remaining.push(arg.to_string());
                }
                i += 1;
            }
        }
    }

    let prompt = remaining.into_iter().next().unwrap_or_default();

    ParsedArgs {
        output_format,
        prompt,
    }
}

/// Generate a mock session ID: `mock-{timestamp_micros}`.
fn generate_session_id() -> String {
    let micros = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros();
    format!("mock-{micros}")
}

/// Build the session history file path and create the directory.
///
/// Claude Code stores session history at: `{home}/.claude/projects/-{path}/{session_id}.jsonl`
fn build_session_history_path(session_id: &str, cwd: &str, home: &str) -> Option<String> {
    let project_name = cwd.trim_start_matches('/').replace('/', "-");
    let session_dir = format!("{home}/.claude/projects/-{project_name}");

    if std::fs::create_dir_all(&session_dir).is_err() {
        return None;
    }

    Some(format!("{session_dir}/{session_id}.jsonl"))
}

/// Create session history using `$HOME` from the environment.
fn create_session_history(session_id: &str, cwd: &str) -> Option<String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/home/user".to_string());
    build_session_history_path(session_id, cwd, &home)
}

/// Execute prompt in text mode: inherited stdio, propagate exit code.
fn run_text_mode(prompt: &str) -> ExitCode {
    match Command::new("bash")
        .args(["-c", prompt])
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
    {
        Ok(status) => ExitCode::from(status.code().unwrap_or(1) as u8),
        Err(_) => ExitCode::from(1),
    }
}

/// Execute prompt in stream-json mode: output JSONL events, capture output.
fn run_stream_json_mode(prompt: &str, session_id: &str) -> ExitCode {
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/".to_string());

    let session_history_file = create_session_history(session_id, &cwd);
    let mut events: Vec<Value> = Vec::with_capacity(5);

    // 1. System init event
    let init_event = json!({
        "type": "system",
        "subtype": "init",
        "cwd": cwd,
        "session_id": session_id,
        "tools": ["Bash"],
        "model": "mock-claude"
    });
    println!("{}", init_event);
    events.push(init_event);

    // 2. Assistant text event
    let text_event = json!({
        "type": "assistant",
        "session_id": session_id,
        "message": {
            "role": "assistant",
            "content": [{"type": "text", "text": "Executing command..."}]
        }
    });
    println!("{}", text_event);
    events.push(text_event);

    // 3. Assistant tool_use event
    let tool_use_event = json!({
        "type": "assistant",
        "session_id": session_id,
        "message": {
            "role": "assistant",
            "content": [{
                "type": "tool_use",
                "id": "toolu_mock_001",
                "name": "Bash",
                "input": {"command": prompt}
            }]
        }
    });
    println!("{}", tool_use_event);
    events.push(tool_use_event);

    // 4. Execute bash and capture output
    let (output, exit_code) = match Command::new("bash")
        .args(["-c", prompt])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
    {
        Ok(result) => {
            let mut combined = String::from_utf8_lossy(&result.stdout).into_owned();
            if !result.status.success() {
                combined.push_str(&String::from_utf8_lossy(&result.stderr));
            }
            let code = result.status.code().unwrap_or(1);
            (combined, code)
        }
        Err(_) => (String::new(), 1),
    };

    let is_error = exit_code != 0;

    // 5. User tool_result event
    let tool_result_event = json!({
        "type": "user",
        "session_id": session_id,
        "message": {
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": "toolu_mock_001",
                "content": output,
                "is_error": is_error
            }]
        }
    });
    println!("{}", tool_result_event);
    events.push(tool_result_event);

    // 6. Result event
    let result_event = json!({
        "type": "result",
        "subtype": if is_error { "error" } else { "success" },
        "session_id": session_id,
        "is_error": is_error,
        "duration_ms": 100,
        "num_turns": 1,
        "result": output,
        "total_cost_usd": 0,
        "usage": {"input_tokens": 0, "output_tokens": 0}
    });
    println!("{}", result_event);
    events.push(result_event);

    // Write session history
    if let Some(path) = session_history_file
        && let Ok(mut file) = std::fs::File::create(&path)
    {
        for event in &events {
            let _ = writeln!(file, "{event}");
        }
    }

    ExitCode::from(exit_code as u8)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let parsed = parse_args(&args);

    // Special test prefix: @fail:<message>
    if let Some(msg) = parsed.prompt.strip_prefix("@fail:") {
        eprintln!("{msg}");
        return ExitCode::from(1);
    }

    let session_id = generate_session_id();

    if parsed.output_format == "stream-json" {
        run_stream_json_mode(&parsed.prompt, &session_id)
    } else {
        run_text_mode(&parsed.prompt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_args_empty() {
        let args: Vec<String> = vec![];
        let result = parse_args(&args);
        assert_eq!(result.output_format, "text");
        assert!(result.prompt.is_empty());
    }

    #[test]
    fn parse_args_output_format() {
        let args: Vec<String> = vec!["--output-format", "stream-json"]
            .into_iter()
            .map(String::from)
            .collect();
        let result = parse_args(&args);
        assert_eq!(result.output_format, "stream-json");
    }

    #[test]
    fn parse_args_all_options() {
        let args: Vec<String> = vec![
            "--output-format",
            "stream-json",
            "--print",
            "--verbose",
            "--dangerously-skip-permissions",
            "--resume",
            "session-abc",
            "ls -la",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        let result = parse_args(&args);
        assert_eq!(result.output_format, "stream-json");
        assert_eq!(result.prompt, "ls -la");
    }

    #[test]
    fn parse_args_prompt_only() {
        let args: Vec<String> = vec!["echo hello".to_string()];
        let result = parse_args(&args);
        assert_eq!(result.prompt, "echo hello");
        assert_eq!(result.output_format, "text");
    }

    #[test]
    fn parse_args_options_any_order() {
        let args: Vec<String> = vec![
            "--print",
            "--output-format",
            "stream-json",
            "my prompt",
            "--verbose",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        let result = parse_args(&args);
        assert_eq!(result.output_format, "stream-json");
        assert_eq!(result.prompt, "my prompt");
    }

    #[test]
    fn parse_args_output_format_missing_value() {
        let args: Vec<String> = vec!["--output-format".to_string()];
        let result = parse_args(&args);
        assert_eq!(result.output_format, "text");
    }

    #[test]
    fn parse_args_resume_skipped() {
        let args: Vec<String> = vec!["--resume", "session-123", "echo hi"]
            .into_iter()
            .map(String::from)
            .collect();
        let result = parse_args(&args);
        // --resume and its value are consumed, not treated as prompt
        assert_eq!(result.prompt, "echo hi");
    }

    #[test]
    fn parse_args_first_remaining_is_prompt() {
        let args: Vec<String> = vec!["first", "second", "third"]
            .into_iter()
            .map(String::from)
            .collect();
        let result = parse_args(&args);
        assert_eq!(result.prompt, "first");
    }

    #[test]
    fn session_history_path_structure() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_str().unwrap();

        let result = build_session_history_path("test-session-123", "/workspaces/my-project", home);

        let expected =
            format!("{home}/.claude/projects/-workspaces-my-project/test-session-123.jsonl");
        assert_eq!(result, Some(expected));
    }

    #[test]
    fn session_history_creates_directory() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_str().unwrap();

        let _ = build_session_history_path("test-session", "/some/path", home);

        let expected_dir = dir.path().join(".claude/projects/-some-path");
        assert!(expected_dir.exists());
    }

    #[test]
    fn session_history_root_path() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_str().unwrap();

        let result = build_session_history_path("root-session", "/", home);

        let expected = format!("{home}/.claude/projects/-/root-session.jsonl");
        assert_eq!(result, Some(expected));
    }

    #[test]
    fn session_history_deep_path() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_str().unwrap();

        let result = build_session_history_path("deep-session", "/a/b/c/d/e/f", home);

        let expected = format!("{home}/.claude/projects/-a-b-c-d-e-f/deep-session.jsonl");
        assert_eq!(result, Some(expected));
    }

    #[test]
    fn session_id_has_mock_prefix() {
        let id = generate_session_id();
        assert!(id.starts_with("mock-"));
    }

    #[test]
    fn session_id_unique() {
        let id1 = generate_session_id();
        // Small sleep to ensure different timestamp
        std::thread::sleep(std::time::Duration::from_millis(1));
        let id2 = generate_session_id();
        assert_ne!(id1, id2);
    }
}
