use std::io;
use std::sync::Arc;
use std::time::Duration;

use vsock_proto::{
    CommandOutputPolicy, CommandOutputStream, CommandTermination, MSG_COMMAND_START,
};

use super::super::support::{
    assert_connection_accepts_command_exec, operation_count, read_guest_message,
    send_command_output, send_command_result, send_discarded_command_result, setup_host_and_guest,
};
use crate::{CommandOperationRequest, CommandStreamRequest, command as command_impl};

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
