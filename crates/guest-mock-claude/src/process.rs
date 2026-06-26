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
#[cfg(unix)]
use std::os::fd::AsRawFd;
use std::path::Path;
use std::process::{Child, Command, ExitCode, ExitStatus, Stdio};
#[cfg(unix)]
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::thread;
use std::time::Duration;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

const REAPABLE_HANG_DURATION: Duration = Duration::from_secs(3600);
const ACTIVE_INPUT_READY_RESULT: &str = "READY_FOR_ACTIVE_INPUT";
const STREAM_JSON_SHELL_OUTPUT_LIMIT_BYTES: usize = 1024 * 1024;
const STREAM_JSON_SHELL_READ_BUFFER_BYTES: usize = 8 * 1024;
#[cfg(unix)]
const STREAM_JSON_SHELL_CANCEL_POLL_TIMEOUT_MS: libc::c_int = 100;

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
        MockScenario::HangAfterResultThenEvent => {
            run_hang_after_result_then_event_scenario(output_format)
        }
        MockScenario::HangAfterResultPeriodicEvents => {
            run_hang_after_result_periodic_events_scenario(output_format)
        }
        MockScenario::HangAfterErrorResult => run_hang_after_error_result_scenario(output_format),
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
    let _ = emit_result_pair(false, "Done.");
}

fn emit_result_pair(is_error: bool, result: &str) -> String {
    let session_id = generate_session_id();
    let mut transcript = JsonlTranscript::default();
    transcript.emit_value(init_event(&session_id, &["Bash"]));
    transcript.emit_value(result_event(&session_id, is_error, result));
    transcript.write_session_history(&session_id);

    let _ = std::io::stdout().flush();
    session_id
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

fn run_hang_after_result_then_event_scenario(output_format: &str) -> ExitCode {
    if output_format == "stream-json" {
        let session_id = emit_result_pair(false, "Done.");
        thread::sleep(Duration::from_millis(1_000));
        let mut transcript = JsonlTranscript::default();
        transcript.emit_value(assistant_text_event(&session_id, "post-result event"));
        let _ = std::io::stdout().flush();
        hang_until_reaped();
    }
    ExitCode::SUCCESS
}

fn run_hang_after_result_periodic_events_scenario(output_format: &str) -> ExitCode {
    if output_format == "stream-json" {
        let session_id = emit_result_pair(false, "Done.");
        let mut transcript = JsonlTranscript::default();
        for index in 0..20 {
            thread::sleep(Duration::from_millis(250));
            transcript.emit_value(assistant_text_event(
                &session_id,
                &format!("post-result periodic event {index}"),
            ));
            let _ = std::io::stdout().flush();
        }
        hang_until_reaped();
    }
    ExitCode::SUCCESS
}

fn run_hang_after_error_result_scenario(output_format: &str) -> ExitCode {
    if output_format == "stream-json" {
        let _ = emit_result_pair(true, "Mock Claude error.");
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

fn new_captured_shell_stream() -> CapturedShellStream {
    CapturedShellStream {
        bytes: Vec::with_capacity(STREAM_JSON_SHELL_READ_BUFFER_BYTES),
        truncated: false,
    }
}

fn retain_captured_shell_bytes(stream: &mut CapturedShellStream, bytes: &[u8]) {
    let remaining = STREAM_JSON_SHELL_OUTPUT_LIMIT_BYTES.saturating_sub(stream.bytes.len());
    if remaining == 0 {
        stream.truncated = true;
        return;
    }

    let retained = remaining.min(bytes.len());
    stream.bytes.extend(bytes.iter().take(retained).copied());
    if retained < bytes.len() {
        stream.truncated = true;
    }
}

#[cfg(not(unix))]
fn capture_shell_stream(mut reader: impl Read) -> std::io::Result<CapturedShellStream> {
    let mut stream = new_captured_shell_stream();
    let mut buffer = [0_u8; STREAM_JSON_SHELL_READ_BUFFER_BYTES];

    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };

        let Some(chunk) = buffer.get(..read) else {
            return Err(std::io::Error::other("shell stream read exceeded buffer"));
        };
        retain_captured_shell_bytes(&mut stream, chunk);
    }

    Ok(stream)
}

#[cfg(unix)]
fn capture_shell_stream_until_cancelled<R>(
    mut reader: R,
    cancel: Arc<AtomicBool>,
) -> std::io::Result<CapturedShellStream>
where
    R: Read + AsRawFd,
{
    let fd = reader.as_raw_fd();
    let mut stream = new_captured_shell_stream();
    let mut buffer = [0_u8; STREAM_JSON_SHELL_READ_BUFFER_BYTES];

    loop {
        // After bash exits, escaped descendants can keep the write end open.
        // Cancellation switches to a zero-timeout final drain instead of
        // waiting for EOF from those descendants.
        let cancelled = cancel.load(Ordering::Acquire);
        let timeout_ms = if cancelled {
            0
        } else {
            STREAM_JSON_SHELL_CANCEL_POLL_TIMEOUT_MS
        };
        let mut pollfd = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        let poll_result = unsafe { libc::poll(&mut pollfd, 1, timeout_ms) };
        if poll_result < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if poll_result == 0 {
            if cancelled {
                break;
            }
            continue;
        }
        if pollfd.revents & libc::POLLNVAL != 0 {
            break;
        }
        if pollfd.revents & (libc::POLLIN | libc::POLLHUP) == 0 {
            if pollfd.revents & libc::POLLERR != 0 || cancelled {
                break;
            }
            continue;
        }

        let read = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == ErrorKind::WouldBlock => continue,
            Err(error) => return Err(error),
        };
        let Some(chunk) = buffer.get(..read) else {
            return Err(std::io::Error::other("shell stream read exceeded buffer"));
        };
        retain_captured_shell_bytes(&mut stream, chunk);
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

fn spawn_captured_shell(prompt: &str) -> std::io::Result<Child> {
    let mut command = Command::new("bash");
    command
        .args(["-c", prompt])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    spawn_shell_process(&mut command)
}

#[cfg(unix)]
fn spawn_shell_process(command: &mut Command) -> std::io::Result<Child> {
    command.process_group(0).spawn()
}

#[cfg(not(unix))]
fn spawn_shell_process(command: &mut Command) -> std::io::Result<Child> {
    command.spawn()
}

fn terminate_shell_child(mut child: Child) {
    terminate_shell_process_group(child.id());
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(unix)]
fn wait_shell_child_and_cleanup_group(mut child: Child) -> std::io::Result<ExitStatus> {
    let pid = child.id();
    if let Err(error) = observe_shell_child_exit_without_reaping(pid) {
        terminate_shell_process_group(pid);
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }

    terminate_shell_process_group(pid);
    child.wait()
}

#[cfg(not(unix))]
fn wait_shell_child_and_cleanup_group(mut child: Child) -> std::io::Result<ExitStatus> {
    child.wait()
}

#[cfg(unix)]
fn observe_shell_child_exit_without_reaping(pid: u32) -> std::io::Result<()> {
    let pid = i32::try_from(pid).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "shell child PID does not fit in i32",
        )
    })?;

    loop {
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::uninit();
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOWAIT,
            )
        };
        if result == 0 {
            return Ok(());
        }

        let error = std::io::Error::last_os_error();
        if error.kind() != ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

