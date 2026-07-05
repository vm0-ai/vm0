use super::*;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::support::MOCK_COPY_FILE_MAX_BYTES;

fn copy_file_options(missing_ok: bool) -> CopyFileOptions {
    CopyFileOptions {
        max_bytes: 1024,
        timeout: test_timeout(),
        missing_ok,
    }
}

fn temp_host_path(file_name: &str) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(file_name);
    (dir, path)
}

#[tokio::test]
async fn sandbox_copy_file_missing_ok_default_does_not_write_host_file() {
    let sandbox = MockSandbox::new("test-1");
    let (_host_dir, path) = temp_host_path("missing.log");

    let result = sandbox
        .copy_file("/tmp/missing.log", &path, copy_file_options(true))
        .await
        .unwrap();

    assert_eq!(result.bytes_copied, 0);
    assert!(!path.exists());
}

#[tokio::test]
async fn sandbox_copy_file_missing_ok_default_preserves_existing_host_file() {
    let sandbox = MockSandbox::new("test-1");
    let (_host_dir, path) = temp_host_path("missing-existing.log");
    std::fs::write(&path, b"old host log").unwrap();

    let result = sandbox
        .copy_file("/tmp/missing.log", &path, copy_file_options(true))
        .await
        .unwrap();

    assert_eq!(result.bytes_copied, 0);
    assert_eq!(std::fs::read(&path).unwrap(), b"old host log");
}

#[tokio::test]
async fn sandbox_copy_file_rejects_queued_bytes_over_max() {
    let sandbox = MockSandbox::new("test-1");
    sandbox.push_copy_file_result(Ok(b"too long".to_vec()));
    let (_host_dir, path) = temp_host_path("over-max.log");

    let err = sandbox
        .copy_file(
            "/tmp/system.log",
            &path,
            CopyFileOptions {
                max_bytes: 3,
                ..copy_file_options(false)
            },
        )
        .await
        .unwrap_err();

    assert_operation_error(
        err,
        SandboxOperation::CopyFile,
        SandboxOperationReason::Other,
        "exceeded 3 bytes",
    );
    assert!(!path.exists());
}

#[tokio::test]
async fn sandbox_copy_file_rejects_invalid_options() {
    let sandbox = MockSandbox::new("test-1");
    let (_guest_path_dir, guest_path) = temp_host_path("invalid-guest.log");
    let (_options_path_dir, options_path) = temp_host_path("invalid-options.log");
    let (_host_path_dir, host_path) = temp_host_path("invalid-host.log");

    sandbox.push_copy_file_result(Ok(b"valid log\n".to_vec()));
    for invalid_guest_path in ["", "/tmp/bad\0path.log"] {
        let err = sandbox
            .copy_file(invalid_guest_path, &guest_path, copy_file_options(true))
            .await
            .unwrap_err();
        assert_operation_error(
            err,
            SandboxOperation::CopyFile,
            SandboxOperationReason::Other,
            "guest file path",
        );
        assert!(!guest_path.exists());
    }

    let result = sandbox
        .copy_file("/tmp/system.log", &guest_path, copy_file_options(false))
        .await
        .unwrap();
    assert_eq!(result.bytes_copied, 10);
    assert_eq!(std::fs::read(&guest_path).unwrap(), b"valid log\n");

    sandbox.push_copy_file_result(Ok(b"opts ok\n".to_vec()));
    let err = sandbox
        .copy_file(
            "/tmp/system.log",
            &options_path,
            CopyFileOptions {
                max_bytes: 0,
                ..copy_file_options(true)
            },
        )
        .await
        .unwrap_err();
    assert_operation_error(
        err,
        SandboxOperation::CopyFile,
        SandboxOperationReason::Other,
        "max_bytes must be positive",
    );
    assert!(!options_path.exists());

    let err = sandbox
        .copy_file(
            "/tmp/system.log",
            &options_path,
            CopyFileOptions {
                timeout: Duration::ZERO,
                ..copy_file_options(true)
            },
        )
        .await
        .unwrap_err();
    assert_operation_error(
        err,
        SandboxOperation::CopyFile,
        SandboxOperationReason::Other,
        "timeout must be positive",
    );
    assert!(!options_path.exists());

    let err = sandbox
        .copy_file(
            "/tmp/system.log",
            &options_path,
            CopyFileOptions {
                max_bytes: MOCK_COPY_FILE_MAX_BYTES + 1,
                ..copy_file_options(true)
            },
        )
        .await
        .unwrap_err();
    assert_operation_error(
        err,
        SandboxOperation::CopyFile,
        SandboxOperationReason::Other,
        "max_bytes must be at most",
    );
    assert!(!options_path.exists());

    let result = sandbox
        .copy_file("/tmp/system.log", &options_path, copy_file_options(false))
        .await
        .unwrap();
    assert_eq!(result.bytes_copied, 8);
    assert_eq!(std::fs::read(&options_path).unwrap(), b"opts ok\n");

    sandbox.push_copy_file_result(Ok(b"host ok\n".to_vec()));
    for invalid_host_path in ["", ".", "/tmp/", "/tmp/.", "/tmp/bad\0host.log"] {
        let err = sandbox
            .copy_file(
                "/tmp/system.log",
                Path::new(invalid_host_path),
                copy_file_options(true),
            )
            .await
            .unwrap_err();
        assert_operation_error(
            err,
            SandboxOperation::CopyFile,
            SandboxOperationReason::Other,
            "host path",
        );
    }

    let result = sandbox
        .copy_file("/tmp/system.log", &host_path, copy_file_options(false))
        .await
        .unwrap();
    assert_eq!(result.bytes_copied, 8);
    assert_eq!(std::fs::read(&host_path).unwrap(), b"host ok\n");
}

