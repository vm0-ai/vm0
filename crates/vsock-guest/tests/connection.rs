#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::io::{Read, Write};
use std::thread;
use std::time::Duration;

use vsock_guest::{handle_connection, run};
use vsock_proto::{
    self, BoundedExecCapturePolicy, BoundedExecOutput, BoundedExecOutputPolicy, BoundedExecRequest,
    BoundedExecStream, BoundedExecStreamPolicy, BoundedExecTermination, MSG_BOUNDED_EXEC,
    MSG_BOUNDED_EXEC_OUTPUT_CHUNK, MSG_BOUNDED_EXEC_RESULT, MSG_ERROR, MSG_EXEC, MSG_EXEC_RESULT,
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

/// Helper: send a MSG_EXEC via the writer half, read MSG_EXEC_RESULT from the
/// reader half, and return `(exit_code, stdout, stderr)`.
fn send_exec_and_read_result(
    writer: &mut impl std::io::Write,
    reader: &mut impl std::io::Read,
    seq: u32,
    command: &str,
    timeout_ms: u32,
) -> (i32, Vec<u8>, Vec<u8>) {
    send_exec_and_read_result_with_env(writer, reader, seq, command, timeout_ms, &[])
}

fn send_exec_and_read_result_with_env(
    writer: &mut impl std::io::Write,
    reader: &mut impl std::io::Read,
    seq: u32,
    command: &str,
    timeout_ms: u32,
    env: &[(&str, &str)],
) -> (i32, Vec<u8>, Vec<u8>) {
    let payload = vsock_proto::encode_exec(timeout_ms, command, env, false);
    let msg = vsock_proto::encode(MSG_EXEC, seq, &payload).unwrap();
    writer.write_all(&msg).unwrap();

    // Read response — first 4 bytes are length header
    let mut hdr = [0u8; 4];
    reader.read_exact(&mut hdr).unwrap();
    let body_len = u32::from_be_bytes(hdr) as usize;
    let mut body = vec![0u8; body_len];
    reader.read_exact(&mut body).unwrap();

    // Decode
    let mut full = Vec::with_capacity(4 + body_len);
    full.extend_from_slice(&hdr);
    full.extend_from_slice(&body);
    let mut decoder = vsock_proto::Decoder::new();
    let msgs = decoder.decode(&full).unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].msg_type, MSG_EXEC_RESULT);
    assert_eq!(msgs[0].seq, seq);
    vsock_proto::decode_exec_result(&msgs[0].payload)
        .map(|(code, out, err)| (code, out.to_vec(), err.to_vec()))
        .unwrap()
}

struct BoundedChunk {
    stream: BoundedExecStream,
    sequence: u32,
    chunk: Vec<u8>,
    truncated: bool,
}

struct BoundedResult {
    termination: BoundedExecTermination,
    stdout: OwnedBoundedOutput,
    stderr: OwnedBoundedOutput,
    diagnostic: Option<String>,
}

#[derive(Debug, Eq, PartialEq)]
enum OwnedBoundedOutput {
    Discarded,
    Captured { bytes: Vec<u8>, truncated: bool },
}

fn owned_output(output: BoundedExecOutput<'_>) -> OwnedBoundedOutput {
    match output {
        BoundedExecOutput::Discarded => OwnedBoundedOutput::Discarded,
        BoundedExecOutput::Captured { bytes, truncated } => OwnedBoundedOutput::Captured {
            bytes: bytes.to_vec(),
            truncated,
        },
    }
}

fn assert_captured_output(
    output: &OwnedBoundedOutput,
    expected_bytes: &[u8],
    expected_truncated: bool,
) {
    match output {
        OwnedBoundedOutput::Captured { bytes, truncated } => {
            assert_eq!(bytes, expected_bytes);
            assert_eq!(*truncated, expected_truncated);
        }
        OwnedBoundedOutput::Discarded => panic!("expected captured output"),
    }
}

fn assert_discarded_output(output: &OwnedBoundedOutput) {
    assert_eq!(*output, OwnedBoundedOutput::Discarded);
}

fn captured_bytes(output: &OwnedBoundedOutput) -> &[u8] {
    match output {
        OwnedBoundedOutput::Captured { bytes, .. } => bytes,
        OwnedBoundedOutput::Discarded => panic!("expected captured output"),
    }
}

fn bounded_request<'a>(
    command: &'a str,
    env: &'a [(&'a str, &'a str)],
    stdin: Option<&'a [u8]>,
) -> BoundedExecRequest<'a> {
    BoundedExecRequest {
        timeout_ms: 5000,
        command,
        env,
        sudo: false,
        stdin,
        stdout: capture_policy(1024 * 1024),
        stderr: capture_policy(1024 * 1024),
    }
}

fn capture_policy(limit_bytes: u32) -> BoundedExecOutputPolicy {
    BoundedExecOutputPolicy {
        capture: BoundedExecCapturePolicy::Capture { limit_bytes },
        stream: None,
    }
}

fn discard_policy() -> BoundedExecOutputPolicy {
    BoundedExecOutputPolicy {
        capture: BoundedExecCapturePolicy::Discard,
        stream: None,
    }
}

fn stream_policy(limit_bytes: u32, chunk_limit_bytes: u32) -> BoundedExecStreamPolicy {
    BoundedExecStreamPolicy {
        limit_bytes,
        chunk_limit_bytes,
    }
}

fn send_bounded_exec(stream: &mut impl std::io::Write, seq: u32, request: &BoundedExecRequest<'_>) {
    let payload = vsock_proto::encode_bounded_exec(request).unwrap();
    let msg = vsock_proto::encode(MSG_BOUNDED_EXEC, seq, &payload).unwrap();
    stream.write_all(&msg).unwrap();
}

fn read_bounded_exec_result(
    stream: &mut impl std::io::Read,
    seq: u32,
) -> (Vec<BoundedChunk>, BoundedResult) {
    let mut decoder = vsock_proto::Decoder::new();
    let mut buf = [0u8; 4096];
    let mut chunks = Vec::new();
    loop {
        let n = read_retry_eintr(stream, &mut buf).unwrap();
        assert!(n > 0, "unexpected EOF waiting for bounded exec result");
        for msg in decoder.decode(buf.get(..n).unwrap_or_default()).unwrap() {
            if msg.seq != seq {
                continue;
            }
            match msg.msg_type {
                MSG_BOUNDED_EXEC_OUTPUT_CHUNK => {
                    let decoded =
                        vsock_proto::decode_bounded_exec_output_chunk(&msg.payload).unwrap();
                    chunks.push(BoundedChunk {
                        stream: decoded.stream,
                        sequence: decoded.sequence,
                        chunk: decoded.chunk.to_vec(),
                        truncated: decoded.truncated,
                    });
                }
                MSG_BOUNDED_EXEC_RESULT => {
                    let decoded = vsock_proto::decode_bounded_exec_result(&msg.payload).unwrap();
                    return (
                        chunks,
                        BoundedResult {
                            termination: decoded.termination,
                            stdout: owned_output(decoded.stdout),
                            stderr: owned_output(decoded.stderr),
                            diagnostic: decoded.diagnostic.map(ToOwned::to_owned),
                        },
                    );
                }
                other => panic!("unexpected bounded exec response type: 0x{other:02X}"),
            }
        }
    }
}

