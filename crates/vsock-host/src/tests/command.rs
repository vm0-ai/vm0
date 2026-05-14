use std::io;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use vsock_proto::{
    CommandCapturedOutput, CommandOutputPolicy, CommandOutputStream, CommandTermination, Decoder,
    MSG_COMMAND_CANCEL, MSG_COMMAND_OUTPUT, MSG_COMMAND_RESULT, MSG_COMMAND_START, MSG_ERROR,
};

use super::support::{
    assert_connection_accepts_command_exec, host_from_stream, is_connected, make_pair,
    mock_handshake, operation_count, read_guest_message, read_guest_messages, send_command_output,
    send_command_result, send_discarded_command_result, send_raw_command_result,
    setup_host_and_guest, wait_for_operation_count,
};
use crate::{
    CommandCaptureRequest, CommandOperationHandle, CommandOperationRequest,
    CommandOwnedCapturedOutput, CommandStreamRequest, command as command_impl,
};

async fn start_capture_operation(host: &crate::VsockHost, command: &str) -> CommandOperationHandle {
    host.start_command_operation(CommandOperationRequest {
        timeout_ms: 5000,
        command,
        env: &[],
        sudo: false,
        label: "test-command",
        stdout: CommandOutputPolicy::Capture { limit_bytes: 1024 },
        stderr: CommandOutputPolicy::Capture { limit_bytes: 1024 },
        expected_exit_codes: &[],
        stream_queue_capacity: None,
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn command_capture_sends_start_and_receives_result() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.command_capture(CommandCaptureRequest {
                timeout_ms: 7000,
                command: "printf hello",
                env: &[("A", "B")],
                sudo: true,
                label: "capture-test",
                stdout_limit_bytes: 7,
                stderr_limit_bytes: 9,
                expected_exit_codes: &[],
                wait_timeout: Duration::from_secs(5),
            })
            .await
        })
    };

    let msg = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(msg.msg_type, MSG_COMMAND_START);
    let decoded = vsock_proto::decode_command_start(&msg.payload).unwrap();
    assert_eq!(decoded.timeout_ms, 7000);
    assert_eq!(decoded.command, "printf hello");
    assert_eq!(decoded.env, vec![("A", "B")]);
    assert!(decoded.sudo);
    assert_eq!(decoded.label, "capture-test");
    assert_eq!(
        decoded.stdout,
        CommandOutputPolicy::Capture { limit_bytes: 7 }
    );
    assert_eq!(
        decoded.stderr,
        CommandOutputPolicy::Capture { limit_bytes: 9 }
    );
    assert!(decoded.expected_exit_codes.is_empty());

    send_command_result(
        &mut guest,
        msg.seq,
        CommandTermination::Exited { exit_code: 0 },
        b"stdout",
        b"stderr",
    )
    .await;

    let result = task.await.unwrap().unwrap();
    assert_eq!(
        result.termination,
        CommandTermination::Exited { exit_code: 0 }
    );
    assert_eq!(
        result.stdout,
        CommandOwnedCapturedOutput::Captured {
            bytes: b"stdout".to_vec(),
            truncated: false,
        }
    );
    assert_eq!(
        result.stderr,
        CommandOwnedCapturedOutput::Captured {
            bytes: b"stderr".to_vec(),
            truncated: false,
        }
    );
    assert_eq!(operation_count(&host), 0);
}

#[tokio::test]
async fn command_start_sends_expected_exit_codes() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;

    let handle = host
        .start_command_operation(CommandOperationRequest {
            timeout_ms: 5000,
            command: "optional",
            env: &[],
            sudo: false,
            label: "expected-exit",
            stdout: CommandOutputPolicy::Capture { limit_bytes: 16 },
            stderr: CommandOutputPolicy::Capture { limit_bytes: 16 },
            expected_exit_codes: &[66],
            stream_queue_capacity: None,
        })
        .await
        .unwrap();

    let msg = read_guest_message(&mut guest, &mut decoder).await;
    let decoded = vsock_proto::decode_command_start(&msg.payload).unwrap();
    assert_eq!(decoded.expected_exit_codes, vec![66]);

    send_command_result(
        &mut guest,
        msg.seq,
        CommandTermination::Exited { exit_code: 66 },
        b"",
        b"",
    )
    .await;
    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(
        result.termination,
        CommandTermination::Exited { exit_code: 66 }
    );
}

#[tokio::test]
async fn command_capture_repeated_short_operations_soak() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let host = Arc::new(host);

    for i in 0..8 {
        let label = format!("repeat-{i}");
        let handle = host
            .start_command_operation(CommandOperationRequest {
                timeout_ms: 5000,
                command: "printf ok",
                env: &[],
                sudo: false,
                label: &label,
                stdout: CommandOutputPolicy::Capture { limit_bytes: 16 },
                stderr: CommandOutputPolicy::Capture { limit_bytes: 16 },
                expected_exit_codes: &[],
                stream_queue_capacity: None,
            })
            .await
            .unwrap();

        let msg = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(msg.msg_type, MSG_COMMAND_START);
        let stdout = format!("ok-{i}");
        send_command_result(
            &mut guest,
            msg.seq,
            CommandTermination::Exited { exit_code: 0 },
            stdout.as_bytes(),
            b"",
        )
        .await;

        let result = handle.wait(Duration::from_secs(5)).await.unwrap();
        assert_eq!(
            result.stdout,
            CommandOwnedCapturedOutput::Captured {
                bytes: stdout.into_bytes(),
                truncated: false,
            }
        );
        assert_eq!(operation_count(&host), 0);
        assert!(is_connected(&host));
    }

    assert_connection_accepts_command_exec(&host, &mut guest, &mut decoder).await;
}

