use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot;
use vsock_proto::{
    Decoder, ExecTermination, MSG_ERROR, MSG_EXEC_START, MSG_WRITE_FILE, MSG_WRITE_FILE_RESULT,
};

use super::super::support::{
    assert_connection_accepts_exec_operation, host_from_stream, make_pair, mock_handshake,
    normal_operation_readiness, operation_count, pending_request_count, read_guest_message,
    send_exec_result, setup_host_and_guest,
};
use super::support::ChunkedWriteTempPath;
use crate::file as file_impl;
use crate::{FrameWriteObserver, operation_tracker::NormalOperationReadiness};

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
    let (host_stream, mut guest) = make_pair();

    // Content just over the chunk limit → 2 write messages + 1 exec (mv)
    let chunk_limit = file_impl::test_support::WRITE_FILE_CHUNK_LIMIT;
    let content = vec![0xABu8; chunk_limit + 100];
    let content_clone = content.clone();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut chunks_received = Vec::new();
        let mut temp_path = ChunkedWriteTempPath::default();
        let mut buf = vec![0u8; chunk_limit + 4096];

        // Read write_file chunks + final exec (mv) message
        loop {
            let n = guest.read(&mut buf).await.unwrap();
            if n == 0 {
                break;
            }
            let msgs = decoder.decode(&buf[..n]).unwrap();
            for msg in msgs {
                if msg.msg_type == MSG_WRITE_FILE {
                    let (path, chunk, _sudo, append) =
                        vsock_proto::decode_write_file(&msg.payload).unwrap();
                    temp_path.assert_next_chunk(path, "/tmp/big.bin");
                    chunks_received.push((append, chunk.to_vec()));

                    let payload = vsock_proto::encode_write_file_result(true, "");
                    let resp =
                        vsock_proto::encode(MSG_WRITE_FILE_RESULT, msg.seq, &payload).unwrap();
                    guest.write_all(&resp).await.unwrap();
                } else if msg.msg_type == MSG_EXEC_START {
                    // Atomic rename: mv temp → target
                    let decoded = vsock_proto::decode_exec_start(&msg.payload).unwrap();
                    assert!(decoded.command.contains("mv -f --"));
                    assert!(decoded.command.contains(temp_path.path()));
                    assert!(decoded.command.contains("/tmp/big.bin"));
                    assert_eq!(decoded.label, "write-file-rename");

                    send_exec_result(
                        &mut guest,
                        msg.seq,
                        ExecTermination::Exited { exit_code: 0 },
                        &[],
                        &[],
                    )
                    .await;
                    // Done — verify chunks and return
                    assert_eq!(chunks_received.len(), 2);
                    assert!(!chunks_received[0].0); // first: create
                    assert_eq!(chunks_received[0].1.len(), chunk_limit);
                    assert!(chunks_received[1].0); // second: append
                    assert_eq!(chunks_received[1].1.len(), 100);
                    let mut reassembled = chunks_received[0].1.clone();
                    reassembled.extend_from_slice(&chunks_received[1].1);
                    assert_eq!(reassembled, content_clone);
                    return;
                }
            }
        }
        panic!("guest loop ended without receiving exec (mv)");
    });

    let host = host_from_stream(host_stream).await.unwrap();
    host.write_file("/tmp/big.bin", &content, false)
        .await
        .unwrap();
}

