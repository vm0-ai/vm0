use std::io::Write;

use vsock_proto::{
    self, ExecControlPolicy, ExecLifecyclePolicy, ExecOutputPolicy, ExecTermination,
    ExecTimeoutPolicy, MSG_ERROR, MSG_EXEC_CONTROL, MSG_EXEC_START, MSG_OPERATIONS_QUIESCED,
    MSG_OPERATIONS_RESUMED,
};

use super::exec_helpers::{EXEC_CONTROL_NONCE, send_exec_control};
use super::support::*;

#[test]
fn malformed_exec_control_payload_returns_error_and_keeps_connection_open() {
    let (handle, mut host_stream) = start_guest_connection();

    send_control_payload(&mut host_stream, MSG_EXEC_CONTROL, 121, b"bad");
    let error = read_error_response(&mut host_stream, 121);
    assert_eq!(error, "invalid payload: exec_control target_seq truncated");

    assert_ping_pong(&mut host_stream, 122);

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
