#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::io::Write;
use std::thread;
use std::time::Duration;

use vsock_guest::{handle_connection, run};
use vsock_proto::{
    self, CommandCapturedOutput, CommandOutputPolicy, CommandOutputStream, CommandTermination,
    MSG_COMMAND_CANCEL, MSG_COMMAND_OUTPUT, MSG_COMMAND_RESULT, MSG_COMMAND_START, MSG_ERROR,
    MSG_PROCESS_EXIT, MSG_SHUTDOWN, MSG_SHUTDOWN_ACK, MSG_SPAWN_WATCH, MSG_SPAWN_WATCH_RESULT,
    MSG_STDOUT_CHUNK,
};

const EXIT_CODE_TIMEOUT: i32 = 124;
const DRAIN_DEADLINE_SECS: u64 = 5;
const LARGE_ENV_COMMAND: &str =
    "printf '%s:%s:%s:%s:%s\\n' \"$SMALL\" \"${#BIG_A}\" \"${#BIG_B}\" \"${#BIG_C}\" \"${#BIG_D}\"";

struct TempPathGuard(String);

impl TempPathGuard {
    fn new(path: String) -> Self {
        let _ = std::fs::remove_file(&path);
        Self(path)
    }

    fn as_str(&self) -> &str {
        &self.0
    }
}

impl Drop for TempPathGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn unique_tmp_path(label: &str, suffix: &str) -> TempPathGuard {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    TempPathGuard::new(format!(
        "/tmp/vsock-test-{label}-{}-{nonce}{suffix}",
        std::process::id(),
    ))
}

fn unique_socket_path(label: &str) -> TempPathGuard {
    unique_tmp_path(label, ".sock")
}

fn unique_pid_path(label: &str) -> TempPathGuard {
    unique_tmp_path(label, ".pid")
}

fn large_env_values() -> [String; 4] {
    [
        "A".repeat(40 * 1024),
        "B".repeat(40 * 1024),
        "C".repeat(40 * 1024),
        "D".repeat(40 * 1024),
    ]
}

fn large_env_entries(values: &[String; 4]) -> [(&'static str, &str); 5] {
    [
        ("SMALL", "ok"),
        ("BIG_A", values[0].as_str()),
        ("BIG_B", values[1].as_str()),
        ("BIG_C", values[2].as_str()),
        ("BIG_D", values[3].as_str()),
    ]
}

fn assert_large_env_stdout(stdout: &[u8]) {
    assert_eq!(
        String::from_utf8_lossy(stdout),
        "ok:40960:40960:40960:40960\n"
    );
}

struct OrphanProcessGuard {
    pid_file: TempPathGuard,
}

impl OrphanProcessGuard {
    fn new(label: &str) -> Self {
        Self {
            pid_file: unique_pid_path(label),
        }
    }

    fn pid_path(&self) -> &str {
        self.pid_file.as_str()
    }
}

impl Drop for OrphanProcessGuard {
    fn drop(&mut self) {
        let Ok(pid_text) = std::fs::read_to_string(self.pid_file.as_str()) else {
            return;
        };
        let Ok(pid) = pid_text.trim().parse::<libc::pid_t>() else {
            return;
        };
        if pid > 0 {
            // SAFETY: pid is written by the shell as `$!` for this test's
            // background `sleep` process; failures are best-effort cleanup.
            unsafe {
                let _ = libc::kill(pid, libc::SIGKILL);
            }
        }
    }
}

fn orphan_sleep_command(marker: &str, pid_path: &str) -> String {
    format!("sleep 30 & echo $! > {pid_path}; echo {marker}")
}

#[test]
fn run_exits_after_shutdown_even_when_ack_write_fails() {
    use std::net::Shutdown;
    use std::os::unix::net::UnixListener;

    let socket_path = unique_socket_path("shutdown-failed-ack");
    let listener = UnixListener::bind(socket_path.as_str()).unwrap();

    let guest_socket_path = socket_path.as_str().to_owned();
    let handle = thread::spawn(move || run(Some(&guest_socket_path)));

    let (mut host_stream, _) = listener.accept().unwrap();
    drop(listener);
    read_and_discard_message(&mut host_stream);

    host_stream.shutdown(Shutdown::Read).unwrap();
    let msg = vsock_proto::encode(MSG_SHUTDOWN, 1, &[]).unwrap();
    host_stream.write_all(&msg).unwrap();

    // Refuse the ACK write before delivering MSG_SHUTDOWN. The write half is
    // still open, so the shutdown request is delivered, but the guest's final
    // ACK write fails with EPIPE/BrokenPipe.
    drop(host_stream);

    let result = handle.join().unwrap();
    assert!(
        result.is_ok(),
        "shutdown should stop run() cleanly even if ACK write fails: {result:?}",
    );
}

#[test]
fn run_sends_shutdown_ack_and_exits_without_waiting_for_disconnect() {
    use std::os::unix::net::UnixListener;
    use std::sync::mpsc;

    let socket_path = unique_socket_path("shutdown-ack");
    let listener = UnixListener::bind(socket_path.as_str()).unwrap();

    let guest_socket_path = socket_path.as_str().to_owned();
    let (done_tx, done_rx) = mpsc::channel();
    let handle = thread::spawn(move || {
        let result = run(Some(&guest_socket_path));
        let _ = done_tx.send(());
        result
    });

    let (mut host_stream, _) = listener.accept().unwrap();
    drop(listener);
    read_and_discard_message(&mut host_stream);

    let msg = vsock_proto::encode(MSG_SHUTDOWN, 42, &[]).unwrap();
    host_stream.write_all(&msg).unwrap();

    let ack = read_message(&mut host_stream);
    assert_eq!(ack.msg_type, MSG_SHUTDOWN_ACK);
    assert_eq!(ack.seq, 42);

    let finished_before_disconnect = done_rx.recv_timeout(Duration::from_secs(1)).is_ok();
    drop(host_stream);

    let result = handle.join().unwrap();
    assert!(
        finished_before_disconnect,
        "run() should exit after MSG_SHUTDOWN without waiting for host disconnect",
    );
    assert!(
        result.is_ok(),
        "shutdown should stop run() cleanly: {result:?}"
    );
}

// -----------------------------------------------------------------------
// Helpers for spawn_watch streaming tests
// -----------------------------------------------------------------------

/// Read one framed message from the stream.
fn read_message(stream: &mut impl std::io::Read) -> vsock_proto::RawMessage {
    let mut hdr = [0u8; 4];
    stream.read_exact(&mut hdr).unwrap();
    let body_len = u32::from_be_bytes(hdr) as usize;
    let mut body = vec![0u8; body_len];
    stream.read_exact(&mut body).unwrap();

    let mut full = Vec::with_capacity(4 + body_len);
    full.extend_from_slice(&hdr);
    full.extend_from_slice(&body);
    let mut decoder = vsock_proto::Decoder::new();
    let msgs = decoder.decode(&full).unwrap();
    assert_eq!(msgs.len(), 1);
    msgs.into_iter().next().unwrap()
}

/// Read one framed message from the stream and discard it.
fn read_and_discard_message(stream: &mut impl std::io::Read) {
    let _ = read_message(stream);
}

#[derive(Debug)]
struct CommandChunk {
    stream: CommandOutputStream,
    output_seq: u32,
    chunk: Vec<u8>,
    truncated: bool,
}

#[derive(Debug)]
struct CommandResult {
    termination: CommandTermination,
    stdout: Option<Vec<u8>>,
    stderr: Option<Vec<u8>>,
    stdout_truncated: bool,
    stderr_truncated: bool,
    diagnostic: String,
}

fn start_guest_connection() -> (thread::JoinHandle<()>, std::os::unix::net::UnixStream) {
    let (guest_stream, mut host_stream) = std::os::unix::net::UnixStream::pair().unwrap();
    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });
    read_and_discard_message(&mut host_stream);
    host_stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    (handle, host_stream)
}

fn finish_guest_connection(
    handle: thread::JoinHandle<()>,
    host_stream: std::os::unix::net::UnixStream,
) {
    drop(host_stream);
    let _ = handle.join();
}

