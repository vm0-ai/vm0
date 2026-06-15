use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use sandbox::{
    CopyFileOptions, ExecRequest, ExecResult, ProcessExit, Sandbox, SandboxConfig, SandboxError,
    SandboxFactory, SandboxInitializationPhase, SandboxOperation, SandboxOperationReason,
    StartProcessRequest,
};
use sandbox_mock::MockSandboxFactory;

const QUEUED_COPY_FILE_MAX_BYTES: u64 = 64 * 1024 * 1024;

pub(in crate::executor::tests) struct DestroyPanicFactory {
    pub(in crate::executor::tests) inner: MockSandboxFactory,
}

#[async_trait]
impl SandboxFactory for DestroyPanicFactory {
    fn name(&self) -> &str {
        "destroy-panic"
    }

    fn config_hash(&self) -> String {
        "destroy-panic".into()
    }

    async fn create(&self, config: SandboxConfig) -> sandbox::Result<Box<dyn Sandbox>> {
        self.inner.create(config).await
    }

    #[allow(clippy::panic)]
    async fn destroy(&self, _sandbox: Box<dyn Sandbox>) {
        panic!("simulated destroy panic");
    }

    async fn shutdown(&mut self) {
        self.inner.shutdown().await;
    }
}

pub(in crate::executor::tests) fn sandbox_exec_error(message: impl Into<String>) -> SandboxError {
    SandboxError::Operation {
        operation: SandboxOperation::Exec,
        reason: SandboxOperationReason::Guest,
        message: message.into(),
    }
}

pub(in crate::executor::tests) fn sandbox_write_file_error(
    message: impl Into<String>,
) -> SandboxError {
    SandboxError::Operation {
        operation: SandboxOperation::WriteFile,
        reason: SandboxOperationReason::Guest,
        message: message.into(),
    }
}

fn queued_copy_file_error(message: impl Into<String>) -> SandboxError {
    SandboxError::Operation {
        operation: SandboxOperation::CopyFile,
        reason: SandboxOperationReason::Other,
        message: message.into(),
    }
}

fn validate_queued_copy_guest_path(path: &str) -> sandbox::Result<()> {
    if path.is_empty() {
        return Err(queued_copy_file_error(
            "test copy_file guest file path must not be empty",
        ));
    }
    if path.as_bytes().contains(&0) {
        return Err(queued_copy_file_error(
            "test copy_file guest file path contains NUL bytes",
        ));
    }
    Ok(())
}

fn validate_queued_copy_host_path(host_path: &Path) -> sandbox::Result<()> {
    let path_text = host_path.as_os_str().to_string_lossy();
    if path_text.is_empty() {
        return Err(queued_copy_file_error(
            "test copy_file host path must not be empty",
        ));
    }
    if path_text.contains('\0') {
        return Err(queued_copy_file_error(
            "test copy_file host path contains NUL bytes",
        ));
    }
    if host_path.file_name().is_none() || path_text.ends_with('/') || path_text.ends_with("/.") {
        return Err(queued_copy_file_error(
            "test copy_file host path must name a file",
        ));
    }
    Ok(())
}

fn validate_queued_copy_options(
    path: &str,
    host_path: &Path,
    options: CopyFileOptions,
) -> sandbox::Result<()> {
    validate_queued_copy_guest_path(path)?;
    validate_queued_copy_host_path(host_path)?;
    if options.max_bytes == 0 {
        return Err(queued_copy_file_error(
            "test copy_file max_bytes must be positive",
        ));
    }
    if options.max_bytes > QUEUED_COPY_FILE_MAX_BYTES {
        return Err(queued_copy_file_error(format!(
            "test copy_file max_bytes must be at most {QUEUED_COPY_FILE_MAX_BYTES}"
        )));
    }
    if options.timeout.is_zero() {
        return Err(queued_copy_file_error(
            "test copy_file timeout must be positive",
        ));
    }
    Ok(())
}

pub(in crate::executor::tests) fn sandbox_create_error(message: impl Into<String>) -> SandboxError {
    SandboxError::Initialization {
        phase: SandboxInitializationPhase::SandboxAllocation,
        message: message.into(),
    }
}

pub(in crate::executor::tests) struct CancelAfterWaitSandbox {
    pub(in crate::executor::tests) inner: Box<dyn Sandbox>,
    pub(in crate::executor::tests) cancel: tokio_util::sync::CancellationToken,
}

