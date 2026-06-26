use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ::sandbox::*;
use async_trait::async_trait;

use crate::call_records::{
    CopyFileCall, ExecCall, ProcessCancelCall, ProcessControlCall, ReadFileCall, StartProcessCall,
    WaitProcessCall, WriteFileCall, WriteFilesCall,
};
use crate::lifecycle::{MockLifecycleGate, wait_blocking_gate};
use crate::overrides::MockSandboxOverrides;
use crate::support::{
    LockIgnoringPoison, MOCK_COPY_FILE_MAX_BYTES, validate_mock_copy_host_path,
    validate_mock_exec_env_keys, validate_mock_guest_file_path,
};

/// A mock [`Sandbox`] that succeeds on all operations by default.
///
/// Queue custom results with [`push_exec_result`](Self::push_exec_result)
/// and [`push_write_file_result`](Self::push_write_file_result).
/// When a queue is empty, the operation returns its default success value.
///
/// This type owns sandbox-local queues and sandbox-local call observations.
/// Sandboxes created by an override-enabled factory also record selected calls
/// in the shared [`MockSandboxOverrides`] observations.
pub struct MockSandbox {
    id: String,
    source_ip: String,
    exec_results: Mutex<VecDeque<Result<ExecResult>>>,
    exec_calls: Mutex<Vec<ExecCall>>,
    read_file_results: Mutex<VecDeque<Result<Option<Vec<u8>>>>>,
    read_file_calls: Mutex<Vec<ReadFileCall>>,
    copy_file_results: Mutex<VecDeque<Result<Vec<u8>>>>,
    copy_file_calls: Mutex<Vec<CopyFileCall>>,
    write_file_results: Mutex<VecDeque<Result<()>>>,
    write_file_calls: Mutex<Vec<WriteFileCall>>,
    write_files_calls: Mutex<Vec<WriteFilesCall>>,
    private_write_file_results: Mutex<VecDeque<Result<()>>>,
    private_write_file_calls: Mutex<Vec<WriteFileCall>>,
    write_file_gate: Mutex<Option<MockLifecycleGate>>,
    overrides: Option<Arc<MockSandboxOverrides>>,
    /// Holds the stdout channel sender alive when simulating a non-closing
    /// channel (e.g. wait_process_error override). Without this, the sender is
    /// dropped immediately in `start_process` and the drain task exits.
    stdout_tx: Mutex<Option<tokio::sync::mpsc::Sender<ProcessOutputChunk>>>,
}

impl MockSandbox {
    /// Create a sandbox with empty local queues and observations.
    ///
    /// The default source IP is `10.0.0.1`, and no shared
    /// [`MockSandboxOverrides`] are attached.
    pub fn new(id: impl Into<String>) -> Self {
        Self::build(id, None)
    }

    pub(crate) fn with_overrides(
        id: impl Into<String>,
        overrides: Arc<MockSandboxOverrides>,
    ) -> Self {
        Self::build(id, Some(overrides))
    }

    fn build(id: impl Into<String>, overrides: Option<Arc<MockSandboxOverrides>>) -> Self {
        Self {
            id: id.into(),
            source_ip: "10.0.0.1".into(),
            exec_results: Mutex::new(VecDeque::new()),
            exec_calls: Mutex::new(Vec::new()),
            read_file_results: Mutex::new(VecDeque::new()),
            read_file_calls: Mutex::new(Vec::new()),
            copy_file_results: Mutex::new(VecDeque::new()),
            copy_file_calls: Mutex::new(Vec::new()),
            write_file_results: Mutex::new(VecDeque::new()),
            write_file_calls: Mutex::new(Vec::new()),
            write_files_calls: Mutex::new(Vec::new()),
            private_write_file_results: Mutex::new(VecDeque::new()),
            private_write_file_calls: Mutex::new(Vec::new()),
            write_file_gate: Mutex::new(None),
            overrides,
            stdout_tx: Mutex::new(None),
        }
    }

    /// Override the source IP returned by this sandbox.
    ///
    /// This only changes the value returned by [`Sandbox::source_ip`]; it does
    /// not affect queued behavior or call observations.
    pub fn with_source_ip(mut self, ip: impl Into<String>) -> Self {
        self.source_ip = ip.into();
        self
    }