fn send_command_start(
    stream: &mut impl std::io::Write,
    seq: u32,
    command: &str,
    timeout_ms: u32,
    stdout: CommandOutputPolicy,
    stderr: CommandOutputPolicy,
) {
    send_command_start_with_env(stream, seq, command, timeout_ms, &[], stdout, stderr);
}

fn send_command_start_with_env(
    stream: &mut impl std::io::Write,
    seq: u32,
    command: &str,
    timeout_ms: u32,
    env: &[(&str, &str)],
    stdout: CommandOutputPolicy,
    stderr: CommandOutputPolicy,
) {
    let payload =
        vsock_proto::encode_command_start(timeout_ms, command, env, false, "test", stdout, stderr)
            .unwrap();
    let msg = vsock_proto::encode(MSG_COMMAND_START, seq, &payload).unwrap();
    stream.write_all(&msg).unwrap();
}

fn send_command_cancel(stream: &mut impl std::io::Write, seq: u32) {
    let payload = vsock_proto::encode_command_cancel();
    let msg = vsock_proto::encode(MSG_COMMAND_CANCEL, seq, &payload).unwrap();
    stream.write_all(&msg).unwrap();
}

fn read_command_result(
    stream: &mut impl std::io::Read,
    seq: u32,
) -> (Vec<CommandChunk>, CommandResult) {
    let mut decoder = vsock_proto::Decoder::new();
    let mut buf = [0u8; 4096];
    let mut chunks = Vec::new();
    loop {
        let n = read_retry_eintr(stream, &mut buf).unwrap();
        assert!(n > 0, "unexpected EOF waiting for command result");
        for msg in decoder.decode(buf.get(..n).unwrap_or_default()).unwrap() {
            if msg.seq != seq {
                continue;
            }
            match msg.msg_type {
                MSG_COMMAND_OUTPUT => {
                    let decoded = vsock_proto::decode_command_output(&msg.payload).unwrap();
                    chunks.push(CommandChunk {
                        stream: decoded.stream,
                        output_seq: decoded.output_seq,
                        chunk: decoded.chunk.to_vec(),
                        truncated: decoded.truncated,
                    });
                }
                MSG_COMMAND_RESULT => {
                    let decoded = vsock_proto::decode_command_result(&msg.payload).unwrap();
                    return (
                        chunks,
                        CommandResult {
                            termination: decoded.termination,
                            stdout: captured_to_vec(decoded.stdout),
                            stderr: captured_to_vec(decoded.stderr),
                            stdout_truncated: captured_truncated(decoded.stdout),
                            stderr_truncated: captured_truncated(decoded.stderr),
                            diagnostic: decoded.diagnostic.to_string(),
                        },
                    );
                }
                MSG_ERROR => {
                    let error = vsock_proto::decode_error(&msg.payload).unwrap();
                    panic!("unexpected command error for seq={seq}: {error}");
                }
                other => panic!("unexpected command response type: 0x{other:02X}"),
            }
        }
    }
}

fn read_command_output_chunk(stream: &mut impl std::io::Read, seq: u32) -> CommandChunk {
    let mut decoder = vsock_proto::Decoder::new();
    let mut buf = [0u8; 4096];
    loop {
        let n = read_retry_eintr(stream, &mut buf).unwrap();
        assert!(n > 0, "unexpected EOF waiting for command output");
        for msg in decoder.decode(buf.get(..n).unwrap_or_default()).unwrap() {
            if msg.seq != seq {
                continue;
            }
            match msg.msg_type {
                MSG_COMMAND_OUTPUT => {
                    let decoded = vsock_proto::decode_command_output(&msg.payload).unwrap();
                    return CommandChunk {
                        stream: decoded.stream,
                        output_seq: decoded.output_seq,
                        chunk: decoded.chunk.to_vec(),
                        truncated: decoded.truncated,
                    };
                }
                MSG_COMMAND_RESULT => panic!("unexpected command result before output"),
                MSG_ERROR => {
                    let error = vsock_proto::decode_error(&msg.payload).unwrap();
                    panic!("unexpected command error for seq={seq}: {error}");
                }
                other => panic!("unexpected command response type: 0x{other:02X}"),
            }
        }
    }
}

fn captured_to_vec(captured: CommandCapturedOutput<'_>) -> Option<Vec<u8>> {
    match captured {
        CommandCapturedOutput::Discarded => None,
        CommandCapturedOutput::Captured { bytes, .. } => Some(bytes.to_vec()),
    }
}

fn captured_truncated(captured: CommandCapturedOutput<'_>) -> bool {
    match captured {
        CommandCapturedOutput::Discarded => false,
        CommandCapturedOutput::Captured { truncated, .. } => truncated,
    }
}

fn stdout_data(chunks: &[CommandChunk]) -> Vec<u8> {
    chunks
        .iter()
        .filter(|chunk| chunk.stream == CommandOutputStream::Stdout && !chunk.truncated)
        .flat_map(|chunk| chunk.chunk.clone())
        .collect()
}

fn stderr_data(chunks: &[CommandChunk]) -> Vec<u8> {
    chunks
        .iter()
        .filter(|chunk| chunk.stream == CommandOutputStream::Stderr && !chunk.truncated)
        .flat_map(|chunk| chunk.chunk.clone())
        .collect()
}

#[test]
fn command_capture_only_stdout_stderr_success() {
    let (handle, mut host_stream) = start_guest_connection();

    send_command_start(
        &mut host_stream,
        101,
        "printf stdout; printf stderr >&2",
        5000,
        CommandOutputPolicy::Capture { limit_bytes: 1024 },
        CommandOutputPolicy::Capture { limit_bytes: 1024 },
    );
    let (chunks, result) = read_command_result(&mut host_stream, 101);

    assert!(chunks.is_empty());
    assert_eq!(
        result.termination,
        CommandTermination::Exited { exit_code: 0 }
    );
    assert_eq!(result.stdout, Some(b"stdout".to_vec()));
    assert_eq!(result.stderr, Some(b"stderr".to_vec()));
    assert!(!result.stdout_truncated);
    assert!(!result.stderr_truncated);
    assert!(result.diagnostic.is_empty());

    finish_guest_connection(handle, host_stream);
}

#[test]
fn command_large_env_payload_succeeds() {
    let values = large_env_values();
    let env = large_env_entries(&values);
    let (handle, mut host_stream) = start_guest_connection();

    send_command_start_with_env(
        &mut host_stream,
        124,
        LARGE_ENV_COMMAND,
        5000,
        &env,
        CommandOutputPolicy::Capture { limit_bytes: 128 },
        CommandOutputPolicy::Capture { limit_bytes: 1024 },
    );
    let (_chunks, result) = read_command_result(&mut host_stream, 124);

    assert_eq!(
        result.termination,
        CommandTermination::Exited { exit_code: 0 },
        "diagnostic: {} stderr: {:?}",
        result.diagnostic,
        result.stderr,
    );
    assert_large_env_stdout(&result.stdout.unwrap_or_default());

    finish_guest_connection(handle, host_stream);
}

#[test]
fn command_repeated_short_operations_soak() {
    let (handle, mut host_stream) = start_guest_connection();

    for seq in 130..138 {
        let expected = format!("run-{seq}");
        send_command_start(
            &mut host_stream,
            seq,
            &format!("printf {expected}"),
            5000,
            CommandOutputPolicy::Capture { limit_bytes: 64 },
            CommandOutputPolicy::Capture { limit_bytes: 64 },
        );
        let (chunks, result) = read_command_result(&mut host_stream, seq);

        assert!(chunks.is_empty());
        assert_eq!(
            result.termination,
            CommandTermination::Exited { exit_code: 0 }
        );
        assert_eq!(result.stdout, Some(expected.into_bytes()));
        assert_eq!(result.stderr, Some(Vec::new()));
        assert!(!result.stdout_truncated);
        assert!(!result.stderr_truncated);
    }

    finish_guest_connection(handle, host_stream);
}

