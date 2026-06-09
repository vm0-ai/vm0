use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::Arc;

use vsock_proto::{
    ExecOutputPolicy, ExecOutputStream, ExecTermination, MSG_EXEC_CANCEL, MSG_EXEC_START,
};

use super::super::support::{
    assert_connection_accepts_exec_operation, normal_operation_readiness, operation_count,
    read_guest_message, send_exec_output, send_stream_exec_result, setup_host_and_guest,
};
use super::support::{
    HostTempDir, HostTempPath, copy_options, default_copy_options, expect_exec_start,
    send_guest_error, spawn_copy_file,
};
use crate::file as file_impl;
use crate::operation_tracker::NormalOperationReadiness;

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[tokio::test]
async fn copy_file_rejects_max_bytes_above_stream_budget() {
    let (host, _guest) = setup_host_and_guest().await;
    let err = host
        .copy_file(
            "/tmp/large.log",
            Path::new("/tmp/large.log"),
            copy_options(
                file_impl::test_support::COPY_FILE_STREAM_MAX_BYTES + 1,
                5000,
                false,
            ),
        )
        .await
        .unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert!(err.to_string().contains("copy_file max_bytes"));
}

#[tokio::test]
async fn copy_file_streams_to_temp_then_renames() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let temp_dir = HostTempDir::new("vsock-host-copy");
    let host_path = temp_dir.join("system.log");
    let copy_path = host_path.clone();

    let copy_task = spawn_copy_file(
        Arc::clone(&host),
        "/tmp/vm0-system-run.log",
        copy_path,
        default_copy_options(),
    );

    let start = expect_exec_start(&mut guest).await;
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );
    assert_eq!(start.label, "copy-file");
    assert_eq!(
        start.command,
        "if test -f '/tmp/vm0-system-run.log'; then cat -- '/tmp/vm0-system-run.log'; else exit 66; fi"
    );
    assert_eq!(
        start.stdout,
        ExecOutputPolicy::Stream {
            limit_bytes: 1024,
            chunk_limit_bytes: 64 * 1024,
        }
    );
    send_exec_output(
        &mut guest,
        start.seq(),
        0,
        ExecOutputStream::Stdout,
        b"line 1\n",
        false,
    )
    .await;
    send_exec_output(
        &mut guest,
        start.seq(),
        1,
        ExecOutputStream::Stdout,
        b"line 2\n",
        false,
    )
    .await;
    send_stream_exec_result(
        &mut guest,
        start.seq(),
        ExecTermination::Exited { exit_code: 0 },
        b"",
    )
    .await;

    let result = copy_task.await.unwrap().unwrap();
    assert_eq!(result.bytes_copied, 14);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    assert_eq!(std::fs::read(&host_path).unwrap(), b"line 1\nline 2\n");
    assert_eq!(mode(&host_path), 0o600);
    temp_dir.assert_no_vm0tmp_files();
}

#[tokio::test]
async fn copy_file_rejects_invalid_options_without_sending_frame_or_creating_parent() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let temp_path = HostTempPath::new("vsock-host-copy-invalid");
    let host_path = temp_path.join("nested/system.log");

    let err = host
        .copy_file("/tmp/system.log", &host_path, copy_options(0, 5000, false))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert!(!temp_path.path().exists());

    let err = host
        .copy_file("/tmp/system.log", &host_path, copy_options(1024, 0, false))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert!(!temp_path.path().exists());
    assert_eq!(operation_count(&host), 0);

    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn copy_file_creates_parent_and_quotes_guest_path_with_single_quote() {
    let (host, mut guest) = setup_host_and_guest().await;
    let temp_path = HostTempPath::new("vsock-host-copy-parent-quote");
    let host_path = temp_path.join("nested/system.log");
    let copy_path = host_path.clone();

    let copy_task = tokio::spawn(async move {
        host.copy_file(
            "/tmp/vm0-system-run's.log",
            &copy_path,
            default_copy_options(),
        )
        .await
    });

    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    let decoded = vsock_proto::decode_exec_start(&msg.payload).unwrap();
    assert_eq!(
        decoded.command,
        "if test -f '/tmp/vm0-system-run'\\''s.log'; then cat -- '/tmp/vm0-system-run'\\''s.log'; else exit 66; fi"
    );
    send_exec_output(
        &mut guest,
        msg.seq,
        0,
        ExecOutputStream::Stdout,
        b"quoted path\n",
        false,
    )
    .await;
    send_stream_exec_result(
        &mut guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"",
    )
    .await;

    let result = copy_task.await.unwrap().unwrap();
    assert_eq!(result.bytes_copied, 12);
    assert_eq!(std::fs::read(&host_path).unwrap(), b"quoted path\n");
}

