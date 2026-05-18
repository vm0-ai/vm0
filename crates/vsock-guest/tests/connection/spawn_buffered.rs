use std::thread;
use std::time::Duration;

use vsock_guest::handle_connection;
use vsock_proto::{
    self, MSG_ERROR, MSG_OPERATIONS_QUIESCED, MSG_OPERATIONS_RESUMED, MSG_PROCESS_EXIT,
};

use super::support::*;

#[test]
fn spawn_process_remains_pending_after_spawn_result_until_process_exit() {
    let (handle, mut host_stream) = start_guest_connection();

    send_spawn_process_buffered(&mut host_stream, 231, "sleep 60", 0);
    let pid = read_spawn_process_pid(&mut host_stream, 231);

    send_quiesce_operations(&mut host_stream, 232);
    let busy = read_message(&mut host_stream);
    assert_eq!(busy.msg_type, MSG_ERROR);
    assert_eq!(busy.seq, 232);
    assert!(
        vsock_proto::decode_error(&busy.payload)
            .unwrap()
            .contains("guest operations still pending: 1")
    );

    kill_pid_group(pid);
    let exit = read_message(&mut host_stream);
    assert_eq!(exit.msg_type, MSG_PROCESS_EXIT);
    assert_eq!(exit.seq, 231);
    let (exit_pid, _code, _stdout, _stderr) =
        vsock_proto::decode_process_exit(&exit.payload).unwrap();
    assert_eq!(exit_pid, pid);

    send_quiesce_operations(&mut host_stream, 233);
    let quiesced = read_message(&mut host_stream);
    assert_eq!(quiesced.msg_type, MSG_OPERATIONS_QUIESCED);
    assert_eq!(quiesced.seq, 233);

    send_resume_operations(&mut host_stream, 234);
    let resumed = read_message(&mut host_stream);
    assert_eq!(resumed.msg_type, MSG_OPERATIONS_RESUMED);

    finish_guest_connection(handle, host_stream);
}

#[test]
fn spawn_process_buffered_timeout_zero_silent_child_is_cancelled_on_host_disconnect() {
    use std::os::unix::net::UnixStream as StdUnixStream;

    let (guest_stream, mut host_stream) = StdUnixStream::pair().unwrap();
    let handle = thread::spawn(move || {
        let _ = handle_connection(guest_stream);
    });
    read_and_discard_message(&mut host_stream); // MSG_READY

    send_spawn_process_buffered(&mut host_stream, 1, "sleep 60", 0);
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
    wait_for_pid_exit(pid, "buffered spawn_process host disconnect");
}

#[test]
fn buffered_spawn_process_large_env_payload_succeeds() {
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

    send_spawn_process_buffered_with_env(&mut host_stream, 1, LARGE_ENV_COMMAND, &env, 5000);
    let (_pid, code, stdout, stderr) = read_buffered_spawn_process_result(&mut host_stream, 1);

    assert_eq!(code, 0, "stderr: {}", String::from_utf8_lossy(&stderr));
    assert_large_env_stdout(&stdout);

    drop(host_stream);
    let _ = handle.join();
}

/// Regression: a child producing > 64 KB on **both** stdout and stderr
/// concurrently must not deadlock. The kernel pipe buffer is ~64 KB; if
/// either drain were sequential (waiting for the other to finish first),
/// the second pipe would fill, the child would block on its next write,
/// and the test would hit the read timeout.
///
/// Pins down the concurrent-drain invariant for buffered `MSG_SPAWN_PROCESS`.
/// The streaming path in `spawn_streaming_monitor` follows the same
/// stderr-thread-before-stdout-thread structure for the same reason.
#[test]
fn buffered_spawn_process_concurrent_large_stdout_stderr() {
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
    send_spawn_process_buffered(
        &mut host_stream,
        1,
        "{ yes A | head -c 102400; } & { yes B | head -c 102400 >&2; } & wait",
        10_000,
    );
    let (pid, code, stdout, stderr) = read_buffered_spawn_process_result(&mut host_stream, 1);

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

/// Regression for #11077 (`MSG_SPAWN_PROCESS` buffered side): symmetric to
/// `streaming_monitor_drains_on_orphaned_stdout`. Pre-fix, the buffered
/// monitor used the same `wait_with_output` and hung on a leaked stdout
/// fd. Post-fix, drain threads observe the cancel flag at the deadline,
/// drop the pipe read end, and the orphan's next write returns EPIPE.
#[test]
fn buffered_spawn_process_returns_when_orphaned_grandchild_holds_stdout() {
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
    send_spawn_process_buffered(&mut host_stream, 1, &command, 0);
    let (pid, code, stdout, _stderr) = read_buffered_spawn_process_result(&mut host_stream, 1);
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
