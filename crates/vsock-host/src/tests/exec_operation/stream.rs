use std::io;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use vsock_proto::{
    ExecCapturedOutput, ExecOutputPolicy, ExecOutputStream, ExecTermination, MSG_EXEC_OUTPUT,
    MSG_EXEC_RESULT, MSG_EXEC_START, MSG_OPERATIONS_QUIESCED, MSG_QUIESCE_OPERATIONS,
};

use super::super::support::{
    assert_connection_accepts_exec_operation, operation_count, read_guest_message,
    send_discarded_exec_result, send_exec_output, send_exec_result, setup_host_and_guest,
};
use crate::{ExecOperationRequest, ExecStreamRequest, exec_operation as exec_operation_impl};

fn stream_request(label: &str) -> ExecStreamRequest<'_> {
    ExecStreamRequest {
        timeout_ms: 5000,
        command: "stream",
        env: &[],
        sudo: false,
        label,
        stdout: ExecOutputPolicy::Stream {
            limit_bytes: 1024,
            chunk_limit_bytes: 16,
        },
        stderr: ExecOutputPolicy::Discard,
        expected_exit_codes: &[],
        stdin_bytes: None,
        stream_queue_capacity: None,
    }
}

fn operation_request(label: &str) -> ExecOperationRequest<'_> {
    ExecOperationRequest {
        timeout_ms: 5000,
        command: "stream",
        env: &[],
        sudo: false,
        label,
        stdout: ExecOutputPolicy::Capture { limit_bytes: 1024 },
        stderr: ExecOutputPolicy::Capture { limit_bytes: 1024 },
        expected_exit_codes: &[],
        stdin_bytes: None,
        stream_queue_capacity: None,
    }
}