#[test]
fn command_large_stdout_stderr_capture_soak() {
    let (handle, mut host_stream) = start_guest_connection();
    let len = 32 * 1024usize;

    send_command_start(
        &mut host_stream,
        138,
        "head -c 32768 /dev/zero | tr '\\0' o; head -c 32768 /dev/zero | tr '\\0' e >&2",
        5000,
        CommandOutputPolicy::Capture {
            limit_bytes: len as u32,
        },
        CommandOutputPolicy::Capture {
            limit_bytes: len as u32,
        },
    );
    let (chunks, result) = read_command_result(&mut host_stream, 138);

    assert!(chunks.is_empty());
    assert_eq!(
        result.termination,
        CommandTermination::Exited { exit_code: 0 }
    );
    let stdout = result.stdout.unwrap();
    let stderr = result.stderr.unwrap();
    assert_eq!(stdout.len(), len);
    assert_eq!(stderr.len(), len);
    assert!(stdout.iter().all(|byte| *byte == b'o'));
    assert!(stderr.iter().all(|byte| *byte == b'e'));
    assert!(!result.stdout_truncated);
    assert!(!result.stderr_truncated);

    finish_guest_connection(handle, host_stream);
}

#[test]
fn command_stream_only_stdout_stderr_success() {
    let (handle, mut host_stream) = start_guest_connection();

    send_command_start(
        &mut host_stream,
        102,
        "printf out; printf err >&2",
        5000,
        CommandOutputPolicy::Stream {
            limit_bytes: 64,
            chunk_limit_bytes: 8,
        },
        CommandOutputPolicy::Stream {
            limit_bytes: 64,
            chunk_limit_bytes: 8,
        },
    );
    let (chunks, result) = read_command_result(&mut host_stream, 102);

    assert_eq!(
        result.termination,
        CommandTermination::Exited { exit_code: 0 }
    );
    assert_eq!(result.stdout, None);
    assert_eq!(result.stderr, None);
    assert_eq!(stdout_data(&chunks), b"out".to_vec());
    assert_eq!(stderr_data(&chunks), b"err".to_vec());
    for (expected, chunk) in chunks.iter().enumerate() {
        assert_eq!(chunk.output_seq, expected as u32);
    }

    finish_guest_connection(handle, host_stream);
}

#[test]
fn command_stream_handles_more_chunks_than_output_queue_capacity() {
    let (handle, mut host_stream) = start_guest_connection();
    let expected = "x".repeat(96);
    let command = format!("printf {expected}");

    send_command_start(
        &mut host_stream,
        116,
        &command,
        5000,
        CommandOutputPolicy::Stream {
            limit_bytes: expected.len() as u32,
            chunk_limit_bytes: 1,
        },
        CommandOutputPolicy::Discard,
    );
    let (chunks, result) = read_command_result(&mut host_stream, 116);

    assert_eq!(
        result.termination,
        CommandTermination::Exited { exit_code: 0 }
    );
    assert_eq!(stdout_data(&chunks), expected.as_bytes());
    assert_eq!(chunks.len(), expected.len());
    assert!(chunks.iter().all(|chunk| !chunk.truncated));
    for (expected_seq, chunk) in chunks.iter().enumerate() {
        assert_eq!(chunk.output_seq, expected_seq as u32);
    }

    finish_guest_connection(handle, host_stream);
}

#[test]
fn command_stream_disconnect_cancels_child() {
    let pid_path = unique_pid_path("command-stream-disconnect");
    let fifo_path = unique_tmp_path("command-stream-disconnect", ".fifo");
    let mut child_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (handle, mut host_stream) = start_guest_connection();

    let command = format!(
        "mkfifo '{}'; echo $$ > '{}'; printf tick; read _ < '{}'",
        fifo_path.as_str(),
        pid_path.as_str(),
        fifo_path.as_str()
    );
    send_command_start(
        &mut host_stream,
        117,
        &command,
        0,
        CommandOutputPolicy::Stream {
            limit_bytes: 1024 * 1024,
            chunk_limit_bytes: 16,
        },
        CommandOutputPolicy::Discard,
    );
    let pid = child_guard.read_pid();
    let chunk = read_command_output_chunk(&mut host_stream, 117);
    assert_eq!(chunk.stream, CommandOutputStream::Stdout);
    assert!(!chunk.chunk.is_empty());
    assert!(
        pid_alive(pid),
        "command child should be running before disconnect"
    );

    drop(host_stream);
    let _ = handle.join();
    wait_for_pid_exit(pid, "command stream host disconnect");
    child_guard.disarm();
}

#[test]
fn command_rejects_output_policies_that_cannot_fit_protocol_frames_without_running() {
    let capture_marker = unique_tmp_path("command-huge-capture-policy", ".marker");
    let stream_marker = unique_tmp_path("command-huge-stream-policy", ".marker");
    let (handle, mut host_stream) = start_guest_connection();

    send_command_start(
        &mut host_stream,
        118,
        &format!("printf ran > '{}'", capture_marker.as_str()),
        5000,
        CommandOutputPolicy::Capture {
            limit_bytes: u32::MAX,
        },
        CommandOutputPolicy::Discard,
    );
    let (_chunks, capture_result) = read_command_result(&mut host_stream, 118);
    assert_eq!(capture_result.termination, CommandTermination::StartFailed);
    assert!(
        capture_result
            .diagnostic
            .contains("capture limits exceed protocol result frame budget")
    );
    assert!(std::fs::metadata(capture_marker.as_str()).is_err());

    send_command_start(
        &mut host_stream,
        119,
        &format!("printf ran > '{}'", stream_marker.as_str()),
        5000,
        CommandOutputPolicy::Stream {
            limit_bytes: 1,
            chunk_limit_bytes: u32::MAX,
        },
        CommandOutputPolicy::Discard,
    );
    let (_chunks, stream_result) = read_command_result(&mut host_stream, 119);
    assert_eq!(stream_result.termination, CommandTermination::StartFailed);
    assert!(
        stream_result
            .diagnostic
            .contains("stream chunk limit exceeds protocol frame budget")
    );
    assert!(std::fs::metadata(stream_marker.as_str()).is_err());

    finish_guest_connection(handle, host_stream);
}

#[test]
fn command_capture_and_stream_success() {
    let (handle, mut host_stream) = start_guest_connection();

    send_command_start(
        &mut host_stream,
        103,
        "printf visible",
        5000,
        CommandOutputPolicy::CaptureAndStream {
            capture_limit_bytes: 64,
            stream_limit_bytes: 64,
            chunk_limit_bytes: 4,
        },
        CommandOutputPolicy::Discard,
    );
    let (chunks, result) = read_command_result(&mut host_stream, 103);

    assert_eq!(
        result.termination,
        CommandTermination::Exited { exit_code: 0 }
    );
    assert_eq!(result.stdout, Some(b"visible".to_vec()));
    assert_eq!(result.stderr, None);
    assert_eq!(stdout_data(&chunks), b"visible".to_vec());
    assert!(chunks.iter().all(|chunk| !chunk.truncated));

    finish_guest_connection(handle, host_stream);
}

#[test]
fn command_capture_limits_track_exact_and_one_byte_over() {
    let (handle, mut host_stream) = start_guest_connection();

    send_command_start(
        &mut host_stream,
        104,
        "printf abcd",
        5000,
        CommandOutputPolicy::Capture { limit_bytes: 4 },
        CommandOutputPolicy::Discard,
    );
    let (_chunks, exact) = read_command_result(&mut host_stream, 104);
    assert_eq!(exact.stdout, Some(b"abcd".to_vec()));
    assert!(!exact.stdout_truncated);

    send_command_start(
        &mut host_stream,
        105,
        "printf abcde",
        5000,
        CommandOutputPolicy::Capture { limit_bytes: 4 },
        CommandOutputPolicy::Discard,
    );
    let (_chunks, over) = read_command_result(&mut host_stream, 105);
    assert_eq!(over.stdout, Some(b"abcd".to_vec()));
    assert!(over.stdout_truncated);

    finish_guest_connection(handle, host_stream);
}