#[tokio::test]
async fn write_file_chunked_tracks_one_operation_until_rename_result() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let chunk_limit = file_impl::test_support::WRITE_FILE_CHUNK_LIMIT;
    let content = vec![0xABu8; chunk_limit + 100];
    let write_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.write_file("/tmp/big.bin", &content, false).await })
    };

    let first = read_guest_message(&mut guest).await;
    assert_eq!(first.msg_type, MSG_WRITE_FILE);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );
    let payload = vsock_proto::encode_write_file_result(true, "");
    guest
        .write_all(&vsock_proto::encode(MSG_WRITE_FILE_RESULT, first.seq, &payload).unwrap())
        .await
        .unwrap();

    let second = read_guest_message(&mut guest).await;
    assert_eq!(second.msg_type, MSG_WRITE_FILE);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );
    let payload = vsock_proto::encode_write_file_result(true, "");
    guest
        .write_all(&vsock_proto::encode(MSG_WRITE_FILE_RESULT, second.seq, &payload).unwrap())
        .await
        .unwrap();

    let rename = read_guest_message(&mut guest).await;
    assert_eq!(rename.msg_type, MSG_EXEC_START);
    let decoded = vsock_proto::decode_exec_start(&rename.payload).unwrap();
    assert_eq!(decoded.label, "write-file-rename");
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    send_exec_result(
        &mut guest,
        rename.seq,
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;

    write_task.await.unwrap().unwrap();
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn write_file_chunked_rename_result_before_connection_close_keeps_tracker_closed_not_not_parkable()
 {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let chunk_limit = file_impl::test_support::WRITE_FILE_CHUNK_LIMIT;
    let content = vec![0xABu8; chunk_limit + 100];
    let write_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.write_file("/tmp/big.bin", &content, false).await })
    };

    let first = read_guest_message(&mut guest).await;
    assert_eq!(first.msg_type, MSG_WRITE_FILE);
    let payload = vsock_proto::encode_write_file_result(true, "");
    guest
        .write_all(&vsock_proto::encode(MSG_WRITE_FILE_RESULT, first.seq, &payload).unwrap())
        .await
        .unwrap();

    let second = read_guest_message(&mut guest).await;
    assert_eq!(second.msg_type, MSG_WRITE_FILE);
    let payload = vsock_proto::encode_write_file_result(true, "");
    guest
        .write_all(&vsock_proto::encode(MSG_WRITE_FILE_RESULT, second.seq, &payload).unwrap())
        .await
        .unwrap();

    let rename = read_guest_message(&mut guest).await;
    assert_eq!(rename.msg_type, MSG_EXEC_START);
    let decoded = vsock_proto::decode_exec_start(&rename.payload).unwrap();
    assert_eq!(decoded.label, "write-file-rename");
    send_exec_result(
        &mut guest,
        rename.seq,
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;
    drop(guest);

    write_task.await.unwrap().unwrap();
    assert_ne!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
}

