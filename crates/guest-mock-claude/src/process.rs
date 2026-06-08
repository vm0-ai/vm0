use crate::args::ParsedArgs;
use crate::scenario::{MockScenario, echo_session_id, parse_echo_jsonl};
use crate::transcript::{
    JsonlTranscript, assistant_text_event, create_session_history, generate_session_id, init_event,
    is_valid_session_history_id, result_event, tool_result_event, tool_use_event,
};
use serde_json::json;
use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;
use std::process::{Command, ExitCode, Stdio};
use std::time::Duration;

const REAPABLE_HANG_DURATION: Duration = Duration::from_secs(3600);

pub(crate) fn run(parsed: ParsedArgs) -> ExitCode {
    match MockScenario::from_prompt(&parsed.prompt) {
        MockScenario::EchoJsonl(payload) => run_echo_jsonl_mode(payload),
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
        MockScenario::WriteEnvJson(path) => {
            run_write_env_json_scenario(&parsed.output_format, path)
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

fn run_echo_jsonl_mode(payload: &str) -> ExitCode {
    let events = match parse_echo_jsonl(payload) {
        Ok(events) => events,
        Err(msg) => {
            eprintln!("{msg}");
            return ExitCode::from(1);
        }
    };

    let session_id = echo_session_id(&events).map(str::to_owned);
    if let Some(session_id) = session_id.as_deref()
        && !is_valid_session_history_id(session_id)
    {
        eprintln!("invalid @ECHO@ session_id: {session_id:?}");
        return ExitCode::from(1);
    }

    let mut transcript = JsonlTranscript::default();
    for (line, _) in events {
        transcript.emit_raw_line(line);
    }
    if let Some(session_id) = session_id.as_deref() {
        transcript.write_session_history(session_id);
    }
    let _ = std::io::stdout().flush();
    ExitCode::SUCCESS
}

/// Emit the init + result JSONL pair shared by post-result mock test
/// prefixes, flush stdout so guest-agent sees them, and write the
/// session history checkpoint file. Caller decides which post-result
/// behavior follows (hang / exit / ignore SIGTERM / orphan stdout).
fn emit_post_result_pair() {
    let session_id = generate_session_id();
    let mut transcript = JsonlTranscript::default();
    transcript.emit_value(init_event(&session_id, &["Bash"]));
    transcript.emit_value(result_event(&session_id, false, "Done."));
    transcript.write_session_history(&session_id);

    let _ = std::io::stdout().flush();
}

fn emit_stuck_tool_events() {
    let session_id = generate_session_id();
    let mut transcript = JsonlTranscript::default();

    transcript.emit_value(init_event(&session_id, &["WebFetch"]));
    transcript.emit_value(tool_use_event(
        &session_id,
        "toolu_stuck_001",
        "WebFetch",
        json!({"url": "https://example.com/hang"}),
    ));

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

        // Hang forever - simulates a stuck WebFetch
        hang_until_reaped();
    }
    ExitCode::from(1)
}

fn run_hang_after_result_scenario(output_format: &str, deaf: bool) -> ExitCode {
    if output_format == "stream-json" {
        emit_post_result_pair();
        if deaf {
            // Ignore SIGTERM so only SIGKILL can terminate this process.
            // Exercises the SigtermPending -> SigkillPending -> Done escalation
            // branch of the reap FSM.
            ignore_sigterm();
        }
        // Hang this process forever. guest-agent's post-result reap SIGTERMs
        // it within POST_RESULT_SIGTERM_GRACE_SECS unless SIGTERM is ignored.
        hang_until_reaped();
    }
    ExitCode::SUCCESS
}

fn run_write_env_json_scenario(output_format: &str, path: &str) -> ExitCode {
    if output_format != "stream-json" {
        return ExitCode::from(1);
    }

    let env: BTreeMap<String, String> = std::env::vars().collect();
    if let Some(parent) = Path::new(path).parent()
        && !parent.as_os_str().is_empty()
        && let Err(e) = std::fs::create_dir_all(parent)
    {
        eprintln!("create env json parent: {e}");
        return ExitCode::from(1);
    }
    let payload = match serde_json::to_vec(&env) {
        Ok(payload) => payload,
        Err(e) => {
            eprintln!("serialize env json: {e}");
            return ExitCode::from(1);
        }
    };
    if let Err(e) = std::fs::write(path, payload) {
        eprintln!("write env json: {e}");
        return ExitCode::from(1);
    }

    emit_post_result_pair();
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
    let session_history_file = create_session_history(session_id);
    let mut transcript = JsonlTranscript::default();

    // 1. System init event
    transcript.emit_value(init_event(session_id, &["Bash"]));

    // 2. Assistant text event
    transcript.emit_value(assistant_text_event(session_id, "Executing command..."));

    // 3. Assistant tool_use event
    transcript.emit_value(tool_use_event(
        session_id,
        "toolu_mock_001",
        "Bash",
        json!({"command": prompt}),
    ));

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
    transcript.emit_value(tool_result_event(
        session_id,
        "toolu_mock_001",
        &output,
        is_error,
    ));

    // 6. Result event
    transcript.emit_value(result_event(session_id, is_error, &output));

    // Write session history
    if let Some(path) = session_history_file {
        transcript.write_session_history_file(&path);
    }

    ExitCode::from(exit_code as u8)
}
