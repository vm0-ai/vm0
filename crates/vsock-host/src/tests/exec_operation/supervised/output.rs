use std::future::{Future, poll_fn};
use std::io;
use std::task::Poll;
use std::time::Duration;

use vsock_proto::{ExecOutputStream, ExecTermination};

use super::super::super::support::{
    normal_operation_readiness, operation_count, send_discarded_exec_result, send_exec_output,
    wait_for_operation_count,
};
use super::support::{
    StartedSupervisedExec, start_supervised_exec_fixture, start_supervised_process_fixture,
    supervised_stream_request,
};
use crate::operation_tracker::NormalOperationReadiness;

#[tokio::test]
async fn supervised_exec_handle_drop_keeps_terminal_cleanup_without_cancel() {
    let StartedSupervisedExec {
        host,
        mut guest,
        start,
        handle,
    } = start_supervised_exec_fixture(supervised_stream_request("drop-handle")).await;
    let start_seq = start.seq();
    drop(handle);

    assert_eq!(operation_count(&host), 1);
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("handle drop must not send exec cancel; read {n} bytes"),
        Err(err) => panic!("unexpected read error after handle drop: {err}"),
    }

    send_discarded_exec_result(
        &mut guest,
        start_seq,
        ExecTermination::Exited { exit_code: 0 },
    )
    .await;
    wait_for_operation_count(&host, 0).await;
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn supervised_exec_taken_stream_receiver_survives_handle_drop() {
    let StartedSupervisedExec {
        host,
        mut guest,
        start,
        mut handle,
    } = start_supervised_exec_fixture(supervised_stream_request("drop-handle-after-take-stream"))
        .await;
    let start_seq = start.seq();
    let mut stream_rx = handle
        .take_stream_receiver()
        .expect("supervised stream receiver should be available");
    drop(handle);

    send_exec_output(
        &mut guest,
        start_seq,
        0,
        ExecOutputStream::Stdout,
        b"still-streams",
        false,
    )
    .await;
    let event = tokio::time::timeout(Duration::from_secs(5), stream_rx.recv())
        .await
        .unwrap()
        .expect("taken stream receiver should stay connected");
    assert_eq!(event.stream, ExecOutputStream::Stdout);
    assert_eq!(event.output_seq, 0);
    assert_eq!(event.chunk, b"still-streams");

    send_discarded_exec_result(
        &mut guest,
        start_seq,
        ExecTermination::Exited { exit_code: 0 },
    )
    .await;
    wait_for_operation_count(&host, 0).await;
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn supervised_exec_wait_releases_unclaimed_stream_sender() {
    let StartedSupervisedExec {
        host,
        mut guest,
        start,
        handle,
    } = start_supervised_exec_fixture(supervised_stream_request("wait-with-unclaimed-stream"))
        .await;
    let start_seq = start.seq();
    let wait_fut = handle.wait(Duration::from_secs(5));
    tokio::pin!(wait_fut);
    poll_fn(|cx| match wait_fut.as_mut().poll(cx) {
        Poll::Pending => Poll::Ready(()),
        Poll::Ready(_) => panic!("wait should remain pending until terminal result"),
    })
    .await;

    send_exec_output(
        &mut guest,
        start_seq,
        0,
        ExecOutputStream::Stdout,
        b"first",
        false,
    )
    .await;
    send_exec_output(
        &mut guest,
        start_seq,
        1,
        ExecOutputStream::Stdout,
        b"second",
        false,
    )
    .await;
    send_discarded_exec_result(
        &mut guest,
        start_seq,
        ExecTermination::Exited { exit_code: 0 },
    )
    .await;

    let result = wait_fut.await.unwrap();
    assert!(!result.stream_overflowed);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn supervised_exec_output_sequence_validation_applies_after_started() {
    let StartedSupervisedExec {
        host,
        mut guest,
        start,
        handle,
    } = start_supervised_exec_fixture(supervised_stream_request("bad-output-seq")).await;
    let start_seq = start.seq();
    send_exec_output(
        &mut guest,
        start_seq,
        1,
        ExecOutputStream::Stdout,
        b"out-of-order",
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
async fn supervised_exec_stream_overflow_is_reported_in_terminal_result() {
    let StartedSupervisedExec {
        host: _host,
        mut guest,
        start,
        mut handle,
    } = start_supervised_exec_fixture(supervised_stream_request("stream-overflow")).await;
    let start_seq = start.seq();
    let _stream_rx = handle
        .take_stream_receiver()
        .expect("supervised stream receiver should be available");
    send_exec_output(
        &mut guest,
        start_seq,
        0,
        ExecOutputStream::Stdout,
        b"first",
        false,
    )
    .await;
    send_exec_output(
        &mut guest,
        start_seq,
        1,
        ExecOutputStream::Stdout,
        b"second",
        false,
    )
    .await;
    send_discarded_exec_result(
        &mut guest,
        start_seq,
        ExecTermination::Exited { exit_code: 0 },
    )
    .await;

    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert!(result.stream_overflowed);
}

#[tokio::test]
async fn supervised_process_output_capacity_retains_one_chunk_before_overflow() {
    let StartedSupervisedExec {
        host: _host,
        mut guest,
        start,
        mut handle,
    } = start_supervised_process_fixture(supervised_stream_request("process-output-overflow"))
        .await;
    let start_seq = start.seq();
    let mut output_rx = handle
        .take_process_output_receiver()
        .expect("process output receiver should be available");

    send_exec_output(
        &mut guest,
        start_seq,
        0,
        ExecOutputStream::Stdout,
        b"first",
        false,
    )
    .await;
    send_exec_output(
        &mut guest,
        start_seq,
        1,
        ExecOutputStream::Stdout,
        b"second",
        false,
    )
    .await;
    send_discarded_exec_result(
        &mut guest,
        start_seq,
        ExecTermination::Exited { exit_code: 0 },
    )
    .await;

    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert!(result.stream_overflowed);
    let chunk = output_rx.recv().await.unwrap();
    assert_eq!(chunk.bytes, b"first");
    assert!(!chunk.truncated);
    assert!(output_rx.recv().await.is_none());
}

#[tokio::test]
async fn supervised_process_output_closed_receiver_does_not_mark_overflow() {
    let StartedSupervisedExec {
        host: _host,
        mut guest,
        start,
        mut handle,
    } = start_supervised_process_fixture(supervised_stream_request("process-output-closed")).await;
    let start_seq = start.seq();
    let output_rx = handle
        .take_process_output_receiver()
        .expect("process output receiver should be available");
    drop(output_rx);

    send_exec_output(
        &mut guest,
        start_seq,
        0,
        ExecOutputStream::Stdout,
        b"closed",
        false,
    )
    .await;
    send_discarded_exec_result(
        &mut guest,
        start_seq,
        ExecTermination::Exited { exit_code: 0 },
    )
    .await;

    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert!(!result.stream_overflowed);
}

#[tokio::test]
async fn supervised_process_wait_releases_unclaimed_output_sender() {
    let StartedSupervisedExec {
        host,
        mut guest,
        start,
        handle,
    } = start_supervised_process_fixture(supervised_stream_request("unclaimed-process-output"))
        .await;
    let start_seq = start.seq();
    let wait_fut = handle.wait(Duration::from_secs(5));
    tokio::pin!(wait_fut);
    poll_fn(|cx| match wait_fut.as_mut().poll(cx) {
        Poll::Pending => Poll::Ready(()),
        Poll::Ready(_) => panic!("wait should remain pending until terminal result"),
    })
    .await;

    send_exec_output(
        &mut guest,
        start_seq,
        0,
        ExecOutputStream::Stdout,
        b"first",
        false,
    )
    .await;
    send_exec_output(
        &mut guest,
        start_seq,
        1,
        ExecOutputStream::Stdout,
        b"second",
        false,
    )
    .await;
    send_discarded_exec_result(
        &mut guest,
        start_seq,
        ExecTermination::Exited { exit_code: 0 },
    )
    .await;

    let result = wait_fut.await.unwrap();
    assert!(!result.stream_overflowed);
    assert_eq!(operation_count(&host), 0);
}

#[tokio::test]
async fn supervised_process_output_preserves_truncation() {
    let StartedSupervisedExec {
        host: _host,
        mut guest,
        start,
        mut handle,
    } = start_supervised_process_fixture(supervised_stream_request("truncated-process-output"))
        .await;
    let start_seq = start.seq();
    let mut output_rx = handle
        .take_process_output_receiver()
        .expect("process output receiver should be available");

    send_exec_output(
        &mut guest,
        start_seq,
        0,
        ExecOutputStream::Stdout,
        b"truncated",
        true,
    )
    .await;
    send_discarded_exec_result(
        &mut guest,
        start_seq,
        ExecTermination::Exited { exit_code: 0 },
    )
    .await;

    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert!(!result.stream_overflowed);
    let chunk = output_rx.recv().await.unwrap();
    assert_eq!(chunk.bytes, b"truncated");
    assert!(chunk.truncated);
    assert!(output_rx.recv().await.is_none());
}