#[tokio::test]
async fn write_file_chunked_failure_remains_busy_until_cleanup_result() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let chunk_limit = file_impl::test_support::WRITE_FILE_CHUNK_LIMIT;
    let content = vec![0xABu8; chunk_limit + 100];
    let write_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.write_file("/tmp/big.bin", &content, false).await })
    };

    let first = read_guest_message(&mut guest).await;
    assert_eq!(first.msg_type, MSG_WRITE_FILE);
    let payload = vsock_proto::encode_write_file_result(true, "");
    guest
        .write_all(&vsock_proto::encode(MSG_WRITE_FILE_RESULT, first.seq, &payload).unwrap())
        .await
        .unwrap();

    let second = read_guest_message(&mut guest).await;
    assert_eq!(second.msg_type, MSG_WRITE_FILE);
    let payload = vsock_proto::encode_write_file_result(false, "disk full");
    guest
        .write_all(&vsock_proto::encode(MSG_WRITE_FILE_RESULT, second.seq, &payload).unwrap())
        .await
        .unwrap();

    let cleanup = read_guest_message(&mut guest).await;
    assert_eq!(cleanup.msg_type, MSG_EXEC_START);
    let decoded = vsock_proto::decode_exec_start(&cleanup.payload).unwrap();
    assert_eq!(decoded.label, "exec-cleanup");
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    send_exec_result(
        &mut guest,
        cleanup.seq,
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;

    let err = write_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("disk full"));
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn write_file_chunked_error_response_cleans_up_and_releases_tracker() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let chunk_limit = file_impl::test_support::WRITE_FILE_CHUNK_LIMIT;
    let content = vec![0xABu8; chunk_limit + 100];
    let write_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.write_file("/tmp/big.bin", &content, false).await })
    };

    let first = read_guest_message(&mut guest).await;
    assert_eq!(first.msg_type, MSG_WRITE_FILE);
    let payload = vsock_proto::encode_write_file_result(true, "");
    guest
        .write_all(&vsock_proto::encode(MSG_WRITE_FILE_RESULT, first.seq, &payload).unwrap())
        .await
        .unwrap();

    let second = read_guest_message(&mut guest).await;
    assert_eq!(second.msg_type, MSG_WRITE_FILE);
    let payload = vsock_proto::encode_error("guest write failed");
    guest
        .write_all(&vsock_proto::encode(MSG_ERROR, second.seq, &payload).unwrap())
        .await
        .unwrap();

    let cleanup = read_guest_message(&mut guest).await;
    assert_eq!(cleanup.msg_type, MSG_EXEC_START);
    let decoded = vsock_proto::decode_exec_start(&cleanup.payload).unwrap();
    assert_eq!(decoded.label, "exec-cleanup");
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );
    send_exec_result(
        &mut guest,
        cleanup.seq,
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;

    let err = write_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("guest write failed"));
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn write_file_chunked_unexpected_response_keeps_tracker_fail_closed() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let chunk_limit = file_impl::test_support::WRITE_FILE_CHUNK_LIMIT;
    let content = vec![0xABu8; chunk_limit + 100];
    let write_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.write_file("/tmp/big.bin", &content, false).await })
    };

    let first = read_guest_message(&mut guest).await;
    assert_eq!(first.msg_type, MSG_WRITE_FILE);
    let payload = vsock_proto::encode_write_file_result(true, "");
    guest
        .write_all(&vsock_proto::encode(MSG_WRITE_FILE_RESULT, first.seq, &payload).unwrap())
        .await
        .unwrap();

    let second = read_guest_message(&mut guest).await;
    assert_eq!(second.msg_type, MSG_WRITE_FILE);
    guest
        .write_all(&vsock_proto::encode(MSG_EXEC_START, second.seq, &[]).unwrap())
        .await
        .unwrap();

    let err = write_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );

    let cleanup_retry =
        tokio::time::timeout(Duration::from_secs(2), read_guest_message(&mut guest))
            .await
            .expect("cleanup retry was not sent after unexpected response");
    assert_eq!(cleanup_retry.msg_type, MSG_EXEC_START);
    let decoded = vsock_proto::decode_exec_start(&cleanup_retry.payload).unwrap();
    assert_eq!(decoded.label, "exec-cleanup");
    assert!(decoded.command.contains("rm -f --"));
    send_exec_result(
        &mut guest,
        cleanup_retry.seq,
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;
}

