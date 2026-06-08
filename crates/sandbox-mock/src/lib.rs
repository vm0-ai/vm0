//! Mock implementations of all sandbox traits for testing.
//!
//! All mocks succeed by default with exit code 0 and empty output.
//! Use [`MockSandbox::push_exec_result`], [`MockSandbox::push_write_file_result`],
//! [`MockSandboxControl::push_exec_remote_result`], or
//! [`MockSandboxControl::push_kill_remote_result`] to queue custom responses
//! consumed in FIFO order.
//!
//! For advanced control, create [`MockSandboxOverrides`] and pass it via
//! [`MockSandboxRuntime::with_overrides`]. This enables pattern-matched exec
//! results, shared read-file results, shared lifecycle behavior queues, custom
//! `wait_process` exits, and durable [`MockLifecycleGate`] gates for lifecycle
//! and cancellation testing.
//!
//! ```toml
//! [dev-dependencies]
//! sandbox-mock = { workspace = true }
//! ```

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
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

/// Captured `exec` request fields recorded for test assertions.
///
/// The record intentionally keeps environment variable names but not their
/// values. Stdin bytes and output limits are captured because downstream tests
/// assert those request properties directly.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecCall {
    /// Command string passed to `ExecRequest.cmd`.
    pub cmd: String,
    /// Timeout passed to `ExecRequest.timeout`.
    pub timeout: Duration,
    /// Environment variable names from `ExecRequest.env`.
    ///
    /// Environment values are not recorded in this field.
    pub env_keys: Vec<String>,
    /// Whether the exec request was made with sudo privileges.
    pub sudo: bool,
    /// Stdin bytes supplied to the exec request, when present.
    pub stdin_bytes: Option<Vec<u8>>,
    /// Output limits supplied to the exec request.
    pub output_limits: ExecOutputLimits,
}

/// Captured `start_process` request fields recorded for test assertions.
///
/// Unlike [`ExecCall`], this record captures environment values as well as
/// names because tests use it to assert guest-agent bootstrap environment
/// construction.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StartProcessCall {
    /// Command string passed to `StartProcessRequest.cmd`.
    pub cmd: String,
    /// Timeout passed to `StartProcessRequest.timeout`.
    pub timeout: Duration,
    /// Environment variable names and values from `StartProcessRequest.env`.
    pub env: Vec<(String, String)>,
    /// Whether the process request was made with sudo privileges.
    pub sudo: bool,
    /// Output mode requested for the guest process.
    pub output: ProcessOutputMode,
    /// Control mode requested for the guest process.
    pub control: ProcessControlMode,
}

/// Captured process-cancel request fields recorded for test assertions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessCancelCall {
    /// Timeout supplied to the process cancel handle.
    pub timeout: Duration,
}

/// Captured `write_file` request fields recorded for test assertions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WriteFileCall {
    /// Guest path passed to `write_file`.
    pub path: String,
    /// Content bytes passed to `write_file`.
    pub content: Vec<u8>,
}

/// Captured `read_file` request fields recorded for test assertions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReadFileCall {
    /// Guest path passed to `read_file`.
    pub path: String,
    /// Maximum byte count passed to `read_file`.
    pub max_bytes: u64,
}

/// Captured `copy_file` request fields recorded for test assertions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CopyFileCall {
    /// Guest path requested as the copy source.
    pub path: String,
    /// Host path requested as the copy destination.
    pub host_path: PathBuf,
    /// Maximum byte count requested for the copy.
    pub max_bytes: u64,
    /// Timeout requested for the copy operation.
    pub timeout: Duration,
    /// Whether a missing guest source should be accepted as a no-op.
    pub missing_ok: bool,
}

enum LifecycleBehavior {
    Result(Result<()>),
    Panic(String),
}

impl LifecycleBehavior {
    fn into_result(self) -> Result<()> {
        match self {
            Self::Result(result) => result,
            #[allow(clippy::panic)]
            Self::Panic(message) => panic!("{message}"),
        }
    }
}

#[derive(Default)]
struct LifecycleBehaviors {
    queue: Mutex<VecDeque<LifecycleBehavior>>,
}

impl LifecycleBehaviors {
    fn push_result(&self, result: Result<()>) {
        self.queue
            .lock_ignoring_poison()
            .push_back(LifecycleBehavior::Result(result));
    }

    fn push_panic(&self, message: impl Into<String>) {
        self.queue
            .lock_ignoring_poison()
            .push_back(LifecycleBehavior::Panic(message.into()));
    }

    fn next_result(&self) -> Result<()> {
        let behavior = self.queue.lock_ignoring_poison().pop_front();
        behavior.map_or(Ok(()), LifecycleBehavior::into_result)
    }
}

enum DestroyBehavior {
    Panic(String),
}

/// Error returned when a [`MockLifecycleGate`] does not record enough entries
/// before the caller's timeout expires.
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub struct MockLifecycleGateTimeout {
    target_count: u64,
    actual_count: u64,
    timeout: Duration,
}

impl MockLifecycleGateTimeout {
    /// Entry count that the caller was waiting for.
    pub fn target_count(&self) -> u64 {
        self.target_count
    }

    /// Entry count observed when the timeout expired.
    pub fn actual_count(&self) -> u64 {
        self.actual_count
    }

    /// Timeout used by the wait operation.
    pub fn timeout(&self) -> Duration {
        self.timeout
    }
}

impl std::fmt::Display for MockLifecycleGateTimeout {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "mock lifecycle gate did not reach entry count {} within {:?} (actual: {})",
            self.target_count, self.timeout, self.actual_count
        )
    }
}

impl std::error::Error for MockLifecycleGateTimeout {}

struct MockLifecycleGateInner {
    state: Mutex<MockLifecycleGateState>,
    entered_tx: tokio::sync::watch::Sender<u64>,
    release_tx: tokio::sync::watch::Sender<u64>,
}

struct MockLifecycleGateState {
    entered_count: u64,
    released_count: u64,
}

/// Durable lifecycle gate for tests that need to block mock sandbox lifecycle
/// operations at deterministic points.
///
/// Unlike raw [`tokio::sync::Notify`] pairs, entries and releases are counted
/// durably. A test can wait for an entry after it has already happened, and a
/// release issued before the lifecycle operation blocks is consumed by that
/// entry instead of being lost. Releases advance entry tickets, so a cancelled
/// entry still consumes its ticket instead of transferring that release to a
/// later lifecycle operation.
#[derive(Clone)]
pub struct MockLifecycleGate {
    inner: Arc<MockLifecycleGateInner>,
}

impl MockLifecycleGate {
    /// Create a gate with zero recorded entries and no releases.
    pub fn new() -> Self {
        let (entered_tx, _) = tokio::sync::watch::channel(0);
        let (release_tx, _) = tokio::sync::watch::channel(0);
        Self {
            inner: Arc::new(MockLifecycleGateInner {
                state: Mutex::new(MockLifecycleGateState {
                    entered_count: 0,
                    released_count: 0,
                }),
                entered_tx,
                release_tx,
            }),
        }
    }

    /// Return the number of lifecycle entries recorded by this gate.
    pub fn entered_count(&self) -> u64 {
        self.inner.state.lock_ignoring_poison().entered_count
    }

    /// Wait until at least `target_count` lifecycle entries have been recorded.
    pub async fn wait_entered(
        &self,
        target_count: u64,
        timeout: Duration,
    ) -> std::result::Result<u64, MockLifecycleGateTimeout> {
        let gate = self.clone();
        let wait = async move {
            let mut entered_rx = gate.inner.entered_tx.subscribe();
            loop {
                let current = *entered_rx.borrow_and_update();
                if current >= target_count {
                    return current;
                }
                if entered_rx.changed().await.is_err() {
                    // The waiter owns a gate clone, so sender closure should not
                    // happen. Let the outer timeout report failure instead of
                    // returning a below-target count as success.
                    return std::future::pending().await;
                }
            }
        };

        tokio::time::timeout(timeout, wait)
            .await
            .map_err(|_| MockLifecycleGateTimeout {
                target_count,
                actual_count: self.entered_count(),
                timeout,
            })
    }

    /// Release the next lifecycle entry ticket.
    pub fn release_one(&self) {
        self.release_many(1);
    }

    /// Release `count` lifecycle entry tickets by advancing the durable
    /// release count.
    ///
    /// Cancelled entries still occupy tickets. If a blocked lifecycle future is
    /// cancelled, a later release advances past that cancelled ticket instead of
    /// being reused by a future entry.
    pub fn release_many(&self, count: usize) {
        let release_count = u64::try_from(count).unwrap_or(u64::MAX);
        if release_count == 0 {
            return;
        }

        let mut state = self.inner.state.lock_ignoring_poison();
        state.released_count = state.released_count.saturating_add(release_count);
        self.inner.release_tx.send_replace(state.released_count);
    }

    async fn enter_and_wait(&self) {
        let ticket = {
            let mut state = self.inner.state.lock_ignoring_poison();
            state.entered_count = state.entered_count.saturating_add(1);
            self.inner.entered_tx.send_replace(state.entered_count);
            state.entered_count
        };
        let mut release_rx = self.inner.release_tx.subscribe();
        loop {
            let released_count = *release_rx.borrow_and_update();
            if released_count >= ticket {
                return;
            }
            if release_rx.changed().await.is_err() {
                // The waiter owns a gate clone, so sender closure should not
                // happen. Keep waiting rather than letting this entry through.
                std::future::pending::<()>().await;
            }
        }
    }
}