#[tokio::test]
async fn command_capture_large_stdout_stderr_within_limits_soak() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let stdout = vec![b'o'; 64 * 1024];
    let stderr = vec![b'e'; 64 * 1024];
    let handle = host
        .start_command_operation(CommandOperationRequest {
            timeout_ms: 5000,
            command: "large-capture",
            env: &[],
            sudo: false,
            label: "large-capture",
            stdout: CommandOutputPolicy::Capture {
                limit_bytes: stdout.len() as u32,
            },
            stderr: CommandOutputPolicy::Capture {
                limit_bytes: stderr.len() as u32,
            },
            expected_exit_codes: &[],
            stream_queue_capacity: None,
        })
        .await
        .unwrap();

    let msg = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(msg.msg_type, MSG_COMMAND_START);
    send_command_result(
        &mut guest,
        msg.seq,
        CommandTermination::Exited { exit_code: 0 },
        &stdout,
        &stderr,
    )
    .await;

    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(
        result.stdout,
        CommandOwnedCapturedOutput::Captured {
            bytes: stdout,
            truncated: false,
        }
    );
    assert_eq!(
        result.stderr,
        CommandOwnedCapturedOutput::Captured {
            bytes: stderr,
            truncated: false,
        }
    );
    assert_eq!(operation_count(&host), 0);
    assert!(is_connected(&host));
}

#[tokio::test]
async fn command_result_preserves_non_default_metadata() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let handle = host
        .start_command_operation(CommandOperationRequest {
            timeout_ms: 5000,
            command: "metadata",
            env: &[],
            sudo: false,
            label: "metadata",
            stdout: CommandOutputPolicy::Discard,
            stderr: CommandOutputPolicy::Capture { limit_bytes: 1024 },
            expected_exit_codes: &[],
            stream_queue_capacity: None,
        })
        .await
        .unwrap();
    let msg = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(msg.msg_type, MSG_COMMAND_START);

    let payload = vsock_proto::encode_command_result(
        CommandTermination::WaitFailed,
        345,
        CommandCapturedOutput::Discarded,
        CommandCapturedOutput::Captured {
            bytes: b"stderr",
            truncated: true,
        },
        "wait failed",
    )
    .unwrap();
    let frame = vsock_proto::encode(MSG_COMMAND_RESULT, msg.seq, &payload).unwrap();
    guest.write_all(&frame).await.unwrap();

    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(result.termination, CommandTermination::WaitFailed);
    assert_eq!(result.duration_ms, 345);
    assert_eq!(result.stdout, CommandOwnedCapturedOutput::Discarded);
    assert_eq!(
        result.stderr,
        CommandOwnedCapturedOutput::Captured {
            bytes: b"stderr".to_vec(),
            truncated: true,
        }
    );
    assert_eq!(result.diagnostic, "wait failed");
}

#[tokio::test]
async fn command_result_capture_for_discard_policy_poisons_connection() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let handle = host
        .start_command_operation(CommandOperationRequest {
            timeout_ms: 5000,
            command: "discard",
            env: &[],
            sudo: false,
            label: "discard-result",
            stdout: CommandOutputPolicy::Discard,
            stderr: CommandOutputPolicy::Discard,
            expected_exit_codes: &[],
            stream_queue_capacity: None,
        })
        .await
        .unwrap();

    let msg = read_guest_message(&mut guest, &mut decoder).await;
    let payload = vsock_proto::encode_command_result(
        CommandTermination::Exited { exit_code: 0 },
        1,
        CommandCapturedOutput::Captured {
            bytes: b"unexpected",
            truncated: false,
        },
        CommandCapturedOutput::Discarded,
        "",
    )
    .unwrap();
    send_raw_command_result(&mut guest, msg.seq, payload).await;

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn command_result_over_capture_limit_poisons_connection() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let handle = host
        .start_command_operation(CommandOperationRequest {
            timeout_ms: 5000,
            command: "capture-limit",
            env: &[],
            sudo: false,
            label: "capture-limit",
            stdout: CommandOutputPolicy::Capture { limit_bytes: 4 },
            stderr: CommandOutputPolicy::Discard,
            expected_exit_codes: &[],
            stream_queue_capacity: None,
        })
        .await
        .unwrap();

    let msg = read_guest_message(&mut guest, &mut decoder).await;
    let payload = vsock_proto::encode_command_result(
        CommandTermination::Exited { exit_code: 0 },
        1,
        CommandCapturedOutput::Captured {
            bytes: b"abcde",
            truncated: true,
        },
        CommandCapturedOutput::Discarded,
        "",
    )
    .unwrap();
    send_raw_command_result(&mut guest, msg.seq, payload).await;

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn command_result_discard_for_capture_policy_poisons_connection() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let handle = host
        .start_command_operation(CommandOperationRequest {
            timeout_ms: 5000,
            command: "missing-capture",
            env: &[],
            sudo: false,
            label: "missing-capture",
            stdout: CommandOutputPolicy::Capture { limit_bytes: 4 },
            stderr: CommandOutputPolicy::Discard,
            expected_exit_codes: &[],
            stream_queue_capacity: None,
        })
        .await
        .unwrap();

    let msg = read_guest_message(&mut guest, &mut decoder).await;
    let payload = vsock_proto::encode_command_result(
        CommandTermination::Exited { exit_code: 0 },
        1,
        CommandCapturedOutput::Discarded,
        CommandCapturedOutput::Discarded,
        "",
    )
    .unwrap();
    send_raw_command_result(&mut guest, msg.seq, payload).await;

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn command_result_zero_capture_limit_accepts_empty_capture() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let handle = host
        .start_command_operation(CommandOperationRequest {
            timeout_ms: 5000,
            command: "zero-capture",
            env: &[],
            sudo: false,
            label: "zero-capture",
            stdout: CommandOutputPolicy::Capture { limit_bytes: 0 },
            stderr: CommandOutputPolicy::Capture { limit_bytes: 0 },
            expected_exit_codes: &[],
            stream_queue_capacity: None,
        })
        .await
        .unwrap();

    let msg = read_guest_message(&mut guest, &mut decoder).await;
    let payload = vsock_proto::encode_command_result(
        CommandTermination::Exited { exit_code: 0 },
        1,
        CommandCapturedOutput::Captured {
            bytes: b"",
            truncated: true,
        },
        CommandCapturedOutput::Captured {
            bytes: b"",
            truncated: false,
        },
        "",
    )
    .unwrap();
    send_raw_command_result(&mut guest, msg.seq, payload).await;

    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(
        result.stdout,
        CommandOwnedCapturedOutput::Captured {
            bytes: Vec::new(),
            truncated: true,
        }
    );
    assert_eq!(
        result.stderr,
        CommandOwnedCapturedOutput::Captured {
            bytes: Vec::new(),
            truncated: false,
        }
    );
    assert!(is_connected(&host));
}

