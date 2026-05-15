use std::io;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use vsock_proto::{
    ExecCapturedOutput, ExecOutputPolicy, ExecTermination, MSG_EXEC_RESULT, MSG_EXEC_START,
};

use super::super::support::{
    assert_connection_accepts_exec_operation, is_connected, operation_count, read_guest_message,
    read_guest_messages, send_exec_result, send_raw_exec_result, setup_host_and_guest,
};
use super::start_capture_operation;
use crate::{ExecCaptureRequest, ExecOperationRequest, ExecOwnedCapturedOutput};

#[tokio::test]
async fn exec_operation_capture_sends_start_and_receives_result() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.exec_operation_capture(ExecCaptureRequest {
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
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    let decoded = vsock_proto::decode_exec_start(&msg.payload).unwrap();
    assert_eq!(decoded.timeout_ms, 7000);
    assert_eq!(decoded.command, "printf hello");
    assert_eq!(decoded.env, vec![("A", "B")]);
    assert!(decoded.sudo);
    assert_eq!(decoded.label, "capture-test");
    assert_eq!(decoded.stdout, ExecOutputPolicy::Capture { limit_bytes: 7 });
    assert_eq!(decoded.stderr, ExecOutputPolicy::Capture { limit_bytes: 9 });
    assert!(decoded.expected_exit_codes.is_empty());

    send_exec_result(
        &mut guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"stdout",
        b"stderr",
    )
    .await;

    let result = task.await.unwrap().unwrap();
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert_eq!(
        result.stdout,
        ExecOwnedCapturedOutput::Captured {
            bytes: b"stdout".to_vec(),
            truncated: false,
        }
    );
    assert_eq!(
        result.stderr,
        ExecOwnedCapturedOutput::Captured {
            bytes: b"stderr".to_vec(),
            truncated: false,
        }
    );
    assert_eq!(operation_count(&host), 0);
}

#[tokio::test]
async fn exec_start_sends_expected_exit_codes() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;

    let handle = host
        .start_exec_operation(ExecOperationRequest {
            timeout_ms: 5000,
            command: "optional",
            env: &[],
            sudo: false,
            label: "expected-exit",
            stdout: ExecOutputPolicy::Capture { limit_bytes: 16 },
            stderr: ExecOutputPolicy::Capture { limit_bytes: 16 },
            expected_exit_codes: &[66],
            stream_queue_capacity: None,
        })
        .await
        .unwrap();

    let msg = read_guest_message(&mut guest, &mut decoder).await;
    let decoded = vsock_proto::decode_exec_start(&msg.payload).unwrap();
    assert_eq!(decoded.expected_exit_codes, vec![66]);

    send_exec_result(
        &mut guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 66 },
        b"",
        b"",
    )
    .await;
    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(
        result.termination,
        ExecTermination::Exited { exit_code: 66 }
    );
}

#[tokio::test]
async fn exec_operation_capture_repeated_short_operations_soak() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let host = Arc::new(host);

    for i in 0..8 {
        let label = format!("repeat-{i}");
        let handle = host
            .start_exec_operation(ExecOperationRequest {
                timeout_ms: 5000,
                command: "printf ok",
                env: &[],
                sudo: false,
                label: &label,
                stdout: ExecOutputPolicy::Capture { limit_bytes: 16 },
                stderr: ExecOutputPolicy::Capture { limit_bytes: 16 },
                expected_exit_codes: &[],
                stream_queue_capacity: None,
            })
            .await
            .unwrap();

        let msg = read_guest_message(&mut guest, &mut decoder).await;
        assert_eq!(msg.msg_type, MSG_EXEC_START);
        let stdout = format!("ok-{i}");
        send_exec_result(
            &mut guest,
            msg.seq,
            ExecTermination::Exited { exit_code: 0 },
            stdout.as_bytes(),
            b"",
        )
        .await;

        let result = handle.wait(Duration::from_secs(5)).await.unwrap();
        assert_eq!(
            result.stdout,
            ExecOwnedCapturedOutput::Captured {
                bytes: stdout.into_bytes(),
                truncated: false,
            }
        );
        assert_eq!(operation_count(&host), 0);
        assert!(is_connected(&host));
    }

    assert_connection_accepts_exec_operation(&host, &mut guest, &mut decoder).await;
}

