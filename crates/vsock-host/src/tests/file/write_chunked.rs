use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use vsock_proto::{ExecOutputPolicy, ExecTermination, MSG_EXEC_START, MSG_WRITE_FILE};

use super::super::support::{
    MockGuest, assert_connection_accepts_exec_operation, await_mock_guest, host_from_stream,
    make_pair, normal_operation_readiness, operation_count, pending_request_count,
    read_guest_message, send_exec_result, setup_host_and_guest,
};
use super::support::{
    ExecStartFrame, WriteFileFrame, expect_exec_start, expect_write_file, send_guest_error,
    send_write_file_failure, send_write_file_success, spawn_write_file,
};
use crate::{FrameWriteObserver, VsockHost, operation_tracker::NormalOperationReadiness};
use crate::{exec_operation, file as file_impl};

struct ChunkedWriteFixture {
    host: Arc<VsockHost>,
    guest: UnixStream,
    target_path: &'static str,
    temp_path: Option<String>,
    sudo: bool,
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
            sudo: false,
        }
    }

    fn chunk_limit() -> usize {
        file_impl::test_support::WRITE_FILE_CHUNK_LIMIT
    }

    fn two_chunk_content() -> Vec<u8> {
        vec![0xABu8; Self::chunk_limit() + 100]
    }

    fn three_chunk_content() -> Vec<u8> {
        vec![0xABu8; Self::chunk_limit() * 2 + 100]
    }

    fn spawn_write(&mut self, content: Vec<u8>, sudo: bool) -> JoinHandle<io::Result<()>> {
        self.sudo = sudo;
        spawn_write_file(Arc::clone(&self.host), self.target_path, content, sudo)
    }

    async fn expect_chunk(&mut self) -> WriteFileFrame {
        let frame = expect_write_file(&mut self.guest).await;
        assert_eq!(frame.sudo, self.sudo);
        if let Some(temp_path) = &self.temp_path {
            assert_eq!(frame.path.as_str(), temp_path);
            assert!(frame.append);
        } else {
            assert!(
                frame
                    .path
                    .starts_with(&format!("{}.vm0tmp-", self.target_path))
            );
            assert!(!frame.append);
            self.temp_path = Some(frame.path.clone());
        }
        frame
    }

    async fn expect_rename(&mut self) -> ExecStartFrame {
        let frame = expect_exec_start(&mut self.guest).await;
        assert_eq!(frame.label, "write-file-rename");
        assert_eq!(frame.sudo, self.sudo);
        assert_helper_exec_capture_policy(&frame);
        assert_eq!(frame.command, self.expected_rename_command());
        frame
    }

    async fn expect_cleanup(&mut self) -> ExecStartFrame {
        let frame = expect_exec_start(&mut self.guest).await;
        assert_eq!(frame.label, "exec-cleanup");
        assert_eq!(frame.sudo, self.sudo);
        assert_helper_exec_capture_policy(&frame);
        assert_eq!(frame.command, self.expected_cleanup_command());
        frame
    }

    fn expected_rename_command(&self) -> String {
        format!(
            "mv -f -- {} {}",
            shell_quote_for_test(self.temp_path()),
            shell_quote_for_test(self.target_path)
        )
    }

    fn expected_cleanup_command(&self) -> String {
        format!("rm -f -- {}", shell_quote_for_test(self.temp_path()))
    }

    fn assert_readiness(&self, expected: NormalOperationReadiness) {
        assert_eq!(normal_operation_readiness(&self.host), expected);
    }

    fn temp_path(&self) -> &str {
        self.temp_path.as_deref().expect("temp path")
    }
}

fn assert_helper_exec_capture_policy(frame: &ExecStartFrame) {
    let capture_policy = helper_exec_capture_policy();
    assert_eq!(frame.stdout, capture_policy);
    assert_eq!(frame.stderr, capture_policy);
    assert!(frame.expected_exit_codes.is_empty());
}