fn start_guest_connection() -> (thread::JoinHandle<()>, std::os::unix::net::UnixStream) {
    use std::os::unix::net::UnixStream as StdUnixStream;

    let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();
    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });
    read_and_discard_message(&mut host_stream);
    host_stream
        .set_read_timeout(Some(Duration::from_secs(10)))
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

#[test]
fn bounded_exec_stdout_stderr_success() {
    let (handle, mut host_stream) = start_guest_connection();

    let request = bounded_request("printf stdout; printf stderr >&2", &[], None);
    send_bounded_exec(&mut host_stream, 11, &request);
    let (chunks, result) = read_bounded_exec_result(&mut host_stream, 11);

    assert!(chunks.is_empty());
    assert_eq!(
        result.termination,
        BoundedExecTermination::Exited { exit_code: 0 }
    );
    assert_captured_output(&result.stdout, b"stdout", false);
    assert_captured_output(&result.stderr, b"stderr", false);

    finish_guest_connection(handle, host_stream);
}

#[test]
fn bounded_exec_nonzero_exit_is_exited() {
    let (handle, mut host_stream) = start_guest_connection();

    let request = bounded_request("printf failed >&2; exit 42", &[], None);
    send_bounded_exec(&mut host_stream, 12, &request);
    let (_chunks, result) = read_bounded_exec_result(&mut host_stream, 12);

    assert_eq!(
        result.termination,
        BoundedExecTermination::Exited { exit_code: 42 }
    );
    assert_captured_output(&result.stdout, b"", false);
    assert_captured_output(&result.stderr, b"failed", false);

    finish_guest_connection(handle, host_stream);
}

#[test]
fn bounded_exec_stdin_is_written_and_closed() {
    let (handle, mut host_stream) = start_guest_connection();

    let stdin = b"hello from stdin";
    let request = bounded_request(
        "cat; read extra || printf ':eof'",
        &[],
        Some(stdin.as_slice()),
    );
    send_bounded_exec(&mut host_stream, 13, &request);
    let (_chunks, result) = read_bounded_exec_result(&mut host_stream, 13);

    assert_eq!(
        result.termination,
        BoundedExecTermination::Exited { exit_code: 0 }
    );
    assert_captured_output(&result.stdout, b"hello from stdin:eof", false);
    assert_captured_output(&result.stderr, b"", false);

    finish_guest_connection(handle, host_stream);
}

#[test]
fn bounded_exec_broken_pipe_stdin_keeps_child_exit_status() {
    let (handle, mut host_stream) = start_guest_connection();

    let stdin = vec![b'x'; 1024 * 1024];
    let request = bounded_request("exit 7", &[], Some(stdin.as_slice()));
    send_bounded_exec(&mut host_stream, 14, &request);
    let (_chunks, result) = read_bounded_exec_result(&mut host_stream, 14);

    assert_eq!(
        result.termination,
        BoundedExecTermination::Exited { exit_code: 7 }
    );

    finish_guest_connection(handle, host_stream);
}

#[test]
fn bounded_exec_stdin_writer_exits_when_grandchild_holds_stdin() {
    let orphan = OrphanProcessGuard::new("bounded-exec-stdin-orphan");
    let (handle, mut host_stream) = start_guest_connection();

    let stdin = vec![b'x'; 8 * 1024 * 1024];
    let command = format!(
        "python3 -c \"import os,signal; p=os.fork(); (os.write(os.open('{}', os.O_WRONLY|os.O_CREAT|os.O_TRUNC, 0o600), str(p).encode()), os._exit(0)) if p else (os.setsid(), os.dup2(os.open('/dev/null', os.O_WRONLY), 1), os.dup2(os.open('/dev/null', os.O_WRONLY), 2), signal.pause())\"",
        orphan.pid_path()
    );
    let request = bounded_request(&command, &[], Some(stdin.as_slice()));
    send_bounded_exec(&mut host_stream, 37, &request);
    let (_chunks, result) = read_bounded_exec_result(&mut host_stream, 37);

    assert_eq!(
        result.termination,
        BoundedExecTermination::Exited { exit_code: 0 }
    );
    let orphan_pid = read_pid_file(orphan.pid_path());
    wait_for_pid_exit(orphan_pid, "bounded exec stdin cleanup");

    finish_guest_connection(handle, host_stream);
}

#[test]
fn bounded_exec_cleans_stdin_holder_after_small_stdin_finishes() {
    let orphan = OrphanProcessGuard::new("bounded-exec-small-stdin-orphan");
    let (handle, mut host_stream) = start_guest_connection();

    let stdin = b"x";
    let command = format!(
        "python3 -c \"import os,signal; p=os.fork(); (os.write(os.open('{}', os.O_WRONLY|os.O_CREAT|os.O_TRUNC, 0o600), str(p).encode()), os._exit(0)) if p else (os.setsid(), os.dup2(os.open('/dev/null', os.O_WRONLY), 1), os.dup2(os.open('/dev/null', os.O_WRONLY), 2), signal.pause())\"",
        orphan.pid_path()
    );
    let request = bounded_request(&command, &[], Some(stdin.as_slice()));
    send_bounded_exec(&mut host_stream, 39, &request);
    let (_chunks, result) = read_bounded_exec_result(&mut host_stream, 39);

    assert_eq!(
        result.termination,
        BoundedExecTermination::Exited { exit_code: 0 }
    );
    let orphan_pid = read_pid_file(orphan.pid_path());
    wait_for_pid_exit(orphan_pid, "bounded exec small stdin cleanup");

    finish_guest_connection(handle, host_stream);
}

