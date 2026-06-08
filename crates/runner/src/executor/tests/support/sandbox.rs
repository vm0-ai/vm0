use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use sandbox::{
    CopyFileOptions, ExecRequest, ExecResult, ProcessExit, Sandbox, SandboxConfig, SandboxError,
    SandboxFactory, SandboxInitializationPhase, SandboxOperation, SandboxOperationReason,
    StartProcessRequest,
};
use sandbox_mock::MockSandboxFactory;

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
        host_path: &std::path::Path,
        options: CopyFileOptions,
    ) -> sandbox::Result<sandbox::CopyFileResult> {
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
