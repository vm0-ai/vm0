//! Mock implementations of all sandbox traits for testing.
//!
//! All mocks succeed by default with exit code 0 and empty output.
//! Use [`MockSandbox::push_exec_result`], [`MockSandbox::push_write_file_result`],
//! or [`MockSandboxControl::push_exec_remote_result`] to queue custom responses
//! consumed in FIFO order.
//!
//! For advanced control, create [`MockSandboxOverrides`] and pass it via
//! [`MockSandboxRuntime::with_overrides`]. This enables pattern-matched exec
//! results, custom `wait_exit` exit codes, and blocking gates for
//! cancellation testing.
//!
//! ```toml
//! [dev-dependencies]
//! sandbox-mock = { workspace = true }
//! ```

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use async_trait::async_trait;
use sandbox::*;

/// Ignore mutex poisoning and take the lock anyway.
///
/// Callers here are test doubles; surfacing a poison error would appear as
/// a spurious test failure rather than a real issue to propagate.
trait LockIgnoringPoison<T> {
    fn lock_ignoring_poison(&self) -> MutexGuard<'_, T>;
}

impl<T> LockIgnoringPoison<T> for Mutex<T> {
    fn lock_ignoring_poison(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|e| e.into_inner())
    }
}

// ---------------------------------------------------------------------------
// MockSandboxOverrides
// ---------------------------------------------------------------------------

/// Behavior override applied to exec calls whose command contains the pattern.
pub struct ExecMatcher {
    /// Substring to match against `ExecRequest.cmd`.
    pub pattern: String,
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// Shared behavior overrides propagated from runtime → factory → sandbox.
///
/// Tests create this via [`MockSandboxRuntime::with_overrides`] so every
/// sandbox produced by the factory checks these overrides before falling
/// back to the default FIFO-queue behaviour.
pub struct MockSandboxOverrides {
    /// Pattern-matched exec results. First matching pattern wins and is
    /// consumed (one-shot).
    exec_matchers: Mutex<Vec<ExecMatcher>>,
    /// When `Some`, `wait_exit` returns this exit code instead of 0.
    wait_exit_code: Option<i32>,
    /// When set, `wait_exit` awaits this [`tokio::sync::Notify`] before
    /// returning — giving the test a window to cancel the job.
    wait_exit_gate: Option<Arc<tokio::sync::Notify>>,
    /// When `Some`, `wait_exit` returns `Err(SandboxError::ExecFailed(msg))`
    /// to simulate timeout or crash. The stdout channel sender is also kept
    /// alive in `MockSandbox` so the drain task would block without the fix.
    wait_exit_error: Option<String>,
}

impl MockSandboxOverrides {
    pub fn new() -> Self {
        Self {
            exec_matchers: Mutex::new(Vec::new()),
            wait_exit_code: None,
            wait_exit_gate: None,
            wait_exit_error: None,
        }
    }

    /// Create overrides that make `wait_exit` return a custom exit code.
    pub fn with_wait_exit_code(code: i32) -> Self {
        Self {
            exec_matchers: Mutex::new(Vec::new()),
            wait_exit_code: Some(code),
            wait_exit_gate: None,
            wait_exit_error: None,
        }
    }

    /// Create overrides that block `wait_exit` until the gate is notified.
    pub fn with_wait_exit_gate(gate: Arc<tokio::sync::Notify>) -> Self {
        Self {
            exec_matchers: Mutex::new(Vec::new()),
            wait_exit_code: None,
            wait_exit_gate: Some(gate),
            wait_exit_error: None,
        }
    }

    /// Create overrides that make `wait_exit` return an error (simulating
    /// timeout or crash). The stdout channel sender is kept alive so the
    /// drain task blocks unless the caller aborts it.
    pub fn with_wait_exit_error(msg: impl Into<String>) -> Self {
        Self {
            exec_matchers: Mutex::new(Vec::new()),
            wait_exit_code: None,
            wait_exit_gate: None,
            wait_exit_error: Some(msg.into()),
        }
    }