#[test]
fn command_stream_limits_track_exact_over_and_zero_budget() {
    let (handle, mut host_stream) = start_guest_connection();

    send_command_start(
        &mut host_stream,
        106,
        "printf abcd",
        5000,
        CommandOutputPolicy::Stream {
            limit_bytes: 4,
            chunk_limit_bytes: 2,
        },
        CommandOutputPolicy::Discard,
    );
    let (exact_chunks, exact) = read_command_result(&mut host_stream, 106);
    assert_eq!(
        exact.termination,
        CommandTermination::Exited { exit_code: 0 }
    );
    assert_eq!(stdout_data(&exact_chunks), b"abcd".to_vec());
    assert!(exact_chunks.iter().all(|chunk| !chunk.truncated));

    send_command_start(
        &mut host_stream,
        107,
        "printf abcde",
        5000,
        CommandOutputPolicy::Stream {
            limit_bytes: 4,
            chunk_limit_bytes: 2,
        },
        CommandOutputPolicy::Discard,
    );
    let (over_chunks, over) = read_command_result(&mut host_stream, 107);
    assert_eq!(
        over.termination,
        CommandTermination::Exited { exit_code: 0 }
    );
    assert_eq!(stdout_data(&over_chunks), b"abcd".to_vec());
    assert!(
        over_chunks
            .iter()
            .any(|chunk| chunk.stream == CommandOutputStream::Stdout
                && chunk.truncated
                && chunk.chunk.is_empty())
    );

    send_command_start(
        &mut host_stream,
        108,
        "printf abc",
        5000,
        CommandOutputPolicy::Stream {
            limit_bytes: 0,
            chunk_limit_bytes: 2,
        },
        CommandOutputPolicy::Discard,
    );
    let (zero_chunks, zero) = read_command_result(&mut host_stream, 108);
    assert_eq!(
        zero.termination,
        CommandTermination::Exited { exit_code: 0 }
    );
    assert_eq!(stdout_data(&zero_chunks), Vec::<u8>::new());
    assert_eq!(zero_chunks.len(), 1);
    assert_eq!(zero_chunks[0].stream, CommandOutputStream::Stdout);
    assert!(zero_chunks[0].truncated);
    assert!(zero_chunks[0].chunk.is_empty());

    finish_guest_connection(handle, host_stream);
}

#[test]
fn command_timeout_returns_timed_out_with_partial_capture() {
    let (handle, mut host_stream) = start_guest_connection();

    send_command_start(
        &mut host_stream,
        109,
        "printf before; sleep 60",
        200,
        CommandOutputPolicy::Capture { limit_bytes: 64 },
        CommandOutputPolicy::Capture { limit_bytes: 64 },
    );
    let (_chunks, result) = read_command_result(&mut host_stream, 109);

    assert_eq!(result.termination, CommandTermination::TimedOut);
    assert_eq!(result.stdout, Some(b"before".to_vec()));

    finish_guest_connection(handle, host_stream);
}

#[test]
fn command_invalid_env_returns_start_failed_without_leaking_value() {
    let (handle, mut host_stream) = start_guest_connection();

    let secret = "do-not-print-this-secret";
    send_command_start_with_env(
        &mut host_stream,
        110,
        "echo should-not-run",
        5000,
        &[("BAD;KEY", secret)],
        CommandOutputPolicy::Capture { limit_bytes: 64 },
        CommandOutputPolicy::Capture { limit_bytes: 64 },
    );
    let (chunks, result) = read_command_result(&mut host_stream, 110);

    assert!(chunks.is_empty());
    assert_eq!(result.termination, CommandTermination::StartFailed);
    assert!(
        result
            .diagnostic
            .contains("invalid environment variable name")
    );
    assert!(!result.diagnostic.contains(secret));

    finish_guest_connection(handle, host_stream);
}

#[test]
fn command_explicit_cancel_kills_child_and_returns_cancelled() {
    let pid_path = unique_pid_path("command-cancel");
    let mut child_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (handle, mut host_stream) = start_guest_connection();

    let command = format!("echo $$ > '{}'; sleep 60", pid_path.as_str());
    send_command_start(
        &mut host_stream,
        111,
        &command,
        0,
        CommandOutputPolicy::Capture { limit_bytes: 64 },
        CommandOutputPolicy::Capture { limit_bytes: 64 },
    );
    let pid = child_guard.read_pid();
    assert!(
        pid_alive(pid),
        "command child should be running before cancel"
    );

    send_command_cancel(&mut host_stream, 111);
    let (_chunks, result) = read_command_result(&mut host_stream, 111);

    assert_eq!(result.termination, CommandTermination::Cancelled);
    wait_for_pid_exit(pid, "command explicit cancel");
    child_guard.disarm();

    finish_guest_connection(handle, host_stream);
}

#[test]
fn command_connection_close_cancels_child() {
    let pid_path = unique_pid_path("command-connection-close");
    let mut child_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (handle, mut host_stream) = start_guest_connection();

    let command = format!("echo $$ > '{}'; sleep 60", pid_path.as_str());
    send_command_start(
        &mut host_stream,
        112,
        &command,
        0,
        CommandOutputPolicy::Capture { limit_bytes: 64 },
        CommandOutputPolicy::Capture { limit_bytes: 64 },
    );
    let pid = child_guard.read_pid();
    assert!(
        pid_alive(pid),
        "command child should be running before disconnect"
    );

    drop(host_stream);
    let _ = handle.join();
    wait_for_pid_exit(pid, "command host disconnect");
    child_guard.disarm();
}

#[test]
fn command_duplicate_start_returns_error_without_cancelling_active_command() {
    let pid_path = unique_pid_path("command-duplicate");
    let mut child_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (handle, mut host_stream) = start_guest_connection();

    let command = format!("echo $$ > '{}'; sleep 60", pid_path.as_str());
    send_command_start(
        &mut host_stream,
        113,
        &command,
        0,
        CommandOutputPolicy::Capture { limit_bytes: 64 },
        CommandOutputPolicy::Capture { limit_bytes: 64 },
    );
    let pid = child_guard.read_pid();

    send_command_start(
        &mut host_stream,
        113,
        "printf duplicate",
        5000,
        CommandOutputPolicy::Capture { limit_bytes: 64 },
        CommandOutputPolicy::Discard,
    );
    let msg = read_message(&mut host_stream);
    assert_eq!(msg.msg_type, MSG_ERROR);
    assert_eq!(msg.seq, 113);
    let error = vsock_proto::decode_error(&msg.payload).unwrap();
    assert!(error.contains("already active"));
    assert!(
        pid_alive(pid),
        "duplicate start should not cancel active child"
    );

    send_command_cancel(&mut host_stream, 113);
    let (_chunks, result) = read_command_result(&mut host_stream, 113);
    assert_eq!(result.termination, CommandTermination::Cancelled);
    wait_for_pid_exit(pid, "command duplicate cleanup");
    child_guard.disarm();

    finish_guest_connection(handle, host_stream);
}

#[test]
fn command_different_sequences_run_concurrently_and_cancel_independently() {
    let pid_path = unique_pid_path("command-concurrent");
    let fifo_path = unique_tmp_path("command-concurrent", ".fifo");
    let mut child_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (handle, mut host_stream) = start_guest_connection();

    let blocked_command = format!(
        "mkfifo '{}'; echo $$ > '{}'; read _ < '{}'",
        fifo_path.as_str(),
        pid_path.as_str(),
        fifo_path.as_str()
    );
    send_command_start(
        &mut host_stream,
        120,
        &blocked_command,
        0,
        CommandOutputPolicy::Capture { limit_bytes: 64 },
        CommandOutputPolicy::Capture { limit_bytes: 64 },
    );
    let pid = child_guard.read_pid();
    assert!(
        pid_alive(pid),
        "first command should remain active while second command starts"
    );

    send_command_start(
        &mut host_stream,
        121,
        "printf second",
        5000,
        CommandOutputPolicy::Capture { limit_bytes: 64 },
        CommandOutputPolicy::Discard,
    );
    let (_chunks, second) = read_command_result(&mut host_stream, 121);
    assert_eq!(
        second.termination,
        CommandTermination::Exited { exit_code: 0 }
    );
    assert_eq!(second.stdout, Some(b"second".to_vec()));
    assert!(
        pid_alive(pid),
        "second command completion should not cancel first command"
    );

    send_command_cancel(&mut host_stream, 120);
    let (_chunks, first) = read_command_result(&mut host_stream, 120);
    assert_eq!(first.termination, CommandTermination::Cancelled);
    wait_for_pid_exit(pid, "command concurrent cleanup");
    child_guard.disarm();

    finish_guest_connection(handle, host_stream);
}

