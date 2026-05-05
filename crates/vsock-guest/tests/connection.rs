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
    self, MSG_EXEC, MSG_EXEC_RESULT, MSG_PROCESS_EXIT, MSG_SHUTDOWN, MSG_SHUTDOWN_ACK,
    MSG_SPAWN_WATCH, MSG_SPAWN_WATCH_RESULT, MSG_STDOUT_CHUNK,
};

const EXIT_CODE_TIMEOUT: i32 = 124;
const DRAIN_DEADLINE_SECS: u64 = 5;

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
    let payload = vsock_proto::encode_exec(timeout_ms, command, &[], false);
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

/// Verify that a slow exec does not block a fast exec that arrives later.
/// This is the core regression test for the non-blocking exec fix.
#[test]
fn slow_exec_does_not_block_fast_exec() {
    use std::os::unix::net::UnixStream as StdUnixStream;

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

    // Send a slow exec (sleep 5) — we won't wait for its result
    let slow_payload = vsock_proto::encode_exec(5000, "sleep 5", &[], false);
    let slow_msg = vsock_proto::encode(MSG_EXEC, 1, &slow_payload).unwrap();
    host_stream.write_all(&slow_msg).unwrap();

    // Give it a moment to start processing
    thread::sleep(Duration::from_millis(100));

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
    let payload =
        vsock_proto::encode_spawn_watch(timeout_ms, command, &[], false, true, log_path).unwrap();
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
    let payload =
        vsock_proto::encode_spawn_watch(timeout_ms, command, &[], false, false, None).unwrap();
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
