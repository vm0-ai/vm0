use crate::scenario::{echo_session_id, parse_echo_jsonl};
use crate::transcript::{
    JsonlTranscript, assistant_text_event, generate_session_id, init_event,
    is_valid_session_history_id, result_event, tool_use_event,
};
use serde_json::json;
use std::collections::BTreeMap;
use std::io::Write;
use std::os::unix::net::UnixListener;
use std::path::Path;
use std::process::{Command, ExitCode};
use std::time::Duration;

const REAPABLE_HANG_DURATION: Duration = Duration::from_secs(3600);
const TERMINATION_READY_EVENT: &str = "vm0_mock_termination_ready";
const POST_RESULT_READY_EVENT: &str = "vm0_mock_post_result_ready";
const POST_RESULT_ACTIVITY_ONE_EVENT: &str = "vm0_mock_post_result_activity_1_ready";
const POST_RESULT_ACTIVITY_TWO_EVENT: &str = "vm0_mock_post_result_activity_2_ready";
const POST_RESULT_LIVENESS_EVENT: &str = "vm0_mock_post_result_stale_deadline_survived";
const POST_RESULT_RELEASE_ONE_SOCKET: &str = ".vm0-post-result-release-1.sock";
const POST_RESULT_RELEASE_TWO_SOCKET: &str = ".vm0-post-result-release-2.sock";
// Integration contract with guest-agent's ordinary stdout framing policy.
const ORDINARY_STDOUT_MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
const STDOUT_STREAM_CHUNK_BYTES: usize = 8 * 1024;

pub(super) fn run_fail_no_newline(msg: &str) -> ExitCode {
    eprint!("{msg}");
    let _ = std::io::stderr().flush();
    ExitCode::from(1)
}

pub(super) fn run_fail_invalid_utf8() -> ExitCode {
    let _ = std::io::stderr().write_all(b"invalid-\xff-stderr\n");
    let _ = std::io::stderr().flush();
    ExitCode::from(1)
}

pub(super) fn run_fail_invalid_utf8_long() -> ExitCode {
    let invalid = vec![0xff; 16 * 1024];
    let _ = std::io::stderr().write_all(&invalid);
    let _ = std::io::stderr().write_all(b"\n");
    let _ = std::io::stderr().flush();
    ExitCode::from(1)
}

pub(super) fn run_fail(msg: &str) -> ExitCode {
    eprintln!("{msg}");
    ExitCode::from(1)
}

pub(super) fn run_echo_jsonl_mode(payload: &str, hang_after_output: bool) -> ExitCode {
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
    if hang_after_output {
        hang_until_reaped();
    }
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

fn emit_termination_ready_fence() {
    if let Ok(home) = std::env::var("HOME") {
        let _ = std::fs::write(format!("{home}/.vm0-mock-sigterm-ignored"), b"");
    }
    emit_stream_event_fence(TERMINATION_READY_EVENT);
}

fn emit_stream_event_fence(event_type: &str) {
    println!(
        "{}",
        json!({"type": "stream_event", "event": {"type": event_type}})
    );
    let _ = std::io::stdout().flush();
}

fn emit_fence_and_wait_for_release(
    event_type: &str,
    release_socket_name: &str,
) -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|error| format!("read HOME: {error}"))?;
    let release_socket = Path::new(&home).join(release_socket_name);
    let listener = UnixListener::bind(&release_socket)
        .map_err(|error| format!("bind {}: {error}", release_socket.display()))?;
    emit_stream_event_fence(event_type);
    listener
        .accept()
        .map_err(|error| format!("accept {}: {error}", release_socket.display()))?;
    Ok(())
}

fn hang_until_reaped() {
    std::thread::sleep(REAPABLE_HANG_DURATION);
}

fn write_stdout_limit(stdout: &mut impl Write, byte: u8) -> std::io::Result<()> {
    let chunk = [byte; STDOUT_STREAM_CHUNK_BYTES];
    for _ in 0..ORDINARY_STDOUT_MAX_LINE_BYTES / STDOUT_STREAM_CHUNK_BYTES {
        stdout.write_all(&chunk)?;
    }
    Ok(())
}

pub(super) fn run_stdout_over_limit_scenario(output_format: &str, newline: bool) -> ExitCode {
    if output_format != "stream-json" {
        return ExitCode::from(1);
    }

    let stdout = std::io::stdout();
    let mut stdout = stdout.lock();
    let _ = write_stdout_limit(&mut stdout, b'x');
    let suffix: &[u8] = if newline { b"x\n" } else { b"x" };
    let _ = stdout.write_all(suffix);
    let _ = stdout.flush();
    drop(stdout);
    hang_until_reaped();
    ExitCode::from(1)
}

pub(super) fn run_stdout_invalid_utf8_scenario(output_format: &str) -> ExitCode {
    if output_format != "stream-json" {
        return ExitCode::from(1);
    }

    let stdout = std::io::stdout();
    let mut stdout = stdout.lock();
    let _ = stdout.write_all(b"do-not-log-invalid-stdout-\xff\n");
    let _ = stdout.flush();
    drop(stdout);
    hang_until_reaped();
    ExitCode::from(1)
}

