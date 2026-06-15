use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use vsock_proto::{ExecTermination, MSG_EXEC_START, MSG_WRITE_FILE};

use super::super::support::{
    MockGuest, assert_connection_accepts_exec_operation, await_mock_guest, host_from_stream,
    make_pair, normal_operation_readiness, operation_count, pending_request_count,
    send_exec_result, setup_host_and_guest,
};
use super::support::{
    ExecStartFrame, WriteFileFrame, expect_exec_start, expect_write_file, send_guest_error,
    send_write_file_failure, send_write_file_success, spawn_write_file,
};
use crate::file as file_impl;
use crate::{FrameWriteObserver, VsockHost, operation_tracker::NormalOperationReadiness};

struct ChunkedWriteFixture {
    host: Arc<VsockHost>,
    guest: UnixStream,
    target_path: &'static str,
    temp_path: Option<String>,
}

fn shell_quote_for_test(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

impl ChunkedWriteFixture {
    async fn new(target_path: &'static str) -> Self {
        let (host, guest) = setup_host_and_guest().await;
        Self {
            host: Arc::new(host),
            guest,
            target_path,
            temp_path: None,
        }
    }

    fn chunk_limit() -> usize {
        file_impl::test_support::WRITE_FILE_CHUNK_LIMIT
    }

    fn two_chunk_content() -> Vec<u8> {
        vec![0xABu8; Self::chunk_limit() + 100]
    }

    fn spawn_write(&self, content: Vec<u8>, sudo: bool) -> JoinHandle<io::Result<()>> {
        spawn_write_file(Arc::clone(&self.host), self.target_path, content, sudo)
    }

    async fn expect_chunk(&mut self) -> WriteFileFrame {
        let frame = expect_write_file(&mut self.guest).await;
        if let Some(temp_path) = &self.temp_path {
            assert_eq!(frame.path.as_str(), temp_path);
        } else {
            assert!(
                frame
                    .path
                    .starts_with(&format!("{}.vm0tmp-", self.target_path))
            );
            self.temp_path = Some(frame.path.clone());
        }
        frame
    }

    async fn expect_rename(&mut self) -> ExecStartFrame {
        let frame = expect_exec_start(&mut self.guest).await;
        assert_eq!(frame.label, "write-file-rename");
        assert!(frame.command.contains("mv -f --"));
        assert!(frame.command.ends_with(&format!(
            " {} {}",
            shell_quote_for_test(self.temp_path()),
            shell_quote_for_test(self.target_path)
        )));
        frame
    }

    async fn expect_cleanup(&mut self) -> ExecStartFrame {
        let frame = expect_exec_start(&mut self.guest).await;
        assert_eq!(frame.label, "exec-cleanup");
        assert!(frame.command.contains("rm -f --"));
        assert!(
            frame
                .command
                .ends_with(&format!(" {}", shell_quote_for_test(self.temp_path())))
        );
        frame
    }

    fn assert_readiness(&self, expected: NormalOperationReadiness) {
        assert_eq!(normal_operation_readiness(&self.host), expected);
    }

    fn temp_path(&self) -> &str {
        self.temp_path.as_deref().expect("temp path")
    }
}

#[tokio::test]
async fn write_file_chunked_cancelled_before_first_frame_write_does_not_cleanup() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_start_count = Arc::new(AtomicUsize::new(0));
    let writer_guard = host.shared.writer.lock().await;
    let content = vec![0xABu8; file_impl::test_support::WRITE_FILE_CHUNK_LIMIT + 1];
    let write_task = {
        let host = Arc::clone(&host);
        let write_start_count = Arc::clone(&write_start_count);
        tokio::spawn(async move {
            host.write_file_with_write_observer(
                "/tmp/big-blocked.bin",
                &content,
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
        while pending_request_count(&host) != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    write_task.abort();
    let _ = write_task.await;

    assert_eq!(write_start_count.load(Ordering::SeqCst), 0);
    assert_eq!(pending_request_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );

    drop(writer_guard);
    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn write_file_chunked_rejects_invalid_path_before_cleanup_or_write() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_start_count = Arc::new(AtomicUsize::new(0));
    let path = format!("/{}", "a".repeat(u16::MAX as usize));
    let content = vec![0u8; file_impl::test_support::WRITE_FILE_CHUNK_LIMIT + 1];

    let err = host
        .write_file_with_write_observer(
            &path,
            &content,
            false,
            FrameWriteObserver::new({
                let write_start_count = Arc::clone(&write_start_count);
                move || {
                    write_start_count.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }
            }),
        )
        .await
        .unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(write_start_count.load(Ordering::SeqCst), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    assert_eq!(operation_count(&host), 0);

    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn test_write_file_chunked() {
    let mut fixture = ChunkedWriteFixture::new("/tmp/big.bin").await;
    let chunk_limit = ChunkedWriteFixture::chunk_limit();
    let content = ChunkedWriteFixture::two_chunk_content();
    let write_task = fixture.spawn_write(content.clone(), false);

    let mut chunks_received = Vec::new();

    let first = fixture.expect_chunk().await;
    let first_seq = first.seq();
    chunks_received.push((first.append, first.content));
    send_write_file_success(&mut fixture.guest, first_seq).await;

    let second = fixture.expect_chunk().await;
    let second_seq = second.seq();
    chunks_received.push((second.append, second.content));
    send_write_file_success(&mut fixture.guest, second_seq).await;

    let rename = fixture.expect_rename().await;

    assert_eq!(chunks_received.len(), 2);
    assert!(!chunks_received[0].0);
    assert_eq!(chunks_received[0].1.len(), chunk_limit);
    assert!(chunks_received[1].0);
    assert_eq!(chunks_received[1].1.len(), 100);
    let mut reassembled = chunks_received[0].1.clone();
    reassembled.extend_from_slice(&chunks_received[1].1);
    assert_eq!(reassembled, content);

    send_exec_result(
        &mut fixture.guest,
        rename.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;

    write_task.await.unwrap().unwrap();
}

#[tokio::test]
async fn write_file_chunked_tracks_one_operation_until_rename_result() {
    let mut fixture = ChunkedWriteFixture::new("/tmp/big.bin").await;
    let write_task = fixture.spawn_write(ChunkedWriteFixture::two_chunk_content(), false);

    let first = fixture.expect_chunk().await;
    fixture.assert_readiness(NormalOperationReadiness::Busy);
    send_write_file_success(&mut fixture.guest, first.seq()).await;

    let second = fixture.expect_chunk().await;
    fixture.assert_readiness(NormalOperationReadiness::Busy);
    send_write_file_success(&mut fixture.guest, second.seq()).await;

    let rename = fixture.expect_rename().await;
    fixture.assert_readiness(NormalOperationReadiness::Busy);

    send_exec_result(
        &mut fixture.guest,
        rename.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;

    write_task.await.unwrap().unwrap();
    fixture.assert_readiness(NormalOperationReadiness::Idle);
}

#[tokio::test]
async fn write_file_chunked_rename_result_before_connection_close_keeps_tracker_closed_not_not_parkable()
 {
    let mut fixture = ChunkedWriteFixture::new("/tmp/big.bin").await;
    let write_task = fixture.spawn_write(ChunkedWriteFixture::two_chunk_content(), false);

    let first = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, first.seq()).await;

    let second = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, second.seq()).await;

    let rename = fixture.expect_rename().await;
    send_exec_result(
        &mut fixture.guest,
        rename.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;
    let host = Arc::clone(&fixture.host);
    drop(fixture.guest);

    write_task.await.unwrap().unwrap();
    assert_ne!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
}

#[tokio::test]
async fn write_file_chunked_failure_remains_busy_until_cleanup_result() {
    let mut fixture = ChunkedWriteFixture::new("/tmp/big.bin").await;
    let write_task = fixture.spawn_write(ChunkedWriteFixture::two_chunk_content(), false);

    let first = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, first.seq()).await;

    let second = fixture.expect_chunk().await;
    send_write_file_failure(&mut fixture.guest, second.seq(), "disk full").await;

    let cleanup = fixture.expect_cleanup().await;
    fixture.assert_readiness(NormalOperationReadiness::Busy);

    send_exec_result(
        &mut fixture.guest,
        cleanup.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;

    let err = write_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("disk full"));
    fixture.assert_readiness(NormalOperationReadiness::Idle);
}

#[tokio::test]
async fn write_file_chunked_error_response_cleans_up_and_releases_tracker() {
    let mut fixture = ChunkedWriteFixture::new("/tmp/big.bin").await;
    let write_task = fixture.spawn_write(ChunkedWriteFixture::two_chunk_content(), false);

    let first = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, first.seq()).await;

    let second = fixture.expect_chunk().await;
    send_guest_error(&mut fixture.guest, second.seq(), "guest write failed").await;

    let cleanup = fixture.expect_cleanup().await;
    fixture.assert_readiness(NormalOperationReadiness::Busy);
    send_exec_result(
        &mut fixture.guest,
        cleanup.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;

    let err = write_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("guest write failed"));
    fixture.assert_readiness(NormalOperationReadiness::Idle);
}

#[tokio::test]
async fn write_file_chunked_unexpected_response_keeps_tracker_fail_closed() {
    let mut fixture = ChunkedWriteFixture::new("/tmp/big.bin").await;
    let write_task = fixture.spawn_write(ChunkedWriteFixture::two_chunk_content(), false);

    let first = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, first.seq()).await;

    let second = fixture.expect_chunk().await;
    fixture
        .guest
        .write_all(&vsock_proto::encode(MSG_EXEC_START, second.seq(), &[]).unwrap())
        .await
        .unwrap();

    let err = write_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    fixture.assert_readiness(NormalOperationReadiness::NotParkable);

    let cleanup_retry = tokio::time::timeout(Duration::from_secs(2), fixture.expect_cleanup())
        .await
        .expect("cleanup retry was not sent after unexpected response");
    send_exec_result(
        &mut fixture.guest,
        cleanup_retry.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;
}

#[tokio::test]
async fn write_file_chunked_rename_error_response_cleans_up_and_releases_tracker() {
    let mut fixture = ChunkedWriteFixture::new("/tmp/big.bin").await;
    let write_task = fixture.spawn_write(ChunkedWriteFixture::two_chunk_content(), false);

    let first = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, first.seq()).await;

    let second = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, second.seq()).await;

    let rename = fixture.expect_rename().await;
    send_guest_error(&mut fixture.guest, rename.seq(), "rename unavailable").await;

    let cleanup = fixture.expect_cleanup().await;
    fixture.assert_readiness(NormalOperationReadiness::Busy);
    send_exec_result(
        &mut fixture.guest,
        cleanup.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;

    let err = write_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("rename unavailable"));
    fixture.assert_readiness(NormalOperationReadiness::Idle);
}

#[tokio::test]
async fn write_file_chunked_cleanup_error_retries_untracked_on_drop() {
    let mut fixture = ChunkedWriteFixture::new("/tmp/big.bin").await;
    let write_task = fixture.spawn_write(ChunkedWriteFixture::two_chunk_content(), false);

    let first = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, first.seq()).await;

    let second = fixture.expect_chunk().await;
    send_write_file_failure(&mut fixture.guest, second.seq(), "disk full").await;

    let cleanup = fixture.expect_cleanup().await;
    send_guest_error(&mut fixture.guest, cleanup.seq(), "cleanup unavailable").await;

    let err = write_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("disk full"));
    fixture.assert_readiness(NormalOperationReadiness::NotParkable);

    let retry = tokio::time::timeout(Duration::from_secs(2), fixture.expect_cleanup())
        .await
        .expect("cleanup retry was not sent after cleanup error");
    send_exec_result(
        &mut fixture.guest,
        retry.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;
}

#[tokio::test]
async fn write_file_chunked_cleanup_retry_does_not_reuse_write_observer() {
    let mut fixture = ChunkedWriteFixture::new("/tmp/big.bin").await;
    let write_start_count = Arc::new(AtomicUsize::new(0));

    let content = ChunkedWriteFixture::two_chunk_content();
    let write_task = {
        let host = Arc::clone(&fixture.host);
        let write_start_count = Arc::clone(&write_start_count);
        tokio::spawn(async move {
            host.write_file_with_write_observer(
                "/tmp/big.bin",
                &content,
                false,
                FrameWriteObserver::new(move || {
                    let count = write_start_count.fetch_add(1, Ordering::SeqCst);
                    if count >= 3 {
                        return Err(io::Error::other("write observer is no longer active"));
                    }
                    Ok(())
                }),
            )
            .await
        })
    };

    let first = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, first.seq()).await;

    let second = fixture.expect_chunk().await;
    send_write_file_failure(&mut fixture.guest, second.seq(), "disk full").await;

    let cleanup = fixture.expect_cleanup().await;
    send_guest_error(&mut fixture.guest, cleanup.seq(), "cleanup unavailable").await;

    let err = write_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("disk full"));
    assert_eq!(write_start_count.load(Ordering::SeqCst), 3);

    let retry = tokio::time::timeout(Duration::from_secs(2), fixture.expect_cleanup())
        .await
        .expect("cleanup retry was not sent after observer became inactive");
    send_exec_result(
        &mut fixture.guest,
        retry.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;
    assert_eq!(write_start_count.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn write_file_chunked_cleanup_nonzero_exit_retries_untracked_on_drop() {
    let mut fixture = ChunkedWriteFixture::new("/tmp/big.bin").await;
    let write_task = fixture.spawn_write(ChunkedWriteFixture::two_chunk_content(), false);

    let first = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, first.seq()).await;

    let second = fixture.expect_chunk().await;
    send_write_file_failure(&mut fixture.guest, second.seq(), "disk full").await;

    let cleanup = fixture.expect_cleanup().await;
    send_exec_result(
        &mut fixture.guest,
        cleanup.seq(),
        ExecTermination::Exited { exit_code: 1 },
        &[],
        b"permission denied",
    )
    .await;

    let err = write_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("disk full"));
    fixture.assert_readiness(NormalOperationReadiness::NotParkable);

    let retry = tokio::time::timeout(Duration::from_secs(2), fixture.expect_cleanup())
        .await
        .expect("cleanup retry was not sent after nonzero cleanup exit");
    send_exec_result(
        &mut fixture.guest,
        retry.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;
}

#[tokio::test]
async fn test_write_file_at_chunk_limit_uses_single_message() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let chunk_limit = file_impl::test_support::WRITE_FILE_CHUNK_LIMIT;
    let content = vec![0xABu8; chunk_limit];
    let write_task = spawn_write_file(
        Arc::clone(&host),
        "/tmp/exact-limit.bin",
        content.clone(),
        false,
    );

    let write = expect_write_file(&mut guest).await;
    assert_eq!(write.path, "/tmp/exact-limit.bin");
    assert_eq!(write.content, content);
    assert!(!write.append);

    send_write_file_success(&mut guest, write.seq()).await;

    write_task.await.unwrap().unwrap();
}

#[tokio::test]
async fn test_write_file_chunked_cleans_up_on_chunk_failure() {
    let mut fixture = ChunkedWriteFixture::new("/tmp/big.bin").await;
    let write_task = fixture.spawn_write(ChunkedWriteFixture::two_chunk_content(), false);

    let first = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, first.seq()).await;

    let second = fixture.expect_chunk().await;
    send_write_file_failure(&mut fixture.guest, second.seq(), "disk full").await;

    let cleanup = fixture.expect_cleanup().await;
    send_exec_result(
        &mut fixture.guest,
        cleanup.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;

    let err = write_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("disk full"));
}

