use std::io::Write;
use std::thread;
use std::time::Duration;

use vsock_proto::{
    self, ExecControlNonce, ExecControlPolicy, ExecControlStatus, ExecLifecyclePolicy,
    ExecOutputPolicy, ExecOutputStream, ExecStartEncodeRequest, ExecTermination, ExecTimeoutPolicy,
    MSG_ERROR, MSG_EXEC_CANCEL, MSG_EXEC_CONTROL, MSG_EXEC_CONTROL_RESULT, MSG_EXEC_OUTPUT,
    MSG_EXEC_RESULT, MSG_EXEC_START, MSG_EXEC_STARTED, MSG_OPERATIONS_QUIESCED,
    MSG_OPERATIONS_RESUMED,
};

use super::support::*;

const EXEC_CONTROL_NONCE: ExecControlNonce = *b"exec-ctrl-000001";
const EXEC_CONTROL_WRONG_NONCE: ExecControlNonce = *b"exec-ctrl-999999";
const EXEC_OPERATION_TIMEOUT_TEST_MS: u32 = 2_000;

fn unique_exec_control_nonce(seed: u64) -> ExecControlNonce {
    let mut nonce = [0u8; 16];
    nonce[..8].copy_from_slice(&u64::from(std::process::id()).to_be_bytes());
    nonce[8..].copy_from_slice(&seed.to_be_bytes());
    nonce
}

fn sleep_command_with_pid(pid_path: &str) -> String {
    format!("printf '%s' \"$$\" > '{pid_path}'; sleep 60")
}

fn send_supervised_exec_start(
    stream: &mut impl std::io::Write,
    seq: u32,
    command: &str,
    timeout: ExecTimeoutPolicy,
    stdout: ExecOutputPolicy,
    control: ExecControlPolicy,
) {
    send_exec_start_request(
        stream,
        seq,
        ExecStartEncodeRequest {
            lifecycle: ExecLifecyclePolicy::Supervised,
            timeout,
            command,
            env: &[],
            sudo: false,
            label: "supervised-test",
            stdout,
            stderr: ExecOutputPolicy::Capture { limit_bytes: 1024 },
            expected_exit_codes: &[],
            control,
            stdin_bytes: None,
        },
    );
}

fn read_exec_started(stream: &mut impl std::io::Read, seq: u32) -> u32 {
    let msg = read_message(stream);
    assert_eq!(msg.msg_type, MSG_EXEC_STARTED);
    assert_eq!(msg.seq, seq);
    vsock_proto::decode_exec_started(&msg.payload).unwrap().pid
}

fn read_exec_stdout_output(stream: &mut impl std::io::Read, seq: u32) -> Vec<u8> {
    loop {
        let msg = read_message(stream);
        if msg.seq != seq {
            continue;
        }
        match msg.msg_type {
            MSG_EXEC_OUTPUT => {
                let decoded = vsock_proto::decode_exec_output(&msg.payload).unwrap();
                assert_eq!(decoded.stream, ExecOutputStream::Stdout);
                assert!(!decoded.truncated);
                return decoded.chunk.to_vec();
            }
            MSG_EXEC_RESULT => panic!("unexpected exec result before stdout output"),
            MSG_ERROR => {
                let error = vsock_proto::decode_error(&msg.payload).unwrap();
                panic!("unexpected exec operation error for seq={seq}: {error}");
            }
            other => panic!("unexpected exec operation response type: 0x{other:02X}"),
        }
    }
}

fn send_exec_control(
    stream: &mut impl std::io::Write,
    request_seq: u32,
    target_seq: u32,
    control_nonce: ExecControlNonce,
    message_id: &str,
) {
    let payload =
        vsock_proto::encode_exec_control(target_seq, control_nonce, message_id, b"payload", 5000)
            .unwrap();
    let msg = vsock_proto::encode(MSG_EXEC_CONTROL, request_seq, &payload).unwrap();
    stream.write_all(&msg).unwrap();
}

#[test]
fn malformed_exec_control_payload_returns_error_and_keeps_connection_open() {
    let (handle, mut host_stream) = start_guest_connection();

    send_control_payload(&mut host_stream, MSG_EXEC_CONTROL, 121, b"bad");
    let error = read_error_response(&mut host_stream, 121);
    assert_eq!(error, "invalid payload: exec_control target_seq truncated");

    assert_ping_pong(&mut host_stream, 122);

    finish_guest_connection(handle, host_stream);
}

