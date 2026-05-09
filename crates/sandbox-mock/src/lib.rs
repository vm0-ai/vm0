//! Mock implementations of all sandbox traits for testing.
//!
//! All mocks succeed by default with exit code 0 and empty output.
//! Use [`MockSandbox::push_exec_result`], [`MockSandbox::push_write_file_result`],
//! [`MockSandbox::push_bounded_exec_response`],
//! or [`MockSandboxControl::push_exec_remote_result`] to queue custom responses
//! consumed in FIFO order.
//!
//! For advanced control, create [`MockSandboxOverrides`] and pass it via
//! [`MockSandboxRuntime::with_overrides`]. This enables pattern-matched exec
//! and bounded_exec results, custom `wait_exit` exit codes, and blocking gates
//! for lifecycle and cancellation testing.
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

/// Behavior override applied to bounded_exec calls whose command contains the pattern.
pub struct BoundedExecMatcher {
    /// Substring to match against `BoundedExecRequest.cmd`.
    pub pattern: String,
    pub response: BoundedExecResponse,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundedExecCall {
    pub cmd: String,
    pub env: Vec<(String, String)>,
    pub sudo: bool,
    pub stdin: Option<Vec<u8>>,
    pub stdout: BoundedExecOutputCall,
    pub stderr: BoundedExecOutputCall,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundedExecOutputCall {
    pub capture: BoundedExecCapturePolicy,
    pub stream: Option<BoundedExecStreamCall>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundedExecStreamCall {
    pub limit_bytes: u32,
    pub chunk_limit_bytes: u32,
}

pub struct BoundedExecResponse {
    pub events: Vec<BoundedExecOutputEvent>,
    pub result: Result<BoundedExecResult>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpawnWatchCall {
    pub streams_stdout: bool,
    pub guest_log_path: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WriteFileCall {
    pub path: String,
    pub content: Vec<u8>,
}

enum LifecycleBehavior {
    Result(Result<()>),
    Panic(String),
}

#[derive(Clone)]
struct BlockingGate {
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
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
    /// Pattern-matched bounded_exec responses. First matching pattern wins and
    /// is consumed (one-shot).
    bounded_exec_matchers: Mutex<Vec<BoundedExecMatcher>>,
    /// FIFO bounded_exec responses consumed across all sandboxes built from
    /// these overrides. Empty queue → default success.
    bounded_exec_responses: Mutex<VecDeque<BoundedExecResponse>>,
    /// When `Some`, `wait_exit` returns this exit code instead of 0.
    wait_exit_code: Option<i32>,
    /// When set, `wait_exit` awaits this [`tokio::sync::Notify`] before
    /// returning — giving the test a window to cancel the job.
    wait_exit_gate: Option<Arc<tokio::sync::Notify>>,
    /// When `Some`, `wait_exit` returns a wait-exit operation error to
    /// simulate timeout or crash. The stdout channel sender is also kept alive
    /// in `MockSandbox` so the drain task would block without the fix.
    wait_exit_error: Option<String>,
    /// FIFO queue of start results consumed by every sandbox built with
    /// these overrides. Empty queue → default Ok(()).
    start_results: Mutex<VecDeque<Result<()>>>,
    /// FIFO queue of stop behaviours consumed by every sandbox built with
    /// these overrides. Empty queue → default Ok(()).
    stop_behaviors: Mutex<VecDeque<LifecycleBehavior>>,
    /// FIFO queue of park results consumed by every sandbox built with
    /// these overrides. Empty queue → default Ok(()).
    park_behaviors: Mutex<VecDeque<LifecycleBehavior>>,
    /// When set, `park` notifies `entered` and then blocks until `release`.
    park_gate: Mutex<Option<BlockingGate>>,
    /// FIFO queue of unpark results consumed by every sandbox built with
    /// these overrides. Empty queue → default Ok(()).
    unpark_behaviors: Mutex<VecDeque<LifecycleBehavior>>,
    /// When set, factory `destroy` notifies `entered` and then blocks until
    /// `release`.
    destroy_gate: Mutex<Option<BlockingGate>>,
    /// Recorded spawn_watch output modes across all sandboxes built from
    /// this override set.
    spawn_watch_calls: Mutex<Vec<SpawnWatchCall>>,
    /// Recorded bounded_exec calls across all sandboxes built from this
    /// override set.
    bounded_exec_calls: Mutex<Vec<BoundedExecCall>>,
    /// Total `park()` calls across all sandboxes built from this override set.
    park_calls: Mutex<u32>,
    /// Total `unpark()` calls across all sandboxes built from this override set.
    unpark_calls: Mutex<u32>,
    /// Total factory `destroy()` calls across all factories built from this
    /// override set.
    destroy_calls: Mutex<u32>,
}

impl MockSandboxOverrides {
    pub fn new() -> Self {
        Self {
            exec_matchers: Mutex::new(Vec::new()),
            bounded_exec_matchers: Mutex::new(Vec::new()),
            bounded_exec_responses: Mutex::new(VecDeque::new()),
            wait_exit_code: None,
            wait_exit_gate: None,
            wait_exit_error: None,
            start_results: Mutex::new(VecDeque::new()),
            stop_behaviors: Mutex::new(VecDeque::new()),
            park_behaviors: Mutex::new(VecDeque::new()),
            park_gate: Mutex::new(None),
            unpark_behaviors: Mutex::new(VecDeque::new()),
            destroy_gate: Mutex::new(None),
            spawn_watch_calls: Mutex::new(Vec::new()),
            bounded_exec_calls: Mutex::new(Vec::new()),
            park_calls: Mutex::new(0),
            unpark_calls: Mutex::new(0),
            destroy_calls: Mutex::new(0),
        }
    }

    /// Create overrides that make `wait_exit` return a custom exit code.
    pub fn with_wait_exit_code(code: i32) -> Self {
        Self {
            wait_exit_code: Some(code),
            ..Self::new()
        }
    }

    /// Create overrides that block `wait_exit` until the gate is notified.
    pub fn with_wait_exit_gate(gate: Arc<tokio::sync::Notify>) -> Self {
        Self {
            wait_exit_gate: Some(gate),
            ..Self::new()
        }
    }

    /// Create overrides that make `wait_exit` return an error (simulating
    /// timeout or crash). The stdout channel sender is kept alive so the
    /// drain task blocks unless the caller aborts it.
    pub fn with_wait_exit_error(msg: impl Into<String>) -> Self {
        Self {
            wait_exit_error: Some(msg.into()),
            ..Self::new()
        }
    }

    /// Register a pattern matcher consumed on first match.
    pub fn add_exec_matcher(&self, matcher: ExecMatcher) {
        self.exec_matchers.lock_ignoring_poison().push(matcher);
    }

    /// Register a bounded_exec pattern matcher consumed on first match.
    pub fn add_bounded_exec_matcher(&self, matcher: BoundedExecMatcher) {
        self.bounded_exec_matchers
            .lock_ignoring_poison()
            .push(matcher);
    }

    /// Queue a bounded_exec response consumed FIFO across all sandboxes built
    /// with these overrides. Empty queue → default success.
    pub fn push_bounded_exec_response(&self, response: BoundedExecResponse) {
        self.bounded_exec_responses
            .lock_ignoring_poison()
            .push_back(response);
    }

    /// Queue a `start()` result applied to the next factory-created sandbox.
    /// Consumed FIFO across all sandboxes; empty queue → default Ok(()).
    pub fn push_start_result(&self, result: Result<()>) {
        self.start_results.lock_ignoring_poison().push_back(result);
    }

    /// Queue a `stop()` result applied to the next factory-created sandbox.
    /// Consumed FIFO across all sandboxes; empty queue → default Ok(()).
    pub fn push_stop_result(&self, result: Result<()>) {
        self.stop_behaviors
            .lock_ignoring_poison()
            .push_back(LifecycleBehavior::Result(result));
    }

    /// Queue a `stop()` panic applied to the next factory-created sandbox.
    /// Used by runner tests to exercise panic-safe cleanup boundaries.
    pub fn push_stop_panic(&self, message: impl Into<String>) {
        self.stop_behaviors
            .lock_ignoring_poison()
            .push_back(LifecycleBehavior::Panic(message.into()));
    }

    /// Queue a `park()` result applied to the next factory-created sandbox.
    /// Consumed FIFO across all sandboxes; empty queue → default Ok(()).
    pub fn push_park_result(&self, result: Result<()>) {
        self.park_behaviors
            .lock_ignoring_poison()
            .push_back(LifecycleBehavior::Result(result));
    }

    /// Queue a `park()` panic applied to the next factory-created sandbox.
    /// Used by runner tests to exercise panic-safe cleanup boundaries.
    pub fn push_park_panic(&self, message: impl Into<String>) {
        self.park_behaviors
            .lock_ignoring_poison()
            .push_back(LifecycleBehavior::Panic(message.into()));
    }

    /// Block every `park()` call after recording entry until `release` is
    /// notified. Used by tests to open deterministic race windows.
    pub fn set_park_gate(
        &self,
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    ) {
        *self.park_gate.lock_ignoring_poison() = Some(BlockingGate { entered, release });
    }

    /// Queue an `unpark()` result applied to the next factory-created sandbox.
    /// Consumed FIFO across all sandboxes; empty queue → default Ok(()).
    pub fn push_unpark_result(&self, result: Result<()>) {
        self.unpark_behaviors
            .lock_ignoring_poison()
            .push_back(LifecycleBehavior::Result(result));
    }

    /// Queue an `unpark()` panic applied to the next factory-created sandbox.
    /// Used by runner tests to exercise panic-safe cleanup boundaries.
    pub fn push_unpark_panic(&self, message: impl Into<String>) {
        self.unpark_behaviors
            .lock_ignoring_poison()
            .push_back(LifecycleBehavior::Panic(message.into()));
    }

    /// Block every factory `destroy()` call after recording entry until
    /// `release` is notified.
    pub fn set_destroy_gate(
        &self,
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    ) {
        *self.destroy_gate.lock_ignoring_poison() = Some(BlockingGate { entered, release });
    }

    /// Total `park()` calls across all sandboxes built from this override set.
    pub fn park_call_count(&self) -> u32 {
        *self.park_calls.lock_ignoring_poison()
    }

    /// Total `unpark()` calls across all sandboxes built from this override set.
    pub fn unpark_call_count(&self) -> u32 {
        *self.unpark_calls.lock_ignoring_poison()
    }

    /// Total factory `destroy()` calls across all factories built from this
    /// override set.
    pub fn destroy_call_count(&self) -> u32 {
        *self.destroy_calls.lock_ignoring_poison()
    }

    /// Recorded spawn_watch calls across all sandboxes built from this
    /// override set, in call order.
    pub fn spawn_watch_calls(&self) -> Vec<SpawnWatchCall> {
        self.spawn_watch_calls.lock_ignoring_poison().clone()
    }

    /// Recorded bounded_exec calls across all sandboxes built from this
    /// override set, in call order.
    pub fn bounded_exec_calls(&self) -> Vec<BoundedExecCall> {
        self.bounded_exec_calls.lock_ignoring_poison().clone()
    }
}

async fn wait_blocking_gate(gate: &Mutex<Option<BlockingGate>>) {
    let gate = gate.lock_ignoring_poison().clone();
    if let Some(gate) = gate {
        gate.entered.notify_waiters();
        gate.release.notified().await;
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
/// [`push_bounded_exec_response`](Self::push_bounded_exec_response), and
/// [`push_write_file_result`](Self::push_write_file_result).
/// When a queue is empty, the operation returns its default success value.
pub struct MockSandbox {
    id: String,
    source_ip: String,
    exec_results: Mutex<VecDeque<Result<ExecResult>>>,
    bounded_exec_responses: Mutex<VecDeque<BoundedExecResponse>>,
    bounded_exec_calls: Mutex<Vec<BoundedExecCall>>,
    write_file_results: Mutex<VecDeque<Result<()>>>,
    write_file_calls: Mutex<Vec<WriteFileCall>>,
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
            bounded_exec_responses: Mutex::new(VecDeque::new()),
            bounded_exec_calls: Mutex::new(Vec::new()),
            write_file_results: Mutex::new(VecDeque::new()),
            write_file_calls: Mutex::new(Vec::new()),
            overrides: None,
            stdout_tx: Mutex::new(None),
        }
    }

    fn with_overrides(id: impl Into<String>, overrides: Arc<MockSandboxOverrides>) -> Self {
        Self {
            id: id.into(),
            source_ip: "10.0.0.1".into(),
            exec_results: Mutex::new(VecDeque::new()),
            bounded_exec_responses: Mutex::new(VecDeque::new()),
            bounded_exec_calls: Mutex::new(Vec::new()),
            write_file_results: Mutex::new(VecDeque::new()),
            write_file_calls: Mutex::new(Vec::new()),
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

    /// Queue a bounded_exec response. Responses are consumed in FIFO order.
    pub fn push_bounded_exec_response(&self, response: BoundedExecResponse) {
        self.bounded_exec_responses
            .lock_ignoring_poison()
            .push_back(response);
    }

    pub fn bounded_exec_calls(&self) -> Vec<BoundedExecCall> {
        self.bounded_exec_calls.lock_ignoring_poison().clone()
    }

    /// Queue a write_file result. Results are consumed in FIFO order.
    /// When the queue is empty, write_file returns `Ok(())`.
    pub fn push_write_file_result(&self, result: Result<()>) {
        self.write_file_results
            .lock_ignoring_poison()
            .push_back(result);
    }

    pub fn write_file_calls(&self) -> Vec<WriteFileCall> {
        self.write_file_calls.lock_ignoring_poison().clone()
    }
}

fn default_exec_result() -> ExecResult {
    ExecResult {
        exit_code: 0,
        stdout: Vec::new(),
        stderr: Vec::new(),
    }
}

fn default_bounded_exec_result() -> BoundedExecResult {
    BoundedExecResult {
        termination: BoundedExecTermination::Exited { exit_code: 0 },
        duration: Duration::ZERO,
        stdout: BoundedExecOutput::Captured {
            bytes: Vec::new(),
            truncated: false,
        },
        stderr: BoundedExecOutput::Captured {
            bytes: Vec::new(),
            truncated: false,
        },
        diagnostic: None,
    }
}

fn output_call_from_request(output: &BoundedExecOutputRequest) -> BoundedExecOutputCall {
    BoundedExecOutputCall {
        capture: output.capture,
        stream: output.stream.as_ref().map(|stream| BoundedExecStreamCall {
            limit_bytes: stream.limit_bytes,
            chunk_limit_bytes: stream.chunk_limit_bytes,
        }),
    }
}

fn bounded_exec_call_from_request(request: &BoundedExecRequest<'_>) -> BoundedExecCall {
    BoundedExecCall {
        cmd: request.cmd.to_string(),
        env: request
            .env
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect(),
        sudo: request.sudo,
        stdin: request.stdin.map(<[u8]>::to_vec),
        stdout: output_call_from_request(&request.stdout),
        stderr: output_call_from_request(&request.stderr),
    }
}

fn emit_bounded_exec_events(request: &BoundedExecRequest<'_>, events: Vec<BoundedExecOutputEvent>) {
    for event in events {
        let target = match event.stream {
            BoundedExecStream::Stdout => request.stdout.stream.as_ref(),
            BoundedExecStream::Stderr => request.stderr.stream.as_ref(),
        };
        let Some(stream) = target else { continue };
        let _ = stream.event_tx.send(event);
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
        o.start_results
            .lock_ignoring_poison()
            .pop_front()
            .unwrap_or(Ok(()))
    }

    async fn stop(&mut self) -> Result<()> {
        let Some(o) = &self.overrides else {
            return Ok(());
        };
        match o.stop_behaviors.lock_ignoring_poison().pop_front() {
            Some(LifecycleBehavior::Result(result)) => result,
            #[allow(clippy::panic)]
            Some(LifecycleBehavior::Panic(message)) => panic!("{message}"),
            None => Ok(()),
        }
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
        *o.park_calls.lock_ignoring_poison() += 1;
        wait_blocking_gate(&o.park_gate).await;
        match o.park_behaviors.lock_ignoring_poison().pop_front() {
            Some(LifecycleBehavior::Result(result)) => result,
            #[allow(clippy::panic)]
            Some(LifecycleBehavior::Panic(message)) => panic!("{message}"),
            None => Ok(()),
        }
    }

    /// Mock unpark: counter + queued-result semantics mirror [`park`]
    /// exactly. See [`park`] for details.
    ///
    /// [`park`]: Self::park
    async fn unpark(&mut self) -> Result<()> {
        let Some(o) = &self.overrides else {
            return Ok(());
        };
        *o.unpark_calls.lock_ignoring_poison() += 1;
        match o.unpark_behaviors.lock_ignoring_poison().pop_front() {
            Some(LifecycleBehavior::Result(result)) => result,
            #[allow(clippy::panic)]
            Some(LifecycleBehavior::Panic(message)) => panic!("{message}"),
            None => Ok(()),
        }
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

    async fn bounded_exec(&self, request: &BoundedExecRequest<'_>) -> Result<BoundedExecResult> {
        let call = bounded_exec_call_from_request(request);
        self.bounded_exec_calls
            .lock_ignoring_poison()
            .push(call.clone());
        if let Some(overrides) = &self.overrides {
            overrides
                .bounded_exec_calls
                .lock_ignoring_poison()
                .push(call);
            let matched_response = {
                let mut matchers = overrides.bounded_exec_matchers.lock_ignoring_poison();
                matchers
                    .iter()
                    .position(|m| request.cmd.contains(&m.pattern))
                    .map(|idx| matchers.remove(idx).response)
            };
            if let Some(response) = matched_response {
                emit_bounded_exec_events(request, response.events);
                return response.result;
            }
            if let Some(response) = overrides
                .bounded_exec_responses
                .lock_ignoring_poison()
                .pop_front()
            {
                emit_bounded_exec_events(request, response.events);
                return response.result;
            }
        }
        if let Some(response) = self
            .bounded_exec_responses
            .lock_ignoring_poison()
            .pop_front()
        {
            emit_bounded_exec_events(request, response.events);
            return response.result;
        }
        Ok(default_bounded_exec_result())
    }

    async fn write_file(&self, path: &str, content: &[u8]) -> Result<()> {
        self.write_file_calls
            .lock_ignoring_poison()
            .push(WriteFileCall {
                path: path.to_string(),
                content: content.to_vec(),
            });
        self.write_file_results
            .lock_ignoring_poison()
            .pop_front()
            .unwrap_or(Ok(()))
    }

    async fn spawn_watch(
        &self,
        _request: &ExecRequest<'_>,
        output: sandbox::SpawnOutputMode<'_>,
    ) -> Result<SpawnHandle> {
        if let Some(overrides) = &self.overrides {
            overrides
                .spawn_watch_calls
                .lock_ignoring_poison()
                .push(SpawnWatchCall {
                    streams_stdout: output.streams_stdout(),
                    guest_log_path: output.guest_log_path().map(str::to_owned),
                });
        }
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
            stdout_rx: output.streams_stdout().then_some(rx),
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
                return Err(SandboxError::Operation {
                    operation: SandboxOperation::WaitExit,
                    reason: SandboxOperationReason::Timeout,
                    message: msg.clone(),
                });
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

    async fn destroy(&self, _sandbox: Box<dyn Sandbox>) {
        if let Some(o) = &self.overrides {
            *o.destroy_calls.lock_ignoring_poison() += 1;
            wait_blocking_gate(&o.destroy_gate).await;
        }
    }

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

struct MockPendingSnapshotPublish {
    output_dir: PathBuf,
}

#[async_trait]
impl PendingSnapshotPublish for MockPendingSnapshotPublish {
    async fn commit(&mut self) -> std::result::Result<SnapshotOutput, SnapshotError> {
        Ok(SnapshotOutput {
            snapshot_path: self.output_dir.join("snapshot.bin"),
            memory_path: self.output_dir.join("memory.bin"),
            cow_path: self.output_dir.join("cow.img"),
        })
    }

    async fn discard(&mut self) -> std::result::Result<(), SnapshotError> {
        Ok(())
    }
}

#[async_trait]
impl SnapshotProvider for MockSnapshotProvider {
    async fn create_uncommitted_snapshot(
        &self,
        config: SnapshotCreateConfig,
    ) -> std::result::Result<Box<dyn PendingSnapshotPublish>, SnapshotError> {
        Ok(Box::new(MockPendingSnapshotPublish {
            output_dir: config.output_dir,
        }))
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
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    fn test_snapshot_config(output_dir: PathBuf) -> SnapshotCreateConfig {
        SnapshotCreateConfig {
            id: "test-snapshot".into(),
            binary_path: "/tmp/firecracker".into(),
            kernel_path: "/tmp/kernel".into(),
            rootfs_path: "/tmp/rootfs.ext4".into(),
            output_dir,
            vcpu_count: 2,
            memory_mb: 1024,
        }
    }

    fn test_sandbox_config() -> SandboxConfig {
        SandboxConfig {
            id: sandbox::SandboxId::new_v4(),
            resources: ResourceLimits {
                cpu_count: 2,
                memory_mb: 1024,
            },
        }
    }

    fn capture_output(limit_bytes: u32) -> BoundedExecOutputRequest {
        BoundedExecOutputRequest {
            capture: BoundedExecCapturePolicy::Capture { limit_bytes },
            stream: None,
        }
    }

    fn captured_output(bytes: &[u8], truncated: bool) -> BoundedExecOutput {
        BoundedExecOutput::Captured {
            bytes: bytes.to_vec(),
            truncated,
        }
    }

    fn assert_captured_output(
        output: &BoundedExecOutput,
        expected_bytes: &[u8],
        expected_truncated: bool,
    ) {
        match output {
            BoundedExecOutput::Captured { bytes, truncated } => {
                assert_eq!(bytes, expected_bytes);
                assert_eq!(*truncated, expected_truncated);
            }
            BoundedExecOutput::Discarded => panic!("expected captured output"),
        }
    }

    #[tokio::test]
    async fn snapshot_provider_can_discard_uncommitted_snapshot() {
        let provider = MockSnapshotProvider;
        let output_dir = std::env::temp_dir().join(format!(
            "sandbox-mock-snapshot-discard-{}",
            uuid::Uuid::new_v4().simple()
        ));

        let mut pending = provider
            .create_uncommitted_snapshot(test_snapshot_config(output_dir))
            .await
            .expect("create uncommitted snapshot");

        pending.discard().await.expect("discard pending snapshot");
    }

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
    async fn sandbox_default_bounded_exec_succeeds_and_records_call() {
        let sandbox = MockSandbox::new("test-1");
        let env = [("K", "V")];
        let request = BoundedExecRequest {
            cmd: "echo bounded",
            timeout: Duration::from_secs(5),
            env: &env,
            sudo: true,
            stdin: Some(b"input"),
            stdout: capture_output(100),
            stderr: capture_output(101),
        };

        let result = sandbox.bounded_exec(&request).await.unwrap();

        assert_eq!(
            result.termination,
            BoundedExecTermination::Exited { exit_code: 0 }
        );
        assert_captured_output(&result.stdout, b"", false);
        assert_eq!(
            sandbox.bounded_exec_calls(),
            vec![BoundedExecCall {
                cmd: "echo bounded".to_string(),
                env: vec![("K".to_string(), "V".to_string())],
                sudo: true,
                stdin: Some(b"input".to_vec()),
                stdout: BoundedExecOutputCall {
                    capture: BoundedExecCapturePolicy::Capture { limit_bytes: 100 },
                    stream: None,
                },
                stderr: BoundedExecOutputCall {
                    capture: BoundedExecCapturePolicy::Capture { limit_bytes: 101 },
                    stream: None,
                },
            }]
        );
    }

    #[tokio::test]
    async fn sandbox_queued_bounded_exec_response_emits_stream_events() {
        let sandbox = MockSandbox::new("test-1");
        sandbox.push_bounded_exec_response(BoundedExecResponse {
            events: vec![
                BoundedExecOutputEvent {
                    stream: BoundedExecStream::Stdout,
                    sequence: 7,
                    chunk: b"chunk".to_vec(),
                    truncated: true,
                },
                BoundedExecOutputEvent {
                    stream: BoundedExecStream::Stderr,
                    sequence: 8,
                    chunk: b"ignored".to_vec(),
                    truncated: false,
                },
            ],
            result: Ok(BoundedExecResult {
                termination: BoundedExecTermination::TimedOut,
                duration: Duration::from_millis(25),
                stdout: captured_output(b"final-out", false),
                stderr: captured_output(b"final-err", true),
                diagnostic: None,
            }),
        });

        let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();
        let request = BoundedExecRequest {
            cmd: "timeout",
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            stdin: None,
            stdout: BoundedExecOutputRequest {
                capture: BoundedExecCapturePolicy::Capture { limit_bytes: 100 },
                stream: Some(BoundedExecStreamPolicy {
                    event_tx,
                    limit_bytes: 2048,
                    chunk_limit_bytes: 1024,
                }),
            },
            stderr: BoundedExecOutputRequest {
                capture: BoundedExecCapturePolicy::Capture { limit_bytes: 100 },
                stream: None,
            },
        };

        let result = sandbox.bounded_exec(&request).await.unwrap();

        assert_eq!(result.termination, BoundedExecTermination::TimedOut);
        assert_eq!(result.duration, Duration::from_millis(25));
        assert_captured_output(&result.stdout, b"final-out", false);
        assert_captured_output(&result.stderr, b"final-err", true);
        assert_eq!(
            event_rx.recv().await.unwrap(),
            BoundedExecOutputEvent {
                stream: BoundedExecStream::Stdout,
                sequence: 7,
                chunk: b"chunk".to_vec(),
                truncated: true,
            }
        );
        assert!(matches!(
            event_rx.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
        assert_eq!(
            sandbox.bounded_exec_calls(),
            vec![BoundedExecCall {
                cmd: "timeout".to_string(),
                env: vec![],
                sudo: false,
                stdin: None,
                stdout: BoundedExecOutputCall {
                    capture: BoundedExecCapturePolicy::Capture { limit_bytes: 100 },
                    stream: Some(BoundedExecStreamCall {
                        limit_bytes: 2048,
                        chunk_limit_bytes: 1024,
                    }),
                },
                stderr: BoundedExecOutputCall {
                    capture: BoundedExecCapturePolicy::Capture { limit_bytes: 100 },
                    stream: None,
                },
            }]
        );
    }

    #[tokio::test]
    async fn overrides_queue_bounded_exec_responses_across_factory_sandboxes() {
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.push_bounded_exec_response(BoundedExecResponse {
            events: vec![],
            result: Ok(BoundedExecResult {
                termination: BoundedExecTermination::Exited { exit_code: 42 },
                duration: Duration::from_millis(10),
                stdout: captured_output(b"shared", false),
                stderr: captured_output(b"", false),
                diagnostic: None,
            }),
        });
        let mut factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        factory.startup().await.unwrap();

        let first = factory.create(test_sandbox_config()).await.unwrap();
        let second = factory.create(test_sandbox_config()).await.unwrap();
        let request = BoundedExecRequest {
            cmd: "shared",
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            stdin: None,
            stdout: capture_output(100),
            stderr: capture_output(100),
        };

        let queued = first.bounded_exec(&request).await.unwrap();
        let fallback = second.bounded_exec(&request).await.unwrap();

        assert_eq!(
            queued.termination,
            BoundedExecTermination::Exited { exit_code: 42 }
        );
        assert_captured_output(&queued.stdout, b"shared", false);
        assert_eq!(
            fallback.termination,
            BoundedExecTermination::Exited { exit_code: 0 }
        );
        assert_eq!(overrides.bounded_exec_calls().len(), 2);
    }

    #[tokio::test]
    async fn overrides_match_bounded_exec_response_by_command() {
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.add_bounded_exec_matcher(BoundedExecMatcher {
            pattern: "cat /tmp/vm0-session-".into(),
            response: BoundedExecResponse {
                events: vec![],
                result: Ok(BoundedExecResult {
                    termination: BoundedExecTermination::Exited { exit_code: 0 },
                    duration: Duration::from_millis(10),
                    stdout: captured_output(b"sess-1", false),
                    stderr: captured_output(b"", false),
                    diagnostic: None,
                }),
            },
        });
        let mut factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        factory.startup().await.unwrap();

        let sandbox = factory.create(test_sandbox_config()).await.unwrap();
        let setup_request = BoundedExecRequest {
            cmd: "date -s @0",
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: true,
            stdin: None,
            stdout: capture_output(100),
            stderr: capture_output(100),
        };
        let session_request = BoundedExecRequest {
            cmd: "cat /tmp/vm0-session-run.txt 2>/dev/null",
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
            stdin: None,
            stdout: capture_output(100),
            stderr: capture_output(100),
        };

        let setup = sandbox.bounded_exec(&setup_request).await.unwrap();
        let matched = sandbox.bounded_exec(&session_request).await.unwrap();
        let fallback = sandbox.bounded_exec(&session_request).await.unwrap();

        assert_eq!(
            setup.termination,
            BoundedExecTermination::Exited { exit_code: 0 }
        );
        assert_captured_output(&setup.stdout, b"", false);
        assert_captured_output(&matched.stdout, b"sess-1", false);
        assert_captured_output(&fallback.stdout, b"", false);
        assert_eq!(overrides.bounded_exec_calls().len(), 3);
    }

    #[tokio::test]
    async fn snapshot_provider_default_create_snapshot_commits_pending_publish() {
        let provider = MockSnapshotProvider;
        let output_dir = std::env::temp_dir().join(format!(
            "sandbox-mock-snapshot-{}",
            uuid::Uuid::new_v4().simple()
        ));

        let output = provider
            .create_snapshot(SnapshotCreateConfig {
                id: "snapshot-test".into(),
                binary_path: "/tmp/firecracker".into(),
                kernel_path: "/tmp/kernel".into(),
                rootfs_path: "/tmp/rootfs.ext4".into(),
                output_dir: output_dir.clone(),
                vcpu_count: 1,
                memory_mb: 128,
            })
            .await
            .expect("create snapshot");

        assert_eq!(output.snapshot_path, output_dir.join("snapshot.bin"));
        assert_eq!(output.memory_path, output_dir.join("memory.bin"));
        assert_eq!(output.cow_path, output_dir.join("cow.img"));
    }

    struct FailingPendingSnapshotPublish {
        discarded: Arc<AtomicBool>,
    }

    #[async_trait]
    impl PendingSnapshotPublish for FailingPendingSnapshotPublish {
        async fn commit(&mut self) -> std::result::Result<SnapshotOutput, SnapshotError> {
            Err(SnapshotError::Teardown("commit failed".into()))
        }

        async fn discard(&mut self) -> std::result::Result<(), SnapshotError> {
            self.discarded.store(true, Ordering::SeqCst);
            Ok(())
        }
    }

    struct FailingSnapshotProvider {
        discarded: Arc<AtomicBool>,
    }

    #[async_trait]
    impl SnapshotProvider for FailingSnapshotProvider {
        async fn create_uncommitted_snapshot(
            &self,
            _config: SnapshotCreateConfig,
        ) -> std::result::Result<Box<dyn PendingSnapshotPublish>, SnapshotError> {
            Ok(Box::new(FailingPendingSnapshotPublish {
                discarded: Arc::clone(&self.discarded),
            }))
        }

        fn config_hash(&self) -> String {
            "failing-snapshot-config-hash".into()
        }

        async fn is_complete(
            &self,
            _output_dir: &std::path::Path,
        ) -> std::result::Result<bool, SnapshotError> {
            Ok(false)
        }
    }

    #[tokio::test]
    async fn snapshot_provider_default_create_snapshot_discards_after_commit_failure() {
        let discarded = Arc::new(AtomicBool::new(false));
        let provider = FailingSnapshotProvider {
            discarded: Arc::clone(&discarded),
        };
        let output_dir = std::env::temp_dir().join(format!(
            "sandbox-mock-snapshot-failure-{}",
            uuid::Uuid::new_v4().simple()
        ));

        let err = provider
            .create_snapshot(test_snapshot_config(output_dir))
            .await
            .expect_err("commit should fail");

        assert!(
            matches!(err, SnapshotError::Teardown(ref message) if message == "commit failed"),
            "got: {err:?}"
        );
        assert!(
            discarded.load(Ordering::SeqCst),
            "default create_snapshot should discard after commit failure"
        );
    }

    #[tokio::test]
    async fn sandbox_queued_exec_results() {
        let sandbox = MockSandbox::new("test-1");
        sandbox.push_exec_result(Ok(ExecResult {
            exit_code: 42,
            stdout: b"out".to_vec(),
            stderr: b"err".to_vec(),
        }));
        sandbox.push_exec_result(Err(SandboxError::Operation {
            operation: SandboxOperation::Exec,
            reason: SandboxOperationReason::Guest,
            message: "boom".into(),
        }));

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
    async fn overrides_count_park_and_unpark_calls_across_factory_sandboxes() {
        let overrides = Arc::new(MockSandboxOverrides::new());
        let mut factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        factory.startup().await.unwrap();

        let mut first = factory.create(test_sandbox_config()).await.unwrap();
        let mut second = factory.create(test_sandbox_config()).await.unwrap();

        first.park().await.unwrap();
        first.park().await.unwrap();
        second.park().await.unwrap();

        first.unpark().await.unwrap();
        second.unpark().await.unwrap();

        assert_eq!(overrides.park_call_count(), 3);
        assert_eq!(overrides.unpark_call_count(), 2);
    }

    #[tokio::test]
    async fn overrides_count_destroy_calls_across_factory_sandboxes() {
        let overrides = Arc::new(MockSandboxOverrides::new());
        let mut factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        factory.startup().await.unwrap();

        let first = factory.create(test_sandbox_config()).await.unwrap();
        let second = factory.create(test_sandbox_config()).await.unwrap();

        factory.destroy(first).await;
        factory.destroy(second).await;

        assert_eq!(overrides.destroy_call_count(), 2);
    }

    #[tokio::test]
    async fn overrides_record_spawn_watch_output_modes_in_order() {
        let overrides = Arc::new(MockSandboxOverrides::new());
        let mut factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        factory.startup().await.unwrap();
        let sandbox = factory.create(test_sandbox_config()).await.unwrap();
        let request = ExecRequest {
            cmd: "agent",
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
        };

        let buffered = sandbox
            .spawn_watch(&request, SpawnOutputMode::Buffered)
            .await
            .unwrap();
        assert!(buffered.stdout_rx.is_none());

        let streamed = sandbox
            .spawn_watch(
                &request,
                SpawnOutputMode::Stream {
                    guest_log_path: None,
                },
            )
            .await
            .unwrap();
        assert!(streamed.stdout_rx.is_some());

        let tee = sandbox
            .spawn_watch(
                &request,
                SpawnOutputMode::Stream {
                    guest_log_path: Some("/tmp/guest.log"),
                },
            )
            .await
            .unwrap();
        assert!(tee.stdout_rx.is_some());

        assert_eq!(
            overrides.spawn_watch_calls(),
            vec![
                SpawnWatchCall {
                    streams_stdout: false,
                    guest_log_path: None,
                },
                SpawnWatchCall {
                    streams_stdout: true,
                    guest_log_path: None,
                },
                SpawnWatchCall {
                    streams_stdout: true,
                    guest_log_path: Some("/tmp/guest.log".to_string()),
                },
            ]
        );
    }

    #[tokio::test]
    async fn factory_creates_sandbox() {
        let mut factory = MockSandboxFactory::new();
        factory.startup().await.unwrap();
        let sandbox = factory.create(test_sandbox_config()).await.unwrap();
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
    async fn factory_create_queued_error() {
        let mut factory = MockSandboxFactory::new();
        factory.startup().await.unwrap();
        factory.push_create_result(Err(SandboxError::Initialization {
            phase: SandboxInitializationPhase::SandboxAllocation,
            message: "out of resources".into(),
        }));

        let result = factory.create(test_sandbox_config()).await;
        assert!(result.is_err());

        // Next create falls back to default success.
        factory.create(test_sandbox_config()).await.unwrap();
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