#[tokio::test]
async fn command_stream_rejects_zero_capacity_without_sending_frame() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let err = match host
        .command_stream(CommandStreamRequest {
            timeout_ms: 5000,
            command: "stream",
            env: &[],
            sudo: false,
            label: "zero-capacity",
            stdout: CommandOutputPolicy::Stream {
                limit_bytes: 1024,
                chunk_limit_bytes: 16,
            },
            stderr: CommandOutputPolicy::Discard,
            expected_exit_codes: &[],
            stream_queue_capacity: Some(0),
        })
        .await
    {
        Ok(_) => panic!("zero stream capacity should be rejected"),
        Err(err) => err,
    };
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(operation_count(&host), 0);

    assert_connection_accepts_command_exec(&host, &mut guest, &mut decoder).await;
}

#[tokio::test]
async fn command_stream_rejects_oversized_capacity_without_sending_frame() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let err = match host
        .command_stream(CommandStreamRequest {
            timeout_ms: 5000,
            command: "stream",
            env: &[],
            sudo: false,
            label: "oversized-capacity",
            stdout: CommandOutputPolicy::Stream {
                limit_bytes: 1024,
                chunk_limit_bytes: 16,
            },
            stderr: CommandOutputPolicy::Discard,
            expected_exit_codes: &[],
            stream_queue_capacity: Some(command_impl::test_support::MAX_STREAM_CAPACITY + 1),
        })
        .await
    {
        Ok(_) => panic!("oversized stream capacity should be rejected"),
        Err(err) => err,
    };
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(operation_count(&host), 0);

    assert_connection_accepts_command_exec(&host, &mut guest, &mut decoder).await;
}

#[tokio::test]
async fn command_start_stream_policy_uses_default_receiver() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let mut handle = host
        .start_command_operation(CommandOperationRequest {
            timeout_ms: 5000,
            command: "stream",
            env: &[],
            sudo: false,
            label: "default-receiver",
            stdout: CommandOutputPolicy::Capture { limit_bytes: 1024 },
            stderr: CommandOutputPolicy::CaptureAndStream {
                capture_limit_bytes: 1024,
                stream_limit_bytes: 1024,
                chunk_limit_bytes: 16,
            },
            expected_exit_codes: &[],
            stream_queue_capacity: None,
        })
        .await
        .unwrap();
    let mut rx = handle.take_stream_receiver().unwrap();

    let msg = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(msg.msg_type, MSG_COMMAND_START);
    send_command_output(
        &mut guest,
        msg.seq,
        0,
        CommandOutputStream::Stderr,
        b"default-queued",
        false,
    )
    .await;
    let event = rx.recv().await.unwrap();
    assert_eq!(event.stream, CommandOutputStream::Stderr);
    assert_eq!(event.chunk, b"default-queued");
    send_command_result(
        &mut guest,
        msg.seq,
        CommandTermination::Exited { exit_code: 0 },
        b"",
        b"",
    )
    .await;
    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert!(!result.stream_overflowed);
}

#[tokio::test]
async fn command_start_rejects_receiver_without_stream_policy() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let err = match host
        .start_command_operation(CommandOperationRequest {
            timeout_ms: 5000,
            command: "capture",
            env: &[],
            sudo: false,
            label: "unexpected-receiver",
            stdout: CommandOutputPolicy::Capture { limit_bytes: 1024 },
            stderr: CommandOutputPolicy::Discard,
            expected_exit_codes: &[],
            stream_queue_capacity: Some(1),
        })
        .await
    {
        Ok(_) => panic!("receiver without streaming output policy should be rejected"),
        Err(err) => err,
    };
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(operation_count(&host), 0);

    assert_connection_accepts_command_exec(&host, &mut guest, &mut decoder).await;
}

#[tokio::test]
async fn command_stream_rejects_non_streaming_policy() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let err = match host
        .command_stream(CommandStreamRequest {
            timeout_ms: 5000,
            command: "capture",
            env: &[],
            sudo: false,
            label: "non-streaming-helper",
            stdout: CommandOutputPolicy::Capture { limit_bytes: 1024 },
            stderr: CommandOutputPolicy::Discard,
            expected_exit_codes: &[],
            stream_queue_capacity: None,
        })
        .await
    {
        Ok(_) => panic!("command_stream should reject non-streaming output policies"),
        Err(err) => err,
    };
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(operation_count(&host), 0);

    assert_connection_accepts_command_exec(&host, &mut guest, &mut decoder).await;
}

#[tokio::test]
async fn command_start_encode_error_does_not_register_or_send_frame() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let err = match host
        .start_command_operation(CommandOperationRequest {
            timeout_ms: 5000,
            command: "stream",
            env: &[],
            sudo: false,
            label: "bad-policy",
            stdout: CommandOutputPolicy::Stream {
                limit_bytes: 1024,
                chunk_limit_bytes: 0,
            },
            stderr: CommandOutputPolicy::Discard,
            expected_exit_codes: &[],
            stream_queue_capacity: Some(1),
        })
        .await
    {
        Ok(_) => panic!("invalid command output policy should be rejected"),
        Err(err) => err,
    };
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(operation_count(&host), 0);

    assert_connection_accepts_command_exec(&host, &mut guest, &mut decoder).await;
}