    /// Register a pattern matcher consumed on first match.
    pub fn add_exec_matcher(&self, matcher: ExecMatcher) {
        self.exec_matchers.lock_ignoring_poison().push(matcher);
    }
}

impl Default for MockSandboxOverrides {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// MockSandbox
// ---------------------------------------------------------------------------

/// A mock [`Sandbox`] that succeeds on all operations by default.
///
/// Queue custom results with [`push_exec_result`](Self::push_exec_result)
/// and [`push_write_file_result`](Self::push_write_file_result).
/// When a queue is empty, the operation returns its default success value.
pub struct MockSandbox {
    id: String,
    source_ip: String,
    exec_results: Mutex<VecDeque<Result<ExecResult>>>,
    write_file_results: Mutex<VecDeque<Result<()>>>,
    overrides: Option<Arc<MockSandboxOverrides>>,
    /// Holds the stdout channel sender alive when simulating a non-closing
    /// channel (e.g. wait_exit_error override). Without this, the sender is
    /// dropped immediately in `spawn_watch` and the drain task exits.
    stdout_tx: Mutex<Option<tokio::sync::mpsc::UnboundedSender<Vec<u8>>>>,
}

impl MockSandbox {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            source_ip: "10.0.0.1".into(),
            exec_results: Mutex::new(VecDeque::new()),
            write_file_results: Mutex::new(VecDeque::new()),
            overrides: None,
            stdout_tx: Mutex::new(None),
        }
    }

    fn with_overrides(id: impl Into<String>, overrides: Arc<MockSandboxOverrides>) -> Self {
        Self {
            id: id.into(),
            source_ip: "10.0.0.1".into(),
            exec_results: Mutex::new(VecDeque::new()),
            write_file_results: Mutex::new(VecDeque::new()),
            overrides: Some(overrides),
            stdout_tx: Mutex::new(None),
        }
    }

    pub fn with_source_ip(mut self, ip: impl Into<String>) -> Self {
        self.source_ip = ip.into();
        self
    }

    /// Queue an exec result. Results are consumed in FIFO order.
    pub fn push_exec_result(&self, result: Result<ExecResult>) {
        self.exec_results.lock_ignoring_poison().push_back(result);
    }

    /// Queue a write_file result. Results are consumed in FIFO order.
    /// When the queue is empty, write_file returns `Ok(())`.
    pub fn push_write_file_result(&self, result: Result<()>) {
        self.write_file_results
            .lock_ignoring_poison()
            .push_back(result);
    }
}

fn default_exec_result() -> ExecResult {
    ExecResult {
        exit_code: 0,
        stdout: Vec::new(),
        stderr: Vec::new(),
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
        Ok(())
    }

    async fn stop(&mut self) -> Result<()> {
        Ok(())
    }

    async fn kill(&mut self) -> Result<()> {
        Ok(())
    }

    async fn exec(&self, request: &ExecRequest<'_>) -> Result<ExecResult> {
        // Check pattern matchers before the FIFO queue.
        if let Some(overrides) = &self.overrides {
            let mut matchers = overrides.exec_matchers.lock_ignoring_poison();
            if let Some(idx) = matchers
                .iter()
                .position(|m| request.cmd.contains(&m.pattern))
            {
                let m = matchers.remove(idx);
                return Ok(ExecResult {
                    exit_code: m.exit_code,
                    stdout: m.stdout,
                    stderr: m.stderr,
                });
            }
        }
        self.exec_results
            .lock_ignoring_poison()
            .pop_front()
            .unwrap_or_else(|| Ok(default_exec_result()))
    }

    async fn write_file(&self, _path: &str, _content: &[u8]) -> Result<()> {
        self.write_file_results
            .lock_ignoring_poison()
            .pop_front()
            .unwrap_or(Ok(()))
    }

    async fn spawn_watch(
        &self,
        _request: &ExecRequest<'_>,
        _stdout_log_path: Option<&str>,
    ) -> Result<SpawnHandle> {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        // When simulating wait_exit error (timeout/crash), keep the sender
        // alive so the stdout channel never closes — reproducing the real bug.
        if self
            .overrides
            .as_ref()
            .is_some_and(|o| o.wait_exit_error.is_some())
        {
            *self.stdout_tx.lock_ignoring_poison() = Some(tx);
        }
        Ok(SpawnHandle {
            pid: 1,
            stdout_rx: Some(rx),
        })
    }

    async fn wait_exit(&self, handle: SpawnHandle, _timeout: Duration) -> Result<ProcessExit> {
        if let Some(overrides) = &self.overrides {
            // Block until the test signals (gives a window for cancellation).
            if let Some(gate) = &overrides.wait_exit_gate {
                gate.notified().await;
            }
            // Return error when configured (simulates timeout or crash).
            if let Some(ref msg) = overrides.wait_exit_error {
                return Err(SandboxError::ExecFailed(msg.clone()));
            }
            // Return override exit code when configured.
            if let Some(code) = overrides.wait_exit_code {
                return Ok(ProcessExit {
                    pid: handle.pid,
                    exit_code: code,
                    stdout: Vec::new(),
                    stderr: Vec::new(),
                });
            }
        }
        Ok(ProcessExit {
            pid: handle.pid,
            exit_code: 0,
            stdout: Vec::new(),
            stderr: Vec::new(),
        })
    }
}