#[tokio::test]
async fn copy_file_removes_temp_without_publishing_on_stream_truncation() {
    let (host, mut guest) = setup_host_and_guest().await;
    let temp_dir = HostTempDir::new("vsock-host-copy-truncated");
    let host_path = temp_dir.join("system.log");
    std::fs::write(&host_path, b"old host log").unwrap();
    let copy_path = host_path.clone();

    let copy_task = tokio::spawn(async move {
        host.copy_file(
            "/tmp/vm0-system-run.log",
            &copy_path,
            default_copy_options(),
        )
        .await
    });

    let msg = read_guest_message(&mut guest).await;
    send_exec_output(
        &mut guest,
        msg.seq,
        0,
        ExecOutputStream::Stdout,
        b"partial",
        true,
    )
    .await;

    let cancel = read_guest_message(&mut guest).await;
    assert_eq!(cancel.msg_type, MSG_EXEC_CANCEL);
    assert_eq!(cancel.seq, msg.seq);
    send_stream_exec_result(&mut guest, msg.seq, ExecTermination::Cancelled, b"").await;

    let err = copy_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("truncated"));
    assert_eq!(std::fs::read(&host_path).unwrap(), b"old host log");
    temp_dir.assert_no_vm0tmp_files();
}

#[tokio::test]
async fn copy_file_stream_error_releases_tracker_when_cancel_sees_terminal_result() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let temp_dir = HostTempDir::new("vsock-host-copy-cancel-terminal");
    let host_path = temp_dir.join("system.log");
    std::fs::write(&host_path, b"old host log").unwrap();
    let copy_path = host_path.clone();

    let copy_task = spawn_copy_file(
        Arc::clone(&host),
        "/tmp/vm0-system-run.log",
        copy_path,
        default_copy_options(),
    );

    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );
    send_exec_output(
        &mut guest,
        msg.seq,
        0,
        ExecOutputStream::Stdout,
        b"partial",
        true,
    )
    .await;

    let cancel = read_guest_message(&mut guest).await;
    assert_eq!(cancel.msg_type, MSG_EXEC_CANCEL);
    assert_eq!(cancel.seq, msg.seq);
    send_stream_exec_result(
        &mut guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"",
    )
    .await;

    let err = copy_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("truncated"));
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    assert_eq!(std::fs::read(&host_path).unwrap(), b"old host log");
    temp_dir.assert_no_vm0tmp_files();
}

#[tokio::test]
async fn copy_file_error_response_releases_tracker_after_temp_cleanup() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let temp_dir = HostTempDir::new("vsock-host-copy-error-response");
    let host_path = temp_dir.join("system.log");
    std::fs::write(&host_path, b"old host log").unwrap();
    let copy_path = host_path.clone();

    let copy_task = spawn_copy_file(
        Arc::clone(&host),
        "/tmp/vm0-system-run.log",
        copy_path,
        default_copy_options(),
    );

    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    send_guest_error(&mut guest, msg.seq, "guest copy failed").await;

    let err = copy_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("guest copy failed"));
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    assert_eq!(std::fs::read(&host_path).unwrap(), b"old host log");
    temp_dir.assert_no_vm0tmp_files();
}

#[tokio::test]
async fn copy_file_connection_close_after_request_removes_temp_and_marks_not_parkable() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let temp_dir = HostTempDir::new("vsock-host-copy-connection-close");
    let host_path = temp_dir.join("system.log");
    let copy_path = host_path.clone();

    let copy_task = spawn_copy_file(
        Arc::clone(&host),
        "/tmp/vm0-system-run.log",
        copy_path,
        default_copy_options(),
    );

    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    drop(guest);
    let err = copy_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
    assert!(!host_path.exists());
    temp_dir.assert_no_vm0tmp_files();
}

#[tokio::test]
async fn copy_file_terminal_result_before_connection_close_keeps_tracker_closed_not_not_parkable() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let temp_dir = HostTempDir::new("vsock-host-copy-terminal-close");
    let host_path = temp_dir.join("system.log");
    let copy_path = host_path.clone();

    let copy_task = spawn_copy_file(
        Arc::clone(&host),
        "/tmp/vm0-system-run.log",
        copy_path,
        default_copy_options(),
    );

    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    send_exec_output(
        &mut guest,
        msg.seq,
        0,
        ExecOutputStream::Stdout,
        b"complete\n",
        false,
    )
    .await;
    send_stream_exec_result(
        &mut guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"",
    )
    .await;
    drop(guest);

    let result = copy_task.await.unwrap().unwrap();
    assert_eq!(result.bytes_copied, 9);
    assert_eq!(std::fs::read(&host_path).unwrap(), b"complete\n");
    assert_ne!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
}

