use std::time::Duration;

use vsock_proto::{
    self, ExecControlPolicy, ExecLifecyclePolicy, ExecOutputPolicy, ExecStartEncodeRequest,
    ExecTermination, ExecTimeoutPolicy,
};

use super::exec_helpers::{
    EXEC_OPERATION_TIMEOUT_TEST_MS, read_exec_started, sleep_command_with_pid,
};
use super::support::*;

fn send_exec_start_with_stdin(
    stream: &mut impl std::io::Write,
    seq: u32,
    command: &str,
    stdin_bytes: Option<&[u8]>,
) {
    send_exec_start_with_stdin_timeout(stream, seq, command, 5000, stdin_bytes);
}

fn send_exec_start_with_stdin_timeout(
    stream: &mut impl std::io::Write,
    seq: u32,
    command: &str,
    timeout_ms: u32,
    stdin_bytes: Option<&[u8]>,
) {
    send_exec_start_request(
        stream,
        seq,
        ExecStartEncodeRequest {
            lifecycle: ExecLifecyclePolicy::OneShot,
            timeout: ExecTimeoutPolicy::Duration { timeout_ms },
            command,
            env: &[],
            sudo: false,
            label: "stdin-test",
            stdout: ExecOutputPolicy::Capture { limit_bytes: 1024 },
            stderr: ExecOutputPolicy::Capture { limit_bytes: 1024 },
            expected_exit_codes: &[],
            control: ExecControlPolicy::Disabled,
            stdin_bytes,
        },
    );
}