#[test]
fn command_unknown_cancel_is_ignored() {
    let (handle, mut host_stream) = start_guest_connection();

    send_command_cancel(&mut host_stream, 999);
    send_command_start(
        &mut host_stream,
        114,
        "printf ok",
        5000,
        CommandOutputPolicy::Capture { limit_bytes: 64 },
        CommandOutputPolicy::Discard,
    );
    let (_chunks, result) = read_command_result(&mut host_stream, 114);

    assert_eq!(
        result.termination,
        CommandTermination::Exited { exit_code: 0 }
    );
    assert_eq!(result.stdout, Some(b"ok".to_vec()));

    finish_guest_connection(handle, host_stream);
}

#[test]
fn command_seq_zero_start_and_cancel_return_error() {
    let (handle, mut host_stream) = start_guest_connection();

    send_command_start(
        &mut host_stream,
        0,
        "printf should-not-run",
        5000,
        CommandOutputPolicy::Capture { limit_bytes: 64 },
        CommandOutputPolicy::Discard,
    );
    let start_error = read_message(&mut host_stream);
    assert_eq!(start_error.msg_type, MSG_ERROR);
    assert_eq!(start_error.seq, 0);
    assert!(
        vsock_proto::decode_error(&start_error.payload)
            .unwrap()
            .contains("non-zero sequence")
    );

    send_command_cancel(&mut host_stream, 0);
    let cancel_error = read_message(&mut host_stream);
    assert_eq!(cancel_error.msg_type, MSG_ERROR);
    assert_eq!(cancel_error.seq, 0);
    assert!(
        vsock_proto::decode_error(&cancel_error.payload)
            .unwrap()
            .contains("non-zero sequence")
    );

    finish_guest_connection(handle, host_stream);
}

/// Like `Read::read`, but retries on EINTR. `read_exact` retries
/// internally; bare `read()` does not, and llvm-cov / profilers
/// occasionally send signals that surface as EINTR on blocking reads.
fn read_retry_eintr(stream: &mut impl std::io::Read, buf: &mut [u8]) -> std::io::Result<usize> {
    loop {
        match stream.read(buf) {
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            other => return other,
        }
    }
}

/// Send a MSG_SPAWN_WATCH message with streaming enabled.
fn send_spawn_watch(
    stream: &mut impl std::io::Write,
    seq: u32,
    command: &str,
    log_path: Option<&str>,
    timeout_ms: u32,
) {
    send_spawn_watch_with_env(stream, seq, command, &[], log_path, timeout_ms);
}

fn send_spawn_watch_with_env(
    stream: &mut impl std::io::Write,
    seq: u32,
    command: &str,
    env: &[(&str, &str)],
    log_path: Option<&str>,
    timeout_ms: u32,
) {
    let payload =
        vsock_proto::encode_spawn_watch(timeout_ms, command, env, false, true, log_path).unwrap();
    let msg = vsock_proto::encode(MSG_SPAWN_WATCH, seq, &payload).unwrap();
    stream.write_all(&msg).unwrap();
}

/// Read all streaming messages for a spawn_watch command in a single loop.
/// Uses one decoder to avoid losing messages when the OS batches multiple
/// protocol frames into a single read buffer.
///
/// Returns `(pid, stdout_data, exit_code, stderr)`.
fn read_streaming_result(
    stream: &mut impl std::io::Read,
    seq: u32,
) -> (u32, Vec<u8>, i32, Vec<u8>) {
    let mut decoder = vsock_proto::Decoder::new();
    let mut buf = [0u8; 4096];
    let mut pid: Option<u32> = None;
    let mut stdout_data = Vec::new();
    loop {
        let n = read_retry_eintr(stream, &mut buf).unwrap();
        assert!(n > 0, "unexpected EOF waiting for streaming result");
        for msg in decoder.decode(buf.get(..n).unwrap_or_default()).unwrap() {
            // Pick up the PID from spawn_watch_result
            if msg.msg_type == MSG_SPAWN_WATCH_RESULT && msg.seq == seq {
                pid = Some(vsock_proto::decode_spawn_watch_result(&msg.payload).unwrap());
                continue;
            }
            let Some(p) = pid else { continue };

            // Collect stdout chunks and return on process_exit
            if msg.msg_type == MSG_STDOUT_CHUNK
                && let Ok((chunk_pid, data)) = vsock_proto::decode_stdout_chunk(&msg.payload)
                && chunk_pid == p
            {
                stdout_data.extend_from_slice(data);
            } else if msg.msg_type == MSG_PROCESS_EXIT
                && let Ok((exit_pid, code, _stdout, stderr)) =
                    vsock_proto::decode_process_exit(&msg.payload)
                && exit_pid == p
            {
                return (p, stdout_data, code, stderr.to_vec());
            }
        }
    }
}

// -----------------------------------------------------------------------
// Streaming monitor integration tests
// -----------------------------------------------------------------------

/// Verify that streaming stdout works correctly for a normal command.
#[test]
fn streaming_monitor_normal_exit() {
    use std::os::unix::net::UnixStream as StdUnixStream;

    let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();
    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });

    // Discard MSG_READY
    read_and_discard_message(&mut host_stream);

    let log_path = unique_tmp_path("normal", ".log");
    send_spawn_watch(
        &mut host_stream,
        1,
        "echo hello",
        Some(log_path.as_str()),
        5000,
    );

    host_stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let (pid, stdout_data, exit_code, _stderr) = read_streaming_result(&mut host_stream, 1);

    assert!(pid > 0);
    assert_eq!(exit_code, 0);
    assert_eq!(String::from_utf8_lossy(&stdout_data).trim(), "hello");

    drop(host_stream);
    let _ = handle.join();
}

#[test]
fn streaming_spawn_watch_large_env_payload_succeeds() {
    use std::os::unix::net::UnixStream as StdUnixStream;

    let values = large_env_values();
    let env = large_env_entries(&values);

    let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();
    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });
    read_and_discard_message(&mut host_stream); // MSG_READY
    host_stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();

    send_spawn_watch_with_env(&mut host_stream, 1, LARGE_ENV_COMMAND, &env, None, 5000);
    let (_pid, stdout_data, exit_code, stderr) = read_streaming_result(&mut host_stream, 1);

    assert_eq!(exit_code, 0, "stderr: {}", String::from_utf8_lossy(&stderr));
    assert_large_env_stdout(&stdout_data);

    drop(host_stream);
    let _ = handle.join();
}

#[test]
fn streaming_spawn_watch_invalid_env_payload_returns_error_without_leaking_value() {
    use std::os::unix::net::UnixStream as StdUnixStream;

    let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();
    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });
    read_and_discard_message(&mut host_stream); // MSG_READY
    host_stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();

    let secret = "do-not-print-this-secret";
    send_spawn_watch_with_env(
        &mut host_stream,
        1,
        "echo should-not-run",
        &[("BAD;KEY", secret)],
        None,
        5000,
    );

    let msg = read_message(&mut host_stream);
    assert_eq!(msg.msg_type, MSG_ERROR);
    assert_eq!(msg.seq, 1);
    let error = vsock_proto::decode_error(&msg.payload).unwrap();
    assert!(error.contains("invalid environment variable name"));
    assert!(!error.contains(secret));

    drop(host_stream);
    let _ = handle.join();
}

/// A cleanly exiting streaming process should not wait for the timeout watchdog
/// before reporting `MSG_PROCESS_EXIT`.
#[test]
fn streaming_monitor_clean_exit_returns_before_long_timeout() {
    use std::os::unix::net::UnixStream as StdUnixStream;
    use std::time::Instant;

    let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();
    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });

    read_and_discard_message(&mut host_stream); // MSG_READY
    host_stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();

    let start = Instant::now();
    send_spawn_watch(&mut host_stream, 1, "printf clean-exit", None, 60_000);
    let (pid, stdout_data, exit_code, stderr) = read_streaming_result(&mut host_stream, 1);
    let elapsed = start.elapsed();

    assert!(pid > 0);
    assert_eq!(exit_code, 0);
    assert_eq!(String::from_utf8_lossy(&stdout_data), "clean-exit");
    assert_eq!(stderr, b"");
    assert!(
        elapsed < Duration::from_secs(5),
        "clean exit should not wait for 60s watchdog timeout, took {elapsed:?}",
    );

    drop(host_stream);
    let _ = handle.join();
}