#[tokio::test]
async fn copy_file_rename_failure_removes_temp_and_releases_tracker() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let temp_dir = HostTempDir::new("vsock-host-copy-rename-failure");
    let host_path = temp_dir.join("system.log");
    std::fs::create_dir_all(&host_path).unwrap();
    let copy_path = host_path.clone();

    let copy_task = spawn_copy_file(
        Arc::clone(&host),
        "/tmp/vm0-system-run.log",
        copy_path,
        default_copy_options(),
    );

    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    send_exec_output(
        &mut guest,
        msg.seq,
        0,
        ExecOutputStream::Stdout,
        b"complete\n",
        false,
    )
    .await;
    send_stream_exec_result(
        &mut guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"",
    )
    .await;

    copy_task.await.unwrap().unwrap_err();
    assert!(host_path.is_dir());
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    temp_dir.assert_no_vm0tmp_files();
}

#[tokio::test]
async fn copy_file_nonzero_exit_removes_temp_without_publishing_partial_output() {
    let (host, mut guest) = setup_host_and_guest().await;
    let temp_dir = HostTempDir::new("vsock-host-copy-nonzero");
    let host_path = temp_dir.join("system.log");
    std::fs::write(&host_path, b"old host log").unwrap();
    let copy_path = host_path.clone();

    let copy_task = tokio::spawn(async move {
        host.copy_file(
            "/tmp/vm0-system-run.log",
            &copy_path,
            default_copy_options(),
        )
        .await
    });

    let msg = read_guest_message(&mut guest).await;
    send_exec_output(
        &mut guest,
        msg.seq,
        0,
        ExecOutputStream::Stdout,
        b"partial",
        false,
    )
    .await;
    send_stream_exec_result(
        &mut guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 1 },
        b"read error",
    )
    .await;

    let err = copy_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("read error"));
    assert_eq!(std::fs::read(&host_path).unwrap(), b"old host log");
    temp_dir.assert_no_vm0tmp_files();
}

#[tokio::test]
async fn copy_file_missing_ok_leaves_no_final_or_temp_file() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let temp_dir = HostTempDir::new("vsock-host-copy-missing");
    let host_path = temp_dir.join("system.log");
    let copy_path = host_path.clone();

    let copy_task = spawn_copy_file(
        Arc::clone(&host),
        "/tmp/missing.log",
        copy_path,
        copy_options(1024, 5000, true),
    );

    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );
    let decoded = vsock_proto::decode_exec_start(&msg.payload).unwrap();
    assert_eq!(decoded.expected_exit_codes, vec![66]);
    send_stream_exec_result(
        &mut guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 66 },
        b"",
    )
    .await;

    let result = copy_task.await.unwrap().unwrap();
    assert_eq!(result.bytes_copied, 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    assert!(!host_path.exists());
    temp_dir.assert_no_vm0tmp_files();
}

#[tokio::test]
async fn copy_file_missing_without_missing_ok_preserves_existing_file_and_removes_temp() {
    let (host, mut guest) = setup_host_and_guest().await;
    let temp_dir = HostTempDir::new("vsock-host-copy-missing-error");
    let host_path = temp_dir.join("system.log");
    std::fs::write(&host_path, b"old host log").unwrap();
    let copy_path = host_path.clone();

    let copy_task = tokio::spawn(async move {
        host.copy_file("/tmp/missing.log", &copy_path, default_copy_options())
            .await
    });

    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    let decoded = vsock_proto::decode_exec_start(&msg.payload).unwrap();
    assert!(decoded.expected_exit_codes.is_empty());
    send_stream_exec_result(
        &mut guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 66 },
        b"",
    )
    .await;

    let err = copy_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::NotFound);
    assert_eq!(std::fs::read(&host_path).unwrap(), b"old host log");
    temp_dir.assert_no_vm0tmp_files();
}

#[tokio::test]
async fn copy_file_cancellation_cancels_guest_exec_operation_and_removes_temp() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let temp_dir = HostTempDir::new("vsock-host-copy-cancel");
    let host_path = temp_dir.join("system.log");
    let copy_path = host_path.clone();

    let copy_task = spawn_copy_file(
        Arc::clone(&host),
        "/tmp/vm0-system-run.log",
        copy_path,
        default_copy_options(),
    );

    let start = read_guest_message(&mut guest).await;
    assert_eq!(start.msg_type, MSG_EXEC_START);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );
    let temp_paths: Vec<_> = std::fs::read_dir(temp_dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.contains("vm0tmp"))
        })
        .collect();
    assert_eq!(temp_paths.len(), 1);

    copy_task.abort();
    assert!(copy_task.await.unwrap_err().is_cancelled());
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );

    let cancel = read_guest_message(&mut guest).await;
    assert_eq!(cancel.msg_type, MSG_EXEC_CANCEL);
    assert_eq!(cancel.seq, start.seq);
    assert!(!host_path.exists());
    temp_dir.assert_no_vm0tmp_files();
}