#[test]
fn bounded_exec_disconnect_kills_setsid_grandchild_holding_stdin() {
    let orphan = OrphanProcessGuard::new("bounded-exec-cancel-stdin-orphan");
    let (handle, mut host_stream) = start_guest_connection();

    let stdin = vec![b'x'; 8 * 1024 * 1024];
    let command = format!(
        "python3 -c \"import os,signal; p=os.fork(); (lambda fd: (os.write(fd, str(p).encode()), os.close(fd), signal.pause()))(os.open('{}', os.O_WRONLY|os.O_CREAT|os.O_TRUNC, 0o600)) if p else (os.setsid(), os.dup2(os.open('/dev/null', os.O_WRONLY), 1), os.dup2(os.open('/dev/null', os.O_WRONLY), 2), signal.pause())\"",
        orphan.pid_path()
    );
    let request = bounded_request(&command, &[], Some(stdin.as_slice()));
    send_bounded_exec(&mut host_stream, 38, &request);

    let orphan_pid = read_pid_file(orphan.pid_path());
    assert!(
        pid_alive(orphan_pid),
        "setsid grandchild should be running before disconnect"
    );

    drop(host_stream);
    let _ = handle.join();
    wait_for_pid_exit(orphan_pid, "bounded exec disconnect stdin cleanup");
}

#[test]
fn bounded_exec_streams_stdout_before_final_result() {
    let (handle, mut host_stream) = start_guest_connection();

    let mut request = bounded_request("printf login-url; printf done", &[], None);
    request.stdout.stream = Some(stream_policy(
        64,
        vsock_proto::MIN_BOUNDED_EXEC_STREAM_CHUNK_BYTES as u32,
    ));
    send_bounded_exec(&mut host_stream, 15, &request);
    let (chunks, result) = read_bounded_exec_result(&mut host_stream, 15);

    assert_eq!(
        result.termination,
        BoundedExecTermination::Exited { exit_code: 0 }
    );
    assert_captured_output(&result.stdout, b"login-urldone", false);
    assert!(
        !chunks.is_empty(),
        "expected stream chunks before final result"
    );
    let streamed = chunks
        .iter()
        .filter(|chunk| chunk.stream == BoundedExecStream::Stdout)
        .flat_map(|chunk| chunk.chunk.clone())
        .collect::<Vec<_>>();
    assert_eq!(streamed, b"login-urldone");
    assert_eq!(chunks[0].sequence, 0);
    assert!(chunks.iter().all(|chunk| !chunk.truncated));

    finish_guest_connection(handle, host_stream);
}

#[test]
fn bounded_exec_streams_stdout_and_stderr_independently() {
    let (handle, mut host_stream) = start_guest_connection();

    let mut request = bounded_request("printf out; printf err >&2", &[], None);
    request.stdout.stream = Some(stream_policy(
        1024 * 1024,
        vsock_proto::MIN_BOUNDED_EXEC_STREAM_CHUNK_BYTES as u32,
    ));
    request.stderr.stream = Some(stream_policy(
        1024 * 1024,
        vsock_proto::MIN_BOUNDED_EXEC_STREAM_CHUNK_BYTES as u32,
    ));
    send_bounded_exec(&mut host_stream, 16, &request);
    let (chunks, result) = read_bounded_exec_result(&mut host_stream, 16);

    assert_eq!(
        result.termination,
        BoundedExecTermination::Exited { exit_code: 0 }
    );
    let stdout_chunks = chunks
        .iter()
        .filter(|chunk| chunk.stream == BoundedExecStream::Stdout)
        .collect::<Vec<_>>();
    let stderr_chunks = chunks
        .iter()
        .filter(|chunk| chunk.stream == BoundedExecStream::Stderr)
        .collect::<Vec<_>>();
    assert_eq!(stdout_chunks.len(), 1);
    assert_eq!(stderr_chunks.len(), 1);
    assert_eq!(stdout_chunks[0].sequence, 0);
    assert_eq!(stderr_chunks[0].sequence, 0);
    assert_eq!(stdout_chunks[0].chunk, b"out");
    assert_eq!(stderr_chunks[0].chunk, b"err");

    finish_guest_connection(handle, host_stream);
}

#[test]
fn bounded_exec_timeout_returns_timed_out_with_partial_output() {
    let (handle, mut host_stream) = start_guest_connection();

    let mut request = bounded_request("printf before; sleep 60", &[], None);
    request.timeout_ms = 200;
    send_bounded_exec(&mut host_stream, 17, &request);
    let (_chunks, result) = read_bounded_exec_result(&mut host_stream, 17);

    assert_eq!(result.termination, BoundedExecTermination::TimedOut);
    assert_captured_output(&result.stdout, b"before", false);

    finish_guest_connection(handle, host_stream);
}

#[test]
fn bounded_exec_tracks_stdout_stderr_truncation_independently() {
    let (handle, mut host_stream) = start_guest_connection();

    let mut request = bounded_request("printf abcdefghij; printf err >&2", &[], None);
    request.stdout.capture = BoundedExecCapturePolicy::Capture { limit_bytes: 4 };
    request.stderr.capture = BoundedExecCapturePolicy::Capture { limit_bytes: 10 };
    send_bounded_exec(&mut host_stream, 18, &request);
    let (_chunks, result) = read_bounded_exec_result(&mut host_stream, 18);

    assert_eq!(
        result.termination,
        BoundedExecTermination::Exited { exit_code: 0 }
    );
    assert_captured_output(&result.stdout, b"abcd", true);
    assert_captured_output(&result.stderr, b"err", false);

    finish_guest_connection(handle, host_stream);
}

#[test]
fn bounded_exec_over_cap_output_continues_draining() {
    let (handle, mut host_stream) = start_guest_connection();

    let mut request = bounded_request(
        "head -c 200000 /dev/zero | tr '\\0' A; head -c 200000 /dev/zero | tr '\\0' B >&2",
        &[],
        None,
    );
    request.stdout.capture = BoundedExecCapturePolicy::Capture { limit_bytes: 32 };
    request.stderr.capture = BoundedExecCapturePolicy::Capture { limit_bytes: 32 };
    send_bounded_exec(&mut host_stream, 19, &request);
    let (_chunks, result) = read_bounded_exec_result(&mut host_stream, 19);

    assert_eq!(
        result.termination,
        BoundedExecTermination::Exited { exit_code: 0 }
    );
    assert_captured_output(&result.stdout, &[b'A'; 32], true);
    assert_captured_output(&result.stderr, &[b'B'; 32], true);

    finish_guest_connection(handle, host_stream);
}