#[tokio::test]
async fn command_start_rejects_zero_timeout_without_sending_frame() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let err = match host
        .start_command_operation(CommandOperationRequest {
            timeout_ms: 0,
            command: "sleep 60",
            env: &[],
            sudo: false,
            label: "zero-timeout",
            stdout: CommandOutputPolicy::Capture { limit_bytes: 1024 },
            stderr: CommandOutputPolicy::Capture { limit_bytes: 1024 },
            expected_exit_codes: &[],
            stream_queue_capacity: None,
        })
        .await
    {
        Ok(_) => panic!("zero timeout command operation should be rejected"),
        Err(err) => err,
    };
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(operation_count(&host), 0);

    assert_connection_accepts_command_exec(&host, &mut guest, &mut decoder).await;
}

#[tokio::test]
async fn command_operations_dispatch_out_of_order_results_by_seq() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let first = start_capture_operation(&host, "cmd-a").await;
    let second = start_capture_operation(&host, "cmd-b").await;

    let mut messages = read_guest_messages(&mut guest, &mut decoder, 2).await;
    let msg_a = messages.remove(0);
    let msg_b = messages.remove(0);
    assert_eq!(msg_a.msg_type, MSG_COMMAND_START);
    assert_eq!(msg_b.msg_type, MSG_COMMAND_START);

    send_command_result(
        &mut guest,
        msg_b.seq,
        CommandTermination::Exited { exit_code: 2 },
        b"b",
        b"",
    )
    .await;
    send_command_result(
        &mut guest,
        msg_a.seq,
        CommandTermination::Exited { exit_code: 1 },
        b"a",
        b"",
    )
    .await;

    let first = first.wait(Duration::from_secs(5)).await.unwrap();
    let second = second.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(
        first.termination,
        CommandTermination::Exited { exit_code: 1 }
    );
    assert_eq!(
        first.stdout,
        CommandOwnedCapturedOutput::Captured {
            bytes: b"a".to_vec(),
            truncated: false,
        }
    );
    assert_eq!(
        second.termination,
        CommandTermination::Exited { exit_code: 2 }
    );
    assert_eq!(
        second.stdout,
        CommandOwnedCapturedOutput::Captured {
            bytes: b"b".to_vec(),
            truncated: false,
        }
    );
}

#[tokio::test]
async fn command_stream_dispatches_stdout_stderr_and_closes_on_result() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let mut handle = host
        .command_stream(CommandStreamRequest {
            timeout_ms: 5000,
            command: "stream",
            env: &[],
            sudo: false,
            label: "stream-test",
            stdout: CommandOutputPolicy::Stream {
                limit_bytes: 1024,
                chunk_limit_bytes: 16,
            },
            stderr: CommandOutputPolicy::Stream {
                limit_bytes: 1024,
                chunk_limit_bytes: 16,
            },
            expected_exit_codes: &[],
            stream_queue_capacity: None,
        })
        .await
        .unwrap();
    let mut rx = handle.take_stream_receiver().unwrap();

    let msg = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(msg.msg_type, MSG_COMMAND_START);
    send_command_output(
        &mut guest,
        msg.seq,
        0,
        CommandOutputStream::Stdout,
        b"out",
        false,
    )
    .await;
    send_command_output(
        &mut guest,
        msg.seq,
        1,
        CommandOutputStream::Stderr,
        b"err",
        true,
    )
    .await;

    let out = rx.recv().await.unwrap();
    assert_eq!(out.stream, CommandOutputStream::Stdout);
    assert_eq!(out.output_seq, 0);
    assert_eq!(out.chunk, b"out");
    assert!(!out.truncated);

    let err = rx.recv().await.unwrap();
    assert_eq!(err.stream, CommandOutputStream::Stderr);
    assert_eq!(err.output_seq, 1);
    assert_eq!(err.chunk, b"err");
    assert!(err.truncated);

    send_discarded_command_result(
        &mut guest,
        msg.seq,
        CommandTermination::Exited { exit_code: 0 },
    )
    .await;
    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert!(!result.stream_overflowed);
    assert!(rx.recv().await.is_none());
}

#[tokio::test]
async fn command_stream_full_channel_closes_stream_and_marks_result() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let mut handle = host
        .command_stream(CommandStreamRequest {
            timeout_ms: 5000,
            command: "stream",
            env: &[],
            sudo: false,
            label: "stream-overflow",
            stdout: CommandOutputPolicy::Stream {
                limit_bytes: 1024,
                chunk_limit_bytes: 16,
            },
            stderr: CommandOutputPolicy::Discard,
            expected_exit_codes: &[],
            stream_queue_capacity: Some(1),
        })
        .await
        .unwrap();
    let mut rx = handle.take_stream_receiver().unwrap();

    let msg = read_guest_message(&mut guest, &mut decoder).await;
    send_command_output(
        &mut guest,
        msg.seq,
        0,
        CommandOutputStream::Stdout,
        b"first",
        false,
    )
    .await;
    send_command_output(
        &mut guest,
        msg.seq,
        1,
        CommandOutputStream::Stdout,
        b"second",
        false,
    )
    .await;
    send_discarded_command_result(
        &mut guest,
        msg.seq,
        CommandTermination::Exited { exit_code: 0 },
    )
    .await;

    let first = rx.recv().await.unwrap();
    assert_eq!(first.output_seq, 0);
    assert_eq!(first.chunk, b"first");
    assert!(rx.recv().await.is_none());

    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert!(result.stream_overflowed);
}