/// `MSG_SPAWN_WATCH_RESULT` must arrive before stdout chunks for that pid.
/// The host only registers the stdout stream after processing the spawn
/// result, so a chunk sent first would be dropped by older host code.
#[test]
fn streaming_spawn_watch_result_precedes_stdout_chunks() {
    use std::os::unix::net::UnixStream as StdUnixStream;
    use std::time::Instant;

    let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();
    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });

    read_and_discard_message(&mut host_stream);
    send_spawn_watch(&mut host_stream, 1, "printf ordered-output", None, 5000);

    host_stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();

    let mut decoder = vsock_proto::Decoder::new();
    let mut buf = [0u8; 4096];
    let mut pid: Option<u32> = None;
    let mut stdout_data = Vec::new();
    let mut saw_exit = false;
    let deadline = Instant::now() + Duration::from_secs(5);

    while stdout_data.is_empty() || !saw_exit {
        assert!(
            Instant::now() < deadline,
            "did not see spawn result, stdout chunk, and process exit in time \
             (pid={pid:?}, stdout_len={}, saw_exit={saw_exit})",
            stdout_data.len(),
        );
        let n = read_retry_eintr(&mut host_stream, &mut buf).unwrap();
        assert!(
            n > 0,
            "unexpected EOF waiting for streaming spawn_watch result"
        );

        for msg in decoder.decode(buf.get(..n).unwrap_or_default()).unwrap() {
            if msg.msg_type == MSG_SPAWN_WATCH_RESULT && msg.seq == 1 {
                assert!(pid.is_none(), "duplicate spawn_watch_result");
                pid = Some(vsock_proto::decode_spawn_watch_result(&msg.payload).unwrap());
                continue;
            }

            if msg.msg_type == MSG_STDOUT_CHUNK {
                let Some(p) = pid else {
                    panic!("stdout chunk arrived before spawn_watch_result");
                };
                let (chunk_pid, data) = vsock_proto::decode_stdout_chunk(&msg.payload).unwrap();
                if chunk_pid == p {
                    stdout_data.extend_from_slice(data);
                }
            } else if msg.msg_type == MSG_PROCESS_EXIT {
                let Some(p) = pid else {
                    panic!("process_exit arrived before spawn_watch_result");
                };
                let (exit_pid, code, _stdout, stderr) =
                    vsock_proto::decode_process_exit(&msg.payload).unwrap();
                if exit_pid == p {
                    assert_eq!(code, 0);
                    assert_eq!(stderr, b"");
                    saw_exit = true;
                }
            }
        }
    }

    assert_eq!(String::from_utf8_lossy(&stdout_data), "ordered-output");

    drop(host_stream);
    let _ = handle.join();
}

/// Stream-only mode sends stdout chunks to the host without creating a
/// guest-side tee file.
#[test]
fn streaming_monitor_stream_only_does_not_write_guest_log() {
    use std::os::unix::net::UnixStream as StdUnixStream;

    let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();
    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });

    // Discard MSG_READY
    read_and_discard_message(&mut host_stream);

    let log_path = unique_tmp_path("stream-only", ".log");
    std::fs::write(log_path.as_str(), "preexisting\n").unwrap();
    send_spawn_watch(&mut host_stream, 1, "echo stream-only", None, 5000);

    host_stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let (pid, stdout_data, exit_code, _stderr) = read_streaming_result(&mut host_stream, 1);

    assert!(pid > 0);
    assert_eq!(exit_code, 0);
    assert_eq!(String::from_utf8_lossy(&stdout_data).trim(), "stream-only");
    let log_content = std::fs::read_to_string(log_path.as_str()).unwrap();
    assert_eq!(log_content, "preexisting\n");

    drop(host_stream);
    let _ = handle.join();
}

/// Regression test: if the main child exits but an orphaned background
/// process holds the stdout fd open, `send_process_exit` must still arrive
/// within the drain deadline (DRAIN_DEADLINE_SECS).
///
/// Before the fix, the monitor thread blocked forever on `stdout.read()`
/// because the orphaned process kept the pipe write end open.
#[test]
fn streaming_monitor_drains_on_orphaned_stdout() {
    use std::os::unix::net::UnixStream as StdUnixStream;

    let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();
    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });

    // Discard MSG_READY
    read_and_discard_message(&mut host_stream);

    // Command that writes to stdout, then spawns a background process
    // that inherits (and holds open) the stdout fd. The main shell exits
    // immediately but the backgrounded `sleep` keeps the pipe alive.
    let log_path = unique_tmp_path("orphan", ".log");
    let orphan = OrphanProcessGuard::new("orphan-sleep");
    let command = orphan_sleep_command("orphan-test", orphan.pid_path());
    send_spawn_watch(
        &mut host_stream,
        1,
        &command,
        Some(log_path.as_str()),
        0, // no timeout — relies entirely on drain deadline
    );

    // Set read timeout: drain deadline (5s) + generous margin (7s)
    host_stream
        .set_read_timeout(Some(Duration::from_secs(12)))
        .unwrap();

    let (pid, stdout_data, exit_code, _stderr) = read_streaming_result(&mut host_stream, 1);

    assert!(pid > 0);
    assert_eq!(exit_code, 0);
    assert!(
        String::from_utf8_lossy(&stdout_data).contains("orphan-test"),
        "expected stdout to contain 'orphan-test', got: {:?}",
        String::from_utf8_lossy(&stdout_data),
    );

    drop(host_stream);
    let _ = handle.join();
}

/// Verify that a streaming process killed by timeout returns exit code 124
/// and delivers process_exit promptly.
///
/// The timeout killer fires while the stdout thread is reading. SIGKILL
/// breaks the pipe (EOF), the stdout thread exits, and the monitor thread
/// reports exit_code = EXIT_CODE_TIMEOUT (124).
#[test]
fn streaming_monitor_timeout_kills_process() {
    use std::os::unix::net::UnixStream as StdUnixStream;

    let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();
    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });

    // Discard MSG_READY
    read_and_discard_message(&mut host_stream);

    // Command that runs longer than the timeout.
    // timeout_ms = 1000 (1s), command sleeps 60s → killed after 1s.
    let log_path = unique_tmp_path("timeout", ".log");
    send_spawn_watch(
        &mut host_stream,
        1,
        "echo timeout-test; sleep 60",
        Some(log_path.as_str()),
        1000, // 1 second timeout
    );

    // Timeout (1s) + drain (5s) + margin (4s)
    host_stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();

    let (pid, stdout_data, exit_code, stderr) = read_streaming_result(&mut host_stream, 1);

    assert!(pid > 0);
    assert_eq!(exit_code, EXIT_CODE_TIMEOUT);
    assert_eq!(String::from_utf8_lossy(&stderr), "Timeout");
    assert!(
        String::from_utf8_lossy(&stdout_data).contains("timeout-test"),
        "expected stdout to contain 'timeout-test', got: {:?}",
        String::from_utf8_lossy(&stdout_data),
    );

    drop(host_stream);
    let _ = handle.join();
}

// -----------------------------------------------------------------------
// Buffered (cancellable-drain) regression tests for #11077
// -----------------------------------------------------------------------

/// Send a `MSG_SPAWN_WATCH` with the buffered (no `stdout_log_path`) shape.
fn send_spawn_watch_buffered(
    stream: &mut impl std::io::Write,
    seq: u32,
    command: &str,
    timeout_ms: u32,
) {
    send_spawn_watch_buffered_with_env(stream, seq, command, &[], timeout_ms);
}

fn send_spawn_watch_buffered_with_env(
    stream: &mut impl std::io::Write,
    seq: u32,
    command: &str,
    env: &[(&str, &str)],
    timeout_ms: u32,
) {
    let payload =
        vsock_proto::encode_spawn_watch(timeout_ms, command, env, false, false, None).unwrap();
    let msg = vsock_proto::encode(MSG_SPAWN_WATCH, seq, &payload).unwrap();
    stream.write_all(&msg).unwrap();
}