fn assert_exec_control_result(
    stream: &mut impl std::io::Read,
    request_seq: u32,
    expected_target_seq: u32,
    expected_nonce: ExecControlNonce,
    expected_message_id: &str,
    expected_status: ExecControlStatus,
    expected_diagnostic: &str,
) {
    let msg = read_message(stream);
    assert_eq!(msg.msg_type, MSG_EXEC_CONTROL_RESULT);
    assert_eq!(msg.seq, request_seq);
    let decoded = vsock_proto::decode_exec_control_result(&msg.payload).unwrap();
    assert_eq!(decoded.target_seq, expected_target_seq);
    assert_eq!(decoded.control_nonce, expected_nonce);
    assert_eq!(decoded.message_id, expected_message_id);
    assert_eq!(decoded.status, expected_status);
    assert_eq!(decoded.diagnostic, expected_diagnostic);
}

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
fn exec_operation_capture_only_stdout_stderr_success() {
    let (handle, mut host_stream) = start_guest_connection();

    send_exec_start(
        &mut host_stream,
        101,
        "printf stdout; printf stderr >&2",
        5000,
        ExecOutputPolicy::Capture { limit_bytes: 1024 },
        ExecOutputPolicy::Capture { limit_bytes: 1024 },
    );
    let (chunks, result) = read_exec_result(&mut host_stream, 101);

    assert!(chunks.is_empty());
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.stdout, Some(b"stdout".to_vec()));
    assert_eq!(result.stderr, Some(b"stderr".to_vec()));
    assert!(!result.stdout_truncated);
    assert!(!result.stderr_truncated);
    assert!(result.diagnostic.is_empty());

    finish_guest_connection(handle, host_stream);
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
fn exec_operation_expected_nonzero_exit_still_returns_result() {
    let (handle, mut host_stream) = start_guest_connection();

    let payload = vsock_proto::encode_exec_start_with_expected_exit_codes(
        vsock_proto::ExecStartEncodeRequest {
            lifecycle: ExecLifecyclePolicy::OneShot,
            timeout: ExecTimeoutPolicy::Duration { timeout_ms: 5000 },
            command: "exit 66",
            env: &[],
            sudo: false,
            label: "test",
            stdout: ExecOutputPolicy::Capture { limit_bytes: 1024 },
            stderr: ExecOutputPolicy::Capture { limit_bytes: 1024 },
            expected_exit_codes: &[66],
            control: ExecControlPolicy::Disabled,
            stdin_bytes: None,
        },
    );
    let msg = vsock_proto::encode(MSG_EXEC_START, 102, &payload.unwrap()).unwrap();
    host_stream.write_all(&msg).unwrap();
    let (chunks, result) = read_exec_result(&mut host_stream, 102);

    assert!(chunks.is_empty());
    assert_eq!(
        result.termination,
        ExecTermination::Exited { exit_code: 66 }
    );
    assert_eq!(result.stdout, Some(Vec::new()));
    assert_eq!(result.stderr, Some(Vec::new()));
    assert!(result.diagnostic.is_empty());

    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_rejects_invalid_one_shot_start_policies() {
    let (handle, mut host_stream) = start_guest_connection();

    send_exec_start_request(
        &mut host_stream,
        103,
        vsock_proto::ExecStartEncodeRequest {
            lifecycle: ExecLifecyclePolicy::OneShot,
            timeout: ExecTimeoutPolicy::None,
            command: "printf should-not-run",
            env: &[],
            sudo: false,
            label: "test",
            stdout: ExecOutputPolicy::Discard,
            stderr: ExecOutputPolicy::Discard,
            expected_exit_codes: &[],
            control: ExecControlPolicy::Disabled,
            stdin_bytes: None,
        },
    );
    assert_eq!(
        read_error_response(&mut host_stream, 103),
        "exec timeout policy none requires supervised lifecycle"
    );

    let mut zero_timeout_payload = vsock_proto::encode_exec_start(
        1,
        "printf should-not-run",
        &[],
        false,
        "test",
        ExecOutputPolicy::Discard,
        ExecOutputPolicy::Discard,
    )
    .unwrap();
    zero_timeout_payload[2..6].copy_from_slice(&0u32.to_be_bytes());
    let zero_timeout_msg = vsock_proto::encode(MSG_EXEC_START, 104, &zero_timeout_payload).unwrap();
    host_stream.write_all(&zero_timeout_msg).unwrap();
    assert_eq!(
        read_error_response(&mut host_stream, 104),
        "invalid payload: exec start timeout duration must be positive"
    );

    send_exec_start_request(
        &mut host_stream,
        105,
        vsock_proto::ExecStartEncodeRequest {
            lifecycle: ExecLifecyclePolicy::OneShot,
            timeout: ExecTimeoutPolicy::Duration { timeout_ms: 5000 },
            command: "printf should-not-run",
            env: &[],
            sudo: false,
            label: "test",
            stdout: ExecOutputPolicy::Discard,
            stderr: ExecOutputPolicy::Discard,
            expected_exit_codes: &[],
            control: ExecControlPolicy::Enabled {
                control_nonce: *b"0123456789abcdef",
                sink: false,
            },
            stdin_bytes: None,
        },
    );
    assert_eq!(
        read_error_response(&mut host_stream, 105),
        "exec control policy requires supervised lifecycle"
    );

    send_quiesce_operations(&mut host_stream, 106);
    let quiesced = read_message(&mut host_stream);
    assert_eq!(quiesced.msg_type, MSG_OPERATIONS_QUIESCED);
    assert_eq!(quiesced.seq, 106);
    assert!(quiesced.payload.is_empty());

    send_resume_operations(&mut host_stream, 107);
    let resumed = read_message(&mut host_stream);
    assert_eq!(resumed.msg_type, MSG_OPERATIONS_RESUMED);
    assert_eq!(resumed.seq, 107);
    assert!(resumed.payload.is_empty());

    send_exec_start(
        &mut host_stream,
        108,
        "printf ok",
        5000,
        ExecOutputPolicy::Capture { limit_bytes: 64 },
        ExecOutputPolicy::Discard,
    );
    let (chunks, result) = read_exec_result(&mut host_stream, 108);
    assert!(chunks.is_empty());
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.stdout, Some(b"ok".to_vec()));

    finish_guest_connection(handle, host_stream);
}