#[tokio::test]
async fn test_write_file_chunked_cleans_up_on_mv_failure() {
    let mut fixture = ChunkedWriteFixture::new("/tmp/big.bin").await;
    let write_task = fixture.spawn_write(ChunkedWriteFixture::two_chunk_content(), false);

    let first = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, first.seq()).await;

    let second = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, second.seq()).await;

    let rename = fixture.expect_rename().await;
    send_exec_result(
        &mut fixture.guest,
        rename.seq(),
        ExecTermination::Exited { exit_code: 1 },
        &[],
        b"permission denied",
    )
    .await;

    let cleanup = fixture.expect_cleanup().await;
    send_exec_result(
        &mut fixture.guest,
        cleanup.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;

    let err = write_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("permission denied"));
}

#[tokio::test]
async fn test_write_file_chunked_cleans_up_when_cancelled() {
    let (host_stream, guest) = make_pair();

    let chunk_limit = file_impl::test_support::WRITE_FILE_CHUNK_LIMIT;
    let content = vec![0xABu8; chunk_limit + 100];
    let (first_chunk_tx, first_chunk_rx) = oneshot::channel::<()>();
    let (cleanup_tx, cleanup_rx) = oneshot::channel::<String>();

    let mut guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;

        let mut temp_path = None::<String>;
        let mut first_chunk_tx = Some(first_chunk_tx);
        let mut cleanup_tx = Some(cleanup_tx);

        loop {
            let msg = guest.read_message().await;
            match msg.msg_type {
                MSG_WRITE_FILE => {
                    let (path, _chunk, _sudo, _append) =
                        vsock_proto::decode_write_file(&msg.payload).unwrap();
                    if let Some(temp_path) = &temp_path {
                        assert_eq!(path, temp_path);
                        continue;
                    }

                    assert!(path.starts_with("/tmp/big.bin.vm0tmp-"));
                    temp_path = Some(path.to_string());
                    send_write_file_success(guest.stream_mut(), msg.seq).await;
                    if let Some(tx) = first_chunk_tx.take() {
                        let _ = tx.send(());
                    }
                }
                MSG_EXEC_START => {
                    let decoded = vsock_proto::decode_exec_start(&msg.payload).unwrap();
                    let temp_path = temp_path.as_ref().expect("temp path");
                    assert!(decoded.command.contains("rm -f --"));
                    assert!(decoded.command.contains(temp_path));
                    assert_eq!(decoded.label, "exec-cleanup");
                    if let Some(tx) = cleanup_tx.take() {
                        let _ = tx.send(decoded.command.to_string());
                    }
                    guest
                        .send_exec_result(
                            msg.seq,
                            ExecTermination::Exited { exit_code: 0 },
                            &[],
                            &[],
                        )
                        .await;
                    return;
                }
                _ => panic!("unexpected guest message type {:#04x}", msg.msg_type),
            }
        }
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let mut write = Box::pin(host.write_file("/tmp/big.bin", &content, false));
    tokio::select! {
        _ = &mut write => panic!("chunked write completed before cancellation"),
        result = first_chunk_rx => {
            if result.is_err() {
                match (&mut guest_task).await {
                    Ok(()) => panic!("mock guest finished before first chunk"),
                    Err(err) => panic!("mock guest task panicked before first chunk: {err}"),
                }
            }
        }
        result = &mut guest_task => {
            result.expect("mock guest task panicked before first chunk");
            panic!("mock guest finished before first chunk");
        }
    }
    drop(write);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );

    let cleanup_command = tokio::select! {
        biased;
        result = tokio::time::timeout(Duration::from_secs(2), cleanup_rx) => {
            match result {
                Ok(Ok(command)) => command,
                Ok(Err(_)) => {
                    match (&mut guest_task).await {
                        Ok(()) => panic!("mock guest finished before cleanup command"),
                        Err(err) => panic!("mock guest task panicked before cleanup command: {err}"),
                    }
                }
                Err(_) => panic!("cleanup command was not sent after cancellation"),
            }
        }
        result = &mut guest_task => {
            result.expect("mock guest task panicked before cleanup command");
            panic!("mock guest finished before cleanup command");
        }
    };
    assert!(cleanup_command.contains("rm -f --"));

    await_mock_guest(guest_task).await;
}
