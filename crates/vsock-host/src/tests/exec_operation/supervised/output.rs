use std::future::{Future, poll_fn};
use std::io;
use std::sync::Arc;
use std::task::Poll;
use std::time::Duration;

use vsock_proto::{ExecOutputStream, ExecTermination};

use super::super::super::support::{
    normal_operation_readiness, operation_count, read_guest_message, send_discarded_exec_result,
    send_exec_output, send_exec_started, setup_host_and_guest, wait_for_operation_count,
};
use super::support::supervised_stream_request;
use crate::operation_tracker::NormalOperationReadiness;

#[tokio::test]
async fn supervised_exec_handle_drop_keeps_terminal_cleanup_without_cancel() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(supervised_stream_request("drop-handle"))
                .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    send_exec_started(&mut guest, start.seq, 123).await;
    let handle = task.await.unwrap().unwrap();
    drop(handle);

    assert_eq!(operation_count(&host), 1);
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("handle drop must not send exec cancel; read {n} bytes"),
        Err(err) => panic!("unexpected read error after handle drop: {err}"),
    }

    send_discarded_exec_result(
        &mut guest,
        start.seq,
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
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(supervised_stream_request("drop-handle-after-take-stream"))
                .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    send_exec_started(&mut guest, start.seq, 123).await;
    let mut handle = task.await.unwrap().unwrap();
    let mut stream_rx = handle
        .take_stream_receiver()
        .expect("supervised stream receiver should be available");
    drop(handle);

    send_exec_output(
        &mut guest,
        start.seq,
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
        start.seq,
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
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(supervised_stream_request("wait-with-unclaimed-stream"))
                .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    send_exec_started(&mut guest, start.seq, 123).await;
    let handle = task.await.unwrap().unwrap();
    let wait_fut = handle.wait(Duration::from_secs(5));
    tokio::pin!(wait_fut);
    poll_fn(|cx| match wait_fut.as_mut().poll(cx) {
        Poll::Pending => Poll::Ready(()),
        Poll::Ready(_) => panic!("wait should remain pending until terminal result"),
    })
    .await;

    send_exec_output(
        &mut guest,
        start.seq,
        0,
        ExecOutputStream::Stdout,
        b"first",
        false,
    )
    .await;
    send_exec_output(
        &mut guest,
        start.seq,
        1,
        ExecOutputStream::Stdout,
        b"second",
        false,
    )
    .await;
    send_discarded_exec_result(
        &mut guest,
        start.seq,
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
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(supervised_stream_request("bad-output-seq"))
                .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    send_exec_started(&mut guest, start.seq, 123).await;
    let handle = task.await.unwrap().unwrap();
    send_exec_output(
        &mut guest,
        start.seq,
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
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.start_supervised_exec(supervised_stream_request("stream-overflow"))
                .await
        })
    };

    let start = read_guest_message(&mut guest).await;
    send_exec_started(&mut guest, start.seq, 123).await;
    let mut handle = task.await.unwrap().unwrap();
    let _stream_rx = handle
        .take_stream_receiver()
        .expect("supervised stream receiver should be available");
    send_exec_output(
        &mut guest,
        start.seq,
        0,
        ExecOutputStream::Stdout,
        b"first",
        false,
    )
    .await;
    send_exec_output(
        &mut guest,
        start.seq,
        1,
        ExecOutputStream::Stdout,
        b"second",
        false,
    )
    .await;
    send_discarded_exec_result(
        &mut guest,
        start.seq,
        ExecTermination::Exited { exit_code: 0 },
    )
    .await;

    let result = handle.wait(Duration::from_secs(5)).await.unwrap();
    assert!(result.stream_overflowed);
}