#[test]
fn bounded_exec_timeout_zero_silent_child_is_cancelled_on_host_disconnect() {
    let pid_path = unique_pid_path("bounded-exec-cancel");
    let (handle, mut host_stream) = start_guest_connection();

    let command = format!("echo $$ > '{}'; sleep 60", pid_path.as_str());
    let mut request = bounded_request(&command, &[], None);
    request.timeout_ms = 0;
    send_bounded_exec(&mut host_stream, 20, &request);

    let pid = read_pid_file(pid_path.as_str());
    assert!(
        pid_alive(pid),
        "child should still be running before disconnect",
    );

    drop(host_stream);
    let _ = handle.join();
    wait_for_pid_exit(pid, "bounded exec host disconnect");
}

#[test]
fn bounded_exec_large_env_payload_succeeds() {
    let values = large_env_values();
    let env = large_env_entries(&values);
    let (handle, mut host_stream) = start_guest_connection();

    let request = bounded_request(LARGE_ENV_COMMAND, &env, None);
    send_bounded_exec(&mut host_stream, 21, &request);
    let (_chunks, result) = read_bounded_exec_result(&mut host_stream, 21);

    assert_eq!(
        result.termination,
        BoundedExecTermination::Exited { exit_code: 0 },
        "stderr: {}",
        String::from_utf8_lossy(captured_bytes(&result.stderr)),
    );
    assert_large_env_stdout(captured_bytes(&result.stdout));

    finish_guest_connection(handle, host_stream);
}

#[test]
fn bounded_exec_invalid_env_payload_returns_start_failed_without_leaking_value() {
    let (handle, mut host_stream) = start_guest_connection();

    let secret = "do-not-print-this-secret";
    let env = [("BAD;KEY", secret)];
    let request = bounded_request("echo should-not-run", &env, None);
    send_bounded_exec(&mut host_stream, 22, &request);
    let (_chunks, result) = read_bounded_exec_result(&mut host_stream, 22);
    let diagnostic = result.diagnostic.as_deref().unwrap_or_default();

    assert_eq!(result.termination, BoundedExecTermination::StartFailed);
    assert!(diagnostic.contains("invalid environment variable name"));
    assert!(!diagnostic.contains(secret));

    finish_guest_connection(handle, host_stream);
}

#[test]
fn bounded_exec_rejects_tiny_stream_chunk_limit() {
    let (handle, mut host_stream) = start_guest_connection();

    let mut request = bounded_request("echo should-not-run", &[], None);
    request.stdout.stream = Some(stream_policy(1024, 1));
    send_bounded_exec(&mut host_stream, 23, &request);
    let (chunks, result) = read_bounded_exec_result(&mut host_stream, 23);
    let diagnostic = result.diagnostic.as_deref().unwrap_or_default();

    assert!(chunks.is_empty());
    assert_eq!(result.termination, BoundedExecTermination::StartFailed);
    assert!(diagnostic.contains("stream chunk limit below minimum"));

    finish_guest_connection(handle, host_stream);
}

#[test]
fn bounded_exec_rejects_final_output_limits_that_cannot_fit_result_frame() {
    let (handle, mut host_stream) = start_guest_connection();

    let mut request = bounded_request("echo should-not-run", &[], None);
    request.stdout.capture = BoundedExecCapturePolicy::Capture {
        limit_bytes: vsock_proto::MAX_BOUNDED_EXEC_RESULT_OUTPUT_BYTES as u32,
    };
    request.stderr.capture = BoundedExecCapturePolicy::Capture { limit_bytes: 1 };
    send_bounded_exec(&mut host_stream, 24, &request);
    let (chunks, result) = read_bounded_exec_result(&mut host_stream, 24);
    let diagnostic = result.diagnostic.as_deref().unwrap_or_default();

    assert!(chunks.is_empty());
    assert_eq!(result.termination, BoundedExecTermination::StartFailed);
    assert!(diagnostic.contains("final output limits exceed protocol result frame"));

    finish_guest_connection(handle, host_stream);
}

#[test]
fn bounded_exec_zero_final_limits_return_empty_truncated_output() {
    let (handle, mut host_stream) = start_guest_connection();

    let mut request = bounded_request("printf stdout; printf stderr >&2", &[], None);
    request.stdout.capture = BoundedExecCapturePolicy::Capture { limit_bytes: 0 };
    request.stderr.capture = BoundedExecCapturePolicy::Capture { limit_bytes: 0 };
    send_bounded_exec(&mut host_stream, 25, &request);
    let (_chunks, result) = read_bounded_exec_result(&mut host_stream, 25);

    assert_eq!(
        result.termination,
        BoundedExecTermination::Exited { exit_code: 0 }
    );
    assert_captured_output(&result.stdout, b"", true);
    assert_captured_output(&result.stderr, b"", true);

    finish_guest_connection(handle, host_stream);
}

#[test]
fn bounded_exec_discarded_outputs_do_not_block_large_writes() {
    let (handle, mut host_stream) = start_guest_connection();

    let mut request = bounded_request(
        "head -c 200000 /dev/zero | tr '\\0' A; head -c 200000 /dev/zero | tr '\\0' B >&2",
        &[],
        None,
    );
    request.stdout = discard_policy();
    request.stderr = discard_policy();
    send_bounded_exec(&mut host_stream, 32, &request);
    let (chunks, result) = read_bounded_exec_result(&mut host_stream, 32);

    assert!(chunks.is_empty());
    assert_eq!(
        result.termination,
        BoundedExecTermination::Exited { exit_code: 0 }
    );
    assert_discarded_output(&result.stdout);
    assert_discarded_output(&result.stderr);

    finish_guest_connection(handle, host_stream);
}

#[test]
fn bounded_exec_can_discard_stdout_while_capturing_stderr() {
    let (handle, mut host_stream) = start_guest_connection();

    let mut request = bounded_request("printf out; printf err >&2", &[], None);
    request.stdout = discard_policy();
    request.stderr = capture_policy(16);
    send_bounded_exec(&mut host_stream, 33, &request);
    let (chunks, result) = read_bounded_exec_result(&mut host_stream, 33);

    assert!(chunks.is_empty());
    assert_eq!(
        result.termination,
        BoundedExecTermination::Exited { exit_code: 0 }
    );
    assert_discarded_output(&result.stdout);
    assert_captured_output(&result.stderr, b"err", false);

    finish_guest_connection(handle, host_stream);
}

#[test]
fn bounded_exec_can_discard_stderr_while_capturing_stdout() {
    let (handle, mut host_stream) = start_guest_connection();

    let mut request = bounded_request("printf out; printf err >&2", &[], None);
    request.stdout = capture_policy(16);
    request.stderr = discard_policy();
    send_bounded_exec(&mut host_stream, 34, &request);
    let (chunks, result) = read_bounded_exec_result(&mut host_stream, 34);

    assert!(chunks.is_empty());
    assert_eq!(
        result.termination,
        BoundedExecTermination::Exited { exit_code: 0 }
    );
    assert_captured_output(&result.stdout, b"out", false);
    assert_discarded_output(&result.stderr);

    finish_guest_connection(handle, host_stream);
}