fn helper_exec_capture_policy() -> ExecOutputPolicy {
    ExecOutputPolicy::Capture {
        limit_bytes: exec_operation::SMALL_EXEC_CAPTURE_LIMIT_BYTES,
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
async fn write_file_chunked_rejects_temp_path_overflow_before_cleanup_or_write() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_start_count = Arc::new(AtomicUsize::new(0));
    let path = format!("/{}", "a".repeat(u16::MAX as usize - 1));
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
    let content = ChunkedWriteFixture::three_chunk_content();
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

    let third = fixture.expect_chunk().await;
    let third_seq = third.seq();
    chunks_received.push((third.append, third.content));
    send_write_file_success(&mut fixture.guest, third_seq).await;

    let rename = fixture.expect_rename().await;

    assert_eq!(chunks_received.len(), 3);
    assert!(!chunks_received[0].0);
    assert_eq!(chunks_received[0].1.len(), chunk_limit);
    assert!(chunks_received[1].0);
    assert_eq!(chunks_received[1].1.len(), chunk_limit);
    assert!(chunks_received[2].0);
    assert_eq!(chunks_received[2].1.len(), 100);
    let mut reassembled = chunks_received[0].1.clone();
    reassembled.extend_from_slice(&chunks_received[1].1);
    reassembled.extend_from_slice(&chunks_received[2].1);
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
async fn write_file_chunked_quotes_target_path_with_single_quote() {
    let mut fixture = ChunkedWriteFixture::new("/tmp/big'quote.bin").await;
    let write_task = fixture.spawn_write(ChunkedWriteFixture::two_chunk_content(), false);

    let first = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, first.seq()).await;

    let second = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, second.seq()).await;

    let rename = fixture.expect_rename().await;
    assert!(rename.command.contains("'/tmp/big'\\''quote.bin.vm0tmp-"));
    assert!(rename.command.ends_with(" '/tmp/big'\\''quote.bin'"));
    send_exec_result(
        &mut fixture.guest,
        rename.seq(),
        ExecTermination::Exited { exit_code: 1 },
        &[],
        b"permission denied",
    )
    .await;

    let cleanup = fixture.expect_cleanup().await;
    assert!(
        cleanup
            .command
            .starts_with("rm -f -- '/tmp/big'\\''quote.bin.vm0tmp-")
    );
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
async fn write_file_chunked_concurrent_writes_to_same_target_use_distinct_temp_paths() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let target_path = "/tmp/shared.bin";
    let chunk_limit = ChunkedWriteFixture::chunk_limit();
    let write_a = spawn_write_file(
        Arc::clone(&host),
        target_path,
        vec![0xAA; chunk_limit + 1],
        false,
    );
    let write_b = spawn_write_file(
        Arc::clone(&host),
        target_path,
        vec![0xBB; chunk_limit + 1],
        false,
    );
    let mut chunks_by_temp: BTreeMap<String, (u8, usize)> = BTreeMap::new();
    let mut temp_by_marker: BTreeMap<u8, String> = BTreeMap::new();
    let mut renamed_temps = BTreeSet::new();

    while renamed_temps.len() < 2 {
        let msg = read_guest_message(&mut guest).await;
        match msg.msg_type {
            MSG_WRITE_FILE => {
                let (path, content, sudo, append) =
                    vsock_proto::decode_write_file(&msg.payload).unwrap();
                assert!(!sudo);
                assert!(path.starts_with(&format!("{target_path}.vm0tmp-")));
                let marker = *content.first().expect("chunk content");
                assert!(matches!(marker, 0xAA | 0xBB));
                assert!(content.iter().all(|byte| *byte == marker));

                if let Some((known_marker, chunk_count)) = chunks_by_temp.get_mut(path) {
                    assert_eq!(*known_marker, marker);
                    assert!(append);
                    assert_eq!(content.len(), 1);
                    *chunk_count += 1;
                } else {
                    assert!(!append);
                    assert_eq!(content.len(), chunk_limit);
                    assert!(temp_by_marker.insert(marker, path.to_string()).is_none());
                    chunks_by_temp.insert(path.to_string(), (marker, 1));
                }

                send_write_file_success(&mut guest, msg.seq).await;
            }
            MSG_EXEC_START => {
                let decoded = vsock_proto::decode_exec_start(&msg.payload).unwrap();
                assert_eq!(decoded.label, "write-file-rename");
                assert!(!decoded.sudo);
                assert_eq!(decoded.stdout, helper_exec_capture_policy());
                assert_eq!(decoded.stderr, helper_exec_capture_policy());
                assert!(decoded.expected_exit_codes.is_empty());

                let renamed_temp = chunks_by_temp
                    .iter()
                    .find_map(|(temp_path, (_marker, chunk_count))| {
                        let expected_command = format!(
                            "mv -f -- {} {}",
                            shell_quote_for_test(temp_path),
                            shell_quote_for_test(target_path)
                        );
                        (decoded.command == expected_command && *chunk_count == 2)
                            .then(|| temp_path.clone())
                    })
                    .expect("rename should target a completed temp path");
                assert!(renamed_temps.insert(renamed_temp));

                send_exec_result(
                    &mut guest,
                    msg.seq,
                    ExecTermination::Exited { exit_code: 0 },
                    &[],
                    &[],
                )
                .await;
            }
            _ => panic!("unexpected guest message type {:#04x}", msg.msg_type),
        }
    }

    assert_eq!(chunks_by_temp.len(), 2);
    assert_eq!(temp_by_marker.len(), 2);
    assert_ne!(temp_by_marker.get(&0xAA), temp_by_marker.get(&0xBB));
    assert!(chunks_by_temp.values().all(|(_marker, count)| *count == 2));

    write_a.await.unwrap().unwrap();
    write_b.await.unwrap().unwrap();
}

