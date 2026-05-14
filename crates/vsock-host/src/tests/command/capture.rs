use std::io;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use vsock_proto::{
    CommandCapturedOutput, CommandOutputPolicy, CommandTermination, MSG_COMMAND_RESULT,
    MSG_COMMAND_START,
};

use super::super::support::{
    assert_connection_accepts_command_exec, is_connected, operation_count, read_guest_message,
    read_guest_messages, send_command_result, send_raw_command_result, setup_host_and_guest,
};
use super::start_capture_operation;
use crate::{CommandCaptureRequest, CommandOperationRequest, CommandOwnedCapturedOutput};

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