#[test]
fn bounded_exec_stream_only_returns_discarded_final_output() {
    let (handle, mut host_stream) = start_guest_connection();

    let mut request = bounded_request("printf stream-only", &[], None);
    request.stdout = BoundedExecOutputPolicy {
        capture: BoundedExecCapturePolicy::Discard,
        stream: Some(stream_policy(
            1024,
            vsock_proto::MIN_BOUNDED_EXEC_STREAM_CHUNK_BYTES as u32,
        )),
    };
    request.stderr = discard_policy();
    send_bounded_exec(&mut host_stream, 35, &request);
    let (chunks, result) = read_bounded_exec_result(&mut host_stream, 35);

    assert_eq!(
        result.termination,
        BoundedExecTermination::Exited { exit_code: 0 }
    );
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].stream, BoundedExecStream::Stdout);
    assert_eq!(chunks[0].sequence, 0);
    assert_eq!(chunks[0].chunk, b"stream-only");
    assert!(!chunks[0].truncated);
    assert_discarded_output(&result.stdout);
    assert_discarded_output(&result.stderr);

    finish_guest_connection(handle, host_stream);
}

#[test]
fn bounded_exec_diagnostic_survives_discarded_outputs() {
    let (handle, mut host_stream) = start_guest_connection();

    let secret = "discarded-diagnostic-secret";
    let env = [("BAD;KEY", secret)];
    let mut request = bounded_request("echo should-not-run", &env, None);
    request.stdout = discard_policy();
    request.stderr = discard_policy();
    send_bounded_exec(&mut host_stream, 36, &request);
    let (chunks, result) = read_bounded_exec_result(&mut host_stream, 36);
    let diagnostic = result.diagnostic.as_deref().unwrap_or_default();

    assert!(chunks.is_empty());
    assert_eq!(result.termination, BoundedExecTermination::StartFailed);
    assert_discarded_output(&result.stdout);
    assert_discarded_output(&result.stderr);
    assert!(diagnostic.contains("invalid environment variable name"));
    assert!(!diagnostic.contains(secret));

    finish_guest_connection(handle, host_stream);
}

#[test]
fn bounded_exec_ignores_stream_limits_when_streaming_is_disabled() {
    let (handle, mut host_stream) = start_guest_connection();

    let mut request = bounded_request("printf no-stream", &[], None);
    request.stdout.stream = None;
    request.stderr.stream = None;
    send_bounded_exec(&mut host_stream, 26, &request);
    let (chunks, result) = read_bounded_exec_result(&mut host_stream, 26);

    assert!(chunks.is_empty());
    assert_eq!(
        result.termination,
        BoundedExecTermination::Exited { exit_code: 0 }
    );
    assert_captured_output(&result.stdout, b"no-stream", false);
    assert_captured_output(&result.stderr, b"", false);

    finish_guest_connection(handle, host_stream);
}

#[test]
fn bounded_exec_zero_stream_budget_emits_truncation_marker_only() {
    let (handle, mut host_stream) = start_guest_connection();

    let mut request = bounded_request("printf streamed", &[], None);
    request.stdout.stream = Some(stream_policy(
        0,
        vsock_proto::MIN_BOUNDED_EXEC_STREAM_CHUNK_BYTES as u32,
    ));
    send_bounded_exec(&mut host_stream, 27, &request);
    let (chunks, result) = read_bounded_exec_result(&mut host_stream, 27);

    assert_eq!(
        result.termination,
        BoundedExecTermination::Exited { exit_code: 0 }
    );
    assert_captured_output(&result.stdout, b"streamed", false);
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].stream, BoundedExecStream::Stdout);
    assert_eq!(chunks[0].sequence, 0);
    assert!(chunks[0].chunk.is_empty());
    assert!(chunks[0].truncated);

    finish_guest_connection(handle, host_stream);
}

#[test]
fn bounded_exec_stream_limit_emits_data_then_truncation_marker() {
    let (handle, mut host_stream) = start_guest_connection();

    let mut request = bounded_request("head -c 2500 /dev/zero | tr '\\0' S", &[], None);
    request.stdout.stream = Some(stream_policy(
        1500,
        vsock_proto::MIN_BOUNDED_EXEC_STREAM_CHUNK_BYTES as u32,
    ));
    send_bounded_exec(&mut host_stream, 28, &request);
    let (chunks, result) = read_bounded_exec_result(&mut host_stream, 28);

    assert_eq!(
        result.termination,
        BoundedExecTermination::Exited { exit_code: 0 }
    );
    assert_captured_output(&result.stdout, &vec![b'S'; 2500], false);
    assert_captured_output(&result.stderr, b"", false);

    assert!(
        chunks.len() >= 2,
        "expected streamed data and a truncation marker, got {} chunks",
        chunks.len()
    );
    for (expected_sequence, chunk) in chunks.iter().enumerate() {
        assert_eq!(chunk.stream, BoundedExecStream::Stdout);
        assert_eq!(chunk.sequence, expected_sequence as u32);
    }
    let (marker, data_chunks) = chunks.split_last().expect("chunks are not empty");
    assert!(marker.truncated);
    assert!(marker.chunk.is_empty());
    assert!(data_chunks.iter().all(|chunk| !chunk.truncated));
    assert!(data_chunks.iter().all(|chunk| !chunk.chunk.is_empty()));
    let max_stream_chunk_len = vsock_proto::MIN_BOUNDED_EXEC_STREAM_CHUNK_BYTES;
    assert!(
        data_chunks
            .iter()
            .all(|chunk| chunk.chunk.len() <= max_stream_chunk_len)
    );
    let streamed = data_chunks
        .iter()
        .flat_map(|chunk| chunk.chunk.iter().copied())
        .collect::<Vec<_>>();
    assert_eq!(streamed, vec![b'S'; 1500]);

    finish_guest_connection(handle, host_stream);
}