    /// Queue an exec result. Results are consumed in FIFO order.
    pub fn push_exec_result(&self, result: Result<ExecResult>) {
        self.exec_results.lock_ignoring_poison().push_back(result);
    }

    /// Return this sandbox's recorded exec calls.
    ///
    /// The returned vector is a cloned snapshot in recorded order. When this
    /// sandbox was built with shared overrides, exec calls are also recorded in
    /// [`MockSandboxOverrides::exec_calls`].
    pub fn exec_calls(&self) -> Vec<ExecCall> {
        self.exec_calls.lock_ignoring_poison().clone()
    }

    /// Queue a small file read result. Results are consumed in FIFO order.
    pub fn push_read_file_result(&self, result: Result<Option<Vec<u8>>>) {
        self.read_file_results
            .lock_ignoring_poison()
            .push_back(result);
    }

    /// Return this sandbox's recorded read-file calls.
    ///
    /// The returned vector is a cloned snapshot in recorded order. Calls are
    /// recorded before mock validation errors such as invalid guest paths,
    /// oversized `max_bytes`, or zero `max_bytes` are returned.
    pub fn read_file_calls(&self) -> Vec<ReadFileCall> {
        self.read_file_calls.lock_ignoring_poison().clone()
    }

    /// Queue bytes for a guest-to-host copy. The mock writes the bytes to the
    /// requested host path and returns the copied byte count.
    pub fn push_copy_file_result(&self, result: Result<Vec<u8>>) {
        self.copy_file_results
            .lock_ignoring_poison()
            .push_back(result);
    }

    /// Return this sandbox's recorded copy-file calls.
    ///
    /// The returned vector is a cloned snapshot in recorded order. Calls are
    /// recorded before mock validation errors such as invalid guest paths,
    /// oversized `max_bytes`, zero `max_bytes`, zero timeout, or invalid host
    /// paths are returned. When this sandbox was built with shared overrides,
    /// copy-file calls are also recorded in
    /// [`MockSandboxOverrides::copy_file_calls`].
    pub fn copy_file_calls(&self) -> Vec<CopyFileCall> {
        self.copy_file_calls.lock_ignoring_poison().clone()
    }

    /// Queue a write_file result. Results are consumed in FIFO order.
    /// When the queue is empty, write_file returns `Ok(())`.
    pub fn push_write_file_result(&self, result: Result<()>) {
        self.write_file_results
            .lock_ignoring_poison()
            .push_back(result);
    }

    /// Return this sandbox's recorded write-file calls.
    ///
    /// The returned vector is a cloned snapshot in recorded order. When this
    /// sandbox was built with shared overrides, write-file calls are also
    /// recorded in [`MockSandboxOverrides::write_file_calls`].
    pub fn write_file_calls(&self) -> Vec<WriteFileCall> {
        self.write_file_calls.lock_ignoring_poison().clone()
    }

    /// Return this sandbox's recorded write-files batch calls.
    ///
    /// Batch entries are also expanded into [`Self::write_file_calls`] so tests
    /// that only need path/content assertions can use one observation surface.
    pub fn write_files_calls(&self) -> Vec<WriteFilesCall> {
        self.write_files_calls.lock_ignoring_poison().clone()
    }

    /// Queue a write_private_file result. Results are consumed in FIFO order.
    /// When the queue is empty, write_private_file returns `Ok(())`.
    pub fn push_private_write_file_result(&self, result: Result<()>) {
        self.private_write_file_results
            .lock_ignoring_poison()
            .push_back(result);
    }

    /// Return this sandbox's recorded private write-file calls.
    ///
    /// The returned vector is a cloned snapshot in recorded order. When this
    /// sandbox was built with shared overrides, private write-file calls are
    /// also recorded in [`MockSandboxOverrides::private_write_file_calls`].
    pub fn private_write_file_calls(&self) -> Vec<WriteFileCall> {
        self.private_write_file_calls.lock_ignoring_poison().clone()
    }

    /// Block every write_file call with a durable lifecycle gate.
    ///
    /// Calls are recorded before they enter the gate, so tests can assert that a
    /// write was attempted while keeping the mock response pending.
    pub fn set_write_file_lifecycle_gate(&self, gate: MockLifecycleGate) {
        *self.write_file_gate.lock_ignoring_poison() = Some(gate);
    }