#[tokio::test]
async fn sandbox_copy_file_allows_relative_host_path_without_parent() {
    let sandbox = MockSandbox::new("test-1");
    sandbox.push_copy_file_result(Ok(b"log line\n".to_vec()));
    let file_name = format!(
        "sandbox-mock-copy-relative-{}",
        uuid::Uuid::new_v4().simple()
    );
    let path = Path::new(&file_name);

    let result = sandbox
        .copy_file("/tmp/system.log", path, copy_file_options(false))
        .await
        .unwrap();

    assert_eq!(result.bytes_copied, 9);
    assert_eq!(std::fs::read(path).unwrap(), b"log line\n");
    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn sandbox_read_file_applies_mock_max_bytes() {
    let sandbox = MockSandbox::new("test-1");
    sandbox.push_read_file_result(Ok(Some(b"too long".to_vec())));

    let err = sandbox.read_file("/tmp/system.log", 3).await.unwrap_err();

    assert_operation_error(
        err,
        SandboxOperation::ReadFile,
        SandboxOperationReason::Other,
        "exceeded 3 bytes",
    );
}

#[tokio::test]
async fn sandbox_read_file_rejects_invalid_options() {
    let sandbox = MockSandbox::new("test-1");
    sandbox.push_read_file_result(Ok(Some(b"valid log\n".to_vec())));

    for invalid_guest_path in ["", "/tmp/bad\0path.log"] {
        let err = sandbox
            .read_file(invalid_guest_path, 1024)
            .await
            .unwrap_err();

        assert_operation_error(
            err,
            SandboxOperation::ReadFile,
            SandboxOperationReason::Other,
            "guest file path",
        );
    }

    let result = sandbox.read_file("/tmp/system.log", 1024).await.unwrap();
    assert_eq!(result.as_deref(), Some(&b"valid log\n"[..]));

    let err = sandbox.read_file("/tmp/system.log", 0).await.unwrap_err();

    assert_operation_error(
        err,
        SandboxOperation::ReadFile,
        SandboxOperationReason::Other,
        "max_bytes must be positive",
    );

    sandbox.push_read_file_result(Ok(Some(b"after oversized max\n".to_vec())));
    let err = sandbox
        .read_file("/tmp/system.log", u64::from(u32::MAX) + 1)
        .await
        .unwrap_err();

    assert_operation_error(
        err,
        SandboxOperation::ReadFile,
        SandboxOperationReason::Other,
        "max_bytes exceeds exec capture limit",
    );

    let result = sandbox.read_file("/tmp/system.log", 1024).await.unwrap();
    assert_eq!(result.as_deref(), Some(&b"after oversized max\n"[..]));

    sandbox.push_read_file_result(Ok(Some(b"after invalid max\n".to_vec())));
    let err = sandbox.read_file("/tmp/system.log", 0).await.unwrap_err();

    assert_operation_error(
        err,
        SandboxOperation::ReadFile,
        SandboxOperationReason::Other,
        "max_bytes must be positive",
    );

    let result = sandbox.read_file("/tmp/system.log", 1024).await.unwrap();
    assert_eq!(result.as_deref(), Some(&b"after invalid max\n"[..]));
}

#[tokio::test]
async fn overrides_share_read_file_results_across_factory_sandboxes() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_read_file_result(Ok(Some(b"first".to_vec())));
    overrides.push_read_file_result(Ok(Some(b"second".to_vec())));
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let first = factory.create(test_sandbox_config()).await.unwrap();
    let second = factory.create(test_sandbox_config()).await.unwrap();

    assert_eq!(
        first.read_file("/tmp/one", 1024).await.unwrap(),
        Some(b"first".to_vec())
    );
    assert_eq!(
        second.read_file("/tmp/two", 1024).await.unwrap(),
        Some(b"second".to_vec())
    );
    assert_eq!(first.read_file("/tmp/empty", 1024).await.unwrap(), None);
}

