use std::thread;
use std::time::Duration;

use vsock_guest::handle_connection;
use vsock_proto::{self, MSG_ERROR, MSG_PROCESS_EXIT, MSG_SPAWN_PROCESS_RESULT, MSG_STDOUT_CHUNK};

use super::support::*;

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
    send_spawn_process(
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
fn streaming_spawn_process_large_env_payload_succeeds() {
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

    send_spawn_process_with_env(&mut host_stream, 1, LARGE_ENV_COMMAND, &env, None, 5000);
    let (_pid, stdout_data, exit_code, stderr) = read_streaming_result(&mut host_stream, 1);

    assert_eq!(exit_code, 0, "stderr: {}", String::from_utf8_lossy(&stderr));
    assert_large_env_stdout(&stdout_data);

    drop(host_stream);
    let _ = handle.join();
}

#[test]
fn streaming_spawn_process_invalid_env_payload_returns_error_without_leaking_value() {
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
    send_spawn_process_with_env(
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
    send_spawn_process(&mut host_stream, 1, "printf clean-exit", None, 60_000);
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

/// `MSG_SPAWN_PROCESS_RESULT` must arrive before stdout chunks for that request.
/// The host records the pid from the result and rejects lifecycle frames for
/// that request until the pid is known.
#[test]
fn streaming_spawn_process_result_precedes_stdout_chunks() {
    use std::os::unix::net::UnixStream as StdUnixStream;
    use std::time::Instant;

    let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();
    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });

    read_and_discard_message(&mut host_stream);
    send_spawn_process(&mut host_stream, 1, "printf ordered-output", None, 5000);

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
            "unexpected EOF waiting for streaming spawn_process result"
        );

        for msg in decoder.decode(buf.get(..n).unwrap_or_default()).unwrap() {
            if msg.msg_type == MSG_SPAWN_PROCESS_RESULT && msg.seq == 1 {
                assert!(pid.is_none(), "duplicate spawn_process_result");
                pid = Some(vsock_proto::decode_spawn_process_result(&msg.payload).unwrap());
                continue;
            }

            if msg.msg_type == MSG_STDOUT_CHUNK && msg.seq == 1 {
                let Some(p) = pid else {
                    panic!("stdout chunk arrived before spawn_process_result");
                };
                let (chunk_pid, data) = vsock_proto::decode_stdout_chunk(&msg.payload).unwrap();
                if chunk_pid == p {
                    stdout_data.extend_from_slice(data);
                }
            } else if msg.msg_type == MSG_PROCESS_EXIT && msg.seq == 1 {
                let Some(p) = pid else {
                    panic!("process_exit arrived before spawn_process_result");
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
    send_spawn_process(&mut host_stream, 1, "echo stream-only", None, 5000);

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
    send_spawn_process(
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
    send_spawn_process(
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

#[test]
fn spawn_process_timeout_zero_silent_child_is_cancelled_on_host_disconnect() {
    use std::os::unix::net::UnixStream as StdUnixStream;

    let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();
    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });
    read_and_discard_message(&mut host_stream); // MSG_READY

    send_spawn_process(&mut host_stream, 1, "sleep 60", None, 0);
    host_stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let pid = read_spawn_process_pid(&mut host_stream, 1);
    assert!(
        pid_alive(pid),
        "child should still be running before disconnect",
    );

    drop(host_stream);
    let _ = handle.join();
    wait_for_pid_exit(pid, "spawn_process host disconnect");
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
    send_spawn_process(
        &mut host_stream,
        1,
        "while true; do echo tick; sleep 0.05; done",
        Some(log_path.as_str()),
        0, // no timeout — we want SIGPIPE, not the kill watchdog, to terminate
    );

    host_stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();

    // Read until we observe both `MSG_SPAWN_PROCESS_RESULT` (for the pid)
    // and at least one `MSG_STDOUT_CHUNK` (proving the drain is live).
    let mut decoder = vsock_proto::Decoder::new();
    let mut buf = [0u8; 4096];
    let mut pid: Option<u32> = None;
    let mut got_chunk = false;
    let stream_deadline = Instant::now() + Duration::from_secs(3);
    while pid.is_none() || !got_chunk {
        assert!(
            Instant::now() < stream_deadline,
            "did not see spawn_process_result + stdout chunk in time (pid={pid:?}, chunk={got_chunk})",
        );
        let n = read_retry_eintr(&mut host_stream, &mut buf).unwrap();
        for msg in decoder.decode(buf.get(..n).unwrap_or_default()).unwrap() {
            if msg.msg_type == MSG_SPAWN_PROCESS_RESULT && msg.seq == 1 {
                pid = vsock_proto::decode_spawn_process_result(&msg.payload).ok();
            } else if msg.msg_type == MSG_STDOUT_CHUNK && msg.seq == 1 {
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
            // SAFETY: pid was obtained from MSG_SPAWN_PROCESS_RESULT.
            unsafe {
                libc::kill(pid as i32, libc::SIGKILL);
            }
            panic!("pid {pid} did not terminate within 5s after vsock disconnect");
        }
        thread::sleep(Duration::from_millis(50));
    }
}