#[test]
fn bounded_exec_rejects_stream_chunk_limit_that_cannot_fit_frame() {
    let (handle, mut host_stream) = start_guest_connection();

    let mut request = bounded_request("echo should-not-run", &[], None);
    request.stdout.stream = Some(stream_policy(
        1024,
        (vsock_proto::MAX_BOUNDED_EXEC_OUTPUT_CHUNK_BYTES + 1) as u32,
    ));
    send_bounded_exec(&mut host_stream, 29, &request);
    let (chunks, result) = read_bounded_exec_result(&mut host_stream, 29);
    let diagnostic = result.diagnostic.as_deref().unwrap_or_default();

    assert!(chunks.is_empty());
    assert_eq!(result.termination, BoundedExecTermination::StartFailed);
    assert!(diagnostic.contains("stream chunk limit exceeds protocol frame"));

    finish_guest_connection(handle, host_stream);
}

#[test]
fn bounded_exec_slow_request_does_not_block_fast_request() {
    let (handle, mut host_stream) = start_guest_connection();

    let mut slow_request = bounded_request("sleep 60", &[], None);
    slow_request.timeout_ms = 0;
    let fast_request = bounded_request("printf fast", &[], None);

    send_bounded_exec(&mut host_stream, 30, &slow_request);
    send_bounded_exec(&mut host_stream, 31, &fast_request);
    let (_chunks, result) = read_bounded_exec_result(&mut host_stream, 31);

    assert_eq!(
        result.termination,
        BoundedExecTermination::Exited { exit_code: 0 }
    );
    assert_captured_output(&result.stdout, b"fast", false);
    assert_captured_output(&result.stderr, b"", false);

    finish_guest_connection(handle, host_stream);
}

/// Verify that a slow exec does not block a fast exec that arrives later.
/// This is the core regression test for the non-blocking exec fix.
#[test]
fn slow_exec_does_not_block_fast_exec() {
    use std::os::unix::net::UnixStream as StdUnixStream;

    let slow_pid_path = unique_pid_path("slow-exec");
    let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();

    // Run handle_connection in a background thread (it blocks on read)
    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });

    // Read and discard the MSG_READY sent by handle_connection
    let mut hdr = [0u8; 4];
    host_stream.read_exact(&mut hdr).unwrap();
    let body_len = u32::from_be_bytes(hdr) as usize;
    let mut body = vec![0u8; body_len];
    host_stream.read_exact(&mut body).unwrap();

    // Send a slow exec and wait until its child shell has actually started.
    // This keeps the ordering deterministic without a fixed timing delay.
    let slow_command = format!("echo $$ > '{}'; sleep 5", slow_pid_path.as_str());
    let slow_payload = vsock_proto::encode_exec(5000, &slow_command, &[], false);
    let slow_msg = vsock_proto::encode(MSG_EXEC, 1, &slow_payload).unwrap();
    host_stream.write_all(&slow_msg).unwrap();

    let slow_pid = read_pid_file(slow_pid_path.as_str());
    assert!(
        pid_alive(slow_pid),
        "slow exec should still be running before fast exec"
    );

    // Send a fast exec — this should return quickly despite the slow one
    let fast_payload = vsock_proto::encode_exec(5000, "echo ok", &[], false);
    let fast_msg = vsock_proto::encode(MSG_EXEC, 2, &fast_payload).unwrap();
    host_stream.write_all(&fast_msg).unwrap();

    // Read responses — we need to find seq=2 (the fast one) within 3 seconds.
    // Before the fix, this would block on the slow exec.
    host_stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();

    let mut decoder = vsock_proto::Decoder::new();
    let mut found_fast = false;
    let deadline = std::time::Instant::now() + Duration::from_secs(3);

    while std::time::Instant::now() < deadline {
        let mut buf = [0u8; 4096];
        match host_stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                for msg in decoder.decode(buf.get(..n).unwrap_or_default()).unwrap() {
                    if msg.seq == 2 && msg.msg_type == MSG_EXEC_RESULT {
                        let (code, stdout, _) =
                            vsock_proto::decode_exec_result(&msg.payload).unwrap();
                        assert_eq!(code, 0);
                        assert_eq!(String::from_utf8_lossy(stdout).trim(), "ok");
                        found_fast = true;
                    }
                }
                if found_fast {
                    break;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
            Err(e) => panic!("read error: {e}"),
        }
    }

    assert!(
        found_fast,
        "fast exec (seq=2) should complete while slow exec is still running"
    );

    // Shut down: drop the stream so handle_connection sees EOF
    drop(host_stream);
    let _ = handle.join();
}

/// Verify that a normal exec still returns correct results.
#[test]
fn exec_returns_correct_result() {
    use std::os::unix::net::UnixStream as StdUnixStream;

    let (guest_stream, host_stream) = StdUnixStream::pair().unwrap();
    let mut host_writer = host_stream.try_clone().unwrap();
    let mut host_reader = host_stream;

    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });

    // Discard MSG_READY
    let mut hdr = [0u8; 4];
    host_reader.read_exact(&mut hdr).unwrap();
    let body_len = u32::from_be_bytes(hdr) as usize;
    let mut body = vec![0u8; body_len];
    host_reader.read_exact(&mut body).unwrap();

    host_reader
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();

    let (code, stdout, _stderr) =
        send_exec_and_read_result(&mut host_writer, &mut host_reader, 1, "echo hello", 5000);
    assert_eq!(code, 0);
    assert_eq!(String::from_utf8_lossy(&stdout).trim(), "hello");

    drop(host_writer);
    drop(host_reader);
    let _ = handle.join();
}

#[test]
fn exec_large_env_payload_succeeds() {
    use std::os::unix::net::UnixStream as StdUnixStream;

    let values = large_env_values();
    let env = large_env_entries(&values);

    let (guest_stream, host_stream) = StdUnixStream::pair().unwrap();
    let mut host_writer = host_stream.try_clone().unwrap();
    let mut host_reader = host_stream;

    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });
    read_and_discard_message(&mut host_reader); // MSG_READY
    host_reader
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();

    let (code, stdout, stderr) = send_exec_and_read_result_with_env(
        &mut host_writer,
        &mut host_reader,
        1,
        LARGE_ENV_COMMAND,
        5000,
        &env,
    );

    assert_eq!(code, 0, "stderr: {}", String::from_utf8_lossy(&stderr));
    assert_large_env_stdout(&stdout);

    drop(host_writer);
    drop(host_reader);
    let _ = handle.join();
}