#[async_trait]
impl Sandbox for CancelAfterWaitSandbox {
    fn id(&self) -> &str {
        self.inner.id()
    }

    fn source_ip(&self) -> &str {
        self.inner.source_ip()
    }

    fn process_pid(&self) -> Option<u32> {
        self.inner.process_pid()
    }

    async fn start(&mut self) -> sandbox::Result<()> {
        self.inner.start().await
    }

    async fn stop(&mut self) -> sandbox::Result<()> {
        self.inner.stop().await
    }

    async fn kill(&mut self) -> sandbox::Result<()> {
        self.inner.kill().await
    }

    async fn park(&mut self) -> sandbox::Result<()> {
        self.inner.park().await
    }

    async fn unpark(&mut self) -> sandbox::Result<()> {
        self.inner.unpark().await
    }

    async fn exec(&self, request: &ExecRequest<'_>) -> sandbox::Result<ExecResult> {
        self.inner.exec(request).await
    }

    async fn read_file(&self, path: &str, max_bytes: u64) -> sandbox::Result<Option<Vec<u8>>> {
        self.inner.read_file(path, max_bytes).await
    }

    async fn copy_file(
        &self,
        path: &str,
        host_path: &std::path::Path,
        options: CopyFileOptions,
    ) -> sandbox::Result<sandbox::CopyFileResult> {
        self.inner.copy_file(path, host_path, options).await
    }

    async fn write_file(&self, path: &str, content: &[u8]) -> sandbox::Result<()> {
        self.inner.write_file(path, content).await
    }

    async fn start_process(
        &self,
        request: &StartProcessRequest<'_>,
    ) -> sandbox::Result<sandbox::GuestProcessHandle> {
        self.inner.start_process(request).await
    }

    async fn wait_process(
        &self,
        handle: sandbox::GuestProcessHandle,
        timeout: Duration,
    ) -> sandbox::Result<ProcessExit> {
        let result = self.inner.wait_process(handle, timeout).await;
        self.cancel.cancel();
        result
    }
}

pub(in crate::executor::tests) struct QueuedCopyFileSandbox {
    inner: Box<dyn Sandbox>,
    copy_file_results: Mutex<VecDeque<Vec<u8>>>,
    remove_path_before_copy: Option<std::path::PathBuf>,
}

impl QueuedCopyFileSandbox {
    pub(in crate::executor::tests) fn new(
        inner: Box<dyn Sandbox>,
        copy_file_results: Vec<Vec<u8>>,
    ) -> Self {
        Self {
            inner,
            copy_file_results: Mutex::new(VecDeque::from(copy_file_results)),
            remove_path_before_copy: None,
        }
    }

    pub(in crate::executor::tests) fn with_remove_path_before_copy(
        mut self,
        path: std::path::PathBuf,
    ) -> Self {
        self.remove_path_before_copy = Some(path);
        self
    }
}

#[async_trait]
impl Sandbox for QueuedCopyFileSandbox {
    fn id(&self) -> &str {
        self.inner.id()
    }

    fn source_ip(&self) -> &str {
        self.inner.source_ip()
    }

    fn process_pid(&self) -> Option<u32> {
        self.inner.process_pid()
    }

    async fn start(&mut self) -> sandbox::Result<()> {
        self.inner.start().await
    }

    async fn stop(&mut self) -> sandbox::Result<()> {
        self.inner.stop().await
    }

    async fn kill(&mut self) -> sandbox::Result<()> {
        self.inner.kill().await
    }

    async fn park(&mut self) -> sandbox::Result<()> {
        self.inner.park().await
    }

    async fn unpark(&mut self) -> sandbox::Result<()> {
        self.inner.unpark().await
    }

    async fn exec(&self, request: &ExecRequest<'_>) -> sandbox::Result<ExecResult> {
        self.inner.exec(request).await
    }

    async fn read_file(&self, path: &str, max_bytes: u64) -> sandbox::Result<Option<Vec<u8>>> {
        self.inner.read_file(path, max_bytes).await
    }