#[tokio::test]
async fn command_stream_many_chunks_soak_does_not_block_terminal_result() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let mut handle = host
        .command_stream(CommandStreamRequest {
            timeout_ms: 5000,
            command: "stream-many",
            env: &[],
            sudo: false,
            label: "stream-many",
            stdout: CommandOutputPolicy::Stream {
                limit_bytes: 1024,
                chunk_limit_bytes: 16,
            },
            stderr: CommandOutputPolicy::Discard,
            expected_exit_codes: &[],
            stream_queue_capacity: Some(2),
        })
        .await
        .unwrap();
    let mut rx = handle.take_stream_receiver().unwrap();

    let msg = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(msg.msg_type, MSG_COMMAND_START);
    for output_seq in 0..32 {
        send_command_output(
            &mut guest,
            msg.seq,
            output_seq,
            CommandOutputStream::Stdout,
            b"x",
            false,
        )
        .await;
    }
    send_discarded_command_result(
        &mut guest,
        msg.seq,
        CommandTermination::Exited { exit_code: 0 },
    )
    .await;

    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert!(result.stream_overflowed);
    assert_eq!(operation_count(&host), 0);
    let mut buffered_chunks = 0;
    loop {
        match rx.try_recv() {
            Ok(_) => buffered_chunks += 1,
            Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => break,
            Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {
                panic!("stream receiver should be closed after terminal result");
            }
        }
    }
    assert!(buffered_chunks <= 2);
}

#[tokio::test]
async fn command_output_for_non_streamed_side_poisons_connection() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let handle = host
        .command_stream(CommandStreamRequest {
            timeout_ms: 5000,
            command: "stream",
            env: &[],
            sudo: false,
            label: "stream-side",
            stdout: CommandOutputPolicy::Discard,
            stderr: CommandOutputPolicy::Stream {
                limit_bytes: 1024,
                chunk_limit_bytes: 16,
            },
            expected_exit_codes: &[],
            stream_queue_capacity: Some(1),
        })
        .await
        .unwrap();

    let msg = read_guest_message(&mut guest, &mut decoder).await;
    send_command_output(
        &mut guest,
        msg.seq,
        0,
        CommandOutputStream::Stdout,
        b"unexpected",
        false,
    )
    .await;

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn command_output_seq_gap_poisons_connection() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let handle = host
        .command_stream(CommandStreamRequest {
            timeout_ms: 5000,
            command: "stream",
            env: &[],
            sudo: false,
            label: "stream-seq",
            stdout: CommandOutputPolicy::Stream {
                limit_bytes: 1024,
                chunk_limit_bytes: 16,
            },
            stderr: CommandOutputPolicy::Discard,
            expected_exit_codes: &[],
            stream_queue_capacity: Some(1),
        })
        .await
        .unwrap();

    let msg = read_guest_message(&mut guest, &mut decoder).await;
    send_command_output(
        &mut guest,
        msg.seq,
        1,
        CommandOutputStream::Stdout,
        b"gap",
        false,
    )
    .await;

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn command_output_zero_stream_limit_accepts_empty_truncation_marker() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let mut handle = host
        .command_stream(CommandStreamRequest {
            timeout_ms: 5000,
            command: "stream",
            env: &[],
            sudo: false,
            label: "stream-zero-limit",
            stdout: CommandOutputPolicy::Stream {
                limit_bytes: 0,
                chunk_limit_bytes: 16,
            },
            stderr: CommandOutputPolicy::Discard,
            expected_exit_codes: &[],
            stream_queue_capacity: Some(1),
        })
        .await
        .unwrap();
    let mut rx = handle.take_stream_receiver().unwrap();

    let msg = read_guest_message(&mut guest, &mut decoder).await;
    send_command_output(
        &mut guest,
        msg.seq,
        0,
        CommandOutputStream::Stdout,
        b"",
        true,
    )
    .await;
    send_discarded_command_result(
        &mut guest,
        msg.seq,
        CommandTermination::Exited { exit_code: 0 },
    )
    .await;

    let event = rx.recv().await.unwrap();
    assert_eq!(event.output_seq, 0);
    assert_eq!(event.chunk, b"");
    assert!(event.truncated);
    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert!(!result.stream_overflowed);
}