#[test]
fn exec_operation_writes_stdin_and_closes_pipe() {
    let (handle, mut host_stream) = start_guest_connection();

    send_exec_start_with_stdin(
        &mut host_stream,
        106,
        "cat; printf ':after'",
        Some(b"payload"),
    );
    let (chunks, result) = read_exec_result(&mut host_stream, 106);

    assert!(chunks.is_empty());
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.stdout, Some(b"payload:after".to_vec()));
    assert_eq!(result.stderr, Some(Vec::new()));
    assert!(result.diagnostic.is_empty());

    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_empty_stdin_is_immediate_eof() {
    let (handle, mut host_stream) = start_guest_connection();

    send_exec_start_with_stdin(
        &mut host_stream,
        107,
        "if read line; then printf unexpected; else printf eof; fi",
        Some(&[]),
    );
    let (chunks, result) = read_exec_result(&mut host_stream, 107);

    assert!(chunks.is_empty());
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.stdout, Some(b"eof".to_vec()));
    assert_eq!(result.stderr, Some(Vec::new()));
    assert!(result.diagnostic.is_empty());

    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_child_can_exit_without_reading_stdin() {
    let (handle, mut host_stream) = start_guest_connection();
    let stdin = vec![b'x'; vsock_proto::MAX_EXEC_STDIN_BYTES];

    send_exec_start_with_stdin(&mut host_stream, 108, "true", Some(&stdin));
    let (chunks, result) = read_exec_result(&mut host_stream, 108);

    assert!(chunks.is_empty());
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.stdout, Some(Vec::new()));
    assert_eq!(result.stderr, Some(Vec::new()));
    assert!(result.diagnostic.is_empty());

    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_returns_when_grandchild_holds_stdin_without_reading() {
    use std::time::Instant;

    let (handle, mut host_stream) = start_guest_connection();
    host_stream
        .set_read_timeout(Some(Duration::from_secs(8)))
        .unwrap();
    let orphan = OrphanProcessGuard::new("orphan-exec-operation-stdin");
    let stdin = vec![b'x'; vsock_proto::MAX_EXEC_STDIN_BYTES];
    let command = format!(
        "sleep 30 <&0 >/dev/null 2>/dev/null & echo $! > '{}'; printf stdin-orphan-done",
        orphan.pid_path()
    );

    let start = Instant::now();
    send_exec_start_with_stdin(&mut host_stream, 109, &command, Some(&stdin));
    let (_chunks, result) = read_exec_result(&mut host_stream, 109);
    let elapsed = start.elapsed();

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.stdout, Some(b"stdin-orphan-done".to_vec()));
    assert_eq!(result.stderr, Some(Vec::new()));
    assert!(result.diagnostic.is_empty());
    assert!(
        elapsed < Duration::from_secs(DRAIN_DEADLINE_SECS),
        "exec result should not wait for an inherited stdin pipe, took {elapsed:?}",
    );

    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_timeout_with_stdin_kills_child() {
    let (handle, mut host_stream) = start_guest_connection();
    host_stream
        .set_read_timeout(Some(Duration::from_secs(8)))
        .unwrap();
    let stdin = vec![b'x'; vsock_proto::MAX_EXEC_STDIN_BYTES];

    send_exec_start_request(
        &mut host_stream,
        125,
        ExecStartEncodeRequest {
            lifecycle: ExecLifecyclePolicy::Supervised,
            timeout: ExecTimeoutPolicy::Duration {
                timeout_ms: EXEC_OPERATION_TIMEOUT_TEST_MS,
            },
            command: "sleep 60",
            env: &[],
            sudo: false,
            label: "stdin-timeout-test",
            stdout: ExecOutputPolicy::Capture { limit_bytes: 1024 },
            stderr: ExecOutputPolicy::Capture { limit_bytes: 1024 },
            expected_exit_codes: &[],
            control: ExecControlPolicy::Disabled,
            stdin_bytes: Some(stdin.as_slice()),
        },
    );
    let pid = read_exec_started(&mut host_stream, 125);

    let (_chunks, result) = read_exec_result(&mut host_stream, 125);

    assert_eq!(result.termination, ExecTermination::TimedOut);
    wait_for_pid_exit(pid, "exec operation stdin timeout");

    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_explicit_cancel_with_stdin_kills_child() {
    let pid_path = unique_pid_path("exec-operation-stdin-cancel");
    let mut child_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (handle, mut host_stream) = start_guest_connection();
    let stdin = vec![b'x'; vsock_proto::MAX_EXEC_STDIN_BYTES];

    let command = sleep_command_with_pid(pid_path.as_str());
    send_exec_start_with_stdin_timeout(
        &mut host_stream,
        126,
        &command,
        LONG_RUNNING_EXEC_TIMEOUT_MS,
        Some(&stdin),
    );
    let pid = child_guard.read_pid();
    assert!(
        pid_alive(pid),
        "exec operation child should be running before cancel"
    );

    send_exec_cancel(&mut host_stream, 126);
    let (_chunks, result) = read_exec_result(&mut host_stream, 126);

    assert_eq!(result.termination, ExecTermination::Cancelled);
    wait_for_pid_exit(pid, "exec operation stdin cancel");
    child_guard.disarm();

    finish_guest_connection(handle, host_stream);
}

#[test]
fn supervised_exec_writes_stdin_and_closes_pipe() {
    let (handle, mut host_stream) = start_guest_connection();

    send_exec_start_request(
        &mut host_stream,
        211,
        ExecStartEncodeRequest {
            lifecycle: ExecLifecyclePolicy::Supervised,
            timeout: ExecTimeoutPolicy::Duration { timeout_ms: 5000 },
            command: "cat; printf ':after'",
            env: &[],
            sudo: false,
            label: "supervised-stdin-test",
            stdout: ExecOutputPolicy::Capture { limit_bytes: 1024 },
            stderr: ExecOutputPolicy::Capture { limit_bytes: 1024 },
            expected_exit_codes: &[],
            control: ExecControlPolicy::Disabled,
            stdin_bytes: Some(b"payload"),
        },
    );

    assert!(read_exec_started(&mut host_stream, 211) > 0);
    let (chunks, result) = read_exec_result(&mut host_stream, 211);

    assert!(chunks.is_empty());
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.stdout, Some(b"payload:after".to_vec()));
    assert_eq!(result.stderr, Some(Vec::new()));
    assert!(result.diagnostic.is_empty());

    finish_guest_connection(handle, host_stream);
}