impl Default for MockLifecycleGate {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone)]
enum BlockingGate {
    LegacyNotify {
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    },
    Lifecycle(MockLifecycleGate),
}

/// Shared behavior overrides propagated from runtime → factory → sandbox.
///
/// Tests create this via [`MockSandboxRuntime::with_overrides`] so every
/// sandbox produced by the factory can share queued behavior and call
/// observations. Queue fields on this type are shared globally by every
/// factory and sandbox that receives the same `Arc<MockSandboxOverrides>`.
///
/// Accessors on this type return shared observation snapshots across that
/// override set. Sandbox-local observations remain available through
/// [`MockSandbox`] accessors.
pub struct MockSandboxOverrides {
    /// Pattern-matched exec results. First matching pattern wins and is
    /// consumed (one-shot).
    exec_matchers: Mutex<Vec<ExecMatcher>>,
    /// Recorded exec calls across all sandboxes built from this override set.
    exec_calls: Mutex<Vec<ExecCall>>,
    /// Recorded write_file calls across all sandboxes built from this override set.
    write_file_calls: Mutex<Vec<WriteFileCall>>,
    /// FIFO queue of read_file results consumed by factory-created sandboxes.
    read_file_results: Mutex<VecDeque<Result<Option<Vec<u8>>>>>,
    /// When `Some`, `wait_process` returns this exit code instead of 0.
    wait_process_code: Option<i32>,
    /// When set, `wait_process` awaits this [`tokio::sync::Notify`] before
    /// returning — giving the test a window to cancel the job.
    wait_process_gate: Option<Arc<tokio::sync::Notify>>,
    /// Optional durable gate that records and blocks every `wait_process`
    /// entry until released.
    wait_process_lifecycle_gate: Mutex<Option<MockLifecycleGate>>,
    /// When `Some`, `wait_process` returns a wait-process operation error to
    /// simulate timeout or crash. The stdout channel sender is also kept alive
    /// in `MockSandbox` so the drain task would block without the fix.
    wait_process_error: Option<String>,
    /// FIFO queue of full wait_process exits consumed by factory-created
    /// sandboxes. Empty queue follows the existing default/override behavior.
    wait_process_exits: Mutex<VecDeque<ProcessExit>>,
    /// FIFO queue of create results consumed by every factory built with
    /// these overrides. Empty queue → default Ok(()).
    create_results: Mutex<VecDeque<Result<()>>>,
    /// Sandbox create configs observed across factories built with these overrides.
    create_configs: Mutex<Vec<SandboxConfig>>,
    /// FIFO queue of start results consumed by every sandbox built with
    /// these overrides. Empty queue → default Ok(()).
    start_results: Mutex<VecDeque<Result<()>>>,
    /// FIFO queue of stop behaviours consumed by every sandbox built with
    /// these overrides. Empty queue → default Ok(()).
    stop_behaviors: LifecycleBehaviors,
    /// FIFO queue of park results consumed by every sandbox built with
    /// these overrides. Empty queue → default Ok(()).
    park_behaviors: LifecycleBehaviors,
    /// Optional gate that records and blocks every `park()` entry until released.
    park_gate: Mutex<Option<BlockingGate>>,
    /// FIFO queue of unpark results consumed by every sandbox built with
    /// these overrides. Empty queue → default Ok(()).
    unpark_behaviors: LifecycleBehaviors,
    /// Optional gate that records and blocks every factory `destroy()` entry
    /// until released.
    destroy_gate: Mutex<Option<BlockingGate>>,
    /// FIFO queue of destroy behaviours consumed by every factory built with
    /// these overrides. Empty queue → default successful destroy.
    destroy_behaviors: Mutex<VecDeque<DestroyBehavior>>,
    /// Recorded start_process output modes across all sandboxes built from
    /// this override set.
    start_process_calls: Mutex<Vec<StartProcessCall>>,
    /// FIFO queue of stdout chunk batches emitted by factory-created
    /// sandboxes during streaming start_process calls.
    start_process_stdout_chunks: Mutex<VecDeque<Vec<ProcessOutputChunk>>>,
    /// Whether factory-created sandboxes expose a process cancel handle.
    process_cancel_supported: Mutex<bool>,
    /// Recorded process cancel calls across all sandboxes built from this
    /// override set.
    process_cancel_calls: Mutex<Vec<ProcessCancelCall>>,
    /// Wakes tests waiting for process cancel calls to be recorded.
    process_cancel_notify: tokio::sync::Notify,
    /// FIFO queue of process cancel errors consumed by cancel handles.
    process_cancel_errors: Mutex<VecDeque<String>>,
    /// Whether a successful process cancel releases the configured
    /// `wait_process` gate. Tests can disable this to exercise bounded wait
    /// timeout paths after cancel is sent.
    process_cancel_releases_wait_gate: Mutex<bool>,
    /// Total `park()` calls across all sandboxes built from this override set.
    park_calls: Mutex<u32>,
    /// Total `unpark()` calls across all sandboxes built from this override set.
    unpark_calls: Mutex<u32>,
    /// Total factory `destroy()` calls across all factories built from this
    /// override set.
    destroy_calls: Mutex<u32>,
}

impl MockSandboxOverrides {
    /// Create an override set with empty shared queues and observations.
    ///
    /// Sandboxes and factories only share this state after the same instance is
    /// passed through [`MockSandboxRuntime::with_overrides`] or
    /// [`MockSandboxFactory::with_overrides`].
    pub fn new() -> Self {
        Self {
            exec_matchers: Mutex::new(Vec::new()),
            exec_calls: Mutex::new(Vec::new()),
            write_file_calls: Mutex::new(Vec::new()),
            read_file_results: Mutex::new(VecDeque::new()),
            wait_process_code: None,
            wait_process_gate: None,
            wait_process_lifecycle_gate: Mutex::new(None),
            wait_process_error: None,
            wait_process_exits: Mutex::new(VecDeque::new()),
            create_results: Mutex::new(VecDeque::new()),
            create_configs: Mutex::new(Vec::new()),
            start_results: Mutex::new(VecDeque::new()),
            stop_behaviors: LifecycleBehaviors::default(),
            park_behaviors: LifecycleBehaviors::default(),
            park_gate: Mutex::new(None),
            unpark_behaviors: LifecycleBehaviors::default(),
            destroy_gate: Mutex::new(None),
            destroy_behaviors: Mutex::new(VecDeque::new()),
            start_process_calls: Mutex::new(Vec::new()),
            start_process_stdout_chunks: Mutex::new(VecDeque::new()),
            process_cancel_supported: Mutex::new(true),
            process_cancel_calls: Mutex::new(Vec::new()),
            process_cancel_notify: tokio::sync::Notify::new(),
            process_cancel_errors: Mutex::new(VecDeque::new()),
            process_cancel_releases_wait_gate: Mutex::new(true),
            park_calls: Mutex::new(0),
            unpark_calls: Mutex::new(0),
            destroy_calls: Mutex::new(0),
        }
    }

    /// Create overrides that make `wait_process` return a custom exit code.
    pub fn with_wait_process_code(code: i32) -> Self {
        Self {
            wait_process_code: Some(code),
            ..Self::new()
        }
    }

    /// Create overrides that block `wait_process` until the gate is notified.
    pub fn with_wait_process_gate(gate: Arc<tokio::sync::Notify>) -> Self {
        Self {
            wait_process_gate: Some(gate),
            ..Self::new()
        }
    }

    /// Block every `wait_process` call with a durable lifecycle gate.
    ///
    /// Prefer this over [`Self::with_wait_process_gate`]: entries and releases
    /// are durable, so tests do not need to pre-arm `Notify` futures.
    pub fn set_wait_process_lifecycle_gate(&self, gate: MockLifecycleGate) {
        *self.wait_process_lifecycle_gate.lock_ignoring_poison() = Some(gate);
    }

    /// Remove the durable `wait_process` gate for future wait calls.
    ///
    /// Already-entered wait calls keep waiting on their cloned gate until the
    /// test releases it.
    pub fn clear_wait_process_lifecycle_gate(&self) {
        *self.wait_process_lifecycle_gate.lock_ignoring_poison() = None;
    }

    /// Create overrides that make `wait_process` return an error (simulating
    /// timeout or crash). The stdout channel sender is kept alive so the
    /// drain task blocks unless the caller aborts it.
    pub fn with_wait_process_error(msg: impl Into<String>) -> Self {
        Self {
            wait_process_error: Some(msg.into()),
            ..Self::new()
        }
    }

    /// Queue a full `wait_process` exit applied to the next matching wait call.
    /// Consumed FIFO across all sandboxes; empty queue follows the existing
    /// default/override behavior.
    pub fn push_wait_process_exit(&self, exit: ProcessExit) {
        self.wait_process_exits
            .lock_ignoring_poison()
            .push_back(exit);
    }

    /// Register a pattern matcher consumed on first match.
    pub fn add_exec_matcher(&self, matcher: ExecMatcher) {
        self.exec_matchers.lock_ignoring_poison().push(matcher);
    }

    /// Return recorded exec calls across all sandboxes built from this
    /// override set.
    ///
    /// The returned vector is a cloned snapshot in recorded order. Each record
    /// is captured before exec matchers or queued exec results are consumed.
    pub fn exec_calls(&self) -> Vec<ExecCall> {
        self.exec_calls.lock_ignoring_poison().clone()
    }