#[cfg(unix)]
fn terminate_shell_process_group(child_pid: u32) {
    if let Some(pgid) = signalable_shell_process_group(child_pid) {
        unsafe {
            libc::kill(-pgid, libc::SIGKILL);
        }
    }
}

#[cfg(not(unix))]
fn terminate_shell_process_group(_child_pid: u32) {}

#[cfg(unix)]
fn signalable_shell_process_group(child_pid: u32) -> Option<libc::pid_t> {
    let pgid = i32::try_from(child_pid).ok()?;
    (pgid > 1 && pgid != current_process_group()).then_some(pgid as libc::pid_t)
}

#[cfg(unix)]
fn current_process_group() -> i32 {
    unsafe { libc::getpgrp() }
}

fn capture_shell_output(prompt: &str) -> CapturedShellOutput {
    let mut child = match spawn_captured_shell(prompt) {
        Ok(child) => child,
        Err(_) => return CapturedShellOutput::failed(),
    };

    let Some(stdout) = child.stdout.take() else {
        terminate_shell_child(child);
        return CapturedShellOutput::failed();
    };
    let Some(stderr) = child.stderr.take() else {
        terminate_shell_child(child);
        return CapturedShellOutput::failed();
    };
    #[cfg(unix)]
    let cancel_streams = Arc::new(AtomicBool::new(false));

    #[cfg(unix)]
    let stdout_thread = {
        let cancel = Arc::clone(&cancel_streams);
        thread::spawn(move || capture_shell_stream_until_cancelled(stdout, cancel))
    };
    #[cfg(unix)]
    let stderr_thread = {
        let cancel = Arc::clone(&cancel_streams);
        thread::spawn(move || capture_shell_stream_until_cancelled(stderr, cancel))
    };

    #[cfg(not(unix))]
    let stdout_thread = thread::spawn(move || capture_shell_stream(stdout));
    #[cfg(not(unix))]
    let stderr_thread = thread::spawn(move || capture_shell_stream(stderr));

    let exit_code =
        wait_shell_child_and_cleanup_group(child).map_or(1, |status| status.code().unwrap_or(1));
    #[cfg(unix)]
    cancel_streams.store(true, Ordering::Release);

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

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn signalable_shell_process_group_rejects_dangerous_values() {
        assert_eq!(signalable_shell_process_group(0), None);
        assert_eq!(signalable_shell_process_group(1), None);
        assert_eq!(signalable_shell_process_group((i32::MAX as u32) + 1), None);
        if let Ok(current_pgid) = u32::try_from(current_process_group()) {
            assert_eq!(signalable_shell_process_group(current_pgid), None);
        }
    }
}
