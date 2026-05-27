//! Mock Claude CLI for testing.
//!
//! Executes the prompt as a bash command and outputs Claude-compatible JSONL.
//! This is the Rust equivalent of `mock-claude.ts` for Firecracker VMs.
//!
//! Usage: mock-claude [options] <prompt>
//!
//! Special test prefixes:
//!   @fail:<message>           - Output message to stderr and exit with code 1
//!   @fail-no-newline:<message>
//!                             - Output message to stderr without a trailing
//!                               newline and exit with code 1
//!   @fail-invalid-utf8        - Output invalid UTF-8 bytes to stderr and exit
//!                               with code 1
//!   @fail-invalid-utf8-long   - Output many invalid UTF-8 bytes to stderr and exit
//!                               with code 1
//!   @stuck-tool               - Emit WebFetch tool_use then hang (test stuck-tool watchdog)
//!   @stuck-tool-deaf          - Same, but ignores SIGTERM so only SIGKILL
//!                               can terminate it
//!   @stuck-tool-closed-stdout-deaf
//!                             - Same, but closes stdout before hanging
//!   @orphan-pipe              - Emit events, spawn child holding stdout, then exit
//!   @hang-after-result        - Emit result event, then hang the process
//!                               (SIGTERM kills it → exits with 143; tests
//!                               the SigtermPending→Done reap path)
//!   @hang-after-result-deaf   - Same, but ignores SIGTERM so only SIGKILL
//!                               can terminate it; tests the
//!                               SigkillPending→Done escalation path
//!   @exit-after-result        - Emit result event, exit(0) immediately;
//!                               tests that reap stays no-op on the
//!                               happy path

use serde_json::{Value, json};
use std::io::Write;
use std::process::{Command, ExitCode, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const REAPABLE_HANG_DURATION: Duration = Duration::from_secs(3600);

/// Parsed command-line arguments.
struct ParsedArgs {
    output_format: String,
    prompt: String,
}

#[derive(Debug, Eq, PartialEq)]
enum MockScenario<'a> {
    FailNoNewline(&'a str),
    FailInvalidUtf8,
    FailInvalidUtf8Long,
    Fail(&'a str),
    StuckTool { deaf: bool, close_stdout: bool },
    OrphanPipe,
    HangAfterResult { deaf: bool },
    ExitAfterResult,
    Shell,
}

impl<'a> MockScenario<'a> {
    fn from_prompt(prompt: &'a str) -> Self {
        if let Some(msg) = prompt.strip_prefix("@fail-no-newline:") {
            return Self::FailNoNewline(msg);
        }
        if prompt == "@fail-invalid-utf8" {
            return Self::FailInvalidUtf8;
        }
        if prompt == "@fail-invalid-utf8-long" {
            return Self::FailInvalidUtf8Long;
        }
        if let Some(msg) = prompt.strip_prefix("@fail:") {
            return Self::Fail(msg);
        }
        if prompt.starts_with("@stuck-tool-closed-stdout-deaf") {
            return Self::StuckTool {
                deaf: true,
                close_stdout: true,
            };
        }
        if prompt.starts_with("@stuck-tool-deaf") {
            return Self::StuckTool {
                deaf: true,
                close_stdout: false,
            };
        }
        if prompt.starts_with("@stuck-tool") {
            return Self::StuckTool {
                deaf: false,
                close_stdout: false,
            };
        }
        if prompt.starts_with("@orphan-pipe") {
            return Self::OrphanPipe;
        }
        if prompt.starts_with("@hang-after-result-deaf") {
            return Self::HangAfterResult { deaf: true };
        }
        if prompt.starts_with("@exit-after-result") {
            return Self::ExitAfterResult;
        }
        if prompt.starts_with("@hang-after-result") {
            return Self::HangAfterResult { deaf: false };
        }
        Self::Shell
    }
}

fn skip_flag_value(args: &[String], i: &mut usize) {
    if args.get(*i + 1).is_some() {
        *i += 2;
    } else {
        *i += 1;
    }
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
            "--resume" | "--append-system-prompt" => {
                // Parsed for CLI compat but not used by mock-claude
                skip_flag_value(args, &mut i);
            }
            "--disallowed-tools" | "--tools" => {
                // Variadic: consume all following non-option args until "--"
                // or next "--flag". Matches Commander.js behavior where
                // <tools...> greedily consumes subsequent positional args.
                i += 1;
                while let Some(next) = args.get(i) {
                    if next == "--" || next.starts_with("--") {
                        break;
                    }
                    i += 1; // skip tool name
                }
            }
            "--settings" => {
                // Skip the flag and its single JSON value argument
                skip_flag_value(args, &mut i);
            }
            "--print" | "--verbose" | "--dangerously-skip-permissions" => {
                i += 1;
            }
            "--" => {
                // End of options — everything after is positional
                i += 1;
                for trailing in args.get(i..).unwrap_or_default() {
                    remaining.push(trailing.clone());
                }
                break;
            }
            _ => {
                if !arg.is_empty() {
                    remaining.push(arg.to_string());
                }
                i += 1;
            }
        }
    }

    let prompt = remaining.into_iter().last().unwrap_or_default();

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

/// Emit the init + result JSONL pair shared by post-result mock test
/// prefixes, flush stdout so guest-agent sees them, and write the
/// session history checkpoint file. Caller decides which post-result
/// behavior follows (hang / exit / ignore SIGTERM / orphan stdout).
fn emit_post_result_pair() {
    let session_id = generate_session_id();
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/".to_string());

    let init_event = json!({
        "type": "system",
        "subtype": "init",
        "cwd": cwd,
        "session_id": session_id,
        "tools": ["Bash"],
        "model": "mock-claude"
    });
    println!("{init_event}");

    let result_event = json!({
        "type": "result",
        "subtype": "success",
        "session_id": session_id,
        "is_error": false,
        "duration_ms": 100,
        "num_turns": 1,
        "result": "Done.",
        "total_cost_usd": 0,
        "usage": {"input_tokens": 0, "output_tokens": 0}
    });
    println!("{result_event}");

    if let Some(path) = create_session_history(&session_id, &cwd)
        && let Ok(mut file) = std::fs::File::create(&path)
    {
        let _ = writeln!(file, "{init_event}");
        let _ = writeln!(file, "{result_event}");
    }

    let _ = std::io::stdout().flush();
}

fn emit_stuck_tool_events() {
    let session_id = generate_session_id();
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/".to_string());

    // Init event
    println!(
        "{}",
        json!({
            "type": "system",
            "subtype": "init",
            "cwd": cwd,
            "session_id": session_id,
            "tools": ["WebFetch"],
            "model": "mock-claude"
        })
    );

    // Tool use event — WebFetch that never completes
    println!(
        "{}",
        json!({
            "type": "assistant",
            "session_id": session_id,
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": "toolu_stuck_001",
                    "name": "WebFetch",
                    "input": {"url": "https://example.com/hang"}
                }]
            }
        })
    );

    // Flush stdout so guest-agent receives the events before we hang.
    // When piped, stdout is fully buffered and println! may not flush.
    let _ = std::io::stdout().flush();
}