#[test]
fn exec_invalid_env_payload_returns_error_without_leaking_value() {
    use std::os::unix::net::UnixStream as StdUnixStream;

    let (guest_stream, host_stream) = StdUnixStream::pair().unwrap();
    let mut host_writer = host_stream.try_clone().unwrap();
    let mut host_reader = host_stream;

    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });
    read_and_discard_message(&mut host_reader); // MSG_READY
    host_reader
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();

    let secret = "do-not-print-this-secret";
    let (code, stdout, stderr) = send_exec_and_read_result_with_env(
        &mut host_writer,
        &mut host_reader,
        1,
        "echo should-not-run",
        5000,
        &[("BAD;KEY", secret)],
    );
    let stderr = String::from_utf8_lossy(&stderr);

    assert_eq!(code, 1);
    assert!(stdout.is_empty());
    assert!(stderr.contains("invalid environment variable name"));
    assert!(!stderr.contains(secret));

    drop(host_writer);
    drop(host_reader);
    let _ = handle.join();
}

/// Buffered exec killed by timeout returns exit code 124.
#[test]
fn exec_timeout_returns_124() {
    use std::os::unix::net::UnixStream as StdUnixStream;

    let (guest_stream, host_stream) = StdUnixStream::pair().unwrap();
    let mut host_writer = host_stream.try_clone().unwrap();
    let mut host_reader = host_stream;

    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });

    // Discard MSG_READY
    let mut hdr = [0u8; 4];
    host_reader.read_exact(&mut hdr).unwrap();
    let body_len = u32::from_be_bytes(hdr) as usize;
    let mut body = vec![0u8; body_len];
    host_reader.read_exact(&mut body).unwrap();

    host_reader
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();

    // sleep 60 with a 500ms timeout → killed by timeout
    let (code, _stdout, stderr) =
        send_exec_and_read_result(&mut host_writer, &mut host_reader, 1, "sleep 60", 500);
    assert_eq!(code, EXIT_CODE_TIMEOUT);
    assert_eq!(String::from_utf8_lossy(&stderr), "Timeout");

    drop(host_writer);
    drop(host_reader);
    let _ = handle.join();
}

/// Regression for #9701: `timeout_ms == 0` must mean "no timeout", not
/// "kill immediately". Before the fix, `wait_with_timeout` built a
/// `Duration::ZERO` and the killer thread fired on the first tick,
/// returning exit 124 ("Timeout") for any command.
#[test]
fn exec_timeout_zero_means_no_timeout() {
    use std::os::unix::net::UnixStream as StdUnixStream;

    let (guest_stream, host_stream) = StdUnixStream::pair().unwrap();
    let mut host_writer = host_stream.try_clone().unwrap();
    let mut host_reader = host_stream;

    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });

    // Discard MSG_READY
    let mut hdr = [0u8; 4];
    host_reader.read_exact(&mut hdr).unwrap();
    let body_len = u32::from_be_bytes(hdr) as usize;
    let mut body = vec![0u8; body_len];
    host_reader.read_exact(&mut body).unwrap();

    host_reader
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();

    let (code, stdout, stderr) =
        send_exec_and_read_result(&mut host_writer, &mut host_reader, 1, "echo hello", 0);
    assert_eq!(code, 0);
    assert_eq!(String::from_utf8_lossy(&stdout), "hello\n");
    assert_eq!(stderr, b"");

    drop(host_writer);
    drop(host_reader);
    let _ = handle.join();
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
        if let Some(pid) = try_read_pid_file(path) {
            return pid;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "pid file {path} was not created",
        );
        if wait_for_pid_file_change(path, deadline).unwrap_or(false) {
            continue;
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn try_read_pid_file(path: &str) -> Option<u32> {
    match std::fs::read_to_string(path) {
        Ok(contents) => contents.trim().parse().ok(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => panic!("failed to read pid file {path}: {e}"),
    }
}

#[cfg(target_os = "linux")]
fn wait_for_pid_file_change(path: &str, deadline: std::time::Instant) -> std::io::Result<bool> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    let path = Path::new(path);
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let parent_c = CString::new(parent.as_os_str().as_bytes())?;

    // SAFETY: inotify_init1 has no preconditions; the returned fd is checked.
    let fd = unsafe { libc::inotify_init1(libc::IN_CLOEXEC) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }

    struct FdGuard(libc::c_int);
    impl Drop for FdGuard {
        fn drop(&mut self) {
            // SAFETY: the fd is owned by this guard.
            unsafe {
                libc::close(self.0);
            }
        }
    }
    let fd = FdGuard(fd);

    let mask = libc::IN_CREATE | libc::IN_CLOSE_WRITE | libc::IN_MODIFY | libc::IN_MOVED_TO;
    // SAFETY: parent_c is a valid nul-terminated path and fd is an inotify fd.
    let wd = unsafe { libc::inotify_add_watch(fd.0, parent_c.as_ptr(), mask) };
    if wd < 0 {
        return Err(std::io::Error::last_os_error());
    }

    if try_read_pid_file(path.to_string_lossy().as_ref()).is_some() {
        return Ok(true);
    }

    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Ok(false);
        }
        let timeout_ms = remaining.as_millis().clamp(1, libc::c_int::MAX as u128) as libc::c_int;
        let mut pfd = libc::pollfd {
            fd: fd.0,
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: pfd points to one initialized pollfd and timeout_ms is bounded.
        let ret = unsafe { libc::poll(&mut pfd, 1, timeout_ms) };
        if ret < 0 {
            let err = std::io::Error::last_os_error();
            if err.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(err);
        }
        if ret == 0 {
            return Ok(false);
        }

        let mut buf = [0u8; 4096];
        // SAFETY: buf is valid writable memory and fd is readable after poll.
        let _ = unsafe { libc::read(fd.0, buf.as_mut_ptr().cast(), buf.len()) };
        return Ok(true);
    }
}

#[cfg(not(target_os = "linux"))]
fn wait_for_pid_file_change(_path: &str, _deadline: std::time::Instant) -> std::io::Result<bool> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "inotify is linux-only",
    ))
}