#[tokio::test]
async fn write_file_chunked_rename_error_response_cleans_up_and_releases_tracker() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let chunk_limit = file_impl::test_support::WRITE_FILE_CHUNK_LIMIT;
    let content = vec![0xABu8; chunk_limit + 100];
    let write_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.write_file("/tmp/big.bin", &content, false).await })
    };

    let first = read_guest_message(&mut guest).await;
    assert_eq!(first.msg_type, MSG_WRITE_FILE);
    let payload = vsock_proto::encode_write_file_result(true, "");
    guest
        .write_all(&vsock_proto::encode(MSG_WRITE_FILE_RESULT, first.seq, &payload).unwrap())
        .await
        .unwrap();

    let second = read_guest_message(&mut guest).await;
    assert_eq!(second.msg_type, MSG_WRITE_FILE);
    let payload = vsock_proto::encode_write_file_result(true, "");
    guest
        .write_all(&vsock_proto::encode(MSG_WRITE_FILE_RESULT, second.seq, &payload).unwrap())
        .await
        .unwrap();

    let rename = read_guest_message(&mut guest).await;
    assert_eq!(rename.msg_type, MSG_EXEC_START);
    let decoded = vsock_proto::decode_exec_start(&rename.payload).unwrap();
    assert_eq!(decoded.label, "write-file-rename");
    let payload = vsock_proto::encode_error("rename unavailable");
    guest
        .write_all(&vsock_proto::encode(MSG_ERROR, rename.seq, &payload).unwrap())
        .await
        .unwrap();

    let cleanup = read_guest_message(&mut guest).await;
    assert_eq!(cleanup.msg_type, MSG_EXEC_START);
    let decoded = vsock_proto::decode_exec_start(&cleanup.payload).unwrap();
    assert_eq!(decoded.label, "exec-cleanup");
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );
    send_exec_result(
        &mut guest,
        cleanup.seq,
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;

    let err = write_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("rename unavailable"));
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn write_file_chunked_cleanup_error_retries_untracked_on_drop() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let chunk_limit = file_impl::test_support::WRITE_FILE_CHUNK_LIMIT;
    let content = vec![0xABu8; chunk_limit + 100];
    let write_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.write_file("/tmp/big.bin", &content, false).await })
    };

    let first = read_guest_message(&mut guest).await;
    assert_eq!(first.msg_type, MSG_WRITE_FILE);
    let payload = vsock_proto::encode_write_file_result(true, "");
    guest
        .write_all(&vsock_proto::encode(MSG_WRITE_FILE_RESULT, first.seq, &payload).unwrap())
        .await
        .unwrap();

    let second = read_guest_message(&mut guest).await;
    assert_eq!(second.msg_type, MSG_WRITE_FILE);
    let payload = vsock_proto::encode_write_file_result(false, "disk full");
    guest
        .write_all(&vsock_proto::encode(MSG_WRITE_FILE_RESULT, second.seq, &payload).unwrap())
        .await
        .unwrap();

    let cleanup = read_guest_message(&mut guest).await;
    assert_eq!(cleanup.msg_type, MSG_EXEC_START);
    let decoded = vsock_proto::decode_exec_start(&cleanup.payload).unwrap();
    assert_eq!(decoded.label, "exec-cleanup");
    let payload = vsock_proto::encode_error("cleanup unavailable");
    guest
        .write_all(&vsock_proto::encode(MSG_ERROR, cleanup.seq, &payload).unwrap())
        .await
        .unwrap();

    let err = write_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("disk full"));
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );

    let retry = tokio::time::timeout(Duration::from_secs(2), read_guest_message(&mut guest))
        .await
        .expect("cleanup retry was not sent after cleanup error");
    assert_eq!(retry.msg_type, MSG_EXEC_START);
    let decoded = vsock_proto::decode_exec_start(&retry.payload).unwrap();
    assert_eq!(decoded.label, "exec-cleanup");
    assert!(decoded.command.contains("rm -f --"));
    send_exec_result(
        &mut guest,
        retry.seq,
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;
}