async fn assert_stream_request_rejected_without_frame(
    request: ExecStreamRequest<'_>,
    expected_message_substring: Option<&str>,
) {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let label = request.label;

    let err = match host.exec_operation_stream(request).await {
        Ok(_) => panic!("stream request {label:?} should be rejected before sending a frame"),
        Err(err) => err,
    };
    assert_eq!(
        err.kind(),
        io::ErrorKind::InvalidInput,
        "stream request {label:?} returned unexpected error: {err}",
    );
    if let Some(expected) = expected_message_substring {
        assert!(
            err.to_string().contains(expected),
            "stream request {label:?} error should contain {expected:?}, got: {err}",
        );
    }
    assert_eq!(
        operation_count(&host),
        0,
        "stream request {label:?} should not register an operation",
    );

    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

async fn assert_start_request_rejected_without_frame(
    request: ExecOperationRequest<'_>,
    expected_message_substring: Option<&str>,
) {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let label = request.label;

    let err = match host.start_exec_operation(request).await {
        Ok(_) => panic!("exec start request {label:?} should be rejected before sending a frame"),
        Err(err) => err,
    };
    assert_eq!(
        err.kind(),
        io::ErrorKind::InvalidInput,
        "exec start request {label:?} returned unexpected error: {err}",
    );
    if let Some(expected) = expected_message_substring {
        assert!(
            err.to_string().contains(expected),
            "exec start request {label:?} error should contain {expected:?}, got: {err}",
        );
    }
    assert_eq!(
        operation_count(&host),
        0,
        "exec start request {label:?} should not register an operation",
    );

    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

struct StreamOutputFrame<'a> {
    output_seq: u32,
    stream: ExecOutputStream,
    chunk: &'a [u8],
    truncated: bool,
}

async fn assert_stream_output_frames_poison_connection(
    request: ExecStreamRequest<'_>,
    frames: &[StreamOutputFrame<'_>],
) {
    assert!(
        !frames.is_empty(),
        "stream poison helper requires at least one output frame",
    );
    let (host, mut guest) = setup_host_and_guest().await;
    let label = request.label;
    let handle = match host.exec_operation_stream(request).await {
        Ok(handle) => handle,
        Err(err) => panic!("stream request {label:?} should start before poison frames: {err}"),
    };

    let msg = read_guest_message(&mut guest).await;
    assert_eq!(
        msg.msg_type, MSG_EXEC_START,
        "stream request {label:?} should send an exec start before poison frames",
    );
    for frame in frames {
        send_exec_output(
            &mut guest,
            msg.seq,
            frame.output_seq,
            frame.stream,
            frame.chunk,
            frame.truncated,
        )
        .await;
    }

    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap_or_else(|err| {
            panic!("stream request {label:?} should close after poison frames: {err}")
        });
    let err = match handle.wait(Duration::from_secs(5)).await {
        Ok(_) => panic!("stream request {label:?} should fail after poison frames"),
        Err(err) => err,
    };
    assert_eq!(
        err.kind(),
        io::ErrorKind::ConnectionReset,
        "stream request {label:?} should resolve with ConnectionReset after poison frames: {err}",
    );
}

#[tokio::test]
async fn exec_operation_stream_rejects_zero_capacity_without_sending_frame() {
    assert_stream_request_rejected_without_frame(
        ExecStreamRequest {
            stream_queue_capacity: Some(0),
            ..stream_request("zero-capacity")
        },
        None,
    )
    .await;
}

#[tokio::test]
async fn exec_operation_stream_rejects_oversized_capacity_without_sending_frame() {
    assert_stream_request_rejected_without_frame(
        ExecStreamRequest {
            stream_queue_capacity: Some(exec_operation_impl::test_support::MAX_STREAM_CAPACITY + 1),
            ..stream_request("oversized-capacity")
        },
        None,
    )
    .await;
}

#[tokio::test]
async fn exec_operation_stream_rejects_oversized_stdin_without_sending_frame() {
    let stdin_bytes = vec![0; vsock_proto::MAX_EXEC_STDIN_BYTES + 1];

    assert_stream_request_rejected_without_frame(
        ExecStreamRequest {
            command: "cat",
            stdin_bytes: Some(&stdin_bytes),
            ..stream_request("stream-oversized-stdin")
        },
        Some("stdin_bytes"),
    )
    .await;
}

#[tokio::test]
async fn exec_start_stream_policy_uses_default_receiver() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let mut handle = host
        .start_exec_operation(ExecOperationRequest {
            stderr: ExecOutputPolicy::CaptureAndStream {
                capture_limit_bytes: 1024,
                stream_limit_bytes: 1024,
                chunk_limit_bytes: 16,
            },
            ..operation_request("default-receiver")
        })
        .await
        .unwrap();
    let mut rx = handle.take_stream_receiver().unwrap();

    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    send_exec_output(
        &mut guest,
        msg.seq,
        0,
        ExecOutputStream::Stderr,
        b"default-queued",
        false,
    )
    .await;
    let event = rx.recv().await.unwrap();
    assert_eq!(event.stream, ExecOutputStream::Stderr);
    assert_eq!(event.chunk, b"default-queued");
    send_exec_result(
        &mut guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"",
        b"",
    )
    .await;
    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert!(!result.stream_overflowed);
}

#[tokio::test]
async fn exec_operation_stream_sends_stdin_bytes() {
    let (host, mut guest) = setup_host_and_guest().await;

    let handle = host
        .exec_operation_stream(ExecStreamRequest {
            command: "cat",
            stdin_bytes: Some(b"stream-stdin"),
            ..stream_request("stream-stdin")
        })
        .await
        .unwrap();

    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    let decoded = vsock_proto::decode_exec_start(&msg.payload).unwrap();
    assert_eq!(decoded.command, "cat");
    assert_eq!(decoded.stdin_bytes, Some(&b"stream-stdin"[..]));

    send_discarded_exec_result(
        &mut guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 0 },
    )
    .await;
    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
}

#[tokio::test]
async fn exec_start_rejects_receiver_without_stream_policy() {
    assert_start_request_rejected_without_frame(
        ExecOperationRequest {
            command: "capture",
            stderr: ExecOutputPolicy::Discard,
            stream_queue_capacity: Some(1),
            ..operation_request("unexpected-receiver")
        },
        None,
    )
    .await;
}