#[tokio::test]
async fn sandbox_local_read_file_result_takes_precedence_over_shared_overrides() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_read_file_result(Ok(Some(b"shared".to_vec())));
    let sandbox = MockSandbox::with_overrides("sandbox", Arc::clone(&overrides));
    sandbox.push_read_file_result(Ok(Some(b"local".to_vec())));

    assert_eq!(
        sandbox.read_file("/tmp/local", 1024).await.unwrap(),
        Some(b"local".to_vec())
    );
    assert_eq!(
        sandbox.read_file("/tmp/shared", 1024).await.unwrap(),
        Some(b"shared".to_vec())
    );
}

#[tokio::test]
async fn sandbox_write_file_default_succeeds() {
    let sandbox = MockSandbox::new("test-1");
    sandbox.write_file("/tmp/test.txt", b"hello").await.unwrap();
}

#[tokio::test]
async fn sandbox_write_file_queued_error() {
    let sandbox = MockSandbox::new("test-1");
    sandbox.push_write_file_result(Err(SandboxError::Operation {
        operation: SandboxOperation::WriteFile,
        reason: SandboxOperationReason::Guest,
        message: "disk full".into(),
    }));

    let result = sandbox.write_file("/tmp/test.txt", b"data").await;
    assert!(result.is_err());

    // Falls back to default Ok.
    sandbox.write_file("/tmp/test.txt", b"data").await.unwrap();
}

#[tokio::test]
async fn sandbox_write_files_records_batch_and_consumes_one_result() {
    let sandbox = MockSandbox::new("test-1");
    sandbox.push_write_file_result(Err(SandboxError::Operation {
        operation: SandboxOperation::WriteFile,
        reason: SandboxOperationReason::Guest,
        message: "disk full".into(),
    }));

    let files = [
        WriteFileEntry {
            path: "/tmp/a.txt",
            content: b"a",
        },
        WriteFileEntry {
            path: "/tmp/b.txt",
            content: b"b",
        },
    ];
    let result = sandbox.write_files(&files).await;
    assert!(result.is_err());

    sandbox.write_files(&files).await.unwrap();

    let batch_calls = sandbox.write_files_calls();
    assert_eq!(batch_calls.len(), 2);
    assert_eq!(batch_calls[0].files.len(), 2);
    assert_eq!(batch_calls[0].files[0].path, "/tmp/a.txt");
    assert_eq!(batch_calls[0].files[0].content, b"a");
    assert_eq!(batch_calls[0].files[1].path, "/tmp/b.txt");
    assert_eq!(batch_calls[0].files[1].content, b"b");

    let write_calls = sandbox.write_file_calls();
    assert_eq!(write_calls.len(), 4);
}

#[tokio::test]
async fn sandbox_write_private_file_queued_error_and_records_calls() {
    let sandbox = MockSandbox::new("test-1");
    sandbox.push_private_write_file_result(Err(SandboxError::Operation {
        operation: SandboxOperation::WriteFile,
        reason: SandboxOperationReason::Guest,
        message: "permission denied".into(),
    }));

    let result = sandbox
        .write_private_file("/tmp/private.env", b"secret")
        .await;
    assert!(result.is_err());
    sandbox
        .write_private_file("/tmp/private.env", b"secret")
        .await
        .unwrap();

    assert!(sandbox.write_file_calls().is_empty());
    let calls = sandbox.private_write_file_calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].path, "/tmp/private.env");
    assert_eq!(calls[0].content, b"secret");
}