#[tokio::test]
async fn command_output_empty_non_truncated_poisons_connection() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let handle = host
        .command_stream(CommandStreamRequest {
            timeout_ms: 5000,
            command: "stream",
            env: &[],
            sudo: false,
            label: "stream-empty",
            stdout: CommandOutputPolicy::Stream {
                limit_bytes: 1024,
                chunk_limit_bytes: 16,
            },
            stderr: CommandOutputPolicy::Discard,
            expected_exit_codes: &[],
            stream_queue_capacity: Some(1),
        })
        .await
        .unwrap();

    let msg = read_guest_message(&mut guest, &mut decoder).await;
    send_command_output(
        &mut guest,
        msg.seq,
        0,
        CommandOutputStream::Stdout,
        b"",
        false,
    )
    .await;

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn command_output_over_requested_chunk_limit_poisons_connection() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let handle = host
        .command_stream(CommandStreamRequest {
            timeout_ms: 5000,
            command: "stream",
            env: &[],
            sudo: false,
            label: "stream-limits",
            stdout: CommandOutputPolicy::Stream {
                limit_bytes: 4,
                chunk_limit_bytes: 3,
            },
            stderr: CommandOutputPolicy::Discard,
            expected_exit_codes: &[],
            stream_queue_capacity: Some(4),
        })
        .await
        .unwrap();

    let msg = read_guest_message(&mut guest, &mut decoder).await;
    send_command_output(
        &mut guest,
        msg.seq,
        0,
        CommandOutputStream::Stdout,
        b"abcd",
        false,
    )
    .await;

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn command_output_over_requested_stream_limit_poisons_connection() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let handle = host
        .command_stream(CommandStreamRequest {
            timeout_ms: 5000,
            command: "stream",
            env: &[],
            sudo: false,
            label: "stream-total-limit",
            stdout: CommandOutputPolicy::Stream {
                limit_bytes: 4,
                chunk_limit_bytes: 3,
            },
            stderr: CommandOutputPolicy::Discard,
            expected_exit_codes: &[],
            stream_queue_capacity: Some(4),
        })
        .await
        .unwrap();

    let msg = read_guest_message(&mut guest, &mut decoder).await;
    send_command_output(
        &mut guest,
        msg.seq,
        0,
        CommandOutputStream::Stdout,
        b"abc",
        false,
    )
    .await;
    send_command_output(
        &mut guest,
        msg.seq,
        1,
        CommandOutputStream::Stdout,
        b"de",
        false,
    )
    .await;

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn command_output_after_truncation_poisons_connection() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let handle = host
        .command_stream(CommandStreamRequest {
            timeout_ms: 5000,
            command: "stream",
            env: &[],
            sudo: false,
            label: "stream-truncated",
            stdout: CommandOutputPolicy::Stream {
                limit_bytes: 4,
                chunk_limit_bytes: 4,
            },
            stderr: CommandOutputPolicy::Discard,
            expected_exit_codes: &[],
            stream_queue_capacity: Some(4),
        })
        .await
        .unwrap();

    let msg = read_guest_message(&mut guest, &mut decoder).await;
    send_command_output(
        &mut guest,
        msg.seq,
        0,
        CommandOutputStream::Stdout,
        b"",
        true,
    )
    .await;
    send_command_output(
        &mut guest,
        msg.seq,
        1,
        CommandOutputStream::Stdout,
        b"late",
        false,
    )
    .await;

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn command_stream_dropped_receiver_does_not_block_result() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let mut handle = host
        .command_stream(CommandStreamRequest {
            timeout_ms: 5000,
            command: "stream",
            env: &[],
            sudo: false,
            label: "stream-dropped",
            stdout: CommandOutputPolicy::Stream {
                limit_bytes: 1024,
                chunk_limit_bytes: 16,
            },
            stderr: CommandOutputPolicy::Discard,
            expected_exit_codes: &[],
            stream_queue_capacity: Some(1),
        })
        .await
        .unwrap();
    drop(handle.take_stream_receiver());

    let msg = read_guest_message(&mut guest, &mut decoder).await;
    send_command_output(
        &mut guest,
        msg.seq,
        0,
        CommandOutputStream::Stdout,
        b"ignored",
        false,
    )
    .await;
    send_discarded_command_result(
        &mut guest,
        msg.seq,
        CommandTermination::Exited { exit_code: 0 },
    )
    .await;

    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert!(!result.stream_overflowed);
}

#[tokio::test]
async fn command_wait_timeout_cleans_operation_state() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let handle = start_capture_operation(&host, "timeout").await;
    let msg = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(msg.msg_type, MSG_COMMAND_START);
    assert_eq!(operation_count(&host), 1);

    let err = handle.wait(Duration::ZERO).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    assert_eq!(operation_count(&host), 0);
    assert!(is_connected(&host));
}

#[tokio::test]
async fn command_error_response_completes_operation_without_timeout() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let handle = start_capture_operation(&host, "error-response").await;
    let msg = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(msg.msg_type, MSG_COMMAND_START);

    let payload = vsock_proto::encode_error("command operation already active");
    let frame = vsock_proto::encode(MSG_ERROR, msg.seq, &payload).unwrap();
    guest.write_all(&frame).await.unwrap();

    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::Other);
    assert_eq!(err.to_string(), "command operation already active");
    assert_eq!(operation_count(&host), 0);

    assert_connection_accepts_command_exec(&host, &mut guest, &mut decoder).await;
}

#[tokio::test]
async fn malformed_command_error_poisons_connection() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let handle = start_capture_operation(&host, "bad-error").await;
    let msg = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(msg.msg_type, MSG_COMMAND_START);

    let frame = vsock_proto::encode(MSG_ERROR, msg.seq, &[0]).unwrap();
    guest.write_all(&frame).await.unwrap();

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn command_connection_close_wakes_result_and_stream() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let mut handle = host
        .command_stream(CommandStreamRequest {
            timeout_ms: 5000,
            command: "stream",
            env: &[],
            sudo: false,
            label: "close",
            stdout: CommandOutputPolicy::Stream {
                limit_bytes: 1024,
                chunk_limit_bytes: 16,
            },
            stderr: CommandOutputPolicy::Discard,
            expected_exit_codes: &[],
            stream_queue_capacity: Some(1),
        })
        .await
        .unwrap();
    let mut rx = handle.take_stream_receiver().unwrap();
    let msg = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(msg.msg_type, MSG_COMMAND_START);

    drop(guest);
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    assert!(rx.recv().await.is_none());
}

#[tokio::test]
async fn command_start_after_connection_close_returns_connection_reset() {
    let (host, guest, _decoder) = setup_host_and_guest().await;
    drop(guest);
    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();

    let err = match host
        .start_command_operation(CommandOperationRequest {
            timeout_ms: 5000,
            command: "echo ok",
            env: &[],
            sudo: false,
            label: "closed",
            stdout: CommandOutputPolicy::Capture { limit_bytes: 1024 },
            stderr: CommandOutputPolicy::Capture { limit_bytes: 1024 },
            expected_exit_codes: &[],
            stream_queue_capacity: None,
        })
        .await
    {
        Ok(_) => panic!("command start after connection close should fail"),
        Err(err) => err,
    };
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    assert_eq!(operation_count(&host), 0);
}

#[tokio::test]
async fn host_drop_closes_active_command_result_and_stream() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let mut handle = host
        .command_stream(CommandStreamRequest {
            timeout_ms: 5000,
            command: "stream",
            env: &[],
            sudo: false,
            label: "host-drop",
            stdout: CommandOutputPolicy::Stream {
                limit_bytes: 1024,
                chunk_limit_bytes: 16,
            },
            stderr: CommandOutputPolicy::Discard,
            expected_exit_codes: &[],
            stream_queue_capacity: Some(1),
        })
        .await
        .unwrap();
    let mut rx = handle.take_stream_receiver().unwrap();
    let msg = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(msg.msg_type, MSG_COMMAND_START);

    drop(host);

    let err = tokio::time::timeout(Duration::from_secs(5), handle.wait(Duration::from_secs(60)))
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    assert!(rx.recv().await.is_none());
}