    /// Return recorded write-file calls across all sandboxes built from this
    /// override set.
    ///
    /// The returned vector is a cloned snapshot in recorded order. Shared
    /// overrides observe these calls but do not provide a shared write-file
    /// result queue.
    pub fn write_file_calls(&self) -> Vec<WriteFileCall> {
        self.write_file_calls.lock_ignoring_poison().clone()
    }

    /// Queue a read_file result applied to the next read made through any
    /// sandbox built from these overrides after that sandbox's local read queue
    /// is empty.
    pub fn push_read_file_result(&self, result: Result<Option<Vec<u8>>>) {
        self.read_file_results
            .lock_ignoring_poison()
            .push_back(result);
    }

    /// Queue a factory `create()` result applied to the next factory create
    /// call made through these overrides. Consumed FIFO across all factories;
    /// empty queue → default Ok(()).
    pub fn push_create_result(&self, result: Result<()>) {
        self.create_results.lock_ignoring_poison().push_back(result);
    }

    /// Return sandbox create configs observed by factories using this override
    /// set.
    ///
    /// The returned vector is a cloned snapshot in recorded order. A create
    /// config is recorded before factory-local or shared queued create errors
    /// are returned.
    pub fn create_configs(&self) -> Vec<SandboxConfig> {
        self.create_configs.lock_ignoring_poison().clone()
    }

    /// Queue a `start()` result applied to the next factory-created sandbox.
    /// Consumed FIFO across all sandboxes; empty queue → default Ok(()).
    pub fn push_start_result(&self, result: Result<()>) {
        self.start_results.lock_ignoring_poison().push_back(result);
    }

    /// Queue a `stop()` result applied to the next factory-created sandbox.
    /// Consumed FIFO across all sandboxes; empty queue → default Ok(()).
    pub fn push_stop_result(&self, result: Result<()>) {
        self.stop_behaviors.push_result(result);
    }

    /// Queue a `stop()` panic applied to the next factory-created sandbox.
    /// Used by runner tests to exercise panic-safe cleanup boundaries.
    pub fn push_stop_panic(&self, message: impl Into<String>) {
        self.stop_behaviors.push_panic(message);
    }

    /// Queue a `park()` result applied to the next factory-created sandbox.
    /// Consumed FIFO across all sandboxes; empty queue → default Ok(()).
    pub fn push_park_result(&self, result: Result<()>) {
        self.park_behaviors.push_result(result);
    }

    /// Queue a `park()` panic applied to the next factory-created sandbox.
    /// Used by runner tests to exercise panic-safe cleanup boundaries.
    pub fn push_park_panic(&self, message: impl Into<String>) {
        self.park_behaviors.push_panic(message);
    }

    /// Block every `park()` call with a durable lifecycle gate.
    ///
    /// Prefer this over [`Self::set_park_gate`]: entries and releases are
    /// durable, so tests do not need to pre-arm `Notify` futures.
    pub fn set_park_lifecycle_gate(&self, gate: MockLifecycleGate) {
        *self.park_gate.lock_ignoring_poison() = Some(BlockingGate::Lifecycle(gate));
    }

    /// Legacy `Notify`-pair park gate.
    ///
    /// New tests should use [`Self::set_park_lifecycle_gate`] because this
    /// edge-triggered API can lose entry or release notifications if the test
    /// does not pre-arm the corresponding `notified()` future.
    pub fn set_park_gate(
        &self,
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    ) {
        *self.park_gate.lock_ignoring_poison() =
            Some(BlockingGate::LegacyNotify { entered, release });
    }

    /// Queue an `unpark()` result applied to the next factory-created sandbox.
    /// Consumed FIFO across all sandboxes; empty queue → default Ok(()).
    pub fn push_unpark_result(&self, result: Result<()>) {
        self.unpark_behaviors.push_result(result);
    }

    /// Queue an `unpark()` panic applied to the next factory-created sandbox.
    /// Used by runner tests to exercise panic-safe cleanup boundaries.
    pub fn push_unpark_panic(&self, message: impl Into<String>) {
        self.unpark_behaviors.push_panic(message);
    }

    /// Block every factory `destroy()` call with a durable lifecycle gate.
    ///
    /// Prefer this over [`Self::set_destroy_gate`]: entries and releases are
    /// durable, so tests do not need to pre-arm `Notify` futures.
    pub fn set_destroy_lifecycle_gate(&self, gate: MockLifecycleGate) {
        *self.destroy_gate.lock_ignoring_poison() = Some(BlockingGate::Lifecycle(gate));
    }

    /// Legacy `Notify`-pair destroy gate.
    ///
    /// New tests should use [`Self::set_destroy_lifecycle_gate`] because this
    /// edge-triggered API can lose entry or release notifications if the test
    /// does not pre-arm the corresponding `notified()` future.
    pub fn set_destroy_gate(
        &self,
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    ) {
        *self.destroy_gate.lock_ignoring_poison() =
            Some(BlockingGate::LegacyNotify { entered, release });
    }

