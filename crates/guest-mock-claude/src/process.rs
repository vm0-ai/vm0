use crate::args::ParsedArgs;
use crate::scenario::{MockScenario, echo_session_id, parse_echo_jsonl};
use crate::transcript::{
    JsonlTranscript, assistant_text_event, create_session_history, generate_session_id, init_event,
    is_valid_session_history_id, replayed_user_event, result_event, tool_result_event,
    tool_use_event,
};
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::path::Path;
use std::process::{Command, ExitCode, Stdio};
use std::thread;
use std::time::Duration;

const REAPABLE_HANG_DURATION: Duration = Duration::from_secs(3600);
const ACTIVE_INPUT_READY_RESULT: &str = "READY_FOR_ACTIVE_INPUT";
const STREAM_JSON_SHELL_OUTPUT_LIMIT_BYTES: usize = 1024 * 1024;
const STREAM_JSON_SHELL_READ_BUFFER_BYTES: usize = 8 * 1024;

pub(crate) fn run(parsed: ParsedArgs) -> ExitCode {
    if parsed.input_format == "stream-json" {
        return run_stream_json_input(parsed);
    }

    run_prompt_scenario(&parsed.prompt, &parsed.output_format)
}

#[derive(Debug)]
struct StreamJsonUserFrame {
    content: String,
    uuid: Option<String>,
}

fn run_stream_json_input(parsed: ParsedArgs) -> ExitCode {
    let stdin = std::io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let first_frame =
        match read_next_stream_json_user_frame(&mut reader, StreamJsonFrameKind::First) {
            Ok(Some(frame)) => frame,
            Ok(None) => {
                eprintln!("stream-json stdin did not contain a user message");
                return ExitCode::from(1);
            }
            Err(message) => {
                eprintln!("{message}");
                return ExitCode::from(1);
            }
        };

    match MockScenario::from_prompt(&first_frame.content) {
        MockScenario::ActiveInputSmoke {
            expected_follow_ups,
        } => run_active_input_smoke_scenario(
            &parsed.output_format,
            parsed.replay_user_messages,
            first_frame,
            &mut reader,
            expected_follow_ups,
        ),
        MockScenario::InvalidActiveInputSmokeCount(count) => {
            eprintln!("{}", invalid_active_input_count_message(count));
            ExitCode::from(1)
        }
        scenario => run_scenario(scenario, &first_frame.content, &parsed.output_format),
    }
}

fn run_prompt_scenario(prompt: &str, output_format: &str) -> ExitCode {
    run_scenario(MockScenario::from_prompt(prompt), prompt, output_format)
}

fn invalid_active_input_count_message(count: &str) -> String {
    format!(
        "invalid @active-input-smoke follow-up count ({} bytes)",
        count.len()
    )
}

fn run_scenario(scenario: MockScenario<'_>, prompt: &str, output_format: &str) -> ExitCode {
    match scenario {
        MockScenario::ActiveInputSmoke { .. } => {
            eprintln!("@active-input-smoke requires --input-format stream-json");
            ExitCode::from(1)
        }
        MockScenario::InvalidActiveInputSmokeCount(count) => {
            eprintln!("{}", invalid_active_input_count_message(count));
            ExitCode::from(1)
        }
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
            run_stuck_tool_scenario(output_format, deaf, close_stdout)
        }
        MockScenario::OrphanPipe => {
            if output_format == "stream-json" {
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
            run_hang_after_result_scenario(output_format, deaf)
        }
        MockScenario::ExitAfterResult => {
            if output_format == "stream-json" {
                emit_post_result_pair();
                // Exit immediately. Exercises the happy path: guest-agent
                // either arms post-result reap and observes `child.wait()`
                // before the deadline, or observes `child.wait()` first and
                // never arms reap. No signal should be sent.
            }
            ExitCode::SUCCESS
        }
        MockScenario::WriteEnvJson(path) => run_write_env_json_scenario(output_format, path),
        MockScenario::Shell => {
            let session_id = generate_session_id();

            if output_format == "stream-json" {
                run_stream_json_mode(prompt, &session_id)
            } else {
                run_text_mode(prompt)
            }
        }
    }
}

#[derive(Clone, Copy)]
enum StreamJsonFrameKind {
    First,
    FollowUp { index: usize },
}

fn read_next_stream_json_user_frame(
    reader: &mut impl BufRead,
    kind: StreamJsonFrameKind,
) -> Result<Option<StreamJsonUserFrame>, String> {
    let mut line = String::new();
    loop {
        line.clear();
        let bytes = reader
            .read_line(&mut line)
            .map_err(|e| format!("read stream-json stdin: {e}"))?;
        if bytes == 0 {
            return Ok(None);
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        return parse_stream_json_user_frame(trimmed, kind).map(Some);
    }
}

fn parse_stream_json_user_frame(
    line: &str,
    kind: StreamJsonFrameKind,
) -> Result<StreamJsonUserFrame, String> {
    let event: Value = serde_json::from_str(line).map_err(|e| match kind {
        StreamJsonFrameKind::First => format!("parse stream-json stdin: {e}"),
        StreamJsonFrameKind::FollowUp { index } => {
            format!("parse stream-json stdin follow-up message {index}: {e}")
        }
    })?;

    let description = match kind {
        StreamJsonFrameKind::First => "first message".to_string(),
        StreamJsonFrameKind::FollowUp { index } => format!("follow-up message {index}"),
    };

    if event.get("type").and_then(Value::as_str) != Some("user") {
        return Err(format!(
            "stream-json stdin {description} must have type \"user\""
        ));
    }
    if let Some(role) = event.pointer("/message/role").and_then(Value::as_str)
        && role != "user"
    {
        return Err(format!(
            "stream-json stdin {description} role must be \"user\""
        ));
    }

    let content = event
        .pointer("/message/content")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            format!("stream-json stdin {description} must contain string message.content")
        })?;
    let uuid = event
        .get("uuid")
        .and_then(Value::as_str)
        .map(str::to_string);

    Ok(StreamJsonUserFrame { content, uuid })
}