#[tokio::test]
async fn write_file_chunked_cleanup_retry_does_not_reuse_write_observer() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_start_count = Arc::new(AtomicUsize::new(0));

    let chunk_limit = file_impl::test_support::WRITE_FILE_CHUNK_LIMIT;
    let content = vec![0xABu8; chunk_limit + 100];
    let write_task = {
        let host = Arc::clone(&host);
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

    let first = read_guest_message(&mut guest).await;
    assert_eq!(first.msg_type, MSG_WRITE_FILE);
    let payload = vsock_proto::encode_write_file_result(true, "");
    guest
        .write_all(&vsock_proto::encode(MSG_WRITE_FILE_RESULT, first.seq, &payload).unwrap())
        .await
        .unwrap();

    let second = read_guest_message(&mut guest).await;
    assert_eq!(second.msg_type, MSG_WRITE_FILE);
    let payload = vsock_proto::encode_write_file_result(false, "disk full");
    guest
        .write_all(&vsock_proto::encode(MSG_WRITE_FILE_RESULT, second.seq, &payload).unwrap())
        .await
        .unwrap();

    let cleanup = read_guest_message(&mut guest).await;
    assert_eq!(cleanup.msg_type, MSG_EXEC_START);
    let decoded = vsock_proto::decode_exec_start(&cleanup.payload).unwrap();
    assert_eq!(decoded.label, "exec-cleanup");
    let payload = vsock_proto::encode_error("cleanup unavailable");
    guest
        .write_all(&vsock_proto::encode(MSG_ERROR, cleanup.seq, &payload).unwrap())
        .await
        .unwrap();

    let err = write_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("disk full"));
    assert_eq!(write_start_count.load(Ordering::SeqCst), 3);

    let retry = tokio::time::timeout(Duration::from_secs(2), read_guest_message(&mut guest))
        .await
        .expect("cleanup retry was not sent after observer became inactive");
    assert_eq!(retry.msg_type, MSG_EXEC_START);
    let decoded = vsock_proto::decode_exec_start(&retry.payload).unwrap();
    assert_eq!(decoded.label, "exec-cleanup");
    assert!(decoded.command.contains("rm -f --"));
    send_exec_result(
        &mut guest,
        retry.seq,
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;
    assert_eq!(write_start_count.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn write_file_chunked_cleanup_nonzero_exit_retries_untracked_on_drop() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let chunk_limit = file_impl::test_support::WRITE_FILE_CHUNK_LIMIT;
    let content = vec![0xABu8; chunk_limit + 100];
    let write_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.write_file("/tmp/big.bin", &content, false).await })
    };

    let first = read_guest_message(&mut guest).await;
    assert_eq!(first.msg_type, MSG_WRITE_FILE);
    let payload = vsock_proto::encode_write_file_result(true, "");
    guest
        .write_all(&vsock_proto::encode(MSG_WRITE_FILE_RESULT, first.seq, &payload).unwrap())
        .await
        .unwrap();

    let second = read_guest_message(&mut guest).await;
    assert_eq!(second.msg_type, MSG_WRITE_FILE);
    let payload = vsock_proto::encode_write_file_result(false, "disk full");
    guest
        .write_all(&vsock_proto::encode(MSG_WRITE_FILE_RESULT, second.seq, &payload).unwrap())
        .await
        .unwrap();

    let cleanup = read_guest_message(&mut guest).await;
    assert_eq!(cleanup.msg_type, MSG_EXEC_START);
    let decoded = vsock_proto::decode_exec_start(&cleanup.payload).unwrap();
    assert_eq!(decoded.label, "exec-cleanup");
    send_exec_result(
        &mut guest,
        cleanup.seq,
        ExecTermination::Exited { exit_code: 1 },
        &[],
        b"permission denied",
    )
    .await;

    let err = write_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("disk full"));
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );

    let retry = tokio::time::timeout(Duration::from_secs(2), read_guest_message(&mut guest))
        .await
        .expect("cleanup retry was not sent after nonzero cleanup exit");
    assert_eq!(retry.msg_type, MSG_EXEC_START);
    let decoded = vsock_proto::decode_exec_start(&retry.payload).unwrap();
    assert_eq!(decoded.label, "exec-cleanup");
    assert!(decoded.command.contains("rm -f --"));
    send_exec_result(
        &mut guest,
        retry.seq,
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;
}

#[tokio::test]
async fn test_write_file_at_chunk_limit_uses_single_message() {
    let (host_stream, mut guest) = make_pair();

    let chunk_limit = file_impl::test_support::WRITE_FILE_CHUNK_LIMIT;
    let content = vec![0xABu8; chunk_limit];
    let content_clone = content.clone();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = vec![0u8; chunk_limit + 4096];
        let mut msgs = Vec::new();
        while msgs.is_empty() {
            let n = guest.read(&mut buf).await.unwrap();
            assert_ne!(n, 0, "connection closed before write_file message");
            msgs.extend(decoder.decode(&buf[..n]).unwrap());
        }
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].msg_type, MSG_WRITE_FILE);

        let (path, chunk, _sudo, append) =
            vsock_proto::decode_write_file(&msgs[0].payload).unwrap();
        assert_eq!(path, "/tmp/exact-limit.bin");
        assert_eq!(chunk, content_clone);
        assert!(!append);

        let payload = vsock_proto::encode_write_file_result(true, "");
        let resp = vsock_proto::encode(MSG_WRITE_FILE_RESULT, msgs[0].seq, &payload).unwrap();
        guest.write_all(&resp).await.unwrap();
    });

    let host = host_from_stream(host_stream).await.unwrap();
    host.write_file("/tmp/exact-limit.bin", &content, false)
        .await
        .unwrap();
}