#[tokio::test]
async fn exec_operation_capture_large_stdout_stderr_within_limits_soak() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let stdout = vec![b'o'; 64 * 1024];
    let stderr = vec![b'e'; 64 * 1024];
    let handle = host
        .start_exec_operation(ExecOperationRequest {
            timeout_ms: 5000,
            command: "large-capture",
            env: &[],
            sudo: false,
            label: "large-capture",
            stdout: ExecOutputPolicy::Capture {
                limit_bytes: stdout.len() as u32,
            },
            stderr: ExecOutputPolicy::Capture {
                limit_bytes: stderr.len() as u32,
            },
            expected_exit_codes: &[],
            stream_queue_capacity: None,
        })
        .await
        .unwrap();

    let msg = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    send_exec_result(
        &mut guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 0 },
        &stdout,
        &stderr,
    )
    .await;

    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(
        result.stdout,
        ExecOwnedCapturedOutput::Captured {
            bytes: stdout,
            truncated: false,
        }
    );
    assert_eq!(
        result.stderr,
        ExecOwnedCapturedOutput::Captured {
            bytes: stderr,
            truncated: false,
        }
    );
    assert_eq!(operation_count(&host), 0);
    assert!(is_connected(&host));
}

#[tokio::test]
async fn exec_result_preserves_non_default_metadata() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let handle = host
        .start_exec_operation(ExecOperationRequest {
            timeout_ms: 5000,
            command: "metadata",
            env: &[],
            sudo: false,
            label: "metadata",
            stdout: ExecOutputPolicy::Discard,
            stderr: ExecOutputPolicy::Capture { limit_bytes: 1024 },
            expected_exit_codes: &[],
            stream_queue_capacity: None,
        })
        .await
        .unwrap();
    let msg = read_guest_message(&mut guest, &mut decoder).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);

    let payload = vsock_proto::encode_exec_result(
        ExecTermination::WaitFailed,
        345,
        ExecCapturedOutput::Discarded,
        ExecCapturedOutput::Captured {
            bytes: b"stderr",
            truncated: true,
        },
        "wait failed",
    )
    .unwrap();
    let frame = vsock_proto::encode(MSG_EXEC_RESULT, msg.seq, &payload).unwrap();
    guest.write_all(&frame).await.unwrap();

    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(result.termination, ExecTermination::WaitFailed);
    assert_eq!(result.duration_ms, 345);
    assert_eq!(result.stdout, ExecOwnedCapturedOutput::Discarded);
    assert_eq!(
        result.stderr,
        ExecOwnedCapturedOutput::Captured {
            bytes: b"stderr".to_vec(),
            truncated: true,
        }
    );
    assert_eq!(result.diagnostic, "wait failed");
}