// ---------------------------------------------------------------------------
// MockSandboxFactory
// ---------------------------------------------------------------------------

/// A mock [`SandboxFactory`] that creates [`MockSandbox`] instances.
///
/// Queue custom `create` results with [`push_create_result`](Self::push_create_result).
/// When the queue is empty, `create` returns a default `MockSandbox`.
pub struct MockSandboxFactory {
    create_results: Mutex<VecDeque<Result<()>>>,
    overrides: Option<Arc<MockSandboxOverrides>>,
}

impl MockSandboxFactory {
    pub fn new() -> Self {
        Self {
            create_results: Mutex::new(VecDeque::new()),
            overrides: None,
        }
    }

    pub fn with_overrides(overrides: Arc<MockSandboxOverrides>) -> Self {
        Self {
            create_results: Mutex::new(VecDeque::new()),
            overrides: Some(overrides),
        }
    }

    /// Queue a create result. `Ok(())` creates a normal `MockSandbox`;
    /// `Err(...)` makes `create` return that error.
    /// Results are consumed in FIFO order.
    pub fn push_create_result(&self, result: Result<()>) {
        self.create_results.lock_ignoring_poison().push_back(result);
    }
}

impl Default for MockSandboxFactory {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl SandboxFactory for MockSandboxFactory {
    fn name(&self) -> &str {
        "mock"
    }

    fn config_hash(&self) -> String {
        "mock-config-hash".into()
    }

    async fn startup(&mut self) -> Result<()> {
        Ok(())
    }

    async fn create(&self, config: SandboxConfig) -> Result<Box<dyn Sandbox>> {
        if let Some(result) = self.create_results.lock_ignoring_poison().pop_front() {
            result?;
        }
        let sandbox = match &self.overrides {
            Some(o) => MockSandbox::with_overrides(config.id.to_string(), Arc::clone(o)),
            None => MockSandbox::new(config.id.to_string()),
        };
        Ok(Box::new(sandbox))
    }

    async fn destroy(&self, _sandbox: Box<dyn Sandbox>) {}

    async fn shutdown(&mut self) {}
}

// ---------------------------------------------------------------------------
// MockSandboxRuntime
// ---------------------------------------------------------------------------

/// A mock [`SandboxRuntime`] that creates [`MockSandboxFactory`] instances.
pub struct MockSandboxRuntime {
    overrides: Option<Arc<MockSandboxOverrides>>,
}

impl MockSandboxRuntime {
    pub fn new() -> Self {
        Self { overrides: None }
    }

    pub fn with_overrides(overrides: Arc<MockSandboxOverrides>) -> Self {
        Self {
            overrides: Some(overrides),
        }
    }
}

impl Default for MockSandboxRuntime {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl SandboxRuntime for MockSandboxRuntime {
    async fn create_factory(&self, _config: FactoryConfig) -> Result<Box<dyn SandboxFactory>> {
        let factory = match &self.overrides {
            Some(o) => MockSandboxFactory::with_overrides(Arc::clone(o)),
            None => MockSandboxFactory::new(),
        };
        Ok(Box::new(factory))
    }

