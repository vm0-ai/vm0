use std::io::Write;
use std::time::Duration;

use vsock_proto::{
    self, ExecControlPolicy, ExecLifecyclePolicy, ExecOutputPolicy, ExecOutputStream,
    ExecTermination, ExecTimeoutPolicy, MSG_ERROR, MSG_EXEC_START, MSG_OPERATIONS_QUIESCED,
    MSG_OPERATIONS_RESUMED,
};

use super::support::*;

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
fn exec_operation_rejects_unsupported_start_policies() {
    let (handle, mut host_stream) = start_guest_connection();

    send_exec_start_request(
        &mut host_stream,
        103,
        vsock_proto::ExecStartEncodeRequest {
            lifecycle: ExecLifecyclePolicy::Supervised,
            timeout: ExecTimeoutPolicy::Duration { timeout_ms: 5000 },
            command: "printf should-not-run",
            env: &[],
            sudo: false,
            label: "test",
            stdout: ExecOutputPolicy::Discard,
            stderr: ExecOutputPolicy::Discard,
            expected_exit_codes: &[],
            control: ExecControlPolicy::Disabled,
        },
    );
    assert_eq!(
        read_error_response(&mut host_stream, 103),
        "exec supervised lifecycle is not supported"
    );

    send_exec_start_request(
        &mut host_stream,
        104,
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
        },
    );
    assert_eq!(
        read_error_response(&mut host_stream, 104),
        "exec timeout policy none is not supported"
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
    let zero_timeout_msg = vsock_proto::encode(MSG_EXEC_START, 109, &zero_timeout_payload).unwrap();
    host_stream.write_all(&zero_timeout_msg).unwrap();
    assert_eq!(
        read_error_response(&mut host_stream, 109),
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
        },
    );
    assert_eq!(
        read_error_response(&mut host_stream, 105),
        "exec control policy is not supported"
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

    finish_guest_connection(handle, host_stream);
}

#[test]
fn exec_operation_timeout_returns_timed_out_with_partial_capture() {
    let (handle, mut host_stream) = start_guest_connection();

    send_exec_start(
        &mut host_stream,
        109,
        "printf before; sleep 60",
        200,
        ExecOutputPolicy::Capture { limit_bytes: 64 },
        ExecOutputPolicy::Capture { limit_bytes: 64 },
    );
    let (_chunks, result) = read_exec_result(&mut host_stream, 109);

    assert_eq!(result.termination, ExecTermination::TimedOut);
    assert_eq!(result.stdout, Some(b"before".to_vec()));

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
fn exec_operation_seq_zero_start_and_cancel_return_error() {
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

    let (handle, mut host_stream) = start_guest_connection();
    host_stream
        .set_read_timeout(Some(Duration::from_secs(8)))
        .unwrap();

    let start = Instant::now();
    send_exec_start(
        &mut host_stream,
        123,
        "echo stdout-early; echo stderr-early >&2; { sleep 1; echo stdout-late; echo stderr-late >&2; } &",
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