#[test]
fn supervised_exec_sends_started_before_output() {
    let (handle, mut host_stream) = start_guest_connection();

    send_supervised_exec_start(
        &mut host_stream,
        201,
        "printf ready",
        ExecTimeoutPolicy::Duration { timeout_ms: 5000 },
        ExecOutputPolicy::Stream {
            limit_bytes: 1024,
            chunk_limit_bytes: 1024,
        },
        ExecControlPolicy::Disabled,
    );

    assert!(read_exec_started(&mut host_stream, 201) > 0);
    let (chunks, result) = read_exec_result(&mut host_stream, 201);

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(stdout_data(&chunks), b"ready".to_vec());

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

#[test]
fn supervised_exec_spawn_failure_returns_start_failed_without_started_ack() {
    let (handle, mut host_stream) = start_guest_connection();

    send_supervised_exec_start(
        &mut host_stream,
        202,
        "bad\0command",
        ExecTimeoutPolicy::None,
        ExecOutputPolicy::Capture { limit_bytes: 1024 },
        ExecControlPolicy::Disabled,
    );

    let msg = read_message(&mut host_stream);
    assert_eq!(msg.msg_type, MSG_EXEC_RESULT);
    assert_eq!(msg.seq, 202);
    let result = vsock_proto::decode_exec_result(&msg.payload).unwrap();
    assert_eq!(result.termination, ExecTermination::StartFailed);
    assert!(result.diagnostic.contains("Failed to execute"));

    finish_guest_connection(handle, host_stream);
}

#[test]
fn supervised_exec_control_spawn_failure_releases_registration() {
    let (handle, mut host_stream) = start_guest_connection();

    send_supervised_exec_start(
        &mut host_stream,
        208,
        "bad\0command",
        ExecTimeoutPolicy::None,
        ExecOutputPolicy::Capture { limit_bytes: 1024 },
        ExecControlPolicy::Enabled {
            control_nonce: EXEC_CONTROL_NONCE,
            sink: false,
        },
    );

    let msg = read_message(&mut host_stream);
    assert_eq!(msg.msg_type, MSG_EXEC_RESULT);
    assert_eq!(msg.seq, 208);
    let result = vsock_proto::decode_exec_result(&msg.payload).unwrap();
    assert_eq!(result.termination, ExecTermination::StartFailed);
    assert!(result.diagnostic.contains("Failed to execute"));

    send_exec_control(
        &mut host_stream,
        310,
        208,
        EXEC_CONTROL_NONCE,
        "message-after-start-failed",
    );
    assert_exec_control_result(
        &mut host_stream,
        310,
        208,
        EXEC_CONTROL_NONCE,
        "message-after-start-failed",
        ExecControlStatus::Inactive,
        "exec operation is not active",
    );

    send_quiesce_operations(&mut host_stream, 311);
    let quiesced = read_message(&mut host_stream);
    assert_eq!(quiesced.msg_type, MSG_OPERATIONS_QUIESCED);
    assert_eq!(quiesced.seq, 311);
    assert!(quiesced.payload.is_empty());

    finish_guest_connection(handle, host_stream);
}

#[test]
fn supervised_exec_control_forwards_to_bootstrap_sink() {
    let pid_path = unique_pid_path("supervised-exec-bootstrap-sink");
    let mut child_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let target_seq = 203;
    let control_nonce = unique_exec_control_nonce(u64::from(target_seq));
    let endpoint = process_control_ipc::endpoint_name(target_seq, &control_nonce);
    let command = format!(
        "printf '%s' \"$$\" > '{}'; printf '%s' \"$VM0_PROCESS_CONTROL_ENDPOINT\"; sleep 60",
        pid_path.as_str()
    );
    let (handle, mut host_stream) = start_guest_connection();

    send_exec_start_request(
        &mut host_stream,
        target_seq,
        ExecStartEncodeRequest {
            lifecycle: ExecLifecyclePolicy::Supervised,
            timeout: ExecTimeoutPolicy::None,
            command: &command,
            env: &[(process_control_ipc::BOOTSTRAP_ENV, "stale-endpoint")],
            sudo: false,
            label: "supervised-test",
            stdout: ExecOutputPolicy::CaptureAndStream {
                capture_limit_bytes: 1024,
                stream_limit_bytes: 1024,
                chunk_limit_bytes: 1024,
            },
            stderr: ExecOutputPolicy::Capture { limit_bytes: 1024 },
            expected_exit_codes: &[],
            control: ExecControlPolicy::Enabled {
                control_nonce,
                sink: true,
            },
            stdin_bytes: None,
        },
    );
    assert!(read_exec_started(&mut host_stream, target_seq) > 0);
    let pid = child_guard.read_pid();
    assert_eq!(
        read_exec_stdout_output(&mut host_stream, target_seq),
        endpoint.as_bytes()
    );

    let client_endpoint = endpoint.clone();
    let client = thread::spawn(move || {
        let mut stream = process_control_ipc::connect_abstract(&client_endpoint).unwrap();
        process_control_ipc::write_hello(&mut stream).unwrap();
        let request = process_control_ipc::read_request(&mut stream).unwrap();
        assert_eq!(request.message_id, "message");
        assert_eq!(request.payload, b"payload");
        process_control_ipc::write_response(
            &mut stream,
            &process_control_ipc::ControlResponse {
                message_id: request.message_id,
                status: process_control_ipc::ControlResponseStatus::Accepted,
                diagnostic: "ok".to_owned(),
            },
        )
        .unwrap();
    });

    send_exec_control(&mut host_stream, 303, target_seq, control_nonce, "message");
    assert_exec_control_result(
        &mut host_stream,
        303,
        target_seq,
        control_nonce,
        "message",
        ExecControlStatus::Delivered,
        "ok",
    );
    client.join().unwrap();

    send_exec_cancel(&mut host_stream, target_seq);
    let (_chunks, result) = read_exec_result(&mut host_stream, target_seq);
    assert_eq!(result.termination, ExecTermination::Cancelled);
    assert_eq!(result.stdout, Some(endpoint.into_bytes()));
    wait_for_pid_exit(pid, "supervised exec bootstrap sink cleanup");
    child_guard.disarm();

    finish_guest_connection(handle, host_stream);
}

#[test]
fn supervised_exec_control_reports_unsupported_without_sink() {
    let pid_path = unique_pid_path("supervised-exec-unsupported-control");
    let mut child_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (handle, mut host_stream) = start_guest_connection();
    let command = sleep_command_with_pid(pid_path.as_str());

    send_supervised_exec_start(
        &mut host_stream,
        204,
        &command,
        ExecTimeoutPolicy::None,
        ExecOutputPolicy::Discard,
        ExecControlPolicy::Enabled {
            control_nonce: EXEC_CONTROL_NONCE,
            sink: false,
        },
    );
    assert!(read_exec_started(&mut host_stream, 204) > 0);
    let pid = child_guard.read_pid();

    send_exec_control(&mut host_stream, 304, 204, EXEC_CONTROL_NONCE, "message");
    assert_exec_control_result(
        &mut host_stream,
        304,
        204,
        EXEC_CONTROL_NONCE,
        "message",
        ExecControlStatus::Unsupported,
        "exec control sink is not configured",
    );

    send_exec_cancel(&mut host_stream, 204);
    let (_chunks, result) = read_exec_result(&mut host_stream, 204);
    assert_eq!(result.termination, ExecTermination::Cancelled);
    wait_for_pid_exit(pid, "supervised exec unsupported control cleanup");
    child_guard.disarm();

    finish_guest_connection(handle, host_stream);
}

#[test]
fn supervised_exec_control_registries_are_isolated_per_connection() {
    let first_pid_path = unique_pid_path("supervised-exec-first-isolated");
    let second_pid_path = unique_pid_path("supervised-exec-second-isolated");
    let mut first_child_guard = ProcessGroupFileGuard::new(first_pid_path.as_str());
    let mut second_child_guard = ProcessGroupFileGuard::new(second_pid_path.as_str());
    let (first_handle, mut first_stream) = start_guest_connection();
    let (second_handle, mut second_stream) = start_guest_connection();
    let first_command = sleep_command_with_pid(first_pid_path.as_str());
    let second_command = sleep_command_with_pid(second_pid_path.as_str());

    send_supervised_exec_start(
        &mut first_stream,
        209,
        &first_command,
        ExecTimeoutPolicy::None,
        ExecOutputPolicy::Discard,
        ExecControlPolicy::Enabled {
            control_nonce: EXEC_CONTROL_NONCE,
            sink: false,
        },
    );
    send_supervised_exec_start(
        &mut second_stream,
        209,
        &second_command,
        ExecTimeoutPolicy::None,
        ExecOutputPolicy::Discard,
        ExecControlPolicy::Enabled {
            control_nonce: EXEC_CONTROL_NONCE,
            sink: false,
        },
    );

    assert!(read_exec_started(&mut first_stream, 209) > 0);
    assert!(read_exec_started(&mut second_stream, 209) > 0);
    let first_pid = first_child_guard.read_pid();
    let second_pid = second_child_guard.read_pid();

    send_exec_control(
        &mut first_stream,
        312,
        209,
        EXEC_CONTROL_NONCE,
        "message-first",
    );
    send_exec_control(
        &mut second_stream,
        312,
        209,
        EXEC_CONTROL_NONCE,
        "message-second",
    );

    assert_exec_control_result(
        &mut first_stream,
        312,
        209,
        EXEC_CONTROL_NONCE,
        "message-first",
        ExecControlStatus::Unsupported,
        "exec control sink is not configured",
    );
    assert_exec_control_result(
        &mut second_stream,
        312,
        209,
        EXEC_CONTROL_NONCE,
        "message-second",
        ExecControlStatus::Unsupported,
        "exec control sink is not configured",
    );

    send_exec_cancel(&mut first_stream, 209);
    send_exec_cancel(&mut second_stream, 209);

    let (_chunks, first_result) = read_exec_result(&mut first_stream, 209);
    let (_chunks, second_result) = read_exec_result(&mut second_stream, 209);
    assert_eq!(first_result.termination, ExecTermination::Cancelled);
    assert_eq!(second_result.termination, ExecTermination::Cancelled);
    wait_for_pid_exit(first_pid, "first supervised exec isolation cleanup");
    wait_for_pid_exit(second_pid, "second supervised exec isolation cleanup");
    first_child_guard.disarm();
    second_child_guard.disarm();

    finish_guest_connection(first_handle, first_stream);
    finish_guest_connection(second_handle, second_stream);
}

#[test]
fn supervised_exec_control_duplicate_start_preserves_active_nonce() {
    let pid_path = unique_pid_path("supervised-exec-duplicate-control");
    let mut child_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (handle, mut host_stream) = start_guest_connection();
    let command = sleep_command_with_pid(pid_path.as_str());

    send_supervised_exec_start(
        &mut host_stream,
        206,
        &command,
        ExecTimeoutPolicy::None,
        ExecOutputPolicy::Discard,
        ExecControlPolicy::Enabled {
            control_nonce: EXEC_CONTROL_NONCE,
            sink: false,
        },
    );
    assert!(read_exec_started(&mut host_stream, 206) > 0);
    let pid = child_guard.read_pid();

    send_supervised_exec_start(
        &mut host_stream,
        206,
        "printf duplicate",
        ExecTimeoutPolicy::None,
        ExecOutputPolicy::Discard,
        ExecControlPolicy::Enabled {
            control_nonce: EXEC_CONTROL_WRONG_NONCE,
            sink: false,
        },
    );
    assert_eq!(
        read_error_response(&mut host_stream, 206),
        "exec operation already active"
    );

    send_exec_control(
        &mut host_stream,
        306,
        206,
        EXEC_CONTROL_WRONG_NONCE,
        "message-wrong-nonce",
    );
    assert_exec_control_result(
        &mut host_stream,
        306,
        206,
        EXEC_CONTROL_WRONG_NONCE,
        "message-wrong-nonce",
        ExecControlStatus::NonceMismatch,
        "exec operation nonce mismatch",
    );

    send_exec_control(
        &mut host_stream,
        307,
        206,
        EXEC_CONTROL_NONCE,
        "message-original-nonce",
    );
    assert_exec_control_result(
        &mut host_stream,
        307,
        206,
        EXEC_CONTROL_NONCE,
        "message-original-nonce",
        ExecControlStatus::Unsupported,
        "exec control sink is not configured",
    );

    send_exec_cancel(&mut host_stream, 206);
    let (_chunks, result) = read_exec_result(&mut host_stream, 206);
    assert_eq!(result.termination, ExecTermination::Cancelled);
    wait_for_pid_exit(pid, "supervised exec duplicate control cleanup");
    child_guard.disarm();

    send_quiesce_operations(&mut host_stream, 308);
    let quiesced = read_message(&mut host_stream);
    assert_eq!(quiesced.msg_type, MSG_OPERATIONS_QUIESCED);
    assert_eq!(quiesced.seq, 308);
    assert!(quiesced.payload.is_empty());

    finish_guest_connection(handle, host_stream);
}

#[test]
fn supervised_exec_duplicate_start_with_control_does_not_leak_registration() {
    let pid_path = unique_pid_path("supervised-exec-duplicate-registration");
    let mut child_guard = ProcessGroupFileGuard::new(pid_path.as_str());
    let (handle, mut host_stream) = start_guest_connection();
    let command = sleep_command_with_pid(pid_path.as_str());

    send_supervised_exec_start(
        &mut host_stream,
        210,
        &command,
        ExecTimeoutPolicy::None,
        ExecOutputPolicy::Discard,
        ExecControlPolicy::Disabled,
    );
    assert!(read_exec_started(&mut host_stream, 210) > 0);
    let pid = child_guard.read_pid();

    send_supervised_exec_start(
        &mut host_stream,
        210,
        "printf duplicate",
        ExecTimeoutPolicy::None,
        ExecOutputPolicy::Discard,
        ExecControlPolicy::Enabled {
            control_nonce: EXEC_CONTROL_NONCE,
            sink: false,
        },
    );
    assert_eq!(
        read_error_response(&mut host_stream, 210),
        "exec operation already active"
    );

    send_exec_control(
        &mut host_stream,
        313,
        210,
        EXEC_CONTROL_NONCE,
        "message-duplicate-control",
    );
    assert_exec_control_result(
        &mut host_stream,
        313,
        210,
        EXEC_CONTROL_NONCE,
        "message-duplicate-control",
        ExecControlStatus::Inactive,
        "exec operation is not active",
    );

    send_exec_cancel(&mut host_stream, 210);
    let (_chunks, result) = read_exec_result(&mut host_stream, 210);
    assert_eq!(result.termination, ExecTermination::Cancelled);
    wait_for_pid_exit(pid, "supervised exec duplicate registration cleanup");
    child_guard.disarm();

    finish_guest_connection(handle, host_stream);
}

#[test]
fn supervised_exec_control_after_exit_returns_inactive() {
    let (handle, mut host_stream) = start_guest_connection();

    send_supervised_exec_start(
        &mut host_stream,
        207,
        "printf done",
        ExecTimeoutPolicy::Duration { timeout_ms: 5000 },
        ExecOutputPolicy::Capture { limit_bytes: 1024 },
        ExecControlPolicy::Enabled {
            control_nonce: EXEC_CONTROL_NONCE,
            sink: false,
        },
    );
    assert!(read_exec_started(&mut host_stream, 207) > 0);
    let (_chunks, result) = read_exec_result(&mut host_stream, 207);
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.stdout, Some(b"done".to_vec()));

    send_exec_control(
        &mut host_stream,
        309,
        207,
        EXEC_CONTROL_NONCE,
        "message-after-exit",
    );
    assert_exec_control_result(
        &mut host_stream,
        309,
        207,
        EXEC_CONTROL_NONCE,
        "message-after-exit",
        ExecControlStatus::Inactive,
        "exec operation is not active",
    );

    finish_guest_connection(handle, host_stream);
}

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
fn exec_operation_large_env_payload_succeeds() {
    let values = large_env_values();
    let env = large_env_entries(&values);
    let (handle, mut host_stream) = start_guest_connection();

    send_exec_start_with_env(
        &mut host_stream,
        124,
        LARGE_ENV_COMMAND,
        5000,
        &env,
        ExecOutputPolicy::Capture { limit_bytes: 128 },
        ExecOutputPolicy::Capture { limit_bytes: 1024 },
    );
    let (_chunks, result) = read_exec_result(&mut host_stream, 124);

    assert_eq!(
        result.termination,
        ExecTermination::Exited { exit_code: 0 },
        "diagnostic: {} stderr: {:?}",
        result.diagnostic,
        result.stderr,
    );
    assert_large_env_stdout(&result.stdout.unwrap_or_default());

    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_repeated_short_operations_soak() {
    let (handle, mut host_stream) = start_guest_connection();

    for seq in 130..138 {
        let expected = format!("run-{seq}");
        send_exec_start(
            &mut host_stream,
            seq,
            &format!("printf {expected}"),
            5000,
            ExecOutputPolicy::Capture { limit_bytes: 64 },
            ExecOutputPolicy::Capture { limit_bytes: 64 },
        );
        let (chunks, result) = read_exec_result(&mut host_stream, seq);

        assert!(chunks.is_empty());
        assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
        assert_eq!(result.stdout, Some(expected.into_bytes()));
        assert_eq!(result.stderr, Some(Vec::new()));
        assert!(!result.stdout_truncated);
        assert!(!result.stderr_truncated);
    }

    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_large_stdout_stderr_capture_soak() {
    let (handle, mut host_stream) = start_guest_connection();
    let len = 32 * 1024usize;

    send_exec_start(
        &mut host_stream,
        138,
        "head -c 32768 /dev/zero | tr '\\0' o; head -c 32768 /dev/zero | tr '\\0' e >&2",
        5000,
        ExecOutputPolicy::Capture {
            limit_bytes: len as u32,
        },
        ExecOutputPolicy::Capture {
            limit_bytes: len as u32,
        },
    );
    let (chunks, result) = read_exec_result(&mut host_stream, 138);

    assert!(chunks.is_empty());
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
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
fn exec_operation_stream_only_stdout_stderr_success() {
    let (handle, mut host_stream) = start_guest_connection();

    send_exec_start(
        &mut host_stream,
        102,
        "printf out; printf err >&2",
        5000,
        ExecOutputPolicy::Stream {
            limit_bytes: 64,
            chunk_limit_bytes: 8,
        },
        ExecOutputPolicy::Stream {
            limit_bytes: 64,
            chunk_limit_bytes: 8,
        },
    );
    let (chunks, result) = read_exec_result(&mut host_stream, 102);

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
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
fn exec_operation_stream_handles_more_chunks_than_output_queue_capacity() {
    let (handle, mut host_stream) = start_guest_connection();
    let expected = "x".repeat(96);
    let command = format!("printf {expected}");

    send_exec_start(
        &mut host_stream,
        116,
        &command,
        5000,
        ExecOutputPolicy::Stream {
            limit_bytes: expected.len() as u32,
            chunk_limit_bytes: 1,
        },
        ExecOutputPolicy::Discard,
    );
    let (chunks, result) = read_exec_result(&mut host_stream, 116);

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(stdout_data(&chunks), expected.as_bytes());
    assert_eq!(chunks.len(), expected.len());
    assert!(chunks.iter().all(|chunk| !chunk.truncated));
    for (expected_seq, chunk) in chunks.iter().enumerate() {
        assert_eq!(chunk.output_seq, expected_seq as u32);
    }

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
fn exec_operation_rejects_output_policies_that_cannot_fit_protocol_frames_without_running() {
    let capture_marker = unique_tmp_path("exec-operation-huge-capture-policy", ".marker");
    let stream_marker = unique_tmp_path("exec-operation-huge-stream-policy", ".marker");
    let (handle, mut host_stream) = start_guest_connection();

    send_exec_start(
        &mut host_stream,
        118,
        &format!("printf ran > '{}'", capture_marker.as_str()),
        5000,
        ExecOutputPolicy::Capture {
            limit_bytes: u32::MAX,
        },
        ExecOutputPolicy::Discard,
    );
    let (_chunks, capture_result) = read_exec_result(&mut host_stream, 118);
    assert_eq!(capture_result.termination, ExecTermination::StartFailed);
    assert!(
        capture_result
            .diagnostic
            .contains("capture limits exceed protocol result frame budget")
    );
    assert!(std::fs::metadata(capture_marker.as_str()).is_err());

    send_exec_start(
        &mut host_stream,
        119,
        &format!("printf ran > '{}'", stream_marker.as_str()),
        5000,
        ExecOutputPolicy::Stream {
            limit_bytes: 1,
            chunk_limit_bytes: u32::MAX,
        },
        ExecOutputPolicy::Discard,
    );
    let (_chunks, stream_result) = read_exec_result(&mut host_stream, 119);
    assert_eq!(stream_result.termination, ExecTermination::StartFailed);
    assert!(
        stream_result
            .diagnostic
            .contains("stream chunk limit exceeds protocol frame budget")
    );
    assert!(std::fs::metadata(stream_marker.as_str()).is_err());

    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_capture_and_stream_success() {
    let (handle, mut host_stream) = start_guest_connection();

    send_exec_start(
        &mut host_stream,
        103,
        "printf visible",
        5000,
        ExecOutputPolicy::CaptureAndStream {
            capture_limit_bytes: 64,
            stream_limit_bytes: 64,
            chunk_limit_bytes: 4,
        },
        ExecOutputPolicy::Discard,
    );
    let (chunks, result) = read_exec_result(&mut host_stream, 103);

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.stdout, Some(b"visible".to_vec()));
    assert_eq!(result.stderr, None);
    assert_eq!(stdout_data(&chunks), b"visible".to_vec());
    assert!(chunks.iter().all(|chunk| !chunk.truncated));

    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_capture_limits_track_exact_and_one_byte_over() {
    let (handle, mut host_stream) = start_guest_connection();

    send_exec_start(
        &mut host_stream,
        104,
        "printf abcd",
        5000,
        ExecOutputPolicy::Capture { limit_bytes: 4 },
        ExecOutputPolicy::Discard,
    );
    let (_chunks, exact) = read_exec_result(&mut host_stream, 104);
    assert_eq!(exact.stdout, Some(b"abcd".to_vec()));
    assert!(!exact.stdout_truncated);

    send_exec_start(
        &mut host_stream,
        105,
        "printf abcde",
        5000,
        ExecOutputPolicy::Capture { limit_bytes: 4 },
        ExecOutputPolicy::Discard,
    );
    let (_chunks, over) = read_exec_result(&mut host_stream, 105);
    assert_eq!(over.stdout, Some(b"abcd".to_vec()));
    assert!(over.stdout_truncated);

    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_stream_limits_track_exact_over_and_zero_budget() {
    let (handle, mut host_stream) = start_guest_connection();

    send_exec_start(
        &mut host_stream,
        106,
        "printf abcd",
        5000,
        ExecOutputPolicy::Stream {
            limit_bytes: 4,
            chunk_limit_bytes: 2,
        },
        ExecOutputPolicy::Discard,
    );
    let (exact_chunks, exact) = read_exec_result(&mut host_stream, 106);
    assert_eq!(exact.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(stdout_data(&exact_chunks), b"abcd".to_vec());
    assert!(exact_chunks.iter().all(|chunk| !chunk.truncated));

    send_exec_start(
        &mut host_stream,
        107,
        "printf abcde",
        5000,
        ExecOutputPolicy::Stream {
            limit_bytes: 4,
            chunk_limit_bytes: 2,
        },
        ExecOutputPolicy::Discard,
    );
    let (over_chunks, over) = read_exec_result(&mut host_stream, 107);
    assert_eq!(over.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(stdout_data(&over_chunks), b"abcd".to_vec());
    assert!(
        over_chunks
            .iter()
            .any(|chunk| chunk.stream == ExecOutputStream::Stdout
                && chunk.truncated
                && chunk.chunk.is_empty())
    );

    send_exec_start(
        &mut host_stream,
        108,
        "printf abc",
        5000,
        ExecOutputPolicy::Stream {
            limit_bytes: 0,
            chunk_limit_bytes: 2,
        },
        ExecOutputPolicy::Discard,
    );
    let (zero_chunks, zero) = read_exec_result(&mut host_stream, 108);
    assert_eq!(zero.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(stdout_data(&zero_chunks), Vec::<u8>::new());
    assert_eq!(zero_chunks.len(), 1);
    assert_eq!(zero_chunks[0].stream, ExecOutputStream::Stdout);
    assert!(zero_chunks[0].truncated);
    assert!(zero_chunks[0].chunk.is_empty());

    send_exec_start(
        &mut host_stream,
        139,
        "printf abcde >&2",
        5000,
        ExecOutputPolicy::Discard,
        ExecOutputPolicy::Stream {
            limit_bytes: 4,
            chunk_limit_bytes: 2,
        },
    );
    let (stderr_over_chunks, stderr_over) = read_exec_result(&mut host_stream, 139);
    assert_eq!(
        stderr_over.termination,
        ExecTermination::Exited { exit_code: 0 }
    );
    assert_eq!(stderr_over.stdout, None);
    assert_eq!(stderr_over.stderr, None);
    assert_eq!(stderr_data(&stderr_over_chunks), b"abcd".to_vec());
    assert!(
        stderr_over_chunks
            .iter()
            .any(|chunk| chunk.stream == ExecOutputStream::Stderr
                && chunk.truncated
                && chunk.chunk.is_empty())
    );

    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_timeout_returns_timed_out_with_partial_capture() {
    let (handle, mut host_stream) = start_guest_connection();
    host_stream
        .set_read_timeout(Some(Duration::from_secs(8)))
        .unwrap();

    send_exec_start(
        &mut host_stream,
        109,
        "printf before; sleep 60",
        EXEC_OPERATION_TIMEOUT_TEST_MS,
        ExecOutputPolicy::CaptureAndStream {
            capture_limit_bytes: 64,
            stream_limit_bytes: 64,
            chunk_limit_bytes: 64,
        },
        ExecOutputPolicy::Capture { limit_bytes: 64 },
    );
    assert_eq!(
        read_exec_stdout_output(&mut host_stream, 109),
        b"before".to_vec()
    );
    let (_chunks, result) = read_exec_result(&mut host_stream, 109);

    assert_eq!(result.termination, ExecTermination::TimedOut);
    assert_eq!(result.stdout, Some(b"before".to_vec()));
    assert_eq!(result.stderr, Some(Vec::new()));

    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_invalid_env_returns_start_failed_without_leaking_value() {
    let (handle, mut host_stream) = start_guest_connection();

    let secret = "do-not-print-this-secret";
    send_exec_start_with_env(
        &mut host_stream,
        110,
        "echo should-not-run",
        5000,
        &[("BAD;KEY", secret)],
        ExecOutputPolicy::Capture { limit_bytes: 64 },
        ExecOutputPolicy::Capture { limit_bytes: 64 },
    );
    let (chunks, result) = read_exec_result(&mut host_stream, 110);

    assert!(chunks.is_empty());
    assert_eq!(result.termination, ExecTermination::StartFailed);
    assert!(
        result
            .diagnostic
            .contains("invalid environment variable name")
    );
    assert!(!result.diagnostic.contains(secret));

    finish_guest_connection(handle, host_stream);
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
fn exec_operation_unknown_cancel_is_ignored() {
    let (handle, mut host_stream) = start_guest_connection();

    send_exec_cancel(&mut host_stream, 999);
    send_exec_start(
        &mut host_stream,
        114,
        "printf ok",
        5000,
        ExecOutputPolicy::Capture { limit_bytes: 64 },
        ExecOutputPolicy::Discard,
    );
    let (_chunks, result) = read_exec_result(&mut host_stream, 114);

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(result.stdout, Some(b"ok".to_vec()));

    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_seq_zero_start_cancel_and_control_return_error() {
    let (handle, mut host_stream) = start_guest_connection();

    send_exec_start(
        &mut host_stream,
        0,
        "printf should-not-run",
        5000,
        ExecOutputPolicy::Capture { limit_bytes: 64 },
        ExecOutputPolicy::Discard,
    );
    let start_error = read_message(&mut host_stream);
    assert_eq!(start_error.msg_type, MSG_ERROR);
    assert_eq!(start_error.seq, 0);
    assert!(
        vsock_proto::decode_error(&start_error.payload)
            .unwrap()
            .contains("non-zero sequence")
    );

    send_exec_cancel(&mut host_stream, 0);
    let cancel_error = read_message(&mut host_stream);
    assert_eq!(cancel_error.msg_type, MSG_ERROR);
    assert_eq!(cancel_error.seq, 0);
    assert!(
        vsock_proto::decode_error(&cancel_error.payload)
            .unwrap()
            .contains("non-zero sequence")
    );

    send_exec_control(&mut host_stream, 0, 1, EXEC_CONTROL_NONCE, "message-zero");
    let control_error = read_message(&mut host_stream);
    assert_eq!(control_error.msg_type, MSG_ERROR);
    assert_eq!(control_error.seq, 0);
    assert!(
        vsock_proto::decode_error(&control_error.payload)
            .unwrap()
            .contains("non-zero sequence")
    );

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

/// Output written by an inherited-fd grandchild within the drain deadline must
/// still be included after the foreground shell exits.
#[test]
fn exec_operation_captures_grandchild_output_before_drain_deadline() {
    use std::time::Instant;

    let fifo_path = unique_tmp_path("exec-operation-grandchild-output", ".fifo");
    let (handle, mut host_stream) = start_guest_connection();
    host_stream
        .set_read_timeout(Some(Duration::from_secs(8)))
        .unwrap();

    let command = format!(
        "mkfifo '{}'; {{ cat '{}' >/dev/null; echo stdout-late; echo stderr-late >&2; }} & exec 3>'{}'; echo stdout-early; echo stderr-early >&2",
        fifo_path.as_str(),
        fifo_path.as_str(),
        fifo_path.as_str()
    );
    let start = Instant::now();
    send_exec_start(
        &mut host_stream,
        123,
        &command,
        LONG_RUNNING_EXEC_TIMEOUT_MS,
        ExecOutputPolicy::Capture { limit_bytes: 1024 },
        ExecOutputPolicy::Capture { limit_bytes: 1024 },
    );
    let (_chunks, result) = read_exec_result(&mut host_stream, 123);
    let elapsed = start.elapsed();

    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
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