    async fn copy_file(
        &self,
        path: &str,
        host_path: &Path,
        options: CopyFileOptions,
    ) -> sandbox::Result<sandbox::CopyFileResult> {
        validate_queued_copy_options(path, host_path, options)?;
        if let Some(path) = &self.remove_path_before_copy {
            let _ = std::fs::remove_file(path);
        }
        let bytes = self
            .copy_file_results
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pop_front();
        let Some(bytes) = bytes else {
            return self.inner.copy_file(path, host_path, options).await;
        };

        if bytes.len() as u64 > options.max_bytes {
            return Err(SandboxError::Operation {
                operation: SandboxOperation::CopyFile,
                reason: SandboxOperationReason::Other,
                message: format!("test copy_file exceeded {} bytes", options.max_bytes),
            });
        }
        if let Some(parent) = host_path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(host_path, &bytes)?;
        Ok(sandbox::CopyFileResult {
            bytes_copied: bytes.len() as u64,
        })
    }

    async fn write_file(&self, path: &str, content: &[u8]) -> sandbox::Result<()> {
        self.inner.write_file(path, content).await
    }

    async fn start_process(
        &self,
        request: &StartProcessRequest<'_>,
    ) -> sandbox::Result<sandbox::GuestProcessHandle> {
        self.inner.start_process(request).await
    }

    async fn wait_process(
        &self,
        handle: sandbox::GuestProcessHandle,
        timeout: Duration,
    ) -> sandbox::Result<ProcessExit> {
        self.inner.wait_process(handle, timeout).await
    }
}

pub(in crate::executor::tests) async fn create_overridden_sandbox(
    overrides: Arc<sandbox_mock::MockSandboxOverrides>,
) -> Box<dyn Sandbox> {
    sandbox_mock::MockSandboxFactory::with_overrides(overrides)
        .create(SandboxConfig {
            id: sandbox::SandboxId::new_v4(),
            resources: sandbox::ResourceLimits {
                cpu_count: 2,
                memory_mb: 2048,
            },
            device_rate_limits: None,
            workspace_drive: None,
        })
        .await
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn copy_options(max_bytes: u64, timeout: Duration) -> CopyFileOptions {
        CopyFileOptions {
            max_bytes,
            timeout,
            missing_ok: false,
        }
    }

    fn assert_copy_file_error(error: SandboxError, expected_message: &str) {
        match error {
            SandboxError::Operation {
                operation,
                reason,
                message,
            } => {
                assert_eq!(operation, SandboxOperation::CopyFile);
                assert_eq!(reason, SandboxOperationReason::Other);
                assert!(message.contains(expected_message), "{message}");
            }
            other => panic!("expected copy_file operation error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn queued_copy_file_validates_before_side_effect_or_queue() {
        let dir = tempfile::tempdir().unwrap();
        let side_effect_path = dir.path().join("proxy-registry.json");
        std::fs::write(&side_effect_path, b"registry").unwrap();
        let host_path = dir.path().join("nested/system.log");
        let sandbox = QueuedCopyFileSandbox::new(
            Box::new(sandbox_mock::MockSandbox::new("test-1")),
            vec![b"queued log\n".to_vec()],
        )
        .with_remove_path_before_copy(side_effect_path.clone());

        let invalid_calls = [
            (
                "",
                host_path.as_path(),
                copy_options(1024, Duration::from_secs(5)),
                "guest file path",
            ),
            (
                "/tmp/system.log",
                Path::new(""),
                copy_options(1024, Duration::from_secs(5)),
                "host path",
            ),
            (
                "/tmp/system.log",
                host_path.as_path(),
                copy_options(0, Duration::from_secs(5)),
                "max_bytes must be positive",
            ),
            (
                "/tmp/system.log",
                host_path.as_path(),
                copy_options(QUEUED_COPY_FILE_MAX_BYTES + 1, Duration::from_secs(5)),
                "max_bytes must be at most",
            ),
            (
                "/tmp/system.log",
                host_path.as_path(),
                copy_options(1024, Duration::ZERO),
                "timeout must be positive",
            ),
        ];

        for (guest_path, host_path, options, expected_message) in invalid_calls {
            let err = sandbox
                .copy_file(guest_path, host_path, options)
                .await
                .unwrap_err();
            assert_copy_file_error(err, expected_message);
            assert!(side_effect_path.exists());
        }
        assert!(!host_path.exists());
        assert!(!host_path.parent().unwrap().exists());

        let result = sandbox
            .copy_file(
                "/tmp/system.log",
                &host_path,
                copy_options(1024, Duration::from_secs(5)),
            )
            .await
            .unwrap();

        assert_eq!(result.bytes_copied, 11);
        assert!(!side_effect_path.exists());
        assert_eq!(std::fs::read(&host_path).unwrap(), b"queued log\n");
    }
}