#[tokio::test]
async fn test_write_file_chunked_cleans_up_on_chunk_failure() {
    let (host_stream, mut guest) = make_pair();

    let chunk_limit = file_impl::test_support::WRITE_FILE_CHUNK_LIMIT;
    let content = vec![0xABu8; chunk_limit + 100];

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = vec![0u8; chunk_limit + 4096];
        let mut chunk_count = 0u32;
        let mut temp_path = None::<String>;
        loop {
            let n = guest.read(&mut buf).await.unwrap();
            if n == 0 {
                break;
            }
            let msgs = decoder.decode(&buf[..n]).unwrap();
            for msg in msgs {
                if msg.msg_type == MSG_WRITE_FILE {
                    chunk_count += 1;
                    let (path, _chunk, _sudo, _append) =
                        vsock_proto::decode_write_file(&msg.payload).unwrap();
                    if let Some(temp_path) = &temp_path {
                        assert_eq!(path, temp_path);
                    } else {
                        assert!(path.starts_with("/tmp/big.bin.vm0tmp-"));
                        temp_path = Some(path.to_string());
                    }
                    let (success, err) = if chunk_count == 2 {
                        (false, "disk full")
                    } else {
                        (true, "")
                    };
                    let payload = vsock_proto::encode_write_file_result(success, err);
                    let resp =
                        vsock_proto::encode(MSG_WRITE_FILE_RESULT, msg.seq, &payload).unwrap();
                    guest.write_all(&resp).await.unwrap();
                } else if msg.msg_type == MSG_EXEC_START {
                    // Cleanup: rm -f temp file
                    let decoded = vsock_proto::decode_exec_start(&msg.payload).unwrap();
                    let temp_path = temp_path.as_ref().expect("temp path");
                    assert!(decoded.command.contains("rm -f --"));
                    assert!(decoded.command.contains(temp_path));
                    assert_eq!(decoded.label, "exec-cleanup");
                    send_exec_result(
                        &mut guest,
                        msg.seq,
                        ExecTermination::Exited { exit_code: 0 },
                        &[],
                        &[],
                    )
                    .await;
                    return;
                }
            }
        }
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let err = host
        .write_file("/tmp/big.bin", &content, false)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("disk full"));
}

#[tokio::test]
async fn test_write_file_chunked_cleans_up_on_mv_failure() {
    let (host_stream, mut guest) = make_pair();

    let chunk_limit = file_impl::test_support::WRITE_FILE_CHUNK_LIMIT;
    let content = vec![0xABu8; chunk_limit + 100];

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = vec![0u8; chunk_limit + 4096];
        let mut exec_count = 0u32;
        let mut temp_path = None::<String>;
        loop {
            let n = guest.read(&mut buf).await.unwrap();
            if n == 0 {
                break;
            }
            let msgs = decoder.decode(&buf[..n]).unwrap();
            for msg in msgs {
                if msg.msg_type == MSG_WRITE_FILE {
                    let (path, _chunk, _sudo, _append) =
                        vsock_proto::decode_write_file(&msg.payload).unwrap();
                    if let Some(temp_path) = &temp_path {
                        assert_eq!(path, temp_path);
                    } else {
                        assert!(path.starts_with("/tmp/big.bin.vm0tmp-"));
                        temp_path = Some(path.to_string());
                    }
                    let payload = vsock_proto::encode_write_file_result(true, "");
                    let resp =
                        vsock_proto::encode(MSG_WRITE_FILE_RESULT, msg.seq, &payload).unwrap();
                    guest.write_all(&resp).await.unwrap();
                } else if msg.msg_type == MSG_EXEC_START {
                    exec_count += 1;
                    let decoded = vsock_proto::decode_exec_start(&msg.payload).unwrap();
                    let temp_path = temp_path.as_ref().expect("temp path");
                    if decoded.command.contains("mv -f --") {
                        // mv fails
                        assert!(decoded.command.contains(temp_path));
                        assert_eq!(decoded.label, "write-file-rename");
                        send_exec_result(
                            &mut guest,
                            msg.seq,
                            ExecTermination::Exited { exit_code: 1 },
                            &[],
                            b"permission denied",
                        )
                        .await;
                    } else {
                        // cleanup rm
                        assert!(decoded.command.contains("rm -f --"));
                        assert!(decoded.command.contains(temp_path));
                        assert_eq!(decoded.label, "exec-cleanup");
                        send_exec_result(
                            &mut guest,
                            msg.seq,
                            ExecTermination::Exited { exit_code: 0 },
                            &[],
                            &[],
                        )
                        .await;
                        assert_eq!(exec_count, 2); // mv then rm
                        return;
                    }
                }
            }
        }
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let err = host
        .write_file("/tmp/big.bin", &content, false)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("permission denied"));
}

