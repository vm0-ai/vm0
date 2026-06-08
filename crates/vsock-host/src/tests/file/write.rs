use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use vsock_proto::MSG_EXEC_START;

use super::super::support::{
    MockGuest, assert_connection_accepts_exec_operation, await_mock_guest, host_from_stream,
    make_pair, normal_operation_readiness, pending_request_count, setup_host_and_guest,
};
use super::support::{
    expect_write_file, send_guest_error, send_write_file_failure, send_write_file_success,
    spawn_write_file,
};
use crate::{FrameWriteObserver, operation_tracker::NormalOperationReadiness};

#[tokio::test]
async fn test_write_file() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_task = spawn_write_file(Arc::clone(&host), "/tmp/test.txt", b"hello".to_vec(), false);

    let write = expect_write_file(&mut guest).await;
    assert_eq!(write.path, "/tmp/test.txt");
    assert_eq!(write.content, b"hello");
    assert!(!write.sudo);
    assert!(!write.append);

    send_write_file_success(&mut guest, write.seq()).await;

    write_task.await.unwrap().unwrap();
}

#[tokio::test]
async fn write_file_tracks_until_result() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_task = spawn_write_file(
        Arc::clone(&host),
        "/tmp/tracked.txt",
        b"hello".to_vec(),
        false,
    );

    let write = expect_write_file(&mut guest).await;
    assert_eq!(write.path, "/tmp/tracked.txt");
    assert_eq!(write.content, b"hello");
    assert!(!write.sudo);
    assert!(!write.append);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    send_write_file_success(&mut guest, write.seq()).await;

    write_task.await.unwrap().unwrap();
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn write_file_guest_failure_releases_tracker() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.write_file("/tmp/tracked.txt", b"bad", false).await })
    };

    let write = expect_write_file(&mut guest).await;
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    send_write_file_failure(&mut guest, write.seq(), "permission denied").await;

    let err = write_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("permission denied"));
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn write_file_error_response_releases_tracker() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.write_file("/tmp/tracked.txt", b"bad", false).await })
    };

    let write = expect_write_file(&mut guest).await;
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    send_guest_error(&mut guest, write.seq(), "guest write failed").await;

    let err = write_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("guest write failed"));
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn write_file_unexpected_response_keeps_tracker_fail_closed() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.write_file("/tmp/tracked.txt", b"bad", false).await })
    };

    let write = expect_write_file(&mut guest).await;
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    let resp = vsock_proto::encode(MSG_EXEC_START, write.seq(), &[]).unwrap();
    guest.write_all(&resp).await.unwrap();

    let err = write_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
}

#[tokio::test]
async fn dropping_write_file_after_request_marks_tracker_not_parkable() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.write_file("/tmp/pending.txt", b"hello", false).await })
    };

    let _write = expect_write_file(&mut guest).await;
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    write_task.abort();
    let _ = write_task.await;

    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
    let err = host
        .exec("blocked-after-write-drop", 5000, &[], false)
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn write_file_cancelled_before_frame_write_does_not_poison_or_send_frame() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_start_count = Arc::new(AtomicUsize::new(0));
    let writer_guard = host.shared.writer.lock().await;
    let write_task = {
        let host = Arc::clone(&host);
        let write_start_count = Arc::clone(&write_start_count);
        tokio::spawn(async move {
            host.write_file_with_write_observer(
                "/tmp/blocked.txt",
                b"hello",
                false,
                FrameWriteObserver::new(move || {
                    write_start_count.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }),
            )
            .await
        })
    };

    tokio::time::timeout(Duration::from_secs(5), async {
        while normal_operation_readiness(&host) != NormalOperationReadiness::Busy {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    write_task.abort();
    let _ = write_task.await;
    assert_eq!(write_start_count.load(Ordering::SeqCst), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );

    drop(writer_guard);
    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn write_file_observer_error_cleans_pending_without_sending_frame() {
    let (host, guest) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let err = host
        .write_file_with_write_observer(
            "/tmp/observer-error.txt",
            b"hello",
            false,
            FrameWriteObserver::new(|| Err(io::Error::other("observer failed"))),
        )
        .await
        .unwrap_err();

    assert!(err.to_string().contains("observer failed"));
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("observer error must not send write_file frame; read {n} bytes"),
        Err(err) => panic!("unexpected read error after observer error: {err}"),
    }
    assert_eq!(pending_request_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
}

#[tokio::test]
async fn write_file_connection_close_after_request_marks_tracker_not_parkable() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.write_file("/tmp/pending.txt", b"hello", false).await })
    };

    let _write = expect_write_file(&mut guest).await;
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    drop(guest);
    let err = write_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
}

#[tokio::test]
async fn write_file_after_connection_close_returns_immediately_without_not_parkable() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;
        drop(guest);
    });

    let host = host_from_stream(host_stream).await.unwrap();
    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();

    let err = tokio::time::timeout(
        Duration::from_secs(5),
        host.write_file("/tmp/closed.txt", b"hello", false),
    )
    .await
    .expect("write_file should return when the connection is already closed")
    .unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Closed
    );
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn test_write_file_failure() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_task = spawn_write_file(Arc::clone(&host), "/etc/shadow", b"bad".to_vec(), false);

    let write = expect_write_file(&mut guest).await;
    assert_eq!(write.path, "/etc/shadow");
    assert_eq!(write.content, b"bad");
    assert!(!write.sudo);
    assert!(!write.append);

    send_write_file_failure(&mut guest, write.seq(), "permission denied").await;

    let err = write_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("permission denied"));
}