    /// Queue a factory `destroy()` panic applied to the next destroy call made
    /// through these overrides. Consumed FIFO across all factories.
    pub fn push_destroy_panic(&self, message: impl Into<String>) {
        self.destroy_behaviors
            .lock_ignoring_poison()
            .push_back(DestroyBehavior::Panic(message.into()));
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

    /// Return recorded start-process calls across all sandboxes built from this
    /// override set.
    ///
    /// The returned vector is a cloned snapshot in recorded order.
    pub fn start_process_calls(&self) -> Vec<StartProcessCall> {
        self.start_process_calls.lock_ignoring_poison().clone()
    }

    /// Queue stdout chunks emitted by the next streaming `start_process` call.
    /// Consumed FIFO across all sandboxes; empty queue emits no chunks.
    pub fn push_start_process_stdout_chunks(&self, chunks: Vec<ProcessOutputChunk>) {
        self.start_process_stdout_chunks
            .lock_ignoring_poison()
            .push_back(chunks);
    }

    /// Configure `wait_process` to return an error while preserving any other
    /// overrides already set on this instance.
    pub fn set_wait_process_error(&mut self, msg: impl Into<String>) {
        self.wait_process_error = Some(msg.into());
    }

    /// Configure whether future `start_process` handles include a cancel handle.
    pub fn set_process_cancel_supported(&self, supported: bool) {
        *self.process_cancel_supported.lock_ignoring_poison() = supported;
    }

    /// Return recorded process-cancel calls across all sandboxes built from
    /// this override set.
    ///
    /// The returned vector is a cloned snapshot in recorded order. Cancel
    /// attempts are recorded before any queued cancel send error is returned.
    pub fn process_cancel_calls(&self) -> Vec<ProcessCancelCall> {
        self.process_cancel_calls.lock_ignoring_poison().clone()
    }

    /// Wait until at least `expected` process cancel calls have been recorded.
    pub async fn wait_for_process_cancel_calls(&self, expected: usize, timeout: Duration) -> bool {
        tokio::time::timeout(timeout, async {
            loop {
                let notified = self.process_cancel_notify.notified();
                if self.process_cancel_calls.lock_ignoring_poison().len() >= expected {
                    return;
                }
                notified.await;
            }
        })
        .await
        .is_ok()
    }

    /// Queue a process cancel send error consumed by the next cancel handle.
    pub fn push_process_cancel_error(&self, message: impl Into<String>) {
        self.process_cancel_errors
            .lock_ignoring_poison()
            .push_back(message.into());
    }

    /// Configure whether successful process cancellation releases a configured
    /// `wait_process` gate.
    pub fn set_process_cancel_releases_wait_gate(&self, releases: bool) {
        *self
            .process_cancel_releases_wait_gate
            .lock_ignoring_poison() = releases;
    }

    async fn wait_for_wait_process_gate(&self) {
        let lifecycle_gate = {
            self.wait_process_lifecycle_gate
                .lock_ignoring_poison()
                .clone()
        };
        if let Some(gate) = lifecycle_gate {
            gate.enter_and_wait().await;
        } else if let Some(gate) = &self.wait_process_gate {
            gate.notified().await;
        }
    }

    fn release_wait_process_gate(&self) {
        if let Some(gate) = &self.wait_process_gate {
            gate.notify_one();
        }
        if let Some(gate) = self
            .wait_process_lifecycle_gate
            .lock_ignoring_poison()
            .clone()
        {
            gate.release_one();
        }
    }
}

async fn wait_blocking_gate(gate: &Mutex<Option<BlockingGate>>) {
    let gate = gate.lock_ignoring_poison().clone();
    if let Some(gate) = gate {
        match gate {
            BlockingGate::LegacyNotify { entered, release } => {
                entered.notify_waiters();
                release.notified().await;
            }
            BlockingGate::Lifecycle(gate) => gate.enter_and_wait().await,
        }
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

    fn with_overrides(id: impl Into<String>, overrides: Arc<MockSandboxOverrides>) -> Self {
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
    /// recorded before mock validation errors such as zero `max_bytes` are
    /// returned.
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
    /// recorded before mock validation errors such as zero `max_bytes` or zero
    /// timeout are returned. Copy-file calls are sandbox-local; shared
    /// overrides do not expose a copy-file call accessor.
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
}

fn default_exec_result() -> ExecResult {
    ExecResult {
        exit_code: 0,
        stdout: Vec::new(),
        stderr: Vec::new(),
        stdout_truncated: false,
        stderr_truncated: false,
    }
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
        o.start_results
            .lock_ignoring_poison()
            .pop_front()
            .unwrap_or(Ok(()))
    }

    async fn stop(&mut self) -> Result<()> {
        let Some(o) = &self.overrides else {
            return Ok(());
        };
        o.stop_behaviors.next_result()
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
        o.park_behaviors.next_result()
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
        o.unpark_behaviors.next_result()
    }

    async fn exec(&self, request: &ExecRequest<'_>) -> Result<ExecResult> {
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
            overrides.exec_calls.lock_ignoring_poison().push(call);
        }
        // Check pattern matchers before the FIFO queue.
        let result = if let Some(overrides) = &self.overrides {
            let mut matchers = overrides.exec_matchers.lock_ignoring_poison();
            if let Some(idx) = matchers
                .iter()
                .position(|m| request.cmd.contains(&m.pattern))
            {
                let m = matchers.remove(idx);
                Ok(ExecResult {
                    exit_code: m.exit_code,
                    stdout: m.stdout,
                    stderr: m.stderr,
                    stdout_truncated: false,
                    stderr_truncated: false,
                })
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
        self.copy_file_calls
            .lock_ignoring_poison()
            .push(CopyFileCall {
                path: path.to_string(),
                host_path: host_path.to_path_buf(),
                max_bytes: options.max_bytes,
                timeout: options.timeout,
                missing_ok: options.missing_ok,
            });
        if options.max_bytes == 0 {
            return Err(SandboxError::Operation {
                operation: SandboxOperation::CopyFile,
                reason: SandboxOperationReason::Other,
                message: "mock copy_file max_bytes must be positive".into(),
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
            overrides.write_file_calls.lock_ignoring_poison().push(call);
        }
        self.write_file_results
            .lock_ignoring_poison()
            .pop_front()
            .unwrap_or(Ok(()))
    }

    async fn start_process(&self, request: &StartProcessRequest<'_>) -> Result<GuestProcessHandle> {
        validate_start_process_output(request.output)?;
        if let Some(overrides) = &self.overrides {
            overrides
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
            .is_some_and(|o| o.wait_process_error.is_some())
            && let Some(tx) = tx.take()
        {
            *self.stdout_tx.lock_ignoring_poison() = Some(tx);
        }
        let control = (request.control == ProcessControlMode::Enabled).then(|| {
            GuestProcessControlHandle::new(|message_id, _payload, _timeout| {
                Box::pin(async move { Ok(ProcessControlAck { message_id }) })
            })
        });
        let process_cancel = self.overrides.as_ref().and_then(|overrides| {
            if !*overrides.process_cancel_supported.lock_ignoring_poison() {
                return None;
            }
            let overrides = Arc::clone(overrides);
            Some(GuestProcessCancelHandle::new(move |timeout| {
                Box::pin(async move {
                    overrides
                        .process_cancel_calls
                        .lock_ignoring_poison()
                        .push(ProcessCancelCall { timeout });
                    overrides.process_cancel_notify.notify_waiters();
                    if let Some(message) = overrides
                        .process_cancel_errors
                        .lock_ignoring_poison()
                        .pop_front()
                    {
                        return Err(std::io::Error::other(message));
                    }
                    if *overrides
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
        _timeout: Duration,
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
            // Block until the test signals (gives a window for cancellation).
            overrides.wait_for_wait_process_gate().await;
            // Return error when configured (simulates timeout or crash).
            if let Some(ref msg) = overrides.wait_process_error {
                return Err(SandboxError::Operation {
                    operation: SandboxOperation::WaitProcess,
                    reason: SandboxOperationReason::Timeout,
                    message: msg.clone(),
                });
            }
            // Return override exit code when configured.
            if let Some(code) = overrides.wait_process_code {
                return Ok(ProcessExit::new(handle.pid, code, Vec::new(), Vec::new()));
            }
            if let Some(exit) = overrides
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

// ---------------------------------------------------------------------------
// MockSandboxFactory
// ---------------------------------------------------------------------------

/// A mock [`SandboxFactory`] that creates [`MockSandbox`] instances.
///
/// Queue custom `create` results with [`push_create_result`](Self::push_create_result).
/// When the factory-local queue is empty, `create` checks shared
/// [`MockSandboxOverrides`] create results. When both queues are empty,
/// `create` returns a default `MockSandbox`.
///
/// Factories built with shared overrides record create configs in that override
/// set and pass the same overrides to every sandbox they create.
pub struct MockSandboxFactory {
    create_results: Mutex<VecDeque<Result<()>>>,
    overrides: Option<Arc<MockSandboxOverrides>>,
}

impl MockSandboxFactory {
    /// Create a factory without shared overrides.
    ///
    /// Sandboxes produced by this factory keep only sandbox-local queues and
    /// observations.
    pub fn new() -> Self {
        Self {
            create_results: Mutex::new(VecDeque::new()),
            overrides: None,
        }
    }

    /// Create a factory that shares one override set across all created
    /// sandboxes.
    ///
    /// Create configs and selected sandbox calls are recorded on the supplied
    /// [`MockSandboxOverrides`] instance.
    pub fn with_overrides(overrides: Arc<MockSandboxOverrides>) -> Self {
        Self {
            create_results: Mutex::new(VecDeque::new()),
            overrides: Some(overrides),
        }
    }

    /// Queue a factory-local create result. `Ok(())` creates a normal
    /// `MockSandbox`; `Err(...)` makes `create` return that error.
    /// Results are consumed in FIFO order before shared override results.
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

    async fn create(&self, config: SandboxConfig) -> Result<Box<dyn Sandbox>> {
        if let Some(overrides) = &self.overrides {
            overrides
                .create_configs
                .lock_ignoring_poison()
                .push(config.clone());
        }
        if let Some(result) = self.create_results.lock_ignoring_poison().pop_front() {
            result?;
        } else if let Some(overrides) = &self.overrides
            && let Some(result) = overrides.create_results.lock_ignoring_poison().pop_front()
        {
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
            match o.destroy_behaviors.lock_ignoring_poison().pop_front() {
                #[allow(clippy::panic)]
                Some(DestroyBehavior::Panic(message)) => panic!("{message}"),
                None => {}
            }
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
    /// Create a runtime whose factories do not share overrides.
    pub fn new() -> Self {
        Self { overrides: None }
    }

    /// Create a runtime that propagates one shared override set to every
    /// factory it creates.
    ///
    /// Factories created by this runtime pass the same overrides to their
    /// sandboxes, so shared queues and observations span the whole runtime.
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
/// Queue custom results with [`push_exec_remote_result`](Self::push_exec_remote_result)
/// or [`push_kill_remote_result`](Self::push_kill_remote_result).
/// When queues are empty, exec returns exit code 0 and kill returns accepted.
pub struct MockSandboxControl {
    base_dir: PathBuf,
    exec_results: Mutex<VecDeque<std::result::Result<RemoteExecResult, SandboxControlError>>>,
    kill_results: Mutex<VecDeque<std::result::Result<RemoteKillResult, SandboxControlError>>>,
    recorded_commands: Mutex<Vec<String>>,
    recorded_kill_ids: Mutex<Vec<String>>,
}

impl MockSandboxControl {
    /// Create a control mock that records remote exec commands and kill ids.
    ///
    /// The `base_dir` is used as the remote exec working directory. Result
    /// queues start empty, so remote exec succeeds with exit code 0 and remote
    /// kill returns accepted by default.
    pub fn new(base_dir: impl Into<PathBuf>) -> Self {
        Self {
            base_dir: base_dir.into(),
            exec_results: Mutex::new(VecDeque::new()),
            kill_results: Mutex::new(VecDeque::new()),
            recorded_commands: Mutex::new(Vec::new()),
            recorded_kill_ids: Mutex::new(Vec::new()),
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

    /// Queue a kill remote result. Results are consumed in FIFO order.
    pub fn push_kill_remote_result(
        &self,
        result: std::result::Result<RemoteKillResult, SandboxControlError>,
    ) {
        self.kill_results.lock_ignoring_poison().push_back(result);
    }

    /// Return every sandbox id passed to `kill_remote`, in call order.
    pub fn recorded_kill_ids(&self) -> Vec<String> {
        self.recorded_kill_ids.lock_ignoring_poison().clone()
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
                    stdout_truncated: false,
                    stderr_truncated: false,
                })
            })
    }

    async fn kill_remote(
        &self,
        sandbox_id: &str,
    ) -> std::result::Result<RemoteKillResult, SandboxControlError> {
        self.recorded_kill_ids
            .lock_ignoring_poison()
            .push(sandbox_id.to_string());
        self.kill_results
            .lock_ignoring_poison()
            .pop_front()
            .unwrap_or(Ok(RemoteKillResult::Accepted))
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
            workspace_disk_mb: 16,
        }
    }

    fn test_sandbox_config() -> SandboxConfig {
        SandboxConfig {
            id: sandbox::SandboxId::new_v4(),
            resources: ResourceLimits {
                cpu_count: 2,
                memory_mb: 1024,
            },
            device_rate_limits: None,
            workspace_drive: None,
        }
    }

    fn test_factory_config() -> FactoryConfig {
        FactoryConfig {
            profile: "test".into(),
            binary_path: "/bin/test".into(),
            kernel_path: "/boot/test".into(),
            rootfs_path: "/rootfs/test".into(),
            base_dir: "/tmp/test".into(),
            snapshot: None,
        }
    }

    fn assert_operation_error(
        error: SandboxError,
        expected_operation: SandboxOperation,
        expected_reason: SandboxOperationReason,
        expected_message: &str,
    ) {
        match error {
            SandboxError::Operation {
                operation,
                reason,
                message,
            } => {
                assert_eq!(operation, expected_operation);
                assert_eq!(reason, expected_reason);
                assert!(message.contains(expected_message), "got: {message}");
            }
            other => panic!("expected operation error, got {other:?}"),
        }
    }

    fn test_timeout() -> Duration {
        Duration::from_secs(5)
    }

    fn lifecycle_gate_released_count(gate: &MockLifecycleGate) -> u64 {
        gate.inner.state.lock_ignoring_poison().released_count
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
                stdin_bytes: None,
                output_limits: EXEC_OUTPUT_LIMIT_1_MIB,
            })
            .await;
        let exec = result.unwrap();
        assert_eq!(exec.exit_code, 0);
        assert!(exec.stdout.is_empty());
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
                workspace_disk_mb: 16,
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
            stdout_truncated: false,
            stderr_truncated: false,
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
            stdin_bytes: None,
            output_limits: EXEC_OUTPUT_LIMIT_1_MIB,
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
    async fn sandbox_copy_file_missing_ok_default_does_not_write_host_file() {
        let sandbox = MockSandbox::new("test-1");
        let path = std::env::temp_dir().join(format!(
            "sandbox-mock-copy-missing-{}",
            uuid::Uuid::new_v4().simple()
        ));

        let result = sandbox
            .copy_file(
                "/tmp/missing.log",
                &path,
                CopyFileOptions {
                    max_bytes: 1024,
                    timeout: Duration::from_secs(5),
                    missing_ok: true,
                },
            )
            .await
            .unwrap();

        assert_eq!(result.bytes_copied, 0);
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn sandbox_copy_file_rejects_queued_bytes_over_max() {
        let sandbox = MockSandbox::new("test-1");
        sandbox.push_copy_file_result(Ok(b"too long".to_vec()));
        let path = std::env::temp_dir().join(format!(
            "sandbox-mock-copy-over-max-{}",
            uuid::Uuid::new_v4().simple()
        ));

        let err = sandbox
            .copy_file(
                "/tmp/system.log",
                &path,
                CopyFileOptions {
                    max_bytes: 3,
                    timeout: Duration::from_secs(5),
                    missing_ok: false,
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
        let path = std::env::temp_dir().join(format!(
            "sandbox-mock-copy-invalid-{}",
            uuid::Uuid::new_v4().simple()
        ));

        let err = sandbox
            .copy_file(
                "/tmp/system.log",
                &path,
                CopyFileOptions {
                    max_bytes: 0,
                    timeout: Duration::from_secs(5),
                    missing_ok: true,
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
        assert!(!path.exists());

        let err = sandbox
            .copy_file(
                "/tmp/system.log",
                &path,
                CopyFileOptions {
                    max_bytes: 1024,
                    timeout: Duration::ZERO,
                    missing_ok: true,
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
        assert!(!path.exists());
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
            .copy_file(
                "/tmp/system.log",
                path,
                CopyFileOptions {
                    max_bytes: 1024,
                    timeout: Duration::from_secs(5),
                    missing_ok: false,
                },
            )
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
    async fn sandbox_read_file_rejects_zero_max_bytes() {
        let sandbox = MockSandbox::new("test-1");

        let err = sandbox.read_file("/tmp/system.log", 0).await.unwrap_err();

        assert_operation_error(
            err,
            SandboxOperation::ReadFile,
            SandboxOperationReason::Other,
            "max_bytes must be positive",
        );
    }

    #[tokio::test]
    async fn sandbox_exec_applies_mock_capture_budget() {
        let sandbox = MockSandbox::new("test-1");
        sandbox.push_exec_result(Ok(ExecResult::new(
            0,
            b"stdout".to_vec(),
            b"stderr".to_vec(),
        )));

        let result = sandbox
            .exec(&ExecRequest {
                cmd: "test",
                timeout: Duration::from_secs(5),
                env: &[],
                sudo: false,
                stdin_bytes: None,
                output_limits: ExecOutputLimits::separate(3, 4),
            })
            .await
            .unwrap();

        assert_eq!(result.stdout, b"std");
        assert!(result.stdout_truncated);
        assert_eq!(result.stderr, b"stde");
        assert!(result.stderr_truncated);
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
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));

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
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));

        let first = factory.create(test_sandbox_config()).await.unwrap();
        let second = factory.create(test_sandbox_config()).await.unwrap();

        factory.destroy(first).await;
        factory.destroy(second).await;

        assert_eq!(overrides.destroy_call_count(), 2);
    }

    #[tokio::test]
    async fn lifecycle_behaviors_are_consumed_fifo_and_default_to_success() {
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.push_stop_result(Err(SandboxError::Start {
            message: "queued stop failure".into(),
        }));
        overrides.push_stop_result(Ok(()));
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let mut sandbox = factory.create(test_sandbox_config()).await.unwrap();

        let err = sandbox
            .stop()
            .await
            .expect_err("first queued stop behavior should fail");
        assert!(err.to_string().contains("queued stop failure"));
        sandbox
            .stop()
            .await
            .expect("second queued stop behavior should succeed");
        sandbox
            .stop()
            .await
            .expect("empty stop behavior queue should default to success");
    }

    #[tokio::test]
    async fn legacy_notify_gates_still_block_lifecycle_until_released() {
        let overrides = Arc::new(MockSandboxOverrides::new());
        let park_entered = Arc::new(tokio::sync::Notify::new());
        let park_release = Arc::new(tokio::sync::Notify::new());
        let destroy_entered = Arc::new(tokio::sync::Notify::new());
        let destroy_release = Arc::new(tokio::sync::Notify::new());
        overrides.set_park_gate(Arc::clone(&park_entered), Arc::clone(&park_release));
        overrides.set_destroy_gate(Arc::clone(&destroy_entered), Arc::clone(&destroy_release));
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));

        let mut sandbox = factory.create(test_sandbox_config()).await.unwrap();
        let park_entered_wait = park_entered.notified();
        tokio::pin!(park_entered_wait);
        park_entered_wait.as_mut().enable();
        let park_task = tokio::spawn(async move { sandbox.park().await });

        tokio::time::timeout(test_timeout(), park_entered_wait)
            .await
            .expect("legacy park gate should report entry");
        assert_eq!(overrides.park_call_count(), 1);
        assert!(
            !park_task.is_finished(),
            "legacy park gate should block until release is notified"
        );
        park_release.notify_one();
        park_task.await.unwrap().unwrap();

        let sandbox = factory.create(test_sandbox_config()).await.unwrap();
        let destroy_entered_wait = destroy_entered.notified();
        tokio::pin!(destroy_entered_wait);
        destroy_entered_wait.as_mut().enable();
        let destroy_task = tokio::spawn(async move {
            factory.destroy(sandbox).await;
        });

        tokio::time::timeout(test_timeout(), destroy_entered_wait)
            .await
            .expect("legacy destroy gate should report entry");
        assert_eq!(overrides.destroy_call_count(), 1);
        assert!(
            !destroy_task.is_finished(),
            "legacy destroy gate should block until release is notified"
        );
        destroy_release.notify_one();
        destroy_task.await.unwrap();
    }

    #[tokio::test]
    async fn lifecycle_gate_observes_park_entry_after_it_already_happened() {
        let gate = MockLifecycleGate::new();
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.set_park_lifecycle_gate(gate.clone());
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let mut sandbox = factory.create(test_sandbox_config()).await.unwrap();

        let park_task = tokio::spawn(async move { sandbox.park().await });
        assert_eq!(gate.wait_entered(1, test_timeout()).await.unwrap(), 1);

        assert_eq!(gate.wait_entered(1, test_timeout()).await.unwrap(), 1);
        assert_eq!(overrides.park_call_count(), 1);

        gate.release_one();
        park_task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn lifecycle_gate_wait_entered_zero_returns_immediately() {
        let gate = MockLifecycleGate::new();

        assert_eq!(gate.wait_entered(0, test_timeout()).await.unwrap(), 0);
        assert_eq!(gate.entered_count(), 0);
    }

    #[tokio::test]
    async fn lifecycle_gate_wait_entered_timeout_reports_observed_count() {
        let gate = MockLifecycleGate::new();
        gate.release_one();
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.set_park_lifecycle_gate(gate.clone());
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let mut sandbox = factory.create(test_sandbox_config()).await.unwrap();

        sandbox.park().await.unwrap();
        let err = gate
            .wait_entered(2, Duration::ZERO)
            .await
            .expect_err("second entry should time out");

        assert_eq!(err.target_count(), 2);
        assert_eq!(err.actual_count(), 1);
        assert_eq!(err.timeout(), Duration::ZERO);
        assert_eq!(gate.entered_count(), 1);
    }

    #[tokio::test]
    async fn lifecycle_gate_wakes_multiple_waiters_for_same_entry() {
        let gate = MockLifecycleGate::new();
        let first_waiter = tokio::spawn({
            let gate = gate.clone();
            async move { gate.wait_entered(1, test_timeout()).await.unwrap() }
        });
        let second_waiter = tokio::spawn({
            let gate = gate.clone();
            async move { gate.wait_entered(1, test_timeout()).await.unwrap() }
        });
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.set_park_lifecycle_gate(gate.clone());
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let mut sandbox = factory.create(test_sandbox_config()).await.unwrap();

        let park_task = tokio::spawn(async move { sandbox.park().await });
        assert_eq!(gate.wait_entered(1, test_timeout()).await.unwrap(), 1);
        assert_eq!(first_waiter.await.unwrap(), 1);
        assert_eq!(second_waiter.await.unwrap(), 1);

        gate.release_one();
        park_task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn lifecycle_gate_release_before_park_entry_is_not_lost() {
        let gate = MockLifecycleGate::new();
        gate.release_one();
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.set_park_lifecycle_gate(gate.clone());
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let mut sandbox = factory.create(test_sandbox_config()).await.unwrap();

        tokio::time::timeout(test_timeout(), sandbox.park())
            .await
            .expect("early release permit should let park finish")
            .unwrap();

        assert_eq!(gate.entered_count(), 1);
        assert_eq!(overrides.park_call_count(), 1);

        let mut next_sandbox = factory.create(test_sandbox_config()).await.unwrap();
        let next_park_task = tokio::spawn(async move { next_sandbox.park().await });
        assert_eq!(gate.wait_entered(2, test_timeout()).await.unwrap(), 2);
        assert!(
            !next_park_task.is_finished(),
            "early release permit should be consumed by only one lifecycle entry"
        );
        gate.release_one();
        next_park_task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn lifecycle_gate_release_zero_does_not_release_entry() {
        let gate = MockLifecycleGate::new();
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.set_park_lifecycle_gate(gate.clone());
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let mut sandbox = factory.create(test_sandbox_config()).await.unwrap();

        let park_task = tokio::spawn(async move { sandbox.park().await });
        assert_eq!(gate.wait_entered(1, test_timeout()).await.unwrap(), 1);

        gate.release_many(0);
        assert_eq!(lifecycle_gate_released_count(&gate), 0);
        assert!(
            !park_task.is_finished(),
            "zero release count must not let the entry through"
        );

        gate.release_one();
        park_task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn lifecycle_gate_early_release_many_releases_only_that_many_entries() {
        let gate = MockLifecycleGate::new();
        gate.release_many(2);
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.set_park_lifecycle_gate(gate.clone());
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let (done_tx, mut done_rx) = tokio::sync::mpsc::unbounded_channel();
        let mut park_tasks = Vec::new();

        for idx in 0..3 {
            let mut sandbox = factory.create(test_sandbox_config()).await.unwrap();
            let done_tx = done_tx.clone();
            park_tasks.push(tokio::spawn(async move {
                sandbox.park().await.unwrap();
                done_tx.send(idx).unwrap();
            }));
        }
        drop(done_tx);

        assert_eq!(gate.wait_entered(3, test_timeout()).await.unwrap(), 3);
        assert_eq!(lifecycle_gate_released_count(&gate), 2);
        for _ in 0..2 {
            tokio::time::timeout(test_timeout(), done_rx.recv())
                .await
                .expect("early releases should complete two entries")
                .expect("completion channel should remain open");
        }
        assert!(
            matches!(
                done_rx.try_recv(),
                Err(tokio::sync::mpsc::error::TryRecvError::Empty)
            ),
            "third entry must remain blocked until another release"
        );

        gate.release_one();
        tokio::time::timeout(test_timeout(), done_rx.recv())
            .await
            .expect("final release should complete third entry")
            .expect("completion channel should remain open");
        for task in park_tasks {
            task.await.unwrap();
        }
    }

    #[tokio::test]
    async fn lifecycle_gate_release_after_cancelled_entry_does_not_release_future_entry() {
        let gate = MockLifecycleGate::new();
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.set_park_lifecycle_gate(gate.clone());
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let mut first_sandbox = factory.create(test_sandbox_config()).await.unwrap();

        let first_park_task = tokio::spawn(async move { first_sandbox.park().await });
        assert_eq!(gate.wait_entered(1, test_timeout()).await.unwrap(), 1);
        first_park_task.abort();
        assert!(first_park_task.await.unwrap_err().is_cancelled());

        gate.release_one();
        let mut second_sandbox = factory.create(test_sandbox_config()).await.unwrap();
        let second_park_task = tokio::spawn(async move { second_sandbox.park().await });
        assert_eq!(gate.wait_entered(2, test_timeout()).await.unwrap(), 2);
        assert!(
            !second_park_task.is_finished(),
            "release for a cancelled entry must not pass a future entry"
        );

        gate.release_one();
        second_park_task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn lifecycle_gate_waits_for_nth_park_entry() {
        let gate = MockLifecycleGate::new();
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.set_park_lifecycle_gate(gate.clone());
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));

        let mut park_tasks = Vec::new();
        for _ in 0..3 {
            let mut sandbox = factory.create(test_sandbox_config()).await.unwrap();
            park_tasks.push(tokio::spawn(async move { sandbox.park().await }));
        }

        assert_eq!(gate.wait_entered(3, test_timeout()).await.unwrap(), 3);
        assert_eq!(overrides.park_call_count(), 3);

        gate.release_many(park_tasks.len());
        for task in park_tasks {
            task.await.unwrap().unwrap();
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn lifecycle_gate_counts_concurrent_park_entries_on_multithread_runtime() {
        const ENTRY_COUNT: usize = 32;

        let gate = MockLifecycleGate::new();
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.set_park_lifecycle_gate(gate.clone());
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));

        let mut park_tasks = Vec::with_capacity(ENTRY_COUNT);
        for _ in 0..ENTRY_COUNT {
            let mut sandbox = factory.create(test_sandbox_config()).await.unwrap();
            park_tasks.push(tokio::spawn(async move { sandbox.park().await }));
        }

        assert_eq!(
            gate.wait_entered(ENTRY_COUNT as u64, test_timeout())
                .await
                .unwrap(),
            ENTRY_COUNT as u64
        );
        assert_eq!(gate.entered_count(), ENTRY_COUNT as u64);
        assert_eq!(overrides.park_call_count(), ENTRY_COUNT as u32);

        gate.release_many(ENTRY_COUNT);
        for task in park_tasks {
            task.await.unwrap().unwrap();
        }
    }

    #[tokio::test]
    async fn overrides_share_create_results_across_runtime_factories() {
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.push_create_result(Err(SandboxError::Initialization {
            phase: SandboxInitializationPhase::SandboxAllocation,
            message: "out of resources".into(),
        }));
        let runtime = MockSandboxRuntime::with_overrides(Arc::clone(&overrides));

        let first_factory = runtime.create_factory(test_factory_config()).await.unwrap();
        let result = first_factory.create(test_sandbox_config()).await;
        assert!(matches!(
            result,
            Err(SandboxError::Initialization {
                phase: SandboxInitializationPhase::SandboxAllocation,
                ..
            })
        ));

        let second_factory = runtime.create_factory(test_factory_config()).await.unwrap();
        second_factory.create(test_sandbox_config()).await.unwrap();
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shared_create_result_is_consumed_once_across_concurrent_factories() {
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.push_create_result(Err(SandboxError::Initialization {
            phase: SandboxInitializationPhase::SandboxAllocation,
            message: "out of resources".into(),
        }));
        let first_factory = Arc::new(MockSandboxFactory::with_overrides(Arc::clone(&overrides)));
        let second_factory = Arc::new(MockSandboxFactory::with_overrides(Arc::clone(&overrides)));
        let barrier = Arc::new(tokio::sync::Barrier::new(2));

        let first = tokio::spawn({
            let barrier = Arc::clone(&barrier);
            async move {
                barrier.wait().await;
                first_factory.create(test_sandbox_config()).await.is_err()
            }
        });
        let second = tokio::spawn({
            let barrier = Arc::clone(&barrier);
            async move {
                barrier.wait().await;
                second_factory.create(test_sandbox_config()).await.is_err()
            }
        });

        let failure_count = [first.await.unwrap(), second.await.unwrap()]
            .into_iter()
            .filter(|failed| *failed)
            .count();
        assert_eq!(
            failure_count, 1,
            "shared create result should be consumed by exactly one concurrent factory"
        );
    }

    #[tokio::test]
    async fn factory_local_create_result_takes_precedence_over_shared_overrides() {
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.push_create_result(Err(SandboxError::Initialization {
            phase: SandboxInitializationPhase::SandboxAllocation,
            message: "shared failure".into(),
        }));
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        factory.push_create_result(Ok(()));

        factory.create(test_sandbox_config()).await.unwrap();
        let result = factory.create(test_sandbox_config()).await;

        assert!(matches!(
            result,
            Err(SandboxError::Initialization {
                phase: SandboxInitializationPhase::SandboxAllocation,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn destroy_lifecycle_gate_release_before_entry_is_not_lost() {
        let gate = MockLifecycleGate::new();
        gate.release_one();
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.set_destroy_lifecycle_gate(gate.clone());
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let sandbox = factory.create(test_sandbox_config()).await.unwrap();

        tokio::time::timeout(test_timeout(), factory.destroy(sandbox))
            .await
            .expect("early release permit should let destroy finish");

        assert_eq!(gate.entered_count(), 1);
        assert_eq!(overrides.destroy_call_count(), 1);

        let next_sandbox = factory.create(test_sandbox_config()).await.unwrap();
        let next_destroy_task = tokio::spawn(async move {
            factory.destroy(next_sandbox).await;
        });
        assert_eq!(gate.wait_entered(2, test_timeout()).await.unwrap(), 2);
        assert!(
            !next_destroy_task.is_finished(),
            "early release permit should be consumed by only one lifecycle entry"
        );
        gate.release_one();
        next_destroy_task.await.unwrap();
    }

    #[tokio::test]
    async fn destroy_lifecycle_gate_release_after_cancelled_entry_does_not_release_future_entry() {
        let gate = MockLifecycleGate::new();
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.set_destroy_lifecycle_gate(gate.clone());
        let factory = Arc::new(MockSandboxFactory::with_overrides(Arc::clone(&overrides)));
        let first_sandbox = factory.create(test_sandbox_config()).await.unwrap();

        let first_destroy_task = tokio::spawn({
            let factory = Arc::clone(&factory);
            async move {
                factory.destroy(first_sandbox).await;
            }
        });
        assert_eq!(gate.wait_entered(1, test_timeout()).await.unwrap(), 1);
        first_destroy_task.abort();
        assert!(first_destroy_task.await.unwrap_err().is_cancelled());

        gate.release_one();
        let second_sandbox = factory.create(test_sandbox_config()).await.unwrap();
        let second_destroy_task = tokio::spawn({
            let factory = Arc::clone(&factory);
            async move {
                factory.destroy(second_sandbox).await;
            }
        });
        assert_eq!(gate.wait_entered(2, test_timeout()).await.unwrap(), 2);
        assert!(
            !second_destroy_task.is_finished(),
            "release for a cancelled destroy entry must not pass a future entry"
        );

        gate.release_one();
        second_destroy_task.await.unwrap();
    }

    #[tokio::test]
    async fn destroy_lifecycle_gate_waits_for_nth_destroy_entry() {
        let gate = MockLifecycleGate::new();
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.set_destroy_lifecycle_gate(gate.clone());
        let factory = Arc::new(MockSandboxFactory::with_overrides(Arc::clone(&overrides)));

        let mut destroy_tasks = Vec::new();
        for _ in 0..3 {
            let sandbox = factory.create(test_sandbox_config()).await.unwrap();
            let factory = Arc::clone(&factory);
            destroy_tasks.push(tokio::spawn(async move {
                factory.destroy(sandbox).await;
            }));
        }

        assert_eq!(gate.wait_entered(3, test_timeout()).await.unwrap(), 3);
        assert_eq!(overrides.destroy_call_count(), 3);

        gate.release_many(destroy_tasks.len());
        for task in destroy_tasks {
            task.await.unwrap();
        }
    }

    #[tokio::test]
    async fn destroy_lifecycle_gate_blocks_before_destroy_panic() {
        let gate = MockLifecycleGate::new();
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.set_destroy_lifecycle_gate(gate.clone());
        overrides.push_destroy_panic("simulated destroy panic");
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let sandbox = factory.create(test_sandbox_config()).await.unwrap();

        let destroy_task = tokio::spawn(async move {
            factory.destroy(sandbox).await;
        });
        assert_eq!(gate.wait_entered(1, test_timeout()).await.unwrap(), 1);
        assert_eq!(overrides.destroy_call_count(), 1);
        assert!(
            !destroy_task.is_finished(),
            "destroy behavior should not run until the gate is released"
        );

        gate.release_one();
        let err = destroy_task.await.expect_err("destroy should panic");
        assert!(err.is_panic());
    }

    #[tokio::test]
    async fn destroy_panic_override_is_consumed_once_across_factories() {
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.push_destroy_panic("simulated destroy panic");
        let first_factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let first_sandbox = first_factory.create(test_sandbox_config()).await.unwrap();

        let err = tokio::spawn(async move {
            first_factory.destroy(first_sandbox).await;
        })
        .await
        .expect_err("first destroy should panic");
        assert!(err.is_panic());

        let second_factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let second_sandbox = second_factory.create(test_sandbox_config()).await.unwrap();
        second_factory.destroy(second_sandbox).await;

        assert_eq!(overrides.destroy_call_count(), 2);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shared_destroy_panic_is_consumed_once_across_concurrent_factories() {
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.push_destroy_panic("simulated destroy panic");
        let first_factory = Arc::new(MockSandboxFactory::with_overrides(Arc::clone(&overrides)));
        let second_factory = Arc::new(MockSandboxFactory::with_overrides(Arc::clone(&overrides)));
        let first_sandbox = first_factory.create(test_sandbox_config()).await.unwrap();
        let second_sandbox = second_factory.create(test_sandbox_config()).await.unwrap();
        let barrier = Arc::new(tokio::sync::Barrier::new(2));

        let first = tokio::spawn({
            let barrier = Arc::clone(&barrier);
            async move {
                barrier.wait().await;
                first_factory.destroy(first_sandbox).await;
            }
        });
        let second = tokio::spawn({
            let barrier = Arc::clone(&barrier);
            async move {
                barrier.wait().await;
                second_factory.destroy(second_sandbox).await;
            }
        });

        let classify = |result: std::result::Result<(), tokio::task::JoinError>| match result {
            Ok(()) => (1, 0),
            Err(err) if err.is_panic() => (0, 1),
            Err(err) => panic!("destroy task should not be cancelled: {err}"),
        };
        let (first_success_count, first_panic_count) = classify(first.await);
        let (second_success_count, second_panic_count) = classify(second.await);
        let panic_count = first_panic_count + second_panic_count;
        let success_count = first_success_count + second_success_count;
        assert_eq!(
            panic_count, 1,
            "shared destroy panic should be consumed by exactly one concurrent factory"
        );
        assert_eq!(
            success_count, 1,
            "the factory that did not consume the shared destroy panic should complete"
        );
        assert_eq!(overrides.destroy_call_count(), 2);
    }

    #[tokio::test]
    async fn overrides_record_start_process_output_modes_in_order() {
        let overrides = Arc::new(MockSandboxOverrides::new());
        let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
        let sandbox = factory.create(test_sandbox_config()).await.unwrap();
        let buffered = sandbox
            .start_process(&StartProcessRequest {
                cmd: "agent",
                timeout: Duration::from_secs(5),
                env: &[],
                sudo: false,
                output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
                control: ProcessControlMode::None,
            })
            .await
            .unwrap();
        assert!(!buffered.has_stdout_receiver());

        let streamed = sandbox
            .start_process(&StartProcessRequest {
                cmd: "agent",
                timeout: Duration::from_secs(5),
                env: &[],
                sudo: false,
                output: ProcessOutputMode::stream(),
                control: ProcessControlMode::None,
            })
            .await
            .unwrap();
        assert!(streamed.has_stdout_receiver());

        assert_eq!(
            overrides.start_process_calls(),
            vec![
                StartProcessCall {
                    cmd: "agent".to_string(),
                    timeout: Duration::from_secs(5),
                    env: Vec::new(),
                    sudo: false,
                    output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
                    control: ProcessControlMode::None,
                },
                StartProcessCall {
                    cmd: "agent".to_string(),
                    timeout: Duration::from_secs(5),
                    env: Vec::new(),
                    sudo: false,
                    output: ProcessOutputMode::stream(),
                    control: ProcessControlMode::None,
                },
            ]
        );
    }

    #[tokio::test]
    async fn start_process_emits_queued_stdout_chunks() {
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.push_start_process_stdout_chunks(vec![ProcessOutputChunk {
            bytes: b"partial".to_vec(),
            truncated: true,
        }]);
        let sandbox = MockSandbox::with_overrides("test", overrides);
        let mut handle = sandbox
            .start_process(&StartProcessRequest {
                cmd: "agent",
                timeout: Duration::from_secs(5),
                env: &[],
                sudo: false,
                output: ProcessOutputMode::stream(),
                control: ProcessControlMode::None,
            })
            .await
            .unwrap();
        let mut stdout_rx = handle.take_stdout_receiver().unwrap();

        let chunk = stdout_rx.recv().await.unwrap();

        assert_eq!(chunk.bytes, b"partial");
        assert!(chunk.truncated);
        assert!(stdout_rx.recv().await.is_none());
    }

    #[tokio::test]
    async fn start_process_returns_control_handle_when_requested() {
        let runtime = MockSandboxRuntime::new();
        let factory = runtime.create_factory(test_factory_config()).await.unwrap();
        let sandbox = factory.create(test_sandbox_config()).await.unwrap();

        let without_control = sandbox
            .start_process(&StartProcessRequest {
                cmd: "agent",
                timeout: Duration::from_secs(5),
                env: &[],
                sudo: false,
                output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
                control: ProcessControlMode::None,
            })
            .await
            .unwrap();
        assert!(without_control.control_handle().is_none());

        let with_control = sandbox
            .start_process(&StartProcessRequest {
                cmd: "agent",
                timeout: Duration::from_secs(5),
                env: &[],
                sudo: false,
                output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
                control: ProcessControlMode::Enabled,
            })
            .await
            .unwrap();
        let control = with_control
            .control_handle()
            .expect("enabled control should expose a handle");
        let ack = control
            .control("msg-1", b"payload", Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(ack.message_id, "msg-1");
    }

    #[tokio::test]
    async fn start_process_rejects_invalid_stream_configuration() {
        let runtime = MockSandboxRuntime::new();
        let factory = runtime.create_factory(test_factory_config()).await.unwrap();
        let sandbox = factory.create(test_sandbox_config()).await.unwrap();

        for output in [
            ProcessOutputMode::Stream {
                stream_limit_bytes: 1024,
                chunk_limit_bytes: 0,
                queue_capacity: 1,
            },
            ProcessOutputMode::Stream {
                stream_limit_bytes: 1024,
                chunk_limit_bytes: 16,
                queue_capacity: 0,
            },
        ] {
            match sandbox
                .start_process(&StartProcessRequest {
                    cmd: "agent",
                    timeout: Duration::from_secs(5),
                    env: &[],
                    sudo: false,
                    output,
                    control: ProcessControlMode::None,
                })
                .await
            {
                Ok(_) => panic!("invalid stream configuration should be rejected"),
                Err(SandboxError::Operation {
                    operation, reason, ..
                }) => {
                    assert_eq!(operation, SandboxOperation::StartProcess);
                    assert_eq!(reason, SandboxOperationReason::Other);
                }
                Err(other) => panic!("expected start_process operation error, got {other:?}"),
            }
        }
    }

    #[tokio::test]
    async fn wait_process_rejects_consumed_guest_process_handle() {
        let runtime = MockSandboxRuntime::new();
        let factory = runtime.create_factory(test_factory_config()).await.unwrap();
        let sandbox = factory.create(test_sandbox_config()).await.unwrap();
        let mut handle = sandbox
            .start_process(&StartProcessRequest {
                cmd: "agent",
                timeout: Duration::from_secs(5),
                env: &[],
                sudo: false,
                output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
                control: ProcessControlMode::None,
            })
            .await
            .unwrap();

        let consumed = handle.take_waiter();
        assert!(consumed.is_some());
        match sandbox.wait_process(handle, Duration::from_secs(5)).await {
            Ok(_) => panic!("wait_process should reject an already consumed handle"),
            Err(SandboxError::Operation {
                operation,
                reason,
                message,
            }) => {
                assert_eq!(operation, SandboxOperation::WaitProcess);
                assert_eq!(reason, SandboxOperationReason::Other);
                assert!(message.contains("already consumed"));
            }
            Err(other) => panic!("expected wait_process operation error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn wait_process_returns_queued_process_exit() {
        let overrides = Arc::new(MockSandboxOverrides::new());
        let sandbox = MockSandbox::with_overrides("test", Arc::clone(&overrides));
        let mut exit = ProcessExit::new(77, 0, b"out".to_vec(), b"err".to_vec());
        exit.stream_overflowed = true;
        overrides.push_wait_process_exit(exit);
        let handle = sandbox
            .start_process(&StartProcessRequest {
                cmd: "agent",
                timeout: Duration::from_secs(5),
                env: &[],
                sudo: false,
                output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
                control: ProcessControlMode::None,
            })
            .await
            .unwrap();

        let result = sandbox
            .wait_process(handle, Duration::from_secs(5))
            .await
            .unwrap();

        assert_eq!(result.pid, 77);
        assert_eq!(result.stdout, b"out");
        assert_eq!(result.stderr, b"err");
        assert!(result.stream_overflowed);
    }

    #[tokio::test]
    async fn wait_process_default_exit_is_unchanged_without_queued_exit() {
        let overrides = Arc::new(MockSandboxOverrides::new());
        let sandbox = MockSandbox::with_overrides("test", overrides);
        let handle = sandbox
            .start_process(&StartProcessRequest {
                cmd: "agent",
                timeout: Duration::from_secs(5),
                env: &[],
                sudo: false,
                output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
                control: ProcessControlMode::None,
            })
            .await
            .unwrap();

        let result = sandbox
            .wait_process(handle, Duration::from_secs(5))
            .await
            .unwrap();

        assert_eq!(result.pid, 1);
        assert_eq!(result.exit_code, 0);
        assert!(result.stdout.is_empty());
        assert!(result.stderr.is_empty());
        assert!(!result.stream_overflowed);
    }

    #[tokio::test]
    async fn wait_process_drops_unclaimed_stdout_receiver_before_waiting() {
        let gate = Arc::new(tokio::sync::Notify::new());
        let overrides = Arc::new(MockSandboxOverrides::with_wait_process_gate(Arc::clone(
            &gate,
        )));
        let sandbox = MockSandbox::with_overrides("test", overrides);
        let (stdout_tx, stdout_rx) = tokio::sync::mpsc::channel(1);
        let handle = GuestProcessHandle::new(
            1,
            Some(stdout_rx),
            None,
            GuestProcessWaiter::new(|_timeout| {
                Box::pin(std::future::pending::<std::io::Result<ProcessExit>>())
            }),
        );

        let wait =
            tokio::spawn(async move { sandbox.wait_process(handle, Duration::from_secs(5)).await });
        tokio::time::timeout(test_timeout(), stdout_tx.closed())
            .await
            .expect("wait_process should drop an unclaimed stdout receiver before blocking");

        gate.notify_waiters();
        wait.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn wait_process_lifecycle_gate_blocks_until_released() {
        let gate = MockLifecycleGate::new();
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.set_wait_process_lifecycle_gate(gate.clone());
        let sandbox = MockSandbox::with_overrides("test", overrides);
        let handle = sandbox
            .start_process(&StartProcessRequest {
                cmd: "agent",
                timeout: Duration::from_secs(5),
                env: &[],
                sudo: false,
                output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
                control: ProcessControlMode::None,
            })
            .await
            .unwrap();

        let wait =
            tokio::spawn(async move { sandbox.wait_process(handle, Duration::from_secs(5)).await });
        assert_eq!(gate.wait_entered(1, test_timeout()).await.unwrap(), 1);
        assert!(
            !wait.is_finished(),
            "wait_process should block until the lifecycle gate is released",
        );

        gate.release_one();
        let result = wait.await.unwrap().unwrap();
        assert_eq!(result.pid, 1);
        assert_eq!(result.exit_code, 0);
    }

    #[tokio::test]
    async fn wait_process_lifecycle_gate_clear_only_affects_future_waits() {
        let gate = MockLifecycleGate::new();
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.set_wait_process_lifecycle_gate(gate.clone());
        let first_sandbox = MockSandbox::with_overrides("first", Arc::clone(&overrides));
        let first_handle = first_sandbox
            .start_process(&StartProcessRequest {
                cmd: "agent",
                timeout: Duration::from_secs(5),
                env: &[],
                sudo: false,
                output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
                control: ProcessControlMode::None,
            })
            .await
            .unwrap();

        let first_wait = tokio::spawn(async move {
            first_sandbox
                .wait_process(first_handle, Duration::from_secs(5))
                .await
        });
        assert_eq!(gate.wait_entered(1, test_timeout()).await.unwrap(), 1);

        overrides.clear_wait_process_lifecycle_gate();
        assert!(
            !first_wait.is_finished(),
            "clearing the gate must not release an already-entered wait_process",
        );

        let second_sandbox = MockSandbox::with_overrides("second", overrides);
        let second_handle = second_sandbox
            .start_process(&StartProcessRequest {
                cmd: "agent",
                timeout: Duration::from_secs(5),
                env: &[],
                sudo: false,
                output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
                control: ProcessControlMode::None,
            })
            .await
            .unwrap();
        let second_result = tokio::time::timeout(
            test_timeout(),
            second_sandbox.wait_process(second_handle, Duration::from_secs(5)),
        )
        .await
        .expect("future wait_process calls should bypass a cleared gate")
        .unwrap();
        assert_eq!(second_result.exit_code, 0);

        gate.release_one();
        let first_result = first_wait.await.unwrap().unwrap();
        assert_eq!(first_result.exit_code, 0);
    }

    #[tokio::test]
    async fn process_cancel_releases_wait_process_lifecycle_gate() {
        let gate = MockLifecycleGate::new();
        let overrides = Arc::new(MockSandboxOverrides::new());
        overrides.set_wait_process_lifecycle_gate(gate.clone());
        let sandbox = MockSandbox::with_overrides("test", Arc::clone(&overrides));
        let mut handle = sandbox
            .start_process(&StartProcessRequest {
                cmd: "agent",
                timeout: Duration::from_secs(5),
                env: &[],
                sudo: false,
                output: ProcessOutputMode::buffered(EXEC_OUTPUT_LIMIT_1_MIB),
                control: ProcessControlMode::None,
            })
            .await
            .unwrap();
        let cancel = handle
            .take_cancel_handle()
            .expect("mock process should expose a cancel handle");

        let wait =
            tokio::spawn(async move { sandbox.wait_process(handle, Duration::from_secs(5)).await });
        assert_eq!(gate.wait_entered(1, test_timeout()).await.unwrap(), 1);

        cancel.cancel(Duration::from_secs(1)).await.unwrap();
        let result = wait.await.unwrap().unwrap();
        assert_eq!(result.exit_code, 0);
        assert_eq!(overrides.process_cancel_calls().len(), 1);
    }

    #[tokio::test]
    async fn factory_creates_sandbox() {
        let mut factory = MockSandboxFactory::new();
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
            control.kill_remote("sandbox-1").await.unwrap(),
            RemoteKillResult::Accepted
        );
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
        let factory = MockSandboxFactory::new();
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
    async fn sandbox_control_records_kill_ids() {
        let control = MockSandboxControl::new("/tmp/test");
        control.kill_remote("sandbox-1").await.unwrap();
        control.kill_remote("sandbox-2").await.unwrap();

        assert_eq!(
            control.recorded_kill_ids(),
            vec!["sandbox-1".to_string(), "sandbox-2".to_string()],
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

    #[tokio::test]
    async fn sandbox_control_queued_kill_results() {
        let control = MockSandboxControl::new("/tmp/test");
        control.push_kill_remote_result(Err(SandboxControlError::NotFound("gone".into())));

        let result = control.kill_remote("sandbox-1").await;
        assert!(result.is_err());

        assert_eq!(
            control.kill_remote("sandbox-1").await.unwrap(),
            RemoteKillResult::Accepted
        );
    }
}