#[tokio::test]
async fn test_write_file_chunked_cleans_up_when_cancelled() {
    let (host_stream, mut guest) = make_pair();

    let chunk_limit = file_impl::test_support::WRITE_FILE_CHUNK_LIMIT;
    let content = vec![0xABu8; chunk_limit + 100];
    let (first_chunk_tx, first_chunk_rx) = oneshot::channel::<()>();
    let (cleanup_tx, cleanup_rx) = oneshot::channel::<String>();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = vec![0u8; chunk_limit + 4096];
        let mut temp_path = None::<String>;
        let mut first_chunk_tx = Some(first_chunk_tx);
        let mut cleanup_tx = Some(cleanup_tx);

        loop {
            let n = guest.read(&mut buf).await.unwrap();
            if n == 0 {
                break;
            }
            let msgs = decoder.decode(&buf[..n]).unwrap();
            for msg in msgs {
                if msg.msg_type == MSG_WRITE_FILE {
                    let (path, _chunk, _sudo, _append) =
                        vsock_proto::decode_write_file(&msg.payload).unwrap();
                    if let Some(temp_path) = &temp_path {
                        assert_eq!(path, temp_path);
                        continue;
                    }

                    assert!(path.starts_with("/tmp/big.bin.vm0tmp-"));
                    temp_path = Some(path.to_string());
                    let payload = vsock_proto::encode_write_file_result(true, "");
                    let resp =
                        vsock_proto::encode(MSG_WRITE_FILE_RESULT, msg.seq, &payload).unwrap();
                    guest.write_all(&resp).await.unwrap();
                    if let Some(tx) = first_chunk_tx.take() {
                        let _ = tx.send(());
                    }
                } else if msg.msg_type == MSG_EXEC_START {
                    let decoded = vsock_proto::decode_exec_start(&msg.payload).unwrap();
                    let temp_path = temp_path.as_ref().expect("temp path");
                    assert!(decoded.command.contains("rm -f --"));
                    assert!(decoded.command.contains(temp_path));
                    assert_eq!(decoded.label, "exec-cleanup");
                    if let Some(tx) = cleanup_tx.take() {
                        let _ = tx.send(decoded.command.to_string());
                    }
                    send_exec_result(
                        &mut guest,
                        msg.seq,
                        ExecTermination::Exited { exit_code: 0 },
                        &[],
                        &[],
                    )
                    .await;
                    return;
                }
            }
        }
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let mut write = Box::pin(host.write_file("/tmp/big.bin", &content, false));
    tokio::select! {
        _ = &mut write => panic!("chunked write completed before cancellation"),
        result = first_chunk_rx => result.unwrap(),
    }
    drop(write);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );

    let cleanup_command = tokio::time::timeout(Duration::from_secs(2), cleanup_rx)
        .await
        .expect("cleanup command was not sent after cancellation")
        .expect("cleanup sender dropped");
    assert!(cleanup_command.contains("rm -f --"));
}