pub(super) fn run_stdout_record_boundaries_scenario(output_format: &str) -> ExitCode {
    if output_format != "stream-json" {
        return ExitCode::from(1);
    }

    let stdout = std::io::stdout();
    let mut stdout = stdout.lock();
    let result = stdout
        .write_all(b"crlf-record\r\n")
        .and_then(|()| write_stdout_limit(&mut stdout, b'x'))
        .and_then(|()| stdout.write_all(b"\neof-record"))
        .and_then(|()| stdout.flush());
    if let Err(error) = result {
        eprintln!("write stdout record-boundary fixture: {error}");
        return ExitCode::from(1);
    }
    ExitCode::SUCCESS
}

pub(super) fn run_stuck_tool_scenario(
    output_format: &str,
    deaf: bool,
    close_stdout: bool,
) -> ExitCode {
    if output_format == "stream-json" {
        if deaf {
            ignore_sigterm();
        }
        emit_stuck_tool_events();

        if deaf {
            emit_termination_ready_fence();
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

pub(super) fn run_orphan_pipe_scenario(output_format: &str) -> ExitCode {
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

pub(super) fn run_hang_after_result_scenario(output_format: &str, deaf: bool) -> ExitCode {
    if output_format == "stream-json" {
        if deaf {
            // Ignore SIGTERM so only SIGKILL can terminate this process.
            // Exercises the SigtermPending -> SigkillPending -> Done escalation
            // branch of the reap FSM.
            ignore_sigterm();
        }
        emit_post_result_pair();
        if deaf {
            emit_termination_ready_fence();
        }
        // Hang this process forever. guest-agent's post-result reap SIGTERMs
        // it within POST_RESULT_SIGTERM_GRACE_SECS unless SIGTERM is ignored.
        hang_until_reaped();
    }
    ExitCode::SUCCESS
}

pub(super) fn run_hang_after_result_then_event_scenario(output_format: &str) -> ExitCode {
    if output_format == "stream-json" {
        let session_id = emit_result_pair(false, "Done.");
        if let Err(error) =
            emit_fence_and_wait_for_release(POST_RESULT_READY_EVENT, POST_RESULT_RELEASE_ONE_SOCKET)
        {
            eprintln!("{error}");
            return ExitCode::from(1);
        }
        let mut transcript = JsonlTranscript::default();
        transcript.emit_value(assistant_text_event(&session_id, "post-result event"));
        if let Err(error) = emit_fence_and_wait_for_release(
            POST_RESULT_ACTIVITY_ONE_EVENT,
            POST_RESULT_RELEASE_TWO_SOCKET,
        ) {
            eprintln!("{error}");
            return ExitCode::from(1);
        }
        emit_stream_event_fence(POST_RESULT_LIVENESS_EVENT);
        hang_until_reaped();
    }
    ExitCode::SUCCESS
}

pub(super) fn run_hang_after_result_periodic_events_scenario(output_format: &str) -> ExitCode {
    if output_format == "stream-json" {
        let session_id = emit_result_pair(false, "Done.");
        if let Err(error) =
            emit_fence_and_wait_for_release(POST_RESULT_READY_EVENT, POST_RESULT_RELEASE_ONE_SOCKET)
        {
            eprintln!("{error}");
            return ExitCode::from(1);
        }
        let mut transcript = JsonlTranscript::default();
        transcript.emit_value(assistant_text_event(
            &session_id,
            "post-result periodic event 0",
        ));
        if let Err(error) = emit_fence_and_wait_for_release(
            POST_RESULT_ACTIVITY_ONE_EVENT,
            POST_RESULT_RELEASE_TWO_SOCKET,
        ) {
            eprintln!("{error}");
            return ExitCode::from(1);
        }
        transcript.emit_value(assistant_text_event(
            &session_id,
            "post-result periodic event 1",
        ));
        emit_stream_event_fence(POST_RESULT_ACTIVITY_TWO_EVENT);
        hang_until_reaped();
    }
    ExitCode::SUCCESS
}

pub(super) fn run_hang_after_error_result_scenario(output_format: &str) -> ExitCode {
    if output_format == "stream-json" {
        let _ = emit_result_pair(true, "Mock Claude error.");
        hang_until_reaped();
    }
    ExitCode::SUCCESS
}

pub(super) fn run_exit_after_result_scenario(output_format: &str) -> ExitCode {
    if output_format == "stream-json" {
        emit_post_result_pair();
        // Exit immediately. Exercises the happy path: guest-agent
        // either arms post-result reap and observes `child.wait()`
        // before the deadline, or observes `child.wait()` first and
        // never arms reap. No signal should be sent.
    }
    ExitCode::SUCCESS
}

pub(super) fn run_write_env_json_scenario(output_format: &str, path: &str) -> ExitCode {
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