    /// Remove the durable write_file gate for future write calls.
    ///
    /// Already-entered writes keep waiting on their cloned gate until the test
    /// releases it.
    pub fn clear_write_file_lifecycle_gate(&self) {
        *self.write_file_gate.lock_ignoring_poison() = None;
    }
}

fn default_exec_result() -> ExecResult {
    ExecResult::new(0, Vec::new(), Vec::new())
}

fn apply_exec_output_limits(mut result: ExecResult, limits: ExecOutputLimits) -> ExecResult {
    if result.stdout.len() > limits.stdout_limit_bytes as usize {
        result.stdout.truncate(limits.stdout_limit_bytes as usize);
        result.stdout_truncated = true;
    }
    if result.stderr.len() > limits.stderr_limit_bytes as usize {
        result.stderr.truncate(limits.stderr_limit_bytes as usize);
        result.stderr_truncated = true;
    }
    result
}

fn validate_start_process_output(output: ProcessOutputMode) -> Result<()> {
    match output {
        ProcessOutputMode::Stream {
            chunk_limit_bytes: 0,
            ..
        } => Err(SandboxError::Operation {
            operation: SandboxOperation::StartProcess,
            reason: SandboxOperationReason::Other,
            message: "process stream chunk limit must be positive".to_string(),
        }),
        ProcessOutputMode::Stream {
            queue_capacity: 0, ..
        } => Err(SandboxError::Operation {
            operation: SandboxOperation::StartProcess,
            reason: SandboxOperationReason::Other,
            message: "process stream queue capacity must be positive".to_string(),
        }),
        ProcessOutputMode::Buffered { .. } | ProcessOutputMode::Stream { .. } => Ok(()),
    }
}

#[async_trait]
impl Sandbox for MockSandbox {
    fn id(&self) -> &str {
        &self.id
    }

    fn source_ip(&self) -> &str {
        &self.source_ip
    }

    async fn start(&mut self) -> Result<()> {
        let Some(o) = &self.overrides else {
            return Ok(());
        };
        o.lifecycle
            .start_results
            .lock_ignoring_poison()
            .pop_front()
            .unwrap_or(Ok(()))
    }

    async fn stop(&mut self) -> Result<()> {
        let Some(o) = &self.overrides else {
            return Ok(());
        };
        o.lifecycle.stop_behaviors.next_result()
    }

    async fn kill(&mut self) -> Result<()> {
        Ok(())
    }

    /// Mock park: bumps the override `park_calls` counter on every call (so
    /// tests can assert exact invocation counts) and consumes one queued
    /// result (FIFO). Empty queue → `Ok(())`. The trait's idempotency
    /// requirement is satisfied in practice because the default-Ok behavior
    /// is side-effect-free; tests that need to exercise non-idempotent
    /// scenarios queue explicit results.
    async fn park(&mut self) -> Result<()> {
        let Some(o) = &self.overrides else {
            return Ok(());
        };
        *o.lifecycle.park_calls.lock_ignoring_poison() += 1;
        wait_blocking_gate(&o.lifecycle.park_gate).await;
        o.lifecycle.park_behaviors.next_result()
    }

    /// Mock unpark: counter + queued-result semantics mirror [`park`]
    /// exactly. See [`park`] for details.
    ///
    /// [`park`]: Self::park
    async fn unpark(&mut self) -> Result<()> {
        let Some(o) = &self.overrides else {
            return Ok(());
        };
        *o.lifecycle.unpark_calls.lock_ignoring_poison() += 1;
        o.lifecycle.unpark_behaviors.next_result()
    }

    async fn exec(&self, request: &ExecRequest<'_>) -> Result<ExecResult> {
        validate_mock_exec_env_keys(SandboxOperation::Exec, request.env)?;
        let call = ExecCall {
            cmd: request.cmd.to_string(),
            timeout: request.timeout,
            env_keys: request
                .env
                .iter()
                .map(|(key, _)| (*key).to_string())
                .collect(),
            sudo: request.sudo,
            stdin_bytes: request.stdin_bytes.map(Vec::from),
            output_limits: request.output_limits,
        };
        self.exec_calls.lock_ignoring_poison().push(call.clone());
        if let Some(overrides) = &self.overrides {
            overrides.exec.calls.lock_ignoring_poison().push(call);
        }
        // Check pattern matchers before the FIFO queue.
        let result = if let Some(overrides) = &self.overrides {
            let mut matchers = overrides.exec.matchers.lock_ignoring_poison();
            if let Some(idx) = matchers
                .iter()
                .position(|m| request.cmd.contains(&m.pattern))
            {
                Ok(matchers.remove(idx).result)
            } else {
                self.exec_results
                    .lock_ignoring_poison()
                    .pop_front()
                    .unwrap_or_else(|| Ok(default_exec_result()))
            }
        } else {
            self.exec_results
                .lock_ignoring_poison()
                .pop_front()
                .unwrap_or_else(|| Ok(default_exec_result()))
        }?;
        Ok(apply_exec_output_limits(result, request.output_limits))
    }