#[tokio::test]
async fn overrides_share_private_write_file_results_across_factory_sandboxes() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_private_write_file_result(Err(SandboxError::Operation {
        operation: SandboxOperation::WriteFile,
        reason: SandboxOperationReason::Guest,
        message: "first private write failed".into(),
    }));
    overrides.push_private_write_file_result(Err(SandboxError::Operation {
        operation: SandboxOperation::WriteFile,
        reason: SandboxOperationReason::Guest,
        message: "second private write failed".into(),
    }));
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));

    let first = factory.create(test_sandbox_config()).await.unwrap();
    let second = factory.create(test_sandbox_config()).await.unwrap();

    let first_error = first
        .write_private_file("/tmp/private-one.env", b"one")
        .await
        .unwrap_err();
    assert_operation_error(
        first_error,
        SandboxOperation::WriteFile,
        SandboxOperationReason::Guest,
        "first private write failed",
    );

    let second_error = second
        .write_private_file("/tmp/private-two.env", b"two")
        .await
        .unwrap_err();
    assert_operation_error(
        second_error,
        SandboxOperation::WriteFile,
        SandboxOperationReason::Guest,
        "second private write failed",
    );

    first
        .write_private_file("/tmp/private-empty.env", b"empty")
        .await
        .unwrap();

    let calls = overrides.private_write_file_calls();
    assert_eq!(calls.len(), 3);
    assert_eq!(calls[0].path, "/tmp/private-one.env");
    assert_eq!(calls[1].path, "/tmp/private-two.env");
    assert_eq!(calls[2].path, "/tmp/private-empty.env");
}

#[tokio::test]
async fn sandbox_local_private_write_file_result_takes_precedence_over_shared_overrides() {
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.push_private_write_file_result(Err(SandboxError::Operation {
        operation: SandboxOperation::WriteFile,
        reason: SandboxOperationReason::Guest,
        message: "shared private write failed".into(),
    }));
    let sandbox = MockSandbox::with_overrides("sandbox", Arc::clone(&overrides));
    sandbox.push_private_write_file_result(Err(SandboxError::Operation {
        operation: SandboxOperation::WriteFile,
        reason: SandboxOperationReason::Guest,
        message: "local private write failed".into(),
    }));

    let local_error = sandbox
        .write_private_file("/tmp/local-private.env", b"local")
        .await
        .unwrap_err();
    assert_operation_error(
        local_error,
        SandboxOperation::WriteFile,
        SandboxOperationReason::Guest,
        "local private write failed",
    );

    let shared_error = sandbox
        .write_private_file("/tmp/shared-private.env", b"shared")
        .await
        .unwrap_err();
    assert_operation_error(
        shared_error,
        SandboxOperation::WriteFile,
        SandboxOperationReason::Guest,
        "shared private write failed",
    );
}

#[tokio::test]
async fn sandbox_write_file_lifecycle_gate_blocks_until_released() {
    let sandbox = Arc::new(MockSandbox::new("test-1"));
    let gate = MockLifecycleGate::new();
    sandbox.set_write_file_lifecycle_gate(gate.clone());

    let task = {
        let sandbox = Arc::clone(&sandbox);
        tokio::spawn(async move { sandbox.write_file("/tmp/test.txt", b"data").await })
    };

    gate.wait_entered(1, test_timeout()).await.unwrap();
    assert_eq!(sandbox.write_file_calls().len(), 1);
    assert!(!task.is_finished(), "write_file must wait for gate release");

    gate.release_one();
    task.await.unwrap().unwrap();
}

#[tokio::test]
async fn sandbox_write_files_lifecycle_gate_blocks_batch_until_released() {
    let sandbox = Arc::new(MockSandbox::new("test-1"));
    let gate = MockLifecycleGate::new();
    sandbox.set_write_file_lifecycle_gate(gate.clone());

    let task = {
        let sandbox = Arc::clone(&sandbox);
        tokio::spawn(async move {
            let files = [
                WriteFileEntry {
                    path: "/tmp/a.txt",
                    content: b"a",
                },
                WriteFileEntry {
                    path: "/tmp/b.txt",
                    content: b"b",
                },
            ];
            sandbox.write_files(&files).await
        })
    };

    assert_eq!(gate.wait_entered(1, test_timeout()).await.unwrap(), 1);
    assert_eq!(gate.entered_count(), 1);

    let batch_calls = sandbox.write_files_calls();
    assert_eq!(batch_calls.len(), 1);
    assert_eq!(batch_calls[0].files.len(), 2);
    assert_eq!(batch_calls[0].files[0].path, "/tmp/a.txt");
    assert_eq!(batch_calls[0].files[1].path, "/tmp/b.txt");

    let write_calls = sandbox.write_file_calls();
    assert_eq!(write_calls.len(), 2);
    assert_eq!(write_calls[0].path, "/tmp/a.txt");
    assert_eq!(write_calls[1].path, "/tmp/b.txt");
    assert!(
        !task.is_finished(),
        "write_files must wait for one batch gate release"
    );

    gate.release_one();
    tokio::time::timeout(test_timeout(), task)
        .await
        .expect("write_files must finish after one batch gate release")
        .unwrap()
        .unwrap();
    assert_eq!(gate.entered_count(), 1);
}