#[tokio::test]
async fn exec_operation_stream_rejects_non_streaming_policy() {
    assert_stream_request_rejected_without_frame(
        ExecStreamRequest {
            command: "capture",
            stdout: ExecOutputPolicy::Capture { limit_bytes: 1024 },
            stderr: ExecOutputPolicy::Discard,
            ..stream_request("non-streaming-helper")
        },
        None,
    )
    .await;
}

#[tokio::test]
async fn exec_start_encode_error_does_not_register_or_send_frame() {
    assert_start_request_rejected_without_frame(
        ExecOperationRequest {
            stdout: ExecOutputPolicy::Stream {
                limit_bytes: 1024,
                chunk_limit_bytes: 0,
            },
            stderr: ExecOutputPolicy::Discard,
            stream_queue_capacity: Some(1),
            ..operation_request("bad-policy")
        },
        None,
    )
    .await;
}

#[tokio::test]
async fn exec_start_rejects_zero_timeout_without_sending_frame() {
    assert_start_request_rejected_without_frame(
        ExecOperationRequest {
            timeout_ms: 0,
            command: "sleep 60",
            ..operation_request("zero-timeout")
        },
        None,
    )
    .await;
}

#[tokio::test]
async fn exec_operation_stream_dispatches_stdout_stderr_and_closes_on_result() {
    let (host, mut guest) = setup_host_and_guest().await;
    let mut handle = host
        .exec_operation_stream(ExecStreamRequest {
            stderr: ExecOutputPolicy::Stream {
                limit_bytes: 1024,
                chunk_limit_bytes: 16,
            },
            ..stream_request("stream-test")
        })
        .await
        .unwrap();
    let mut rx = handle.take_stream_receiver().unwrap();

    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    send_exec_output(
        &mut guest,
        msg.seq,
        0,
        ExecOutputStream::Stdout,
        b"out",
        false,
    )
    .await;
    send_exec_output(
        &mut guest,
        msg.seq,
        1,
        ExecOutputStream::Stderr,
        b"err",
        true,
    )
    .await;

    let out = rx.recv().await.unwrap();
    assert_eq!(out.stream, ExecOutputStream::Stdout);
    assert_eq!(out.output_seq, 0);
    assert_eq!(out.chunk, b"out");
    assert!(!out.truncated);

    let err = rx.recv().await.unwrap();
    assert_eq!(err.stream, ExecOutputStream::Stderr);
    assert_eq!(err.output_seq, 1);
    assert_eq!(err.chunk, b"err");
    assert!(err.truncated);

    send_discarded_exec_result(
        &mut guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 0 },
    )
    .await;
    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert!(!result.stream_overflowed);
    assert!(rx.recv().await.is_none());
}

#[tokio::test]
async fn exec_operation_stream_handles_output_and_result_from_one_write() {
    let (host, mut guest) = setup_host_and_guest().await;
    let mut handle = host
        .exec_operation_stream(stream_request("stream-coalesced"))
        .await
        .unwrap();
    let mut rx = handle.take_stream_receiver().unwrap();

    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    let output_payload =
        vsock_proto::encode_exec_output(ExecOutputStream::Stdout, 0, b"coalesced", false).unwrap();
    let result_payload = vsock_proto::encode_exec_result(
        ExecTermination::Exited { exit_code: 0 },
        12,
        ExecCapturedOutput::Discarded,
        ExecCapturedOutput::Discarded,
        "",
    )
    .unwrap();
    let mut frames = vsock_proto::encode(MSG_EXEC_OUTPUT, msg.seq, &output_payload).unwrap();
    frames.extend_from_slice(
        &vsock_proto::encode(MSG_EXEC_RESULT, msg.seq, &result_payload).unwrap(),
    );
    guest.write_all(&frames).await.unwrap();

    let event = rx.recv().await.unwrap();
    assert_eq!(event.stream, ExecOutputStream::Stdout);
    assert_eq!(event.output_seq, 0);
    assert_eq!(event.chunk, b"coalesced");
    assert!(!event.truncated);

    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert!(!result.stream_overflowed);
    assert!(rx.recv().await.is_none());
}