fn run_active_input_smoke_scenario(
    output_format: &str,
    replay_user_messages: bool,
    initial_frame: StreamJsonUserFrame,
    stdin: &mut impl BufRead,
    expected_follow_ups: usize,
) -> ExitCode {
    if output_format != "stream-json" {
        eprintln!("@active-input-smoke requires --output-format stream-json");
        return ExitCode::from(1);
    }

    let session_id = generate_session_id();
    let mut transcript = JsonlTranscript::default();

    transcript.emit_value(init_event(&session_id, &["Bash"]));
    if replay_user_messages {
        transcript.emit_value(replayed_user_event(
            &session_id,
            initial_frame.uuid.as_deref(),
            &initial_frame.content,
        ));
    }
    transcript.emit_value(result_event(&session_id, false, ACTIVE_INPUT_READY_RESULT));
    let _ = std::io::stdout().flush();

    let mut follow_up_contents = Vec::new();
    for index in 1..=expected_follow_ups {
        let frame = match read_next_stream_json_user_frame(
            stdin,
            StreamJsonFrameKind::FollowUp { index },
        ) {
            Ok(Some(frame)) => frame,
            Ok(None) => {
                eprintln!(
                    "active-input stdin closed after {} of {expected_follow_ups} follow-up user messages",
                    follow_up_contents.len()
                );
                return ExitCode::from(1);
            }
            Err(message) => {
                eprintln!("{message}");
                return ExitCode::from(1);
            }
        };

        if replay_user_messages {
            transcript.emit_value(replayed_user_event(
                &session_id,
                frame.uuid.as_deref(),
                &frame.content,
            ));
            let _ = std::io::stdout().flush();
        }
        follow_up_contents.push(frame.content);
    }

    transcript.emit_value(result_event(
        &session_id,
        false,
        &format!("RESULT={}", follow_up_contents.join("+")),
    ));
    transcript.write_session_history(&session_id);
    let _ = std::io::stdout().flush();
    ExitCode::SUCCESS
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

#[derive(Default)]
struct CapturedShellStream {
    bytes: Vec<u8>,
    truncated: bool,
}

struct CapturedShellOutput {
    stdout: CapturedShellStream,
    stderr: CapturedShellStream,
    exit_code: i32,
}

impl CapturedShellOutput {
    fn failed() -> Self {
        Self {
            stdout: CapturedShellStream::default(),
            stderr: CapturedShellStream::default(),
            exit_code: 1,
        }
    }
}

fn capture_shell_stream(mut reader: impl Read) -> std::io::Result<CapturedShellStream> {
    let mut stream = CapturedShellStream {
        bytes: Vec::with_capacity(STREAM_JSON_SHELL_READ_BUFFER_BYTES),
        truncated: false,
    };
    let mut buffer = [0_u8; STREAM_JSON_SHELL_READ_BUFFER_BYTES];

    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };

        let remaining = STREAM_JSON_SHELL_OUTPUT_LIMIT_BYTES.saturating_sub(stream.bytes.len());
        if remaining == 0 {
            stream.truncated = true;
            continue;
        }

        let retained = remaining.min(read);
        stream.bytes.extend(buffer.iter().take(retained).copied());
        if retained < read {
            stream.truncated = true;
        }
    }

    Ok(stream)
}

fn join_captured_shell_stream(
    handle: thread::JoinHandle<std::io::Result<CapturedShellStream>>,
) -> std::io::Result<CapturedShellStream> {
    match handle.join() {
        Ok(result) => result,
        Err(payload) => std::panic::resume_unwind(payload),
    }
}

fn capture_shell_output(prompt: &str) -> CapturedShellOutput {
    let mut child = match Command::new("bash")
        .args(["-c", prompt])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return CapturedShellOutput::failed(),
    };

    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return CapturedShellOutput::failed();
    };
    let Some(stderr) = child.stderr.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return CapturedShellOutput::failed();
    };
    let stdout_thread = thread::spawn(move || capture_shell_stream(stdout));
    let stderr_thread = thread::spawn(move || capture_shell_stream(stderr));

    let exit_code = child.wait().map_or(1, |status| status.code().unwrap_or(1));
    let stdout = join_captured_shell_stream(stdout_thread);
    let stderr = join_captured_shell_stream(stderr_thread);
    let (Ok(stdout), Ok(stderr)) = (stdout, stderr) else {
        return CapturedShellOutput::failed();
    };

    CapturedShellOutput {
        stdout,
        stderr,
        exit_code,
    }
}

fn append_truncation_marker(output: &mut String, stream_name: &str) {
    output.push_str("\n[");
    output.push_str(stream_name);
    output.push_str(" truncated after ");
    output.push_str(&STREAM_JSON_SHELL_OUTPUT_LIMIT_BYTES.to_string());
    output.push_str(" bytes]\n");
}

fn format_captured_shell_output(captured: &CapturedShellOutput) -> String {
    let mut output = String::from_utf8_lossy(&captured.stdout.bytes).into_owned();
    if captured.stdout.truncated {
        append_truncation_marker(&mut output, "stdout");
    }

    if captured.exit_code != 0 {
        output.push_str(&String::from_utf8_lossy(&captured.stderr.bytes));
        if captured.stderr.truncated {
            append_truncation_marker(&mut output, "stderr");
        }
    }

    output
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

    // 4. Execute bash and capture bounded output
    let captured = capture_shell_output(prompt);
    let output = format_captured_shell_output(&captured);
    let exit_code = captured.exit_code;

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