    async fn read_file(&self, path: &str, max_bytes: u64) -> Result<Option<Vec<u8>>> {
        self.read_file_calls
            .lock_ignoring_poison()
            .push(ReadFileCall {
                path: path.to_string(),
                max_bytes,
            });
        validate_mock_guest_file_path(SandboxOperation::ReadFile, "read_file", path)?;
        if max_bytes > u64::from(u32::MAX) {
            return Err(SandboxError::Operation {
                operation: SandboxOperation::ReadFile,
                reason: SandboxOperationReason::Other,
                message: "mock read_file max_bytes exceeds exec capture limit".into(),
            });
        }
        if max_bytes == 0 {
            return Err(SandboxError::Operation {
                operation: SandboxOperation::ReadFile,
                reason: SandboxOperationReason::Other,
                message: "mock read_file max_bytes must be positive".into(),
            });
        }

        let result = self
            .read_file_results
            .lock_ignoring_poison()
            .pop_front()
            .or_else(|| {
                self.overrides.as_ref().and_then(|overrides| {
                    overrides
                        .file
                        .read_file_results
                        .lock_ignoring_poison()
                        .pop_front()
                })
            })
            .unwrap_or(Ok(None))?;
        if let Some(bytes) = &result
            && bytes.len() as u64 > max_bytes
        {
            return Err(SandboxError::Operation {
                operation: SandboxOperation::ReadFile,
                reason: SandboxOperationReason::Other,
                message: format!("mock read_file exceeded {max_bytes} bytes"),
            });
        }
        Ok(result)
    }

    async fn copy_file(
        &self,
        path: &str,
        host_path: &Path,
        options: CopyFileOptions,
    ) -> Result<CopyFileResult> {
        let call = CopyFileCall {
            path: path.to_string(),
            host_path: host_path.to_path_buf(),
            max_bytes: options.max_bytes,
            timeout: options.timeout,
            missing_ok: options.missing_ok,
        };
        self.copy_file_calls
            .lock_ignoring_poison()
            .push(call.clone());
        if let Some(overrides) = &self.overrides {
            overrides
                .file
                .copy_file_calls
                .lock_ignoring_poison()
                .push(call);
        }
        validate_mock_guest_file_path(SandboxOperation::CopyFile, "copy_file", path)?;
        validate_mock_copy_host_path(host_path)?;
        if options.max_bytes == 0 {
            return Err(SandboxError::Operation {
                operation: SandboxOperation::CopyFile,
                reason: SandboxOperationReason::Other,
                message: "mock copy_file max_bytes must be positive".into(),
            });
        }
        if options.max_bytes > MOCK_COPY_FILE_MAX_BYTES {
            return Err(SandboxError::Operation {
                operation: SandboxOperation::CopyFile,
                reason: SandboxOperationReason::Other,
                message: format!(
                    "mock copy_file max_bytes must be at most {MOCK_COPY_FILE_MAX_BYTES}"
                ),
            });
        }
        if options.timeout.is_zero() {
            return Err(SandboxError::Operation {
                operation: SandboxOperation::CopyFile,
                reason: SandboxOperationReason::Other,
                message: "mock copy_file timeout must be positive".into(),
            });
        }

        let queued = self.copy_file_results.lock_ignoring_poison().pop_front();
        let bytes = match queued {
            Some(result) => result?,
            None if options.missing_ok => {
                return Ok(CopyFileResult { bytes_copied: 0 });
            }
            None => Vec::new(),
        };
        if bytes.len() as u64 > options.max_bytes {
            return Err(SandboxError::Operation {
                operation: SandboxOperation::CopyFile,
                reason: SandboxOperationReason::Other,
                message: format!("mock copy_file exceeded {} bytes", options.max_bytes),
            });
        }
        if let Some(parent) = host_path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(host_path, &bytes)?;
        Ok(CopyFileResult {
            bytes_copied: bytes.len() as u64,
        })
    }