#[tokio::test]
async fn malformed_command_output_poisons_connection() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let handle = start_capture_operation(&host, "bad-output").await;
    let msg = read_guest_message(&mut guest, &mut decoder).await;
    let frame = vsock_proto::encode(MSG_COMMAND_OUTPUT, msg.seq, &[0]).unwrap();
    guest.write_all(&frame).await.unwrap();

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn malformed_command_result_poisons_connection() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let handle = start_capture_operation(&host, "bad-result").await;
    let msg = read_guest_message(&mut guest, &mut decoder).await;
    let frame = vsock_proto::encode(MSG_COMMAND_RESULT, msg.seq, &[0]).unwrap();
    guest.write_all(&frame).await.unwrap();

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn command_output_after_result_does_not_poison_or_resurrect_state() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let handle = start_capture_operation(&host, "done").await;
    let msg = read_guest_message(&mut guest, &mut decoder).await;
    send_command_result(
        &mut guest,
        msg.seq,
        CommandTermination::Exited { exit_code: 0 },
        b"done",
        b"",
    )
    .await;
    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(
        result.termination,
        CommandTermination::Exited { exit_code: 0 }
    );
    assert_eq!(operation_count(&host), 0);

    send_command_output(
        &mut guest,
        msg.seq,
        1,
        CommandOutputStream::Stdout,
        b"late",
        false,
    )
    .await;

    let exec_task = tokio::spawn(async move { host.exec("echo ok", 5000, &[], false).await });
    let exec_msg = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(exec_msg.msg_type, MSG_COMMAND_START);
    let decoded = vsock_proto::decode_command_start(&exec_msg.payload).unwrap();
    assert_eq!(decoded.command, "echo ok");
    send_command_result(
        &mut guest,
        exec_msg.seq,
        CommandTermination::Exited { exit_code: 0 },
        b"ok",
        b"",
    )
    .await;
    let exec_result = exec_task.await.unwrap().unwrap();
    assert_eq!(exec_result.stdout, b"ok");
}

#[tokio::test]
async fn malformed_command_output_after_result_is_ignored() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let handle = start_capture_operation(&host, "done").await;
    let msg = read_guest_message(&mut guest, &mut decoder).await;
    send_command_result(
        &mut guest,
        msg.seq,
        CommandTermination::Exited { exit_code: 0 },
        b"done",
        b"",
    )
    .await;
    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(
        result.termination,
        CommandTermination::Exited { exit_code: 0 }
    );
    assert_eq!(operation_count(&host), 0);

    let frame = vsock_proto::encode(MSG_COMMAND_OUTPUT, msg.seq, &[0]).unwrap();
    guest.write_all(&frame).await.unwrap();

    assert_connection_accepts_command_exec(&host, &mut guest, &mut decoder).await;
}

#[tokio::test]
async fn malformed_command_frames_after_handle_drop_are_ignored() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let handle = start_capture_operation(&host, "abandoned").await;
    let msg = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(msg.msg_type, MSG_COMMAND_START);
    assert_eq!(operation_count(&host), 1);

    drop(handle);
    wait_for_operation_count(&host, 0).await;

    let output_frame = vsock_proto::encode(MSG_COMMAND_OUTPUT, msg.seq, &[0]).unwrap();
    guest.write_all(&output_frame).await.unwrap();
    let result_frame = vsock_proto::encode(MSG_COMMAND_RESULT, msg.seq, &[0]).unwrap();
    guest.write_all(&result_frame).await.unwrap();

    assert_connection_accepts_command_exec(&host, &mut guest, &mut decoder).await;
}

#[tokio::test]
async fn duplicate_command_result_after_completion_is_ignored() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let handle = start_capture_operation(&host, "duplicate-result").await;
    let msg = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(msg.msg_type, MSG_COMMAND_START);

    send_command_result(
        &mut guest,
        msg.seq,
        CommandTermination::Exited { exit_code: 0 },
        b"first",
        b"",
    )
    .await;
    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(
        result.stdout,
        CommandOwnedCapturedOutput::Captured {
            bytes: b"first".to_vec(),
            truncated: false,
        }
    );
    assert_eq!(operation_count(&host), 0);

    send_command_result(
        &mut guest,
        msg.seq,
        CommandTermination::Exited { exit_code: 1 },
        b"duplicate",
        b"",
    )
    .await;

    assert_connection_accepts_command_exec(&host, &mut guest, &mut decoder).await;
}

#[tokio::test]
async fn malformed_duplicate_command_result_after_completion_is_ignored() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let handle = start_capture_operation(&host, "malformed-duplicate-result").await;
    let msg = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(msg.msg_type, MSG_COMMAND_START);

    send_command_result(
        &mut guest,
        msg.seq,
        CommandTermination::Exited { exit_code: 0 },
        b"first",
        b"",
    )
    .await;
    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(
        result.stdout,
        CommandOwnedCapturedOutput::Captured {
            bytes: b"first".to_vec(),
            truncated: false,
        }
    );
    assert_eq!(operation_count(&host), 0);

    let frame = vsock_proto::encode(MSG_COMMAND_RESULT, msg.seq, &[0]).unwrap();
    guest.write_all(&frame).await.unwrap();

    assert_connection_accepts_command_exec(&host, &mut guest, &mut decoder).await;
}

#[tokio::test]
async fn command_start_cancelled_before_write_does_not_poison_or_send_frame() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let writer_guard = host.shared.writer.lock().await;
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { start_capture_operation(&host, "blocked").await })
    };

    tokio::time::timeout(Duration::from_secs(5), async {
        while operation_count(&host) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    task.abort();
    let _ = task.await;
    assert_eq!(operation_count(&host), 0);
    assert!(is_connected(&host));

    drop(writer_guard);
    let exec_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.exec("echo ok", 5000, &[], false).await })
    };
    let msg = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(
        msg.msg_type, MSG_COMMAND_START,
        "start frame should not be written"
    );
    send_command_result(
        &mut guest,
        msg.seq,
        CommandTermination::Exited { exit_code: 0 },
        b"ok",
        b"",
    )
    .await;
    let exec_result = exec_task.await.unwrap().unwrap();
    assert_eq!(exec_result.stdout, b"ok");
    assert!(is_connected(&host));
}

