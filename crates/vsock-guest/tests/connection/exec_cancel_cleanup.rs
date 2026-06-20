use std::time::Duration;

use vsock_proto::{
    self, ExecControlPolicy, ExecOutputPolicy, ExecOutputStream, ExecTermination,
    ExecTimeoutPolicy, MSG_ERROR, MSG_EXEC_CANCEL,
};

use super::exec_helpers::{read_exec_started, send_supervised_exec_start};
use super::support::*;

#[test]
fn supervised_exec_none_timeout_runs_until_cancelled() {
    let pid_path = unique_pid_path("supervised-exec-cancel");
    let mut child_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (handle, mut host_stream) = start_guest_connection();

    let command = format!("echo $$ > '{}'; sleep 60", pid_path.as_str());
    send_supervised_exec_start(
        &mut host_stream,
        205,
        &command,
        ExecTimeoutPolicy::None,
        ExecOutputPolicy::Discard,
        ExecControlPolicy::Disabled,
    );
    assert!(read_exec_started(&mut host_stream, 205) > 0);
    let pid = child_guard.read_pid();
    assert!(
        pid_alive(pid),
        "supervised exec child should be running before cancel"
    );

    send_exec_cancel(&mut host_stream, 205);
    let (_chunks, result) = read_exec_result(&mut host_stream, 205);
    assert_eq!(result.termination, ExecTermination::Cancelled);
    assert_eq!(result.stdout, None);
    wait_for_pid_exit(pid, "supervised exec explicit cancel");
    child_guard.disarm();

    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_stream_disconnect_cancels_child() {
    let pid_path = unique_pid_path("exec-operation-stream-disconnect");
    let fifo_path = unique_tmp_path("exec-operation-stream-disconnect", ".fifo");
    let mut child_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (handle, mut host_stream) = start_guest_connection();

    let command = format!(
        "mkfifo '{}'; echo $$ > '{}'; printf tick; read _ < '{}'",
        fifo_path.as_str(),
        pid_path.as_str(),
        fifo_path.as_str()
    );
    send_exec_start(
        &mut host_stream,
        117,
        &command,
        LONG_RUNNING_EXEC_TIMEOUT_MS,
        ExecOutputPolicy::Stream {
            limit_bytes: 1024 * 1024,
            chunk_limit_bytes: 16,
        },
        ExecOutputPolicy::Discard,
    );
    let pid = child_guard.read_pid();
    let chunk = read_exec_output_chunk(&mut host_stream, 117);
    assert_eq!(chunk.stream, ExecOutputStream::Stdout);
    assert!(!chunk.chunk.is_empty());
    assert!(
        pid_alive(pid),
        "exec operation child should be running before disconnect"
    );

    drop(host_stream);
    let _ = handle.join();
    wait_for_pid_exit(pid, "exec operation stream host disconnect");
    child_guard.disarm();
}

#[test]
fn exec_operation_explicit_cancel_kills_child_and_returns_cancelled() {
    let pid_path = unique_pid_path("exec-operation-cancel");
    let mut child_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (handle, mut host_stream) = start_guest_connection();

    let command = format!("echo $$ > '{}'; sleep 60", pid_path.as_str());
    send_exec_start(
        &mut host_stream,
        111,
        &command,
        LONG_RUNNING_EXEC_TIMEOUT_MS,
        ExecOutputPolicy::Capture { limit_bytes: 64 },
        ExecOutputPolicy::Capture { limit_bytes: 64 },
    );
    let pid = child_guard.read_pid();
    assert!(
        pid_alive(pid),
        "exec operation child should be running before cancel"
    );

    send_exec_cancel(&mut host_stream, 111);
    let (_chunks, result) = read_exec_result(&mut host_stream, 111);

    assert_eq!(result.termination, ExecTermination::Cancelled);
    wait_for_pid_exit(pid, "exec operation explicit cancel");
    child_guard.disarm();

    finish_guest_connection(handle, host_stream);
}

#[test]
fn malformed_exec_cancel_payload_still_cancels_and_keeps_connection_open() {
    let pid_path = unique_pid_path("exec-operation-malformed-cancel");
    let mut child_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (handle, mut host_stream) = start_guest_connection();

    let command = format!("echo $$ > '{}'; sleep 60", pid_path.as_str());
    send_exec_start(
        &mut host_stream,
        115,
        &command,
        LONG_RUNNING_EXEC_TIMEOUT_MS,
        ExecOutputPolicy::Capture { limit_bytes: 64 },
        ExecOutputPolicy::Capture { limit_bytes: 64 },
    );
    let pid = child_guard.read_pid();
    assert!(
        pid_alive(pid),
        "exec operation child should be running before malformed cancel"
    );

    send_control_payload(&mut host_stream, MSG_EXEC_CANCEL, 115, b"unexpected");
    let (_chunks, result) = read_exec_result(&mut host_stream, 115);

    assert_eq!(result.termination, ExecTermination::Cancelled);
    wait_for_pid_exit(pid, "exec operation malformed cancel");
    child_guard.disarm();
    assert_ping_pong(&mut host_stream, 116);

    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_connection_close_cancels_child() {
    let pid_path = unique_pid_path("exec-operation-connection-close");
    let mut child_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (handle, mut host_stream) = start_guest_connection();

    let command = format!("echo $$ > '{}'; sleep 60", pid_path.as_str());
    send_exec_start(
        &mut host_stream,
        112,
        &command,
        LONG_RUNNING_EXEC_TIMEOUT_MS,
        ExecOutputPolicy::Capture { limit_bytes: 64 },
        ExecOutputPolicy::Capture { limit_bytes: 64 },
    );
    let pid = child_guard.read_pid();
    assert!(
        pid_alive(pid),
        "exec operation child should be running before disconnect"
    );

    drop(host_stream);
    let _ = handle.join();
    wait_for_pid_exit(pid, "exec operation host disconnect");
    child_guard.disarm();
}

#[test]
fn exec_operation_duplicate_start_returns_error_without_cancelling_active_exec_operation() {
    let pid_path = unique_pid_path("exec-operation-duplicate");
    let mut child_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (handle, mut host_stream) = start_guest_connection();

    let command = format!("echo $$ > '{}'; sleep 60", pid_path.as_str());
    send_exec_start(
        &mut host_stream,
        113,
        &command,
        LONG_RUNNING_EXEC_TIMEOUT_MS,
        ExecOutputPolicy::Capture { limit_bytes: 64 },
        ExecOutputPolicy::Capture { limit_bytes: 64 },
    );
    let pid = child_guard.read_pid();

    send_exec_start(
        &mut host_stream,
        113,
        "printf duplicate",
        5000,
        ExecOutputPolicy::Capture { limit_bytes: 64 },
        ExecOutputPolicy::Discard,
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

    send_exec_cancel(&mut host_stream, 113);
    let (_chunks, result) = read_exec_result(&mut host_stream, 113);
    assert_eq!(result.termination, ExecTermination::Cancelled);
    wait_for_pid_exit(pid, "exec operation duplicate cleanup");
    child_guard.disarm();

    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_different_sequences_run_concurrently_and_cancel_independently() {
    let pid_path = unique_pid_path("exec-operation-concurrent");
    let fifo_path = unique_tmp_path("exec-operation-concurrent", ".fifo");
    let mut child_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (handle, mut host_stream) = start_guest_connection();

    let blocked_command = format!(
        "mkfifo '{}'; echo $$ > '{}'; read _ < '{}'",
        fifo_path.as_str(),
        pid_path.as_str(),
        fifo_path.as_str()
    );
    send_exec_start(
        &mut host_stream,
        120,
        &blocked_command,
        LONG_RUNNING_EXEC_TIMEOUT_MS,
        ExecOutputPolicy::Capture { limit_bytes: 64 },
        ExecOutputPolicy::Capture { limit_bytes: 64 },
    );
    let pid = child_guard.read_pid();
    assert!(
        pid_alive(pid),
        "first exec operation should remain active while second exec starts"
    );

    send_exec_start(
        &mut host_stream,
        121,
        "printf second",
        5000,
        ExecOutputPolicy::Capture { limit_bytes: 64 },
        ExecOutputPolicy::Discard,
    );
    let (_chunks, second) = read_exec_result(&mut host_stream, 121);
    assert_eq!(second.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(second.stdout, Some(b"second".to_vec()));
    assert!(
        pid_alive(pid),
        "second exec operation completion should not cancel first exec operation"
    );

    send_exec_cancel(&mut host_stream, 120);
    let (_chunks, first) = read_exec_result(&mut host_stream, 120);
    assert_eq!(first.termination, ExecTermination::Cancelled);
    wait_for_pid_exit(pid, "exec operation concurrent cleanup");
    child_guard.disarm();

    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_returns_when_orphaned_grandchild_holds_stdout() {
    use std::time::Instant;

    let (handle, mut host_stream) = start_guest_connection();
    host_stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .unwrap();
    let orphan = OrphanProcessGuard::new("orphan-exec-operation-sleep");
    let command = orphan_sleep_command("orphan-exec-operation", orphan.pid_path());
    let start = Instant::now();
    send_exec_start(
        &mut host_stream,
        122,
        &command,
        LONG_RUNNING_EXEC_TIMEOUT_MS,
        ExecOutputPolicy::Capture { limit_bytes: 1024 },
        ExecOutputPolicy::Capture { limit_bytes: 1024 },
    );
    let (_chunks, result) = read_exec_result(&mut host_stream, 122);
    let elapsed = start.elapsed();

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    let stdout = result.stdout.unwrap_or_default();
    assert!(
        String::from_utf8_lossy(&stdout).contains("orphan-exec-operation"),
        "expected stdout to contain 'orphan-exec-operation', got: {:?}",
        String::from_utf8_lossy(&stdout),
    );
    assert!(
        elapsed < Duration::from_secs(DRAIN_DEADLINE_SECS + 5),
        "exec result should arrive within drain deadline, took {elapsed:?}",
    );

    finish_guest_connection(handle, host_stream);
}