/// Read `MSG_SPAWN_WATCH_RESULT` + `MSG_PROCESS_EXIT` for a buffered
/// spawn_watch and return `(pid, exit_code, stdout, stderr)`.
fn read_buffered_spawn_watch_result(
    stream: &mut impl std::io::Read,
    seq: u32,
) -> (u32, i32, Vec<u8>, Vec<u8>) {
    let mut decoder = vsock_proto::Decoder::new();
    let mut buf = [0u8; 4096];
    let mut pid: Option<u32> = None;
    loop {
        let n = read_retry_eintr(stream, &mut buf).unwrap();
        assert!(
            n > 0,
            "unexpected EOF waiting for buffered spawn_watch result"
        );
        for msg in decoder.decode(buf.get(..n).unwrap_or_default()).unwrap() {
            if msg.msg_type == MSG_SPAWN_WATCH_RESULT && msg.seq == seq {
                pid = Some(vsock_proto::decode_spawn_watch_result(&msg.payload).unwrap());
                continue;
            }
            let Some(p) = pid else { continue };
            if msg.msg_type == MSG_PROCESS_EXIT
                && let Ok((exit_pid, code, stdout, stderr)) =
                    vsock_proto::decode_process_exit(&msg.payload)
                && exit_pid == p
            {
                return (p, code, stdout.to_vec(), stderr.to_vec());
            }
        }
    }
}

fn read_spawn_watch_pid(stream: &mut impl std::io::Read, seq: u32) -> u32 {
    let mut decoder = vsock_proto::Decoder::new();
    let mut buf = [0u8; 4096];
    loop {
        let n = read_retry_eintr(stream, &mut buf).unwrap();
        assert!(n > 0, "unexpected EOF waiting for spawn_watch pid");
        for msg in decoder.decode(buf.get(..n).unwrap_or_default()).unwrap() {
            if msg.msg_type == MSG_SPAWN_WATCH_RESULT && msg.seq == seq {
                return vsock_proto::decode_spawn_watch_result(&msg.payload).unwrap();
            }
        }
    }
}

fn read_pid_file(path: &str) -> u32 {
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        match std::fs::read_to_string(path) {
            Ok(contents) => {
                if let Ok(pid) = contents.trim().parse() {
                    return pid;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => panic!("failed to read pid file {path}: {e}"),
        }
        assert!(
            std::time::Instant::now() < deadline,
            "pid file {path} was not created",
        );
        thread::sleep(Duration::from_millis(50));
    }
}

fn kill_pid_group(pid: u32) {
    // SAFETY: best-effort cleanup for a pid produced by a test child process.
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

struct ProcessGroupFileGuard<'a> {
    pid_path: &'a str,
    pid: Option<u32>,
    armed: bool,
}

impl<'a> ProcessGroupFileGuard<'a> {
    fn new(pid_path: &'a str) -> Self {
        Self {
            pid_path,
            pid: None,
            armed: true,
        }
    }

    fn read_pid(&mut self) -> u32 {
        let pid = read_pid_file(self.pid_path);
        self.pid = Some(pid);
        pid
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for ProcessGroupFileGuard<'_> {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let pid = self.pid.or_else(|| {
            std::fs::read_to_string(self.pid_path)
                .ok()
                .and_then(|contents| contents.trim().parse().ok())
        });
        let Some(pid) = pid else {
            return;
        };
        if pid > 0 && pid_alive(pid) {
            kill_pid_group(pid);
        }
    }
}

fn wait_for_pid_exit(pid: u32, context: &str) {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while pid_alive(pid) {
        if std::time::Instant::now() >= deadline {
            kill_pid_group(pid);
            panic!("pid {pid} did not terminate within 5s after {context}");
        }
        thread::sleep(Duration::from_millis(50));
    }
}

/// Regression for #11077: with `timeout_ms = 0`, a backgrounded grandchild
/// that inherits the stdout fd must not keep the command result from arriving
/// after the foreground shell exits. Pre-fix, buffered output collection
/// waited the full ~30 s for the orphaned `sleep` to release the fd. Post-fix,
/// the drain thread cancels at the deadline (well below 30 s) and we return.
#[test]
fn command_returns_when_orphaned_grandchild_holds_stdout() {
    use std::time::Instant;

    let (handle, mut host_stream) = start_guest_connection();
    host_stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .unwrap();
    let orphan = OrphanProcessGuard::new("orphan-command-sleep");
    let command = orphan_sleep_command("orphan-command", orphan.pid_path());
    let start = Instant::now();
    send_command_start(
        &mut host_stream,
        122,
        &command,
        0,
        CommandOutputPolicy::Capture { limit_bytes: 1024 },
        CommandOutputPolicy::Capture { limit_bytes: 1024 },
    );
    let (_chunks, result) = read_command_result(&mut host_stream, 122);
    let elapsed = start.elapsed();

    assert_eq!(
        result.termination,
        CommandTermination::Exited { exit_code: 0 }
    );
    let stdout = result.stdout.unwrap_or_default();
    assert!(
        String::from_utf8_lossy(&stdout).contains("orphan-command"),
        "expected stdout to contain 'orphan-command', got: {:?}",
        String::from_utf8_lossy(&stdout),
    );
    assert!(
        elapsed < Duration::from_secs(DRAIN_DEADLINE_SECS + 5),
        "command result should arrive within drain deadline, took {elapsed:?}",
    );

    finish_guest_connection(handle, host_stream);
}

/// Output written by an inherited-fd grandchild within the drain deadline must
/// still be included after the foreground shell exits.
#[test]
fn command_captures_grandchild_output_before_drain_deadline() {
    use std::time::Instant;

    let (handle, mut host_stream) = start_guest_connection();
    host_stream
        .set_read_timeout(Some(Duration::from_secs(8)))
        .unwrap();

    let start = Instant::now();
    send_command_start(
        &mut host_stream,
        123,
        "echo stdout-early; echo stderr-early >&2; { sleep 1; echo stdout-late; echo stderr-late >&2; } &",
        0,
        CommandOutputPolicy::Capture { limit_bytes: 1024 },
        CommandOutputPolicy::Capture { limit_bytes: 1024 },
    );
    let (_chunks, result) = read_command_result(&mut host_stream, 123);
    let elapsed = start.elapsed();

    assert_eq!(
        result.termination,
        CommandTermination::Exited { exit_code: 0 }
    );
    assert_eq!(
        String::from_utf8_lossy(&result.stdout.unwrap_or_default()),
        "stdout-early\nstdout-late\n"
    );
    assert_eq!(
        String::from_utf8_lossy(&result.stderr.unwrap_or_default()),
        "stderr-early\nstderr-late\n"
    );
    assert!(
        elapsed < Duration::from_secs(DRAIN_DEADLINE_SECS),
        "late output should be captured before drain deadline, took {elapsed:?}",
    );

    finish_guest_connection(handle, host_stream);
}

/// Returns true iff `pid` is still a live (or zombie-but-unreaped) process
/// the test owner has permission to signal. Implemented via `kill(pid, 0)`,
/// the canonical existence check. After bash dies via SIGPIPE the kernel
/// reaps it (we're not its parent — it was reparented to PID 1 when its
/// process group died), so this transitions to false.
fn pid_alive(pid: u32) -> bool {
    // SAFETY: `kill` with sig=0 is a no-op existence check.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[test]
fn spawn_watch_timeout_zero_silent_child_is_cancelled_on_host_disconnect() {
    use std::os::unix::net::UnixStream as StdUnixStream;

    let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();
    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });
    read_and_discard_message(&mut host_stream); // MSG_READY

    send_spawn_watch(&mut host_stream, 1, "sleep 60", None, 0);
    host_stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let pid = read_spawn_watch_pid(&mut host_stream, 1);
    assert!(
        pid_alive(pid),
        "child should still be running before disconnect",
    );

    drop(host_stream);
    let _ = handle.join();
    wait_for_pid_exit(pid, "spawn_watch host disconnect");
}

#[test]
fn spawn_watch_buffered_timeout_zero_silent_child_is_cancelled_on_host_disconnect() {
    use std::os::unix::net::UnixStream as StdUnixStream;

    let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();
    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });
    read_and_discard_message(&mut host_stream); // MSG_READY

    send_spawn_watch_buffered(&mut host_stream, 1, "sleep 60", 0);
    host_stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let pid = read_spawn_watch_pid(&mut host_stream, 1);
    assert!(
        pid_alive(pid),
        "child should still be running before disconnect",
    );

    drop(host_stream);
    let _ = handle.join();
    wait_for_pid_exit(pid, "buffered spawn_watch host disconnect");
}