    async fn shutdown(&mut self) {}
}

// ---------------------------------------------------------------------------
// MockRuntimeProvider
// ---------------------------------------------------------------------------

/// A mock [`RuntimeProvider`] that creates [`MockSandboxRuntime`] instances.
pub struct MockRuntimeProvider;

#[async_trait]
impl RuntimeProvider for MockRuntimeProvider {
    async fn create_runtime(&self, _config: RuntimeConfig) -> Result<Box<dyn SandboxRuntime>> {
        Ok(Box::new(MockSandboxRuntime::new()))
    }
}

// ---------------------------------------------------------------------------
// MockSnapshotProvider
// ---------------------------------------------------------------------------

/// A mock [`SnapshotProvider`] that returns dummy paths.
pub struct MockSnapshotProvider;

#[async_trait]
impl SnapshotProvider for MockSnapshotProvider {
    async fn create_snapshot(
        &self,
        config: SnapshotCreateConfig,
    ) -> std::result::Result<SnapshotOutput, SnapshotError> {
        Ok(SnapshotOutput {
            snapshot_path: config.output_dir.join("snapshot.bin"),
            memory_path: config.output_dir.join("memory.bin"),
            cow_path: config.output_dir.join("cow.img"),
        })
    }

    fn config_hash(&self) -> String {
        "mock-snapshot-config-hash".into()
    }

    async fn is_complete(
        &self,
        _output_dir: &std::path::Path,
    ) -> std::result::Result<bool, SnapshotError> {
        Ok(false)
    }
}

// ---------------------------------------------------------------------------
// MockSandboxControl
// ---------------------------------------------------------------------------

/// A mock [`SandboxControl`] for testing exec/kill commands.
///
/// Queue custom results with [`push_exec_remote_result`](Self::push_exec_remote_result).
/// When the queue is empty, returns exit code 0 with empty output.
pub struct MockSandboxControl {
    base_dir: PathBuf,
    exec_results: Mutex<VecDeque<std::result::Result<RemoteExecResult, SandboxControlError>>>,
    recorded_commands: Mutex<Vec<String>>,
}

impl MockSandboxControl {
    pub fn new(base_dir: impl Into<PathBuf>) -> Self {
        Self {
            base_dir: base_dir.into(),
            exec_results: Mutex::new(VecDeque::new()),
            recorded_commands: Mutex::new(Vec::new()),
        }
    }

    /// Queue an exec remote result. Results are consumed in FIFO order.
    pub fn push_exec_remote_result(
        &self,
        result: std::result::Result<RemoteExecResult, SandboxControlError>,
    ) {
        self.exec_results.lock_ignoring_poison().push_back(result);
    }

    /// Return every command string passed to `exec_remote`, in call order.
    pub fn recorded_commands(&self) -> Vec<String> {
        self.recorded_commands.lock_ignoring_poison().clone()
    }
}

#[async_trait]
impl SandboxControl for MockSandboxControl {
    async fn exec_remote(
        &self,
        _sandbox_id: &str,
        command: &str,
        _timeout: Duration,
        _sudo: bool,
    ) -> std::result::Result<RemoteExecResult, SandboxControlError> {
        self.recorded_commands
            .lock_ignoring_poison()
            .push(command.to_string());
        self.exec_results
            .lock_ignoring_poison()
            .pop_front()
            .unwrap_or_else(|| {
                Ok(RemoteExecResult {
                    exit_code: 0,
                    stdout: Vec::new(),
                    stderr: Vec::new(),
                })
            })
    }