#[tokio::test]
async fn write_file_chunked_concurrent_failure_cleans_only_failed_temp_path() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let target_path = "/tmp/shared-failure.bin";
    let chunk_limit = ChunkedWriteFixture::chunk_limit();
    let success_marker = 0xAA;
    let failure_marker = 0xBB;
    let successful_write = spawn_write_file(
        Arc::clone(&host),
        target_path,
        vec![success_marker; chunk_limit + 1],
        false,
    );
    let failing_write = spawn_write_file(
        Arc::clone(&host),
        target_path,
        vec![failure_marker; chunk_limit + 1],
        false,
    );
    let mut temp_by_marker: BTreeMap<u8, String> = BTreeMap::new();
    let mut first_chunks = BTreeMap::new();
    while first_chunks.len() < 2 {
        let msg = read_guest_message(&mut guest).await;
        assert_eq!(msg.msg_type, MSG_WRITE_FILE);
        let (path, content, sudo, append) = vsock_proto::decode_write_file(&msg.payload).unwrap();
        assert!(!sudo);
        assert!(!append);
        assert!(path.starts_with(&format!("{target_path}.vm0tmp-")));
        assert_eq!(content.len(), chunk_limit);
        let marker = *content.first().expect("chunk content");
        assert!(matches!(marker, 0xAA | 0xBB));
        assert!(content.iter().all(|byte| *byte == marker));
        assert!(first_chunks.insert(marker, msg.seq).is_none());
        assert!(temp_by_marker.insert(marker, path.to_string()).is_none());
    }

    for seq in first_chunks.values() {
        send_write_file_success(&mut guest, *seq).await;
    }

    let mut second_chunks = BTreeMap::new();
    while second_chunks.len() < 2 {
        let msg = read_guest_message(&mut guest).await;
        assert_eq!(msg.msg_type, MSG_WRITE_FILE);
        let (path, content, sudo, append) = vsock_proto::decode_write_file(&msg.payload).unwrap();
        assert!(!sudo);
        assert!(append);
        assert_eq!(content.len(), 1);
        let marker = *content.first().expect("chunk content");
        assert!(matches!(marker, 0xAA | 0xBB));
        assert!(content.iter().all(|byte| *byte == marker));
        assert_eq!(
            path,
            temp_by_marker
                .get(&marker)
                .expect("second chunk should use first chunk temp path")
        );
        assert!(second_chunks.insert(marker, msg.seq).is_none());
    }

    send_write_file_failure(
        &mut guest,
        *second_chunks
            .get(&failure_marker)
            .expect("failure second chunk"),
        "disk full",
    )
    .await;
    send_write_file_success(
        &mut guest,
        *second_chunks
            .get(&success_marker)
            .expect("success second chunk"),
    )
    .await;

    let mut successful_temp_renamed = false;
    let mut failed_temp_cleaned = false;

    while !(successful_temp_renamed && failed_temp_cleaned) {
        let msg = read_guest_message(&mut guest).await;
        assert_eq!(msg.msg_type, MSG_EXEC_START);
        let decoded = vsock_proto::decode_exec_start(&msg.payload).unwrap();
        assert!(!decoded.sudo);
        assert_eq!(decoded.stdout, helper_exec_capture_policy());
        assert_eq!(decoded.stderr, helper_exec_capture_policy());
        assert!(decoded.expected_exit_codes.is_empty());
        let success_temp = temp_by_marker
            .get(&success_marker)
            .expect("successful temp path");
        let failed_temp = temp_by_marker
            .get(&failure_marker)
            .expect("failed temp path");
        assert_ne!(success_temp, failed_temp);

        match decoded.label {
            "write-file-rename" => {
                let expected_command = format!(
                    "mv -f -- {} {}",
                    shell_quote_for_test(success_temp),
                    shell_quote_for_test(target_path)
                );
                assert_eq!(decoded.command, expected_command);
                successful_temp_renamed = true;
            }
            "exec-cleanup" => {
                let expected_command = format!("rm -f -- {}", shell_quote_for_test(failed_temp));
                assert_eq!(decoded.command, expected_command);
                failed_temp_cleaned = true;
            }
            label => panic!("unexpected exec label {label}"),
        }

        send_exec_result(
            &mut guest,
            msg.seq,
            ExecTermination::Exited { exit_code: 0 },
            &[],
            &[],
        )
        .await;
    }

    successful_write.await.unwrap().unwrap();
    let err = failing_write.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("disk full"));
}