fn kill_pid_group(pid: u32) {
    // SAFETY: best-effort cleanup for a pid produced by a test child process.
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

fn wait_for_pid_exit(pid: u32, context: &str) {
    if !pid_alive(pid) {
        return;
    }

    if let Ok(exited) = wait_for_pid_exit_with_pidfd(pid, Duration::from_secs(5)) {
        if exited {
            return;
        }
        kill_pid_group(pid);
        panic!("pid {pid} did not terminate within 5s after {context}");
    }

    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while pid_alive(pid) {
        if std::time::Instant::now() >= deadline {
            kill_pid_group(pid);
            panic!("pid {pid} did not terminate within 5s after {context}");
        }
        thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(target_os = "linux")]
fn wait_for_pid_exit_with_pidfd(pid: u32, timeout: Duration) -> std::io::Result<bool> {
    // SAFETY: pidfd_open is called with a pid produced by this test and flags=0.
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0) };
    if fd < 0 {
        let err = std::io::Error::last_os_error();
        if !pid_alive(pid) {
            return Ok(true);
        }
        return Err(err);
    }

    struct FdGuard(libc::c_int);
    impl Drop for FdGuard {
        fn drop(&mut self) {
            // SAFETY: the fd is owned by this guard.
            unsafe {
                libc::close(self.0);
            }
        }
    }

    let pidfd = FdGuard(fd as libc::c_int);
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if !pid_alive(pid) {
            return Ok(true);
        }

        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Ok(false);
        }
        let timeout_ms = remaining.as_millis().clamp(1, libc::c_int::MAX as u128) as libc::c_int;
        let mut pfd = libc::pollfd {
            fd: pidfd.0,
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: pfd points to one initialized pollfd and timeout_ms is bounded.
        let ret = unsafe { libc::poll(&mut pfd, 1, timeout_ms) };
        if ret < 0 {
            let err = std::io::Error::last_os_error();
            if err.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(err);
        }
        if ret == 0 {
            return Ok(!pid_alive(pid));
        }
        if pfd.revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 {
            return Ok(true);
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn wait_for_pid_exit_with_pidfd(_pid: u32, _timeout: Duration) -> std::io::Result<bool> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "pidfd is linux-only",
    ))
}

/// Regression for #11077 (`MSG_EXEC` side): with `timeout_ms = 0`, a
/// backgrounded grandchild that inherits the stdout fd must NOT keep
/// `MSG_EXEC_RESULT` from arriving after the foreground shell exits.
/// Pre-fix, `wait_with_output` blocked on stdout EOF and waited the full
/// ~30 s for the orphaned `sleep` to release the fd. Post-fix, the
/// drain thread cancels at the deadline (well below 30 s) and we return.
#[test]
fn exec_returns_when_orphaned_grandchild_holds_stdout() {
    use std::os::unix::net::UnixStream as StdUnixStream;
    use std::time::Instant;

    let (guest_stream, host_stream) = StdUnixStream::pair().unwrap();
    let mut host_writer = host_stream.try_clone().unwrap();
    let mut host_reader = host_stream;

    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });

    read_and_discard_message(&mut host_reader); // MSG_READY

    host_reader
        .set_read_timeout(Some(Duration::from_secs(15)))
        .unwrap();

    let orphan = OrphanProcessGuard::new("orphan-exec-sleep");
    let command = orphan_sleep_command("orphan-exec", orphan.pid_path());
    let start = Instant::now();
    let (code, stdout, _stderr) =
        send_exec_and_read_result(&mut host_writer, &mut host_reader, 1, &command, 0);
    let elapsed = start.elapsed();

    assert_eq!(code, 0);
    assert!(
        String::from_utf8_lossy(&stdout).contains("orphan-exec"),
        "expected stdout to contain 'orphan-exec', got: {:?}",
        String::from_utf8_lossy(&stdout),
    );
    assert!(
        elapsed < Duration::from_secs(DRAIN_DEADLINE_SECS + 5),
        "MSG_EXEC_RESULT should arrive within drain deadline, took {elapsed:?}",
    );

    drop(host_writer);
    drop(host_reader);
    let _ = handle.join();
}

/// Output written by an inherited-fd grandchild within the drain deadline must
/// still be included after the foreground shell exits.
#[test]
fn exec_captures_grandchild_output_before_drain_deadline() {
    use std::os::unix::net::UnixStream as StdUnixStream;
    use std::time::Instant;

    let (guest_stream, host_stream) = StdUnixStream::pair().unwrap();
    let mut host_writer = host_stream.try_clone().unwrap();
    let mut host_reader = host_stream;

    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });

    read_and_discard_message(&mut host_reader); // MSG_READY
    host_reader
        .set_read_timeout(Some(Duration::from_secs(8)))
        .unwrap();

    let start = Instant::now();
    let (code, stdout, stderr) = send_exec_and_read_result(
        &mut host_writer,
        &mut host_reader,
        1,
        "echo stdout-early; echo stderr-early >&2; { sleep 1; echo stdout-late; echo stderr-late >&2; } &",
        0,
    );
    let elapsed = start.elapsed();

    assert_eq!(code, 0);
    assert_eq!(
        String::from_utf8_lossy(&stdout),
        "stdout-early\nstdout-late\n"
    );
    assert_eq!(
        String::from_utf8_lossy(&stderr),
        "stderr-early\nstderr-late\n"
    );
    assert!(
        elapsed < Duration::from_secs(DRAIN_DEADLINE_SECS),
        "late output should be captured before drain deadline, took {elapsed:?}",
    );

    drop(host_writer);
    drop(host_reader);
    let _ = handle.join();
}

/// Returns true iff `pid` is still running. Zombies have already terminated
/// and may remain visible until PID 1 reaps them, so they are treated as not
/// alive for cleanup assertions.
fn pid_alive(pid: u32) -> bool {
    if let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        let state = stat
            .rfind(')')
            .and_then(|close| stat.get(close + 2..))
            .and_then(|fields| fields.split_whitespace().next());
        if state == Some("Z") {
            return false;
        }
    }
    // SAFETY: `kill` with sig=0 is a no-op existence check.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[test]
fn exec_timeout_zero_silent_child_is_cancelled_on_host_disconnect() {
    use std::os::unix::net::UnixStream as StdUnixStream;

    let pid_path = unique_pid_path("exec-cancel");

    let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();
    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });
    read_and_discard_message(&mut host_stream); // MSG_READY

    let payload = vsock_proto::encode_exec(
        0,
        &format!("echo $$ > '{}'; sleep 60", pid_path.as_str()),
        &[],
        false,
    );
    let msg = vsock_proto::encode(MSG_EXEC, 1, &payload).unwrap();
    host_stream.write_all(&msg).unwrap();

    let pid = read_pid_file(pid_path.as_str());
    assert!(
        pid_alive(pid),
        "child should still be running before disconnect",
    );

    drop(host_stream);
    let _ = handle.join();
    wait_for_pid_exit(pid, "exec host disconnect");
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

    wait_for_pid_exit(pid, "vsock disconnect");
}

/// Regression: a child producing > 64 KB on **both** stdout and stderr
/// concurrently must not deadlock. The kernel pipe buffer is ~64 KB; if
/// either drain were sequential (waiting for the other to finish first),
/// the second pipe would fill, the child would block on its next write,
/// and the test would hit the read timeout.
///
/// Pins down the concurrent-drain invariant shared by `MSG_EXEC` and buffered
/// `MSG_SPAWN_WATCH`. The streaming path in `spawn_streaming_monitor` follows
/// the same
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