    async fn write_file(&self, path: &str, content: &[u8]) -> Result<()> {
        let call = WriteFileCall {
            path: path.to_string(),
            content: content.to_vec(),
        };
        self.write_file_calls
            .lock_ignoring_poison()
            .push(call.clone());
        if let Some(overrides) = &self.overrides {
            overrides
                .file
                .write_file_calls
                .lock_ignoring_poison()
                .push(call);
        }
        let gate = self.write_file_gate.lock_ignoring_poison().clone();
        if let Some(gate) = gate {
            gate.enter_and_wait().await;
        }
        self.write_file_results
            .lock_ignoring_poison()
            .pop_front()
            .unwrap_or(Ok(()))
    }

    async fn write_files(&self, files: &[WriteFileEntry<'_>]) -> Result<()> {
        let calls = files
            .iter()
            .map(|file| WriteFileCall {
                path: file.path.to_string(),
                content: file.content.to_vec(),
            })
            .collect::<Vec<_>>();
        let batch_call = WriteFilesCall {
            files: calls.clone(),
        };
        self.write_files_calls
            .lock_ignoring_poison()
            .push(batch_call.clone());
        self.write_file_calls
            .lock_ignoring_poison()
            .extend(calls.clone());
        if let Some(overrides) = &self.overrides {
            overrides
                .file
                .write_files_calls
                .lock_ignoring_poison()
                .push(batch_call);
            overrides
                .file
                .write_file_calls
                .lock_ignoring_poison()
                .extend(calls);
        }
        let gate = self.write_file_gate.lock_ignoring_poison().clone();
        if let Some(gate) = gate {
            gate.enter_and_wait().await;
        }
        self.write_file_results
            .lock_ignoring_poison()
            .pop_front()
            .unwrap_or(Ok(()))
    }

    async fn write_private_file(&self, path: &str, content: &[u8]) -> Result<()> {
        let call = WriteFileCall {
            path: path.to_string(),
            content: content.to_vec(),
        };
        self.private_write_file_calls
            .lock_ignoring_poison()
            .push(call.clone());
        if let Some(overrides) = &self.overrides {
            overrides
                .file
                .private_write_file_calls
                .lock_ignoring_poison()
                .push(call);
        }
        self.private_write_file_results
            .lock_ignoring_poison()
            .pop_front()
            .unwrap_or(Ok(()))
    }

    async fn start_process(&self, request: &StartProcessRequest<'_>) -> Result<GuestProcessHandle> {
        validate_mock_exec_env_keys(SandboxOperation::StartProcess, request.env)?;
        validate_start_process_output(request.output)?;
        if let Some(overrides) = &self.overrides {
            overrides
                .process
                .start_process_calls
                .lock_ignoring_poison()
                .push(StartProcessCall {
                    cmd: request.cmd.to_string(),
                    timeout: request.timeout,
                    env: request
                        .env
                        .iter()
                        .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
                        .collect(),
                    sudo: request.sudo,
                    output: request.output,
                    control: request.control,
                });
        }
        let (mut tx, rx) = match request.output {
            ProcessOutputMode::Stream { queue_capacity, .. } => {
                let (tx, rx) = tokio::sync::mpsc::channel(queue_capacity.max(1));
                (Some(tx), Some(rx))
            }
            ProcessOutputMode::Buffered { .. } => (None, None),
        };
        if let Some(overrides) = &self.overrides {
            let chunks = overrides
                .process
                .start_process_stdout_chunks
                .lock_ignoring_poison()
                .pop_front();
            if let Some(chunks) = chunks {
                let Some(sender) = tx.as_ref() else {
                    return Err(SandboxError::Operation {
                        operation: SandboxOperation::StartProcess,
                        reason: SandboxOperationReason::Other,
                        message: "mock stdout chunks require streaming output".to_string(),
                    });
                };
                for chunk in chunks {
                    sender
                        .try_send(chunk)
                        .map_err(|_| SandboxError::Operation {
                            operation: SandboxOperation::StartProcess,
                            reason: SandboxOperationReason::Other,
                            message: "mock stdout chunks exceeded process stream capacity"
                                .to_string(),
                        })?;
                }
            }
        }
        // When simulating wait_process error (timeout/crash), keep the sender
        // alive so the stdout channel never closes — reproducing the real bug.
        if self
            .overrides
            .as_ref()
            .is_some_and(|o| o.process.wait_process_error.is_some())
            && let Some(tx) = tx.take()
        {
            *self.stdout_tx.lock_ignoring_poison() = Some(tx);
        }
        let control = (request.control == ProcessControlMode::Enabled).then(|| {
            let overrides = self.overrides.clone();
            GuestProcessControlHandle::new(move |message_id, payload, timeout| {
                let overrides = overrides.clone();
                Box::pin(async move {
                    if let Some(overrides) = overrides {
                        overrides
                            .process
                            .process_control_calls
                            .lock_ignoring_poison()
                            .push(ProcessControlCall {
                                message_id: message_id.clone(),
                                payload,
                                timeout,
                            });
                        overrides.process.process_control_notify.notify_waiters();
                        if let Some((kind, message)) = overrides
                            .process
                            .process_control_errors
                            .lock_ignoring_poison()
                            .pop_front()
                        {
                            return Err(std::io::Error::new(kind, message));
                        }
                    }
                    Ok(ProcessControlAck { message_id })
                })
            })
        });
        let process_cancel = self.overrides.as_ref().and_then(|overrides| {
            if !*overrides
                .process
                .process_cancel_supported
                .lock_ignoring_poison()
            {
                return None;
            }
            let overrides = Arc::clone(overrides);
            Some(GuestProcessCancelHandle::new(move |timeout| {
                Box::pin(async move {
                    overrides
                        .process
                        .process_cancel_calls
                        .lock_ignoring_poison()
                        .push(ProcessCancelCall { timeout });
                    overrides.process.process_cancel_notify.notify_waiters();
                    if let Some(message) = overrides
                        .process
                        .process_cancel_errors
                        .lock_ignoring_poison()
                        .pop_front()
                    {
                        return Err(std::io::Error::other(message));
                    }
                    if *overrides
                        .process
                        .process_cancel_releases_wait_gate
                        .lock_ignoring_poison()
                    {
                        overrides.release_wait_process_gate();
                    }
                    Ok(())
                })
            }))
        });

        let mut handle = GuestProcessHandle::new(
            1,
            rx,
            control,
            GuestProcessWaiter::new(|_timeout| {
                Box::pin(std::future::pending::<std::io::Result<ProcessExit>>())
            }),
        );
        if let Some(process_cancel) = process_cancel {
            handle = handle.with_cancel_handle(process_cancel);
        }
        Ok(handle)
    }

    async fn wait_process(
        &self,
        mut handle: GuestProcessHandle,
        timeout: Duration,
    ) -> Result<ProcessExit> {
        let Some(_waiter) = handle.take_waiter() else {
            return Err(SandboxError::Operation {
                operation: SandboxOperation::WaitProcess,
                reason: SandboxOperationReason::Other,
                message: "start_process handle already consumed".to_string(),
            });
        };
        // `wait_process` consumes the handle; an unclaimed stream receiver can no
        // longer be observed by the caller and would otherwise buffer forever.
        handle.drop_unclaimed_stdout();

        if let Some(overrides) = &self.overrides {
            overrides
                .process
                .wait_process_calls
                .lock_ignoring_poison()
                .push(WaitProcessCall { timeout });
            // Block until the test signals (gives a window for cancellation).
            overrides.wait_for_wait_process_gate().await;
            // Return error when configured (simulates timeout or crash).
            if let Some(ref msg) = overrides.process.wait_process_error {
                return Err(SandboxError::Operation {
                    operation: SandboxOperation::WaitProcess,
                    reason: SandboxOperationReason::Timeout,
                    message: msg.clone(),
                });
            }
            // Return override exit code when configured.
            if let Some(code) = overrides.process.wait_process_code {
                return Ok(ProcessExit::new(handle.pid, code, Vec::new(), Vec::new()));
            }
            if let Some(exit) = overrides
                .process
                .wait_process_exits
                .lock_ignoring_poison()
                .pop_front()
            {
                return Ok(exit);
            }
        }
        Ok(ProcessExit::new(handle.pid, 0, Vec::new(), Vec::new()))
    }
}
