use std::io;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot;
use vsock_proto::{
    Decoder, ExecCapturedOutput, ExecOutputPolicy, ExecOutputStream, ExecTermination, MSG_ERROR,
    MSG_EXEC_CANCEL, MSG_EXEC_START, MSG_WRITE_FILE, MSG_WRITE_FILE_RESULT,
};

use super::support::{
    assert_connection_accepts_exec_operation, host_from_stream, make_pair, mock_handshake,
    normal_operation_readiness, operation_count, read_guest_message, send_exec_output,
    send_exec_result, send_raw_exec_result, send_stream_exec_result, setup_host_and_guest,
};
use crate::file as file_impl;
use crate::{CopyFileOptions, operation_tracker::NormalOperationReadiness};

#[tokio::test]
async fn copy_file_rejects_max_bytes_above_stream_budget() {
    let (host, _guest) = setup_host_and_guest().await;
    let err = host
        .copy_file(
            "/tmp/large.log",
            Path::new("/tmp/large.log"),
            CopyFileOptions {
                max_bytes: file_impl::test_support::COPY_FILE_STREAM_MAX_BYTES + 1,
                timeout_ms: 5000,
                missing_ok: false,
            },
        )
        .await
        .unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert!(err.to_string().contains("copy_file max_bytes"));
}

#[tokio::test]
async fn read_file_returns_content_and_missing() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let read_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.read_file("/tmp/session.txt", 1024, 5000).await })
    };
    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    let decoded = vsock_proto::decode_exec_start(&msg.payload).unwrap();
    assert_eq!(decoded.label, "read-file");
    assert!(decoded.command.contains("cat -- '/tmp/session.txt'"));
    assert_eq!(decoded.expected_exit_codes, vec![66]);
    send_exec_result(
        &mut guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"session-id\n",
        b"",
    )
    .await;
    let content = read_task.await.unwrap().unwrap();
    assert_eq!(content.as_deref(), Some(&b"session-id\n"[..]));

    let missing_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.read_file("/tmp/missing.txt", 1024, 5000).await })
    };
    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
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
    let missing = missing_task.await.unwrap().unwrap();
    assert_eq!(missing, None);
}

