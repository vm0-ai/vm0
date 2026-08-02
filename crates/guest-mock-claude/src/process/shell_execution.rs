use crate::transcript::{
    JsonlTranscript, assistant_text_event, create_session_history, generate_session_id, init_event,
    result_event, tool_result_event, tool_use_event,
};
use guest_mock_claude::process_group_child::ProcessGroupChild;
use serde_json::json;
use std::io::{ErrorKind, Read};
#[cfg(unix)]
use std::os::fd::AsRawFd;
use std::process::{Command, ExitCode, Stdio};
#[cfg(unix)]
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::thread;

const STREAM_JSON_SHELL_OUTPUT_LIMIT_BYTES: usize = 1024 * 1024;
const STREAM_JSON_SHELL_READ_BUFFER_BYTES: usize = 8 * 1024;
#[cfg(unix)]
const STREAM_JSON_SHELL_CANCEL_POLL_TIMEOUT_MS: libc::c_int = 100;

pub(super) fn run(prompt: &str, output_format: &str) -> ExitCode {
    let session_id = generate_session_id();

    if output_format == "stream-json" {
        run_stream_json_mode(prompt, &session_id)
    } else {
        run_text_mode(prompt)
    }
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
        if cancelled && stream.truncated {
            break;
        }
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

fn spawn_captured_shell(prompt: &str) -> std::io::Result<ProcessGroupChild> {
    let mut command = Command::new("bash");
    command
        .args(["-c", prompt])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    ProcessGroupChild::spawn(&mut command)
}

fn capture_shell_output(prompt: &str) -> CapturedShellOutput {
    let mut child = match spawn_captured_shell(prompt) {
        Ok(child) => child,
        Err(_) => return CapturedShellOutput::failed(),
    };

    let Some(stdout) = child.take_stdout() else {
        child.terminate();
        return CapturedShellOutput::failed();
    };
    let Some(stderr) = child.take_stderr() else {
        child.terminate();
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

    let exit_code = child
        .wait_with_group_cleanup()
        .map_or(1, |status| status.code().unwrap_or(1));
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