fn ignore_sigterm() {
    // SAFETY: signal(SIGTERM, SIG_IGN) is async-signal-safe and these mock
    // scenarios do not share signal handler state after installing it.
    unsafe {
        libc::signal(libc::SIGTERM, libc::SIG_IGN);
    }
}

fn hang_until_reaped() {
    std::thread::sleep(REAPABLE_HANG_DURATION);
}

fn run_stuck_tool_scenario(output_format: &str, deaf: bool, close_stdout: bool) -> ExitCode {
    if output_format == "stream-json" {
        emit_stuck_tool_events();

        if deaf {
            ignore_sigterm();
            if let Ok(home) = std::env::var("HOME") {
                let _ = std::fs::write(format!("{home}/.vm0-mock-sigterm-ignored"), b"");
            }
        }

        if close_stdout {
            // SAFETY: this mock process has finished writing all test events
            // and is about to park forever. Closing fd 1 simulates a CLI that
            // no longer has stdout open while the process is still alive.
            unsafe {
                libc::close(libc::STDOUT_FILENO);
            }
        }

        // Hang forever — simulates a stuck WebFetch
        hang_until_reaped();
    }
    ExitCode::from(1)
}

fn run_hang_after_result_scenario(output_format: &str, deaf: bool) -> ExitCode {
    if output_format == "stream-json" {
        emit_post_result_pair();
        if deaf {
            // Ignore SIGTERM so only SIGKILL can terminate this process.
            // Exercises the SigtermPending → SigkillPending → Done escalation
            // branch of the reap FSM.
            ignore_sigterm();
        }
        // Hang this process forever. guest-agent's post-result reap SIGTERMs
        // it within POST_RESULT_SIGTERM_GRACE_SECS unless SIGTERM is ignored.
        hang_until_reaped();
    }
    ExitCode::SUCCESS
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

    match MockScenario::from_prompt(&parsed.prompt) {
        MockScenario::FailNoNewline(msg) => {
            eprint!("{msg}");
            let _ = std::io::stderr().flush();
            ExitCode::from(1)
        }
        MockScenario::FailInvalidUtf8 => {
            let _ = std::io::stderr().write_all(b"invalid-\xff-stderr\n");
            let _ = std::io::stderr().flush();
            ExitCode::from(1)
        }
        MockScenario::FailInvalidUtf8Long => {
            let invalid = vec![0xff; 16 * 1024];
            let _ = std::io::stderr().write_all(&invalid);
            let _ = std::io::stderr().write_all(b"\n");
            let _ = std::io::stderr().flush();
            ExitCode::from(1)
        }
        MockScenario::Fail(msg) => {
            eprintln!("{msg}");
            ExitCode::from(1)
        }
        MockScenario::StuckTool { deaf, close_stdout } => {
            run_stuck_tool_scenario(&parsed.output_format, deaf, close_stdout)
        }
        MockScenario::OrphanPipe => {
            if parsed.output_format == "stream-json" {
                emit_post_result_pair();

                // Spawn a child after flushing the completed stream. It inherits
                // stdout and keeps the pipe open after this process exits.
                let _ = Command::new("sleep")
                    .arg(REAPABLE_HANG_DURATION.as_secs().to_string())
                    .spawn();
            }
            ExitCode::SUCCESS
        }
        MockScenario::HangAfterResult { deaf } => {
            run_hang_after_result_scenario(&parsed.output_format, deaf)
        }
        MockScenario::ExitAfterResult => {
            if parsed.output_format == "stream-json" {
                emit_post_result_pair();
                // Exit immediately. Exercises the happy path: guest-agent's
                // reap gets armed but `child.wait()` fires before any grace
                // window elapses, so no signal is ever sent.
            }
            ExitCode::SUCCESS
        }
        MockScenario::Shell => {
            let session_id = generate_session_id();

            if parsed.output_format == "stream-json" {
                run_stream_json_mode(&parsed.prompt, &session_id)
            } else {
                run_text_mode(&parsed.prompt)
            }
        }
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
            "--append-system-prompt",
            "Your name is Aria.",
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
    fn parse_args_append_system_prompt_skipped() {
        let args: Vec<String> = vec!["--append-system-prompt", "Your name is Aria.", "echo hi"]
            .into_iter()
            .map(String::from)
            .collect();
        let result = parse_args(&args);
        assert_eq!(result.prompt, "echo hi");
    }

    #[test]
    fn parse_args_settings_skipped() {
        let args: Vec<String> = vec!["--settings", r#"{"permissions":{}}"#, "echo hi"]
            .into_iter()
            .map(String::from)
            .collect();
        let result = parse_args(&args);
        assert_eq!(result.prompt, "echo hi");
    }

    #[test]
    fn parse_args_settings_missing_value() {
        let args: Vec<String> = vec!["--settings".to_string()];
        let result = parse_args(&args);
        assert!(result.prompt.is_empty());
    }

    #[test]
    fn parse_args_value_flag_consumes_flag_like_value() {
        let args: Vec<String> = vec!["--settings", "--print", "echo hi"]
            .into_iter()
            .map(String::from)
            .collect();
        let result = parse_args(&args);
        assert_eq!(result.prompt, "echo hi");
    }

    #[test]
    fn parse_args_last_remaining_is_prompt() {
        let args: Vec<String> = vec!["first", "second", "third"]
            .into_iter()
            .map(String::from)
            .collect();
        let result = parse_args(&args);
        assert_eq!(result.prompt, "third");
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

    #[test]
    fn parse_args_tools_with_separator() {
        let args: Vec<String> = vec!["--tools", "Bash", "Read", "--", "echo hello"]
            .into_iter()
            .map(String::from)
            .collect();
        let result = parse_args(&args);
        assert_eq!(result.prompt, "echo hello");
    }

    #[test]
    fn parse_args_disallowed_tools_with_separator() {
        let args: Vec<String> = vec![
            "--disallowed-tools",
            "CronCreate",
            "CronDelete",
            "--",
            "echo hello",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        let result = parse_args(&args);
        assert_eq!(result.prompt, "echo hello");
    }

    #[test]
    fn parse_args_variadic_without_separator_swallows_prompt() {
        // Without "--", variadic --disallowed-tools consumes the prompt
        // (matches Commander.js behavior that caused the production bug)
        let args: Vec<String> = vec![
            "--disallowed-tools",
            "CronCreate",
            "CronDelete",
            "echo hello",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        let result = parse_args(&args);
        assert!(
            result.prompt.is_empty(),
            "prompt should be empty without '--' separator, got: {:?}",
            result.prompt,
        );
    }

    #[test]
    fn parse_args_separator_after_option_flag() {
        // "--" after another --flag correctly separates prompt
        let args: Vec<String> = vec![
            "--disallowed-tools",
            "CronCreate",
            "--output-format",
            "stream-json",
            "--",
            "echo hello",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        let result = parse_args(&args);
        assert_eq!(result.output_format, "stream-json");
        assert_eq!(result.prompt, "echo hello");
    }

    #[test]
    fn classifies_hang_after_result_variants() {
        assert_eq!(
            MockScenario::from_prompt("@hang-after-result-deaf"),
            MockScenario::HangAfterResult { deaf: true }
        );
        assert_eq!(
            MockScenario::from_prompt("@hang-after-result"),
            MockScenario::HangAfterResult { deaf: false }
        );
    }

    #[test]
    fn classifies_stuck_tool_variants() {
        assert_eq!(
            MockScenario::from_prompt("@stuck-tool"),
            MockScenario::StuckTool {
                deaf: false,
                close_stdout: false
            }
        );
        assert_eq!(
            MockScenario::from_prompt("@stuck-tool-deaf"),
            MockScenario::StuckTool {
                deaf: true,
                close_stdout: false
            }
        );
        assert_eq!(
            MockScenario::from_prompt("@stuck-tool-closed-stdout-deaf"),
            MockScenario::StuckTool {
                deaf: true,
                close_stdout: true
            }
        );
    }

    #[test]
    fn classifies_ordinary_prompt_as_shell() {
        assert_eq!(MockScenario::from_prompt("echo hello"), MockScenario::Shell);
    }
}