#[tokio::test]
async fn exec_operation_stream_handles_output_and_pending_response_from_one_write() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let mut handle = host
        .exec_operation_stream(stream_request("stream-with-pending-response"))
        .await
        .unwrap();
    let mut rx = handle.take_stream_receiver().unwrap();

    let start_msg = read_guest_message(&mut guest).await;
    assert_eq!(start_msg.msg_type, MSG_EXEC_START);
    let quiesce_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.quiesce_operations(Duration::from_secs(5)).await })
    };
    let quiesce_msg = read_guest_message(&mut guest).await;
    assert_eq!(quiesce_msg.msg_type, MSG_QUIESCE_OPERATIONS);

    let output_payload =
        vsock_proto::encode_exec_output(ExecOutputStream::Stdout, 0, b"pending", false).unwrap();
    let mut frames = vsock_proto::encode(MSG_EXEC_OUTPUT, start_msg.seq, &output_payload).unwrap();
    frames.extend_from_slice(
        &vsock_proto::encode(MSG_OPERATIONS_QUIESCED, quiesce_msg.seq, &[]).unwrap(),
    );
    guest.write_all(&frames).await.unwrap();

    let event = rx.recv().await.unwrap();
    assert_eq!(event.stream, ExecOutputStream::Stdout);
    assert_eq!(event.output_seq, 0);
    assert_eq!(event.chunk, b"pending");
    assert!(!event.truncated);
    quiesce_task.await.unwrap().unwrap();

    send_discarded_exec_result(
        &mut guest,
        start_msg.seq,
        ExecTermination::Exited { exit_code: 0 },
    )
    .await;
    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
    assert!(!result.stream_overflowed);
    assert!(rx.recv().await.is_none());
}