    fn runtime_dir(&self, sandbox_id: &str) -> PathBuf {
        self.base_dir.join(sandbox_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn sandbox_default_exec_succeeds() {
        let sandbox = MockSandbox::new("test-1");
        let result = sandbox
            .exec(&ExecRequest {
                cmd: "echo hello",
                timeout: Duration::from_secs(5),
                env: &[],
                sudo: false,
            })
            .await;
        let exec = result.unwrap();
        assert_eq!(exec.exit_code, 0);
        assert!(exec.stdout.is_empty());
    }

    #[tokio::test]
    async fn sandbox_queued_exec_results() {
        let sandbox = MockSandbox::new("test-1");
        sandbox.push_exec_result(Ok(ExecResult {
            exit_code: 42,
            stdout: b"out".to_vec(),
            stderr: b"err".to_vec(),
        }));
        sandbox.push_exec_result(Err(SandboxError::ExecFailed("boom".into())));

        let req = ExecRequest {
            cmd: "test",
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
        };

        // First call returns queued result.
        let r1 = sandbox.exec(&req).await.unwrap();
        assert_eq!(r1.exit_code, 42);
        assert_eq!(r1.stdout, b"out");

        // Second call returns queued error.
        let r2 = sandbox.exec(&req).await;
        assert!(r2.is_err());

        // Third call falls back to default (exit 0).
        let r3 = sandbox.exec(&req).await.unwrap();
        assert_eq!(r3.exit_code, 0);
    }

    #[tokio::test]
    async fn sandbox_lifecycle() {
        let mut sandbox = MockSandbox::new("test-1");
        sandbox.start().await.unwrap();
        sandbox.stop().await.unwrap();
        sandbox.kill().await.unwrap();
    }

    #[tokio::test]
    async fn factory_creates_sandbox() {
        let mut factory = MockSandboxFactory::new();
        factory.startup().await.unwrap();
        let config = SandboxConfig {
            id: uuid::Uuid::new_v4(),
            resources: ResourceLimits {
                cpu_count: 2,
                memory_mb: 1024,
            },
        };
        let sandbox = factory.create(config).await.unwrap();
        assert!(!sandbox.id().is_empty());
        factory.destroy(sandbox).await;
        factory.shutdown().await;
    }

    #[tokio::test]
    async fn runtime_creates_factory() {
        let mut runtime = MockSandboxRuntime::new();
        let factory_config = FactoryConfig {
            profile: "test".into(),
            binary_path: "/bin/test".into(),
            kernel_path: "/boot/test".into(),
            rootfs_path: "/rootfs/test".into(),
            base_dir: "/tmp/test".into(),
            snapshot: None,
        };
        let mut factory = runtime.create_factory(factory_config).await.unwrap();
        assert_eq!(factory.name(), "mock");
        factory.shutdown().await;
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn runtime_provider_creates_runtime() {
        let provider = MockRuntimeProvider;
        let mut runtime = provider
            .create_runtime(RuntimeConfig {
                proxy_port: None,
                dns_port: None,
            })
            .await
            .unwrap();
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn sandbox_control_default_succeeds() {
        let control = MockSandboxControl::new("/tmp/test");
        let result = control
            .exec_remote("sandbox-1", "echo hi", Duration::from_secs(5), false)
            .await
            .unwrap();
        assert_eq!(result.exit_code, 0);
        assert_eq!(
            control.runtime_dir("sandbox-1"),
            PathBuf::from("/tmp/test/sandbox-1")
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
        sandbox.push_write_file_result(Err(SandboxError::ExecFailed("disk full".into())));

        let result = sandbox.write_file("/tmp/test.txt", b"data").await;
        assert!(result.is_err());

        // Falls back to default Ok.
        sandbox.write_file("/tmp/test.txt", b"data").await.unwrap();
    }

    #[tokio::test]
    async fn factory_create_queued_error() {
        let mut factory = MockSandboxFactory::new();
        factory.startup().await.unwrap();
        factory.push_create_result(Err(SandboxError::CreationFailed("out of resources".into())));

        let config = SandboxConfig {
            id: uuid::Uuid::new_v4(),
            resources: ResourceLimits {
                cpu_count: 2,
                memory_mb: 1024,
            },
        };
        let result = factory.create(config).await;
        assert!(result.is_err());

        // Next create falls back to default success.
        let config2 = SandboxConfig {
            id: uuid::Uuid::new_v4(),
            resources: ResourceLimits {
                cpu_count: 2,
                memory_mb: 1024,
            },
        };
        factory.create(config2).await.unwrap();
    }

    #[tokio::test]
    async fn sandbox_control_records_commands() {
        let control = MockSandboxControl::new("/tmp/test");
        control
            .exec_remote("sandbox-1", "echo one", Duration::from_secs(5), false)
            .await
            .unwrap();
        control
            .exec_remote("sandbox-1", "echo two", Duration::from_secs(5), true)
            .await
            .unwrap();

        assert_eq!(
            control.recorded_commands(),
            vec!["echo one".to_string(), "echo two".to_string()],
        );
    }

    #[tokio::test]
    async fn sandbox_control_queued_results() {
        let control = MockSandboxControl::new("/tmp/test");
        control.push_exec_remote_result(Err(SandboxControlError::NotFound("gone".into())));

        let result = control
            .exec_remote("sandbox-1", "test", Duration::from_secs(5), false)
            .await;
        assert!(result.is_err());

        // Falls back to default.
        let result = control
            .exec_remote("sandbox-1", "test", Duration::from_secs(5), false)
            .await
            .unwrap();
        assert_eq!(result.exit_code, 0);
    }
}