#[tokio::test]
async fn read_file_errors_on_truncated_stdout() {
    let (host, mut guest) = setup_host_and_guest().await;
    let read_task = tokio::spawn(async move { host.read_file("/tmp/large.txt", 5, 5000).await });

    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    let payload = vsock_proto::encode_exec_result(
        ExecTermination::Exited { exit_code: 0 },
        12,
        ExecCapturedOutput::Captured {
            bytes: b"hello",
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

    let err = read_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("exceeded 5 bytes"));
}

#[tokio::test]
async fn read_file_rejects_invalid_max_bytes_without_sending_frame() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let err = host.read_file("/tmp/empty.txt", 0, 5000).await.unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(operation_count(&host), 0);

    let err = host
        .read_file("/tmp/huge.txt", u64::from(u32::MAX) + 1, 5000)
        .await
        .unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(operation_count(&host), 0);
    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn read_file_quotes_guest_path_with_single_quote() {
    let (host, mut guest) = setup_host_and_guest().await;
    let read_task =
        tokio::spawn(async move { host.read_file("/tmp/session'one.txt", 1024, 5000).await });

    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    let decoded = vsock_proto::decode_exec_start(&msg.payload).unwrap();
    assert_eq!(
        decoded.command,
        "if test -f '/tmp/session'\\''one.txt'; then cat -- '/tmp/session'\\''one.txt'; else exit 66; fi"
    );
    send_exec_result(
        &mut guest,
        msg.seq,
        ExecTermination::Exited { exit_code: 0 },
        b"ok",
        b"",
    )
    .await;

    let content = read_task.await.unwrap().unwrap();
    assert_eq!(content.as_deref(), Some(&b"ok"[..]));
}

#[tokio::test]
async fn copy_file_streams_to_temp_then_renames() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("vsock-host-copy-{}-{unique}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let host_path = dir.join("system.log");
    let copy_path = host_path.clone();

    let task_host = Arc::clone(&host);
    let copy_task = tokio::spawn(async move {
        task_host
            .copy_file(
                "/tmp/vm0-system-run.log",
                &copy_path,
                CopyFileOptions {
                    max_bytes: 1024,
                    timeout_ms: 5000,
                    missing_ok: false,
                },
            )
            .await
    });

    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );
    let decoded = vsock_proto::decode_exec_start(&msg.payload).unwrap();
    assert_eq!(decoded.label, "copy-file");
    assert_eq!(
        decoded.command,
        "if test -f '/tmp/vm0-system-run.log'; then cat -- '/tmp/vm0-system-run.log'; else exit 66; fi"
    );
    assert_eq!(
        decoded.stdout,
        ExecOutputPolicy::Stream {
            limit_bytes: 1024,
            chunk_limit_bytes: 64 * 1024,
        }
    );
    send_exec_output(
        &mut guest,
        msg.seq,
        0,
        ExecOutputStream::Stdout,
        b"line 1\n",
        false,
    )
    .await;
    send_exec_output(
        &mut guest,
        msg.seq,
        1,
        ExecOutputStream::Stdout,
        b"line 2\n",
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
    assert_eq!(result.bytes_copied, 14);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    assert_eq!(std::fs::read(&host_path).unwrap(), b"line 1\nline 2\n");
    assert!(
        std::fs::read_dir(&dir).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("vm0tmp")),
        "copy temp file should not remain"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn copy_file_rejects_invalid_options_without_sending_frame_or_creating_parent() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "vsock-host-copy-invalid-{}-{unique}",
        std::process::id()
    ));
    let host_path = dir.join("nested/system.log");

    let err = host
        .copy_file(
            "/tmp/system.log",
            &host_path,
            CopyFileOptions {
                max_bytes: 0,
                timeout_ms: 5000,
                missing_ok: false,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert!(!dir.exists());

    let err = host
        .copy_file(
            "/tmp/system.log",
            &host_path,
            CopyFileOptions {
                max_bytes: 1024,
                timeout_ms: 0,
                missing_ok: false,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert!(!dir.exists());
    assert_eq!(operation_count(&host), 0);

    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn copy_file_creates_parent_and_quotes_guest_path_with_single_quote() {
    let (host, mut guest) = setup_host_and_guest().await;
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "vsock-host-copy-parent-quote-{}-{unique}",
        std::process::id()
    ));
    let host_path = dir.join("nested/system.log");
    let copy_path = host_path.clone();

    let copy_task = tokio::spawn(async move {
        host.copy_file(
            "/tmp/vm0-system-run's.log",
            &copy_path,
            CopyFileOptions {
                max_bytes: 1024,
                timeout_ms: 5000,
                missing_ok: false,
            },
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
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn copy_file_removes_temp_without_publishing_on_stream_truncation() {
    let (host, mut guest) = setup_host_and_guest().await;
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "vsock-host-copy-truncated-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let host_path = dir.join("system.log");
    std::fs::write(&host_path, b"old host log").unwrap();
    let copy_path = host_path.clone();

    let copy_task = tokio::spawn(async move {
        host.copy_file(
            "/tmp/vm0-system-run.log",
            &copy_path,
            CopyFileOptions {
                max_bytes: 1024,
                timeout_ms: 5000,
                missing_ok: false,
            },
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
    assert!(
        std::fs::read_dir(&dir).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("vm0tmp")),
        "failed copy temp file should be removed"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn copy_file_stream_error_releases_tracker_when_cancel_sees_terminal_result() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "vsock-host-copy-cancel-terminal-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let host_path = dir.join("system.log");
    std::fs::write(&host_path, b"old host log").unwrap();
    let copy_path = host_path.clone();

    let copy_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.copy_file(
                "/tmp/vm0-system-run.log",
                &copy_path,
                CopyFileOptions {
                    max_bytes: 1024,
                    timeout_ms: 5000,
                    missing_ok: false,
                },
            )
            .await
        })
    };

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
    assert!(
        std::fs::read_dir(&dir).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("vm0tmp")),
        "failed copy temp file should be removed"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn copy_file_error_response_releases_tracker_after_temp_cleanup() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "vsock-host-copy-error-response-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let host_path = dir.join("system.log");
    std::fs::write(&host_path, b"old host log").unwrap();
    let copy_path = host_path.clone();

    let copy_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.copy_file(
                "/tmp/vm0-system-run.log",
                &copy_path,
                CopyFileOptions {
                    max_bytes: 1024,
                    timeout_ms: 5000,
                    missing_ok: false,
                },
            )
            .await
        })
    };

    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_EXEC_START);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    let payload = vsock_proto::encode_error("guest copy failed");
    guest
        .write_all(&vsock_proto::encode(MSG_ERROR, msg.seq, &payload).unwrap())
        .await
        .unwrap();

    let err = copy_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("guest copy failed"));
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    assert_eq!(std::fs::read(&host_path).unwrap(), b"old host log");
    assert!(
        std::fs::read_dir(&dir).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("vm0tmp")),
        "failed copy temp file should be removed"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn copy_file_connection_close_after_request_removes_temp_and_marks_not_parkable() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "vsock-host-copy-connection-close-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let host_path = dir.join("system.log");
    let copy_path = host_path.clone();

    let copy_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.copy_file(
                "/tmp/vm0-system-run.log",
                &copy_path,
                CopyFileOptions {
                    max_bytes: 1024,
                    timeout_ms: 5000,
                    missing_ok: false,
                },
            )
            .await
        })
    };

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
    assert!(
        std::fs::read_dir(&dir).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("vm0tmp")),
        "failed copy temp file should be removed"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn copy_file_terminal_result_before_connection_close_keeps_tracker_closed_not_not_parkable() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "vsock-host-copy-terminal-close-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let host_path = dir.join("system.log");
    let copy_path = host_path.clone();

    let copy_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.copy_file(
                "/tmp/vm0-system-run.log",
                &copy_path,
                CopyFileOptions {
                    max_bytes: 1024,
                    timeout_ms: 5000,
                    missing_ok: false,
                },
            )
            .await
        })
    };

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
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn copy_file_rename_failure_removes_temp_and_releases_tracker() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "vsock-host-copy-rename-failure-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let host_path = dir.join("system.log");
    std::fs::create_dir_all(&host_path).unwrap();
    let copy_path = host_path.clone();

    let copy_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.copy_file(
                "/tmp/vm0-system-run.log",
                &copy_path,
                CopyFileOptions {
                    max_bytes: 1024,
                    timeout_ms: 5000,
                    missing_ok: false,
                },
            )
            .await
        })
    };

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
    assert!(
        std::fs::read_dir(&dir).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("vm0tmp")),
        "failed copy temp file should be removed"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn copy_file_nonzero_exit_removes_temp_without_publishing_partial_output() {
    let (host, mut guest) = setup_host_and_guest().await;
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "vsock-host-copy-nonzero-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let host_path = dir.join("system.log");
    std::fs::write(&host_path, b"old host log").unwrap();
    let copy_path = host_path.clone();

    let copy_task = tokio::spawn(async move {
        host.copy_file(
            "/tmp/vm0-system-run.log",
            &copy_path,
            CopyFileOptions {
                max_bytes: 1024,
                timeout_ms: 5000,
                missing_ok: false,
            },
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
    assert!(
        std::fs::read_dir(&dir).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("vm0tmp")),
        "failed copy temp file should be removed"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn copy_file_missing_ok_leaves_no_final_or_temp_file() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "vsock-host-copy-missing-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let host_path = dir.join("system.log");
    let copy_path = host_path.clone();

    let task_host = Arc::clone(&host);
    let copy_task = tokio::spawn(async move {
        task_host
            .copy_file(
                "/tmp/missing.log",
                &copy_path,
                CopyFileOptions {
                    max_bytes: 1024,
                    timeout_ms: 5000,
                    missing_ok: true,
                },
            )
            .await
    });

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
    assert!(
        std::fs::read_dir(&dir).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("vm0tmp")),
        "missing copy temp file should be removed"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn copy_file_missing_without_missing_ok_preserves_existing_file_and_removes_temp() {
    let (host, mut guest) = setup_host_and_guest().await;
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "vsock-host-copy-missing-error-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let host_path = dir.join("system.log");
    std::fs::write(&host_path, b"old host log").unwrap();
    let copy_path = host_path.clone();

    let copy_task = tokio::spawn(async move {
        host.copy_file(
            "/tmp/missing.log",
            &copy_path,
            CopyFileOptions {
                max_bytes: 1024,
                timeout_ms: 5000,
                missing_ok: false,
            },
        )
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
    assert!(
        std::fs::read_dir(&dir).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("vm0tmp")),
        "missing copy temp file should be removed"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn copy_file_cancellation_cancels_guest_exec_operation_and_removes_temp() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "vsock-host-copy-cancel-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let host_path = dir.join("system.log");
    let copy_path = host_path.clone();

    let task_host = Arc::clone(&host);
    let copy_task = tokio::spawn(async move {
        task_host
            .copy_file(
                "/tmp/vm0-system-run.log",
                &copy_path,
                CopyFileOptions {
                    max_bytes: 1024,
                    timeout_ms: 5000,
                    missing_ok: false,
                },
            )
            .await
    });

    let start = read_guest_message(&mut guest).await;
    assert_eq!(start.msg_type, MSG_EXEC_START);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );
    let temp_paths: Vec<_> = std::fs::read_dir(&dir)
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
    assert!(
        std::fs::read_dir(&dir).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("vm0tmp")),
        "cancelled copy temp file should be removed"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn test_write_file() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();
        assert_eq!(msgs[0].msg_type, MSG_WRITE_FILE);

        let (path, content, sudo, append) =
            vsock_proto::decode_write_file(&msgs[0].payload).unwrap();
        assert_eq!(path, "/tmp/test.txt");
        assert_eq!(content, b"hello");
        assert!(!sudo);
        assert!(!append);

        let payload = vsock_proto::encode_write_file_result(true, "");
        let resp = vsock_proto::encode(MSG_WRITE_FILE_RESULT, msgs[0].seq, &payload).unwrap();
        guest.write_all(&resp).await.unwrap();
    });

    let host = host_from_stream(host_stream).await.unwrap();
    host.write_file("/tmp/test.txt", b"hello", false)
        .await
        .unwrap();
}

#[tokio::test]
async fn write_file_tracks_until_result() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.write_file("/tmp/tracked.txt", b"hello", false).await })
    };

    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_WRITE_FILE);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    let payload = vsock_proto::encode_write_file_result(true, "");
    let resp = vsock_proto::encode(MSG_WRITE_FILE_RESULT, msg.seq, &payload).unwrap();
    guest.write_all(&resp).await.unwrap();

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

    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_WRITE_FILE);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    let payload = vsock_proto::encode_write_file_result(false, "permission denied");
    let resp = vsock_proto::encode(MSG_WRITE_FILE_RESULT, msg.seq, &payload).unwrap();
    guest.write_all(&resp).await.unwrap();

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

    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_WRITE_FILE);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    let payload = vsock_proto::encode_error("guest write failed");
    let resp = vsock_proto::encode(MSG_ERROR, msg.seq, &payload).unwrap();
    guest.write_all(&resp).await.unwrap();

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

    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_WRITE_FILE);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    let resp = vsock_proto::encode(MSG_EXEC_START, msg.seq, &[]).unwrap();
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

    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_WRITE_FILE);
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
    let writer_guard = host.shared.writer.lock().await;
    let write_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.write_file("/tmp/blocked.txt", b"hello", false).await })
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
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );

    drop(writer_guard);
    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn write_file_connection_close_after_request_marks_tracker_not_parkable() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.write_file("/tmp/pending.txt", b"hello", false).await })
    };

    let msg = read_guest_message(&mut guest).await;
    assert_eq!(msg.msg_type, MSG_WRITE_FILE);
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
        let mut temp_path = None::<String>;
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
                    // Chunks go to temp file
                    if let Some(temp_path) = &temp_path {
                        assert_eq!(path, temp_path);
                    } else {
                        assert!(path.starts_with("/tmp/big.bin.vm0tmp-"));
                        temp_path = Some(path.to_string());
                    }
                    chunks_received.push((append, chunk.to_vec()));

                    let payload = vsock_proto::encode_write_file_result(true, "");
                    let resp =
                        vsock_proto::encode(MSG_WRITE_FILE_RESULT, msg.seq, &payload).unwrap();
                    guest.write_all(&resp).await.unwrap();
                } else if msg.msg_type == MSG_EXEC_START {
                    // Atomic rename: mv temp → target
                    let decoded = vsock_proto::decode_exec_start(&msg.payload).unwrap();
                    let temp_path = temp_path.as_ref().expect("temp path");
                    assert!(decoded.command.contains("mv -f --"));
                    assert!(decoded.command.contains(temp_path));
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

#[tokio::test]
async fn test_write_file_failure() {
    let (host_stream, mut guest) = make_pair();

    tokio::spawn(async move {
        let mut decoder = Decoder::new();
        mock_handshake(&mut guest, &mut decoder).await;

        let mut buf = [0u8; 4096];
        let n = guest.read(&mut buf).await.unwrap();
        let msgs = decoder.decode(&buf[..n]).unwrap();

        let payload = vsock_proto::encode_write_file_result(false, "permission denied");
        let resp = vsock_proto::encode(MSG_WRITE_FILE_RESULT, msgs[0].seq, &payload).unwrap();
        guest.write_all(&resp).await.unwrap();
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let err = host
        .write_file("/etc/shadow", b"bad", false)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("permission denied"));
}