#[tokio::test]
async fn exec_operation_stream_full_channel_closes_stream_and_marks_result() {
    let (host, mut guest) = setup_host_and_guest().await;
    let mut handle = host
        .exec_operation_stream(ExecStreamRequest {
            stream_queue_capacity: Some(1),
            ..stream_request("stream-overflow")
        })
        .await
        .unwrap();
    let mut rx = handle.take_stream_receiver().unwrap();

    let msg = read_guest_message(&mut guest).await;
    send_exec_output(
        &mut guest,
        msg.seq,
        0,
        ExecOutputStream::Stdout,
        b"first",
        false,
    )
    .await;
    send_exec_output(
        &mut guest,
        msg.seq,
        1,
        ExecOutputStream::Stdout,
        b"second",
        false,
    )
    .await;
    send_discarded_exec_result(
        &mut guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 0 },
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
async fn exec_operation_stream_many_chunks_soak_does_not_block_terminal_result() {
    let (host, mut guest) = setup_host_and_guest().await;
    let mut handle = host
        .exec_operation_stream(ExecStreamRequest {
            command: "stream-many",
            stream_queue_capacity: Some(2),
            ..stream_request("stream-many")
        })
        .await
        .unwrap();
    let mut rx = handle.take_stream_receiver().unwrap();

    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    for output_seq in 0..32 {
        send_exec_output(
            &mut guest,
            msg.seq,
            output_seq,
            ExecOutputStream::Stdout,
            b"x",
            false,
        )
        .await;
    }
    send_discarded_exec_result(
        &mut guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 0 },
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
async fn exec_output_for_non_streamed_side_poisons_connection() {
    assert_stream_output_frames_poison_connection(
        ExecStreamRequest {
            stdout: ExecOutputPolicy::Discard,
            stderr: ExecOutputPolicy::Stream {
                limit_bytes: 1024,
                chunk_limit_bytes: 16,
            },
            stream_queue_capacity: Some(1),
            ..stream_request("stream-side")
        },
        &[StreamOutputFrame {
            output_seq: 0,
            stream: ExecOutputStream::Stdout,
            chunk: b"unexpected",
            truncated: false,
        }],
    )
    .await;
}

#[tokio::test]
async fn exec_output_seq_gap_poisons_connection() {
    assert_stream_output_frames_poison_connection(
        ExecStreamRequest {
            stream_queue_capacity: Some(1),
            ..stream_request("stream-seq")
        },
        &[StreamOutputFrame {
            output_seq: 1,
            stream: ExecOutputStream::Stdout,
            chunk: b"gap",
            truncated: false,
        }],
    )
    .await;
}

#[tokio::test]
async fn exec_output_zero_stream_limit_accepts_empty_truncation_marker() {
    let (host, mut guest) = setup_host_and_guest().await;
    let mut handle = host
        .exec_operation_stream(ExecStreamRequest {
            stdout: ExecOutputPolicy::Stream {
                limit_bytes: 0,
                chunk_limit_bytes: 16,
            },
            stream_queue_capacity: Some(1),
            ..stream_request("stream-zero-limit")
        })
        .await
        .unwrap();
    let mut rx = handle.take_stream_receiver().unwrap();

    let msg = read_guest_message(&mut guest).await;
    send_exec_output(&mut guest, msg.seq, 0, ExecOutputStream::Stdout, b"", true).await;
    send_discarded_exec_result(
        &mut guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 0 },
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
async fn exec_output_empty_non_truncated_poisons_connection() {
    assert_stream_output_frames_poison_connection(
        ExecStreamRequest {
            stream_queue_capacity: Some(1),
            ..stream_request("stream-empty")
        },
        &[StreamOutputFrame {
            output_seq: 0,
            stream: ExecOutputStream::Stdout,
            chunk: b"",
            truncated: false,
        }],
    )
    .await;
}

#[tokio::test]
async fn exec_output_over_requested_chunk_limit_poisons_connection() {
    assert_stream_output_frames_poison_connection(
        ExecStreamRequest {
            stdout: ExecOutputPolicy::Stream {
                limit_bytes: 4,
                chunk_limit_bytes: 3,
            },
            stream_queue_capacity: Some(4),
            ..stream_request("stream-limits")
        },
        &[StreamOutputFrame {
            output_seq: 0,
            stream: ExecOutputStream::Stdout,
            chunk: b"abcd",
            truncated: false,
        }],
    )
    .await;
}

#[tokio::test]
async fn exec_output_over_requested_stream_limit_poisons_connection() {
    assert_stream_output_frames_poison_connection(
        ExecStreamRequest {
            stdout: ExecOutputPolicy::Stream {
                limit_bytes: 4,
                chunk_limit_bytes: 3,
            },
            stream_queue_capacity: Some(4),
            ..stream_request("stream-total-limit")
        },
        &[
            StreamOutputFrame {
                output_seq: 0,
                stream: ExecOutputStream::Stdout,
                chunk: b"abc",
                truncated: false,
            },
            StreamOutputFrame {
                output_seq: 1,
                stream: ExecOutputStream::Stdout,
                chunk: b"de",
                truncated: false,
            },
        ],
    )
    .await;
}

#[tokio::test]
async fn exec_output_after_truncation_poisons_connection() {
    assert_stream_output_frames_poison_connection(
        ExecStreamRequest {
            stdout: ExecOutputPolicy::Stream {
                limit_bytes: 4,
                chunk_limit_bytes: 4,
            },
            stream_queue_capacity: Some(4),
            ..stream_request("stream-truncated")
        },
        &[
            StreamOutputFrame {
                output_seq: 0,
                stream: ExecOutputStream::Stdout,
                chunk: b"",
                truncated: true,
            },
            StreamOutputFrame {
                output_seq: 1,
                stream: ExecOutputStream::Stdout,
                chunk: b"late",
                truncated: false,
            },
        ],
    )
    .await;
}

#[tokio::test]
async fn exec_operation_stream_dropped_receiver_does_not_block_result() {
    let (host, mut guest) = setup_host_and_guest().await;
    let mut handle = host
        .exec_operation_stream(ExecStreamRequest {
            stream_queue_capacity: Some(1),
            ..stream_request("stream-dropped")
        })
        .await
        .unwrap();
    drop(handle.take_stream_receiver());

    let msg = read_guest_message(&mut guest).await;
    send_exec_output(
        &mut guest,
        msg.seq,
        0,
        ExecOutputStream::Stdout,
        b"ignored",
        false,
    )
    .await;
    send_discarded_exec_result(
        &mut guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 0 },
    )
    .await;

    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert!(!result.stream_overflowed);
}