#[tokio::test]
async fn command_handle_drop_after_full_write_sends_no_cancel() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let handle = start_capture_operation(&host, "drop-after-write").await;
    let msg = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(msg.msg_type, MSG_COMMAND_START);
    drop(handle);
    assert_eq!(operation_count(&host), 0);

    let exec_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.exec("echo ok", 5000, &[], false).await })
    };
    let msg = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(
        msg.msg_type, MSG_COMMAND_START,
        "drop must not send command cancel"
    );
    send_command_result(
        &mut guest,
        msg.seq,
        CommandTermination::Exited { exit_code: 0 },
        b"ok",
        b"",
    )
    .await;
    let exec_result = exec_task.await.unwrap().unwrap();
    assert_eq!(exec_result.stdout, b"ok");
    assert!(is_connected(&host));
}

#[tokio::test]
async fn command_cancel_sends_cancel_and_waits_for_cancelled_result() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let handle = start_capture_operation(&host, "cancel").await;
    let start = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(start.msg_type, MSG_COMMAND_START);

    let cancel_task =
        tokio::spawn(async move { handle.cancel_and_wait(Duration::from_secs(5)).await });
    let cancel = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(cancel.msg_type, MSG_COMMAND_CANCEL);
    assert_eq!(cancel.seq, start.seq);
    vsock_proto::decode_command_cancel(&cancel.payload).unwrap();

    send_command_result(
        &mut guest,
        start.seq,
        CommandTermination::Cancelled,
        b"",
        b"",
    )
    .await;
    let result = cancel_task.await.unwrap().unwrap();
    assert_eq!(result.termination, CommandTermination::Cancelled);
}

#[tokio::test]
async fn command_cancel_after_terminal_result_returns_result_without_cancel_frame() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let handle = start_capture_operation(&host, "already-done").await;
    let start = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(start.msg_type, MSG_COMMAND_START);
    send_command_result(
        &mut guest,
        start.seq,
        CommandTermination::Exited { exit_code: 0 },
        b"done",
        b"",
    )
    .await;
    wait_for_operation_count(&host, 0).await;

    let result = handle
        .cancel_and_wait(Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(
        result.termination,
        CommandTermination::Exited { exit_code: 0 }
    );

    assert_connection_accepts_command_exec(&host, &mut guest, &mut decoder).await;
}

#[tokio::test]
async fn command_cancel_non_cancelled_terminal_result_cleans_operation_without_poisoning() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let handle = start_capture_operation(&host, "cancel-race").await;
    let start = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(start.msg_type, MSG_COMMAND_START);

    let cancel_task =
        tokio::spawn(async move { handle.cancel_and_wait(Duration::from_secs(5)).await });
    let cancel = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(cancel.msg_type, MSG_COMMAND_CANCEL);
    assert_eq!(cancel.seq, start.seq);

    send_command_result(
        &mut guest,
        start.seq,
        CommandTermination::Exited { exit_code: 0 },
        b"",
        b"",
    )
    .await;
    let err = cancel_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::Other);
    assert_eq!(operation_count(&host), 0);
    assert!(is_connected(&host));

    assert_connection_accepts_command_exec(&host, &mut guest, &mut decoder).await;
}

#[tokio::test]
async fn command_cancel_result_timeout_poisons_connection() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let handle = start_capture_operation(&host, "cancel-timeout").await;
    let start = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(start.msg_type, MSG_COMMAND_START);

    let cancel_task = tokio::spawn(async move { handle.cancel_and_wait(Duration::ZERO).await });
    let cancel = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(cancel.msg_type, MSG_COMMAND_CANCEL);
    assert_eq!(cancel.seq, start.seq);

    let err = cancel_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
}

#[tokio::test]
async fn command_frame_write_guard_started_drop_poisons_connection() {
    let (host, _guest, _decoder) = setup_host_and_guest().await;
    command_impl::test_support::drop_started_frame_write_guard(Arc::clone(&host.shared));
    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
}

#[tokio::test]
async fn test_exec() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_COMMAND_START);

        let d = vsock_proto::decode_command_start(&msgs[0].payload).unwrap();
        assert_eq!(d.command, "echo hello");
        assert_eq!(d.timeout_ms, 5000);
        assert!(d.env.is_empty());
        assert!(!d.sudo);
        assert_eq!(d.label, "exec");

        send_command_result(
            &mut guest,
            msgs[0].seq,
            CommandTermination::Exited { exit_code: 0 },
            b"hello\n",
            b"",
        )
        .await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let result = host.exec("echo hello", 5000, &[], false).await.unwrap();
    assert_eq!(result.exit_code, 0);
    assert_eq!(result.stdout, b"hello\n");
    assert!(result.stderr.is_empty());
}

/// `host.exec` with `timeout_ms == 0` must reject at the boundary rather
/// than send the request to the guest — an unbounded exec would leak a
/// guest-side orphan when the host's outer timeout fires.
#[tokio::test]
async fn test_exec_rejects_zero_timeout() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let err = host.exec("echo hi", 0, &[], false).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
}

#[tokio::test]
async fn test_exec_error_response() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();

        let payload = vsock_proto::encode_error("command not found");
        let resp = vsock_proto::encode(MSG_ERROR, msgs[0].seq, &payload).unwrap();
        guest.write_all(&resp).await.unwrap();
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let err = host.exec("badcmd", 5000, &[], false).await.unwrap_err();
    assert!(err.to_string().contains("command not found"));
}