#[tokio::test]
async fn write_file_chunked_preserves_sudo_on_chunks_rename_cleanup_and_retry() {
    let mut rename_fixture = ChunkedWriteFixture::new("/tmp/sudo-big.bin").await;
    let rename_task = rename_fixture.spawn_write(ChunkedWriteFixture::two_chunk_content(), true);

    let first = rename_fixture.expect_chunk().await;
    send_write_file_success(&mut rename_fixture.guest, first.seq()).await;

    let second = rename_fixture.expect_chunk().await;
    send_write_file_success(&mut rename_fixture.guest, second.seq()).await;

    let rename = rename_fixture.expect_rename().await;
    send_exec_result(
        &mut rename_fixture.guest,
        rename.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;

    rename_task.await.unwrap().unwrap();

    let mut cleanup_fixture = ChunkedWriteFixture::new("/tmp/sudo-cleanup.bin").await;
    let cleanup_task = cleanup_fixture.spawn_write(ChunkedWriteFixture::two_chunk_content(), true);

    let first = cleanup_fixture.expect_chunk().await;
    send_write_file_success(&mut cleanup_fixture.guest, first.seq()).await;

    let second = cleanup_fixture.expect_chunk().await;
    send_write_file_failure(&mut cleanup_fixture.guest, second.seq(), "disk full").await;

    let cleanup = cleanup_fixture.expect_cleanup().await;
    send_guest_error(
        &mut cleanup_fixture.guest,
        cleanup.seq(),
        "cleanup unavailable",
    )
    .await;

    let err = cleanup_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("disk full"));
    cleanup_fixture.assert_readiness(NormalOperationReadiness::NotParkable);

    let retry = tokio::time::timeout(Duration::from_secs(2), cleanup_fixture.expect_cleanup())
        .await
        .expect("cleanup retry was not sent after sudo cleanup error");
    send_exec_result(
        &mut cleanup_fixture.guest,
        retry.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;
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
                    let (path, _chunk, sudo, append) =
                        vsock_proto::decode_write_file(&msg.payload).unwrap();
                    assert!(!sudo);
                    if let Some(temp_path) = &temp_path {
                        assert_eq!(path, temp_path);
                        assert!(append);
                        continue;
                    }

                    assert!(path.starts_with("/tmp/big.bin.vm0tmp-"));
                    assert!(!append);
                    temp_path = Some(path.to_string());
                    send_write_file_success(guest.stream_mut(), msg.seq).await;
                    if let Some(tx) = first_chunk_tx.take() {
                        let _ = tx.send(());
                    }
                }
                MSG_EXEC_START => {
                    let decoded = vsock_proto::decode_exec_start(&msg.payload).unwrap();
                    let temp_path = temp_path.as_ref().expect("temp path");
                    let expected_cleanup_command =
                        format!("rm -f -- {}", shell_quote_for_test(temp_path));
                    assert_eq!(decoded.command, expected_cleanup_command.as_str());
                    assert_eq!(decoded.label, "exec-cleanup");
                    assert!(!decoded.sudo);
                    assert_eq!(decoded.stdout, helper_exec_capture_policy());
                    assert_eq!(decoded.stderr, helper_exec_capture_policy());
                    assert!(decoded.expected_exit_codes.is_empty());
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