#[tokio::test]
async fn exec_result_capture_for_discard_policy_poisons_connection() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let handle = host
        .start_exec_operation(ExecOperationRequest {
            timeout_ms: 5000,
            command: "discard",
            env: &[],
            sudo: false,
            label: "discard-result",
            stdout: ExecOutputPolicy::Discard,
            stderr: ExecOutputPolicy::Discard,
            expected_exit_codes: &[],
            stream_queue_capacity: None,
        })
        .await
        .unwrap();

    let msg = read_guest_message(&mut guest, &mut decoder).await;
    let payload = vsock_proto::encode_exec_result(
        ExecTermination::Exited { exit_code: 0 },
        1,
        ExecCapturedOutput::Captured {
            bytes: b"unexpected",
            truncated: false,
        },
        ExecCapturedOutput::Discarded,
        "",
    )
    .unwrap();
    send_raw_exec_result(&mut guest, msg.seq, payload).await;

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn exec_result_over_capture_limit_poisons_connection() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let handle = host
        .start_exec_operation(ExecOperationRequest {
            timeout_ms: 5000,
            command: "capture-limit",
            env: &[],
            sudo: false,
            label: "capture-limit",
            stdout: ExecOutputPolicy::Capture { limit_bytes: 4 },
            stderr: ExecOutputPolicy::Discard,
            expected_exit_codes: &[],
            stream_queue_capacity: None,
        })
        .await
        .unwrap();

    let msg = read_guest_message(&mut guest, &mut decoder).await;
    let payload = vsock_proto::encode_exec_result(
        ExecTermination::Exited { exit_code: 0 },
        1,
        ExecCapturedOutput::Captured {
            bytes: b"abcde",
            truncated: true,
        },
        ExecCapturedOutput::Discarded,
        "",
    )
    .unwrap();
    send_raw_exec_result(&mut guest, msg.seq, payload).await;

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn exec_result_discard_for_capture_policy_poisons_connection() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let handle = host
        .start_exec_operation(ExecOperationRequest {
            timeout_ms: 5000,
            command: "missing-capture",
            env: &[],
            sudo: false,
            label: "missing-capture",
            stdout: ExecOutputPolicy::Capture { limit_bytes: 4 },
            stderr: ExecOutputPolicy::Discard,
            expected_exit_codes: &[],
            stream_queue_capacity: None,
        })
        .await
        .unwrap();

    let msg = read_guest_message(&mut guest, &mut decoder).await;
    let payload = vsock_proto::encode_exec_result(
        ExecTermination::Exited { exit_code: 0 },
        1,
        ExecCapturedOutput::Discarded,
        ExecCapturedOutput::Discarded,
        "",
    )
    .unwrap();
    send_raw_exec_result(&mut guest, msg.seq, payload).await;

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    let err = handle.wait(Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn exec_result_zero_capture_limit_accepts_empty_capture() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let handle = host
        .start_exec_operation(ExecOperationRequest {
            timeout_ms: 5000,
            command: "zero-capture",
            env: &[],
            sudo: false,
            label: "zero-capture",
            stdout: ExecOutputPolicy::Capture { limit_bytes: 0 },
            stderr: ExecOutputPolicy::Capture { limit_bytes: 0 },
            expected_exit_codes: &[],
            stream_queue_capacity: None,
        })
        .await
        .unwrap();

    let msg = read_guest_message(&mut guest, &mut decoder).await;
    let payload = vsock_proto::encode_exec_result(
        ExecTermination::Exited { exit_code: 0 },
        1,
        ExecCapturedOutput::Captured {
            bytes: b"",
            truncated: true,
        },
        ExecCapturedOutput::Captured {
            bytes: b"",
            truncated: false,
        },
        "",
    )
    .unwrap();
    send_raw_exec_result(&mut guest, msg.seq, payload).await;

    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(
        result.stdout,
        ExecOwnedCapturedOutput::Captured {
            bytes: Vec::new(),
            truncated: true,
        }
    );
    assert_eq!(
        result.stderr,
        ExecOwnedCapturedOutput::Captured {
            bytes: Vec::new(),
            truncated: false,
        }
    );
    assert!(is_connected(&host));
}

#[tokio::test]
async fn exec_operations_dispatch_out_of_order_results_by_seq() {
    let (host, mut guest, mut decoder) = setup_host_and_guest().await;
    let first = start_capture_operation(&host, "cmd-a").await;
    let second = start_capture_operation(&host, "cmd-b").await;

    let mut messages = read_guest_messages(&mut guest, &mut decoder, 2).await;
    let msg_a = messages.remove(0);
    let msg_b = messages.remove(0);
    assert_eq!(msg_a.msg_type, MSG_EXEC_START);
    assert_eq!(msg_b.msg_type, MSG_EXEC_START);

    send_exec_result(
        &mut guest,
        msg_b.seq,
        ExecTermination::Exited { exit_code: 2 },
        b"b",
        b"",
    )
    .await;
    send_exec_result(
        &mut guest,
        msg_a.seq,
        ExecTermination::Exited { exit_code: 1 },
        b"a",
        b"",
    )
    .await;

    let first = first.wait(Duration::from_secs(5)).await.unwrap();
    let second = second.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(first.termination, ExecTermination::Exited { exit_code: 1 });
    assert_eq!(
        first.stdout,
        ExecOwnedCapturedOutput::Captured {
            bytes: b"a".to_vec(),
            truncated: false,
        }
    );
    assert_eq!(second.termination, ExecTermination::Exited { exit_code: 2 });
    assert_eq!(
        second.stdout,
        ExecOwnedCapturedOutput::Captured {
            bytes: b"b".to_vec(),
            truncated: false,
        }
    );
}