#[test]
fn buffered_spawn_watch_large_env_payload_succeeds() {
    use std::os::unix::net::UnixStream as StdUnixStream;

    let values = large_env_values();
    let env = large_env_entries(&values);

    let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();
    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });
    read_and_discard_message(&mut host_stream); // MSG_READY
    host_stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();

    send_spawn_watch_buffered_with_env(&mut host_stream, 1, LARGE_ENV_COMMAND, &env, 5000);
    let (_pid, code, stdout, stderr) = read_buffered_spawn_watch_result(&mut host_stream, 1);

    assert_eq!(code, 0, "stderr: {}", String::from_utf8_lossy(&stderr));
    assert_large_env_stdout(&stdout);

    drop(host_stream);
    let _ = handle.join();
}

/// Regression for #11077: when the host drops the vsock connection
/// mid-stream, the streaming monitor's stdout drain hits a write failure
/// on its next chunk forward, signals cancel, drops the pipe fd, and the
/// child receives SIGPIPE on its next stdout write — terminating well
/// inside the drain deadline rather than running until `JOB_TIMEOUT`.
///
/// Pre-cancel-fix this loop was preserved by an explicit `break` on write
/// failure; the refactor moved chunk handling into a closure that has no
/// way to break the helper's loop, so we re-introduce the same fast-stop
/// behavior via the cancel flag. This test pins that behavior down.
#[test]
fn streaming_terminates_child_on_vsock_disconnect() {
    use std::os::unix::net::UnixStream as StdUnixStream;
    use std::time::Instant;

    let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();
    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });
    read_and_discard_message(&mut host_stream); // MSG_READY

    // Long-running command that writes stdout every ~50 ms — gives the
    // streaming drain a chunk to forward at high frequency, so the post-
    // disconnect write failure is observed promptly.
    let log_path = unique_tmp_path("disco", ".log");
    send_spawn_watch(
        &mut host_stream,
        1,
        "while true; do echo tick; sleep 0.05; done",
        Some(log_path.as_str()),
        0, // no timeout — we want SIGPIPE, not the kill watchdog, to terminate
    );

    host_stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();

    // Read until we observe both `MSG_SPAWN_WATCH_RESULT` (for the pid)
    // and at least one `MSG_STDOUT_CHUNK` (proving the drain is live).
    let mut decoder = vsock_proto::Decoder::new();
    let mut buf = [0u8; 4096];
    let mut pid: Option<u32> = None;
    let mut got_chunk = false;
    let stream_deadline = Instant::now() + Duration::from_secs(3);
    while pid.is_none() || !got_chunk {
        assert!(
            Instant::now() < stream_deadline,
            "did not see spawn_watch_result + stdout chunk in time (pid={pid:?}, chunk={got_chunk})",
        );
        let n = read_retry_eintr(&mut host_stream, &mut buf).unwrap();
        for msg in decoder.decode(buf.get(..n).unwrap_or_default()).unwrap() {
            if msg.msg_type == MSG_SPAWN_WATCH_RESULT && msg.seq == 1 {
                pid = vsock_proto::decode_spawn_watch_result(&msg.payload).ok();
            } else if msg.msg_type == MSG_STDOUT_CHUNK {
                got_chunk = true;
            }
        }
    }
    let pid = pid.unwrap();
    assert!(
        pid_alive(pid),
        "child should still be running before disconnect"
    );

    // Disconnect: dropping host_stream closes the host end of the
    // UnixStream pair. The next chunk-forward attempt in the guest
    // returns BrokenPipe → on_chunk closure stores cancel → drain
    // breaks → ChildStdout drops → bash gets SIGPIPE on its next echo.
    drop(host_stream);
    let _ = handle.join();

    // Wait for the child to terminate. Timing budget: ≤100 ms drain
    // poll + 50 ms next echo + tear-down. 5 s deadline is generous.
    let kill_deadline = Instant::now() + Duration::from_secs(5);
    while pid_alive(pid) {
        if Instant::now() >= kill_deadline {
            // Best-effort cleanup before failing
            // SAFETY: pid was obtained from MSG_SPAWN_WATCH_RESULT.
            unsafe {
                libc::kill(pid as i32, libc::SIGKILL);
            }
            panic!("pid {pid} did not terminate within 5s after vsock disconnect");
        }
        thread::sleep(Duration::from_millis(50));
    }
}

/// Regression: a child producing > 64 KB on **both** stdout and stderr
/// concurrently must not deadlock. The kernel pipe buffer is ~64 KB; if
/// either drain were sequential (waiting for the other to finish first),
/// the second pipe would fill, the child would block on its next write,
/// and the test would hit the read timeout.
///
/// Pins down the concurrent-drain invariant for buffered `MSG_SPAWN_WATCH`.
/// The streaming path in `spawn_streaming_monitor` follows the same
/// stderr-thread-before-stdout-thread structure for the same reason.
#[test]
fn buffered_spawn_watch_concurrent_large_stdout_stderr() {
    use std::os::unix::net::UnixStream as StdUnixStream;

    let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();
    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });
    read_and_discard_message(&mut host_stream); // MSG_READY

    // Read timeout well above any reasonable runtime. If we deadlock on
    // a full pipe, the child blocks on write(), drain returns nothing,
    // and we hit this timeout — the failure mode this test guards.
    host_stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .unwrap();

    // Each pipeline produces exactly 100 KB; the two pipelines run
    // concurrently so stdout and stderr are interleaved producers.
    // 100 KB > the ~64 KB pipe buffer on Linux, so a single-threaded
    // drainer would visibly stall.
    send_spawn_watch_buffered(
        &mut host_stream,
        1,
        "{ yes A | head -c 102400; } & { yes B | head -c 102400 >&2; } & wait",
        10_000,
    );
    let (pid, code, stdout, stderr) = read_buffered_spawn_watch_result(&mut host_stream, 1);

    assert!(pid > 0);
    assert_eq!(code, 0);
    assert_eq!(
        stdout.len(),
        102_400,
        "stdout should be exactly 100 KB, got {} bytes",
        stdout.len(),
    );
    assert_eq!(
        stderr.len(),
        102_400,
        "stderr should be exactly 100 KB, got {} bytes",
        stderr.len(),
    );
    assert!(stdout.iter().all(|&b| b == b'A' || b == b'\n'));
    assert!(stderr.iter().all(|&b| b == b'B' || b == b'\n'));

    drop(host_stream);
    let _ = handle.join();
}

/// Regression for #11077 (`MSG_SPAWN_WATCH` buffered side): symmetric to
/// `streaming_monitor_drains_on_orphaned_stdout`. Pre-fix, the buffered
/// monitor used the same `wait_with_output` and hung on a leaked stdout
/// fd. Post-fix, drain threads observe the cancel flag at the deadline,
/// drop the pipe read end, and the orphan's next write returns EPIPE.
#[test]
fn buffered_spawn_watch_returns_when_orphaned_grandchild_holds_stdout() {
    use std::os::unix::net::UnixStream as StdUnixStream;
    use std::time::Instant;

    let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();
    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });

    read_and_discard_message(&mut host_stream); // MSG_READY

    host_stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .unwrap();

    let orphan = OrphanProcessGuard::new("orphan-buf-sleep");
    let command = orphan_sleep_command("orphan-buf", orphan.pid_path());
    let start = Instant::now();
    send_spawn_watch_buffered(&mut host_stream, 1, &command, 0);
    let (pid, code, stdout, _stderr) = read_buffered_spawn_watch_result(&mut host_stream, 1);
    let elapsed = start.elapsed();

    assert!(pid > 0);
    assert_eq!(code, 0);
    assert!(
        String::from_utf8_lossy(&stdout).contains("orphan-buf"),
        "expected stdout to contain 'orphan-buf', got: {:?}",
        String::from_utf8_lossy(&stdout),
    );
    assert!(
        elapsed < Duration::from_secs(DRAIN_DEADLINE_SECS + 5),
        "MSG_PROCESS_EXIT should arrive within drain deadline, took {elapsed:?}",
    );

    drop(host_stream);
    let _ = handle.join();
}
