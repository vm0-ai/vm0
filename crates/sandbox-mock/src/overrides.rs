use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ::sandbox::*;

use crate::call_records::{
    CopyFileCall, ExecCall, ExecMatcher, ProcessCancelCall, ProcessControlCall, StartProcessCall,
    WaitProcessCall, WriteFileCall, WriteFilesCall,
};
use crate::lifecycle::{BlockingGate, DestroyBehavior, LifecycleBehaviors, MockLifecycleGate};
use crate::support::LockIgnoringPoison;

pub(crate) struct ExecMatcherResult {
    pub(crate) pattern: String,
    pub(crate) result: ExecResult,
}

#[derive(Default)]
pub(crate) struct ExecOverrideState {
    /// Pattern-matched exec results. First matching pattern wins and is
    /// consumed (one-shot).
    pub(crate) matchers: Mutex<Vec<ExecMatcherResult>>,
    /// Recorded exec calls across all sandboxes built from this override set.
    pub(crate) calls: Mutex<Vec<ExecCall>>,
}

#[derive(Default)]
pub(crate) struct FileOverrideState {
    /// Recorded write_file calls across all sandboxes built from this override set.
    pub(crate) write_file_calls: Mutex<Vec<WriteFileCall>>,
    /// Recorded write_files calls across all sandboxes built from this override set.
    pub(crate) write_files_calls: Mutex<Vec<WriteFilesCall>>,
    /// Recorded write_private_file calls across all sandboxes built from this override set.
    pub(crate) private_write_file_calls: Mutex<Vec<WriteFileCall>>,
    /// FIFO queue of write_private_file results consumed by factory-created sandboxes.
    pub(crate) private_write_file_results: Mutex<VecDeque<Result<()>>>,
    /// FIFO queue of read_file results consumed by factory-created sandboxes.
    pub(crate) read_file_results: Mutex<VecDeque<Result<Option<Vec<u8>>>>>,
    /// Recorded copy_file calls across all sandboxes built from this override
    /// set.
    pub(crate) copy_file_calls: Mutex<Vec<CopyFileCall>>,
}

#[derive(Default)]
pub(crate) struct LifecycleOverrideState {
    /// FIFO queue of start results consumed by every sandbox built with
    /// these overrides. Empty queue → default Ok(()).
    pub(crate) start_results: Mutex<VecDeque<Result<()>>>,
    /// FIFO queue of stop behaviours consumed by every sandbox built with
    /// these overrides. Empty queue → default Ok(()).
    pub(crate) stop_behaviors: LifecycleBehaviors,
    /// FIFO queue of park results consumed by every sandbox built with
    /// these overrides. Empty queue → default Ok(()).
    pub(crate) park_behaviors: LifecycleBehaviors,
    /// Optional gate that records and blocks every `park()` entry until released.
    pub(crate) park_gate: Mutex<Option<BlockingGate>>,
    /// FIFO queue of unpark results consumed by every sandbox built with
    /// these overrides. Empty queue → default Ok(()).
    pub(crate) unpark_behaviors: LifecycleBehaviors,
    /// Optional gate that records and blocks every factory `destroy()` entry
    /// until released.
    pub(crate) destroy_gate: Mutex<Option<BlockingGate>>,
    /// FIFO queue of destroy behaviours consumed by every factory built with
    /// these overrides. Empty queue → default successful destroy.
    pub(crate) destroy_behaviors: Mutex<VecDeque<DestroyBehavior>>,
    /// Total `park()` calls across all sandboxes built from this override set.
    pub(crate) park_calls: Mutex<u32>,
    /// Total `unpark()` calls across all sandboxes built from this override set.
    pub(crate) unpark_calls: Mutex<u32>,
    /// Total factory `destroy()` calls across all factories built from this
    /// override set.
    pub(crate) destroy_calls: Mutex<u32>,
}

pub(crate) struct ProcessOverrideState {
    /// When `Some`, `wait_process` returns this exit code instead of 0.
    pub(crate) wait_process_code: Option<i32>,
    /// When set, `wait_process` awaits this [`tokio::sync::Notify`] before
    /// returning — giving the test a window to cancel the job.
    pub(crate) wait_process_gate: Option<Arc<tokio::sync::Notify>>,
    /// Optional durable gate that records and blocks every `wait_process`
    /// entry until released.
    pub(crate) wait_process_lifecycle_gate: Mutex<Option<MockLifecycleGate>>,
    /// When `Some`, `wait_process` returns a wait-process operation error to
    /// simulate timeout or crash. The stdout channel sender is also kept alive
    /// in `MockSandbox` so the drain task would block without the fix.
    pub(crate) wait_process_error: Option<String>,
    /// FIFO queue of full wait_process exits consumed by factory-created
    /// sandboxes. Empty queue follows the existing default/override behavior.
    pub(crate) wait_process_exits: Mutex<VecDeque<ProcessExit>>,
    /// Recorded wait_process calls across all sandboxes built from this
    /// override set.
    pub(crate) wait_process_calls: Mutex<Vec<WaitProcessCall>>,
    /// Recorded start_process output modes across all sandboxes built from
    /// this override set.
    pub(crate) start_process_calls: Mutex<Vec<StartProcessCall>>,
    /// FIFO queue of stdout chunk batches emitted by factory-created
    /// sandboxes during streaming start_process calls.
    pub(crate) start_process_stdout_chunks: Mutex<VecDeque<Vec<ProcessOutputChunk>>>,
    /// Whether factory-created sandboxes expose a process cancel handle.
    pub(crate) process_cancel_supported: Mutex<bool>,
    /// Recorded process cancel calls across all sandboxes built from this
    /// override set.
    pub(crate) process_cancel_calls: Mutex<Vec<ProcessCancelCall>>,
    /// Wakes tests waiting for process cancel calls to be recorded.
    pub(crate) process_cancel_notify: tokio::sync::Notify,
    /// FIFO queue of process cancel errors consumed by cancel handles.
    pub(crate) process_cancel_errors: Mutex<VecDeque<String>>,
    /// Recorded process-control calls across all sandboxes built from this
    /// override set.
    pub(crate) process_control_calls: Mutex<Vec<ProcessControlCall>>,
    /// Wakes tests waiting for process-control calls to be recorded.
    pub(crate) process_control_notify: tokio::sync::Notify,
    /// FIFO queue of process-control errors consumed by control handles.
    pub(crate) process_control_errors: Mutex<VecDeque<(std::io::ErrorKind, String)>>,
    /// Whether a successful process cancel releases the configured
    /// `wait_process` gate. Tests can disable this to exercise bounded wait
    /// timeout paths after cancel is sent.
    pub(crate) process_cancel_releases_wait_gate: Mutex<bool>,
}

impl Default for ProcessOverrideState {
    fn default() -> Self {
        Self {
            wait_process_code: None,
            wait_process_gate: None,
            wait_process_lifecycle_gate: Mutex::new(None),
            wait_process_error: None,
            wait_process_exits: Mutex::new(VecDeque::new()),
            wait_process_calls: Mutex::new(Vec::new()),
            start_process_calls: Mutex::new(Vec::new()),
            start_process_stdout_chunks: Mutex::new(VecDeque::new()),
            process_cancel_supported: Mutex::new(true),
            process_cancel_calls: Mutex::new(Vec::new()),
            process_cancel_notify: tokio::sync::Notify::new(),
            process_cancel_errors: Mutex::new(VecDeque::new()),
            process_control_calls: Mutex::new(Vec::new()),
            process_control_notify: tokio::sync::Notify::new(),
            process_control_errors: Mutex::new(VecDeque::new()),
            process_cancel_releases_wait_gate: Mutex::new(true),
        }
    }
}

#[derive(Default)]
pub(crate) struct FactoryOverrideState {
    /// FIFO queue of create results consumed by every factory built with
    /// these overrides. Empty queue → default Ok(()).
    pub(crate) create_results: Mutex<VecDeque<Result<()>>>,
    /// Sandbox create configs observed across factories built with these overrides.
    pub(crate) create_configs: Mutex<Vec<SandboxConfig>>,
}

/// Shared behavior overrides propagated from runtime → factory → sandbox.
///
/// Tests create this via
/// [`MockSandboxRuntime::with_overrides`](crate::MockSandboxRuntime::with_overrides) so every
/// sandbox produced by the factory can share queued behavior and call
/// observations. Queue fields on this type are shared globally by every
/// factory and sandbox that receives the same `Arc<MockSandboxOverrides>`.
///
/// Accessors on this type return shared observation snapshots across that
/// override set. Sandbox-local observations remain available through
/// [`MockSandbox`](crate::MockSandbox) accessors.
pub struct MockSandboxOverrides {
    pub(crate) exec: ExecOverrideState,
    pub(crate) file: FileOverrideState,
    pub(crate) lifecycle: LifecycleOverrideState,
    pub(crate) process: ProcessOverrideState,
    pub(crate) factory: FactoryOverrideState,
}

impl MockSandboxOverrides {
    /// Create an override set with empty shared queues and observations.
    ///
    /// Sandboxes and factories only share this state after the same instance is
    /// passed through
    /// [`MockSandboxRuntime::with_overrides`](crate::MockSandboxRuntime::with_overrides) or
    /// [`MockSandboxFactory::with_overrides`](crate::MockSandboxFactory::with_overrides).
    pub fn new() -> Self {
        Self {
            exec: ExecOverrideState::default(),
            file: FileOverrideState::default(),
            lifecycle: LifecycleOverrideState::default(),
            process: ProcessOverrideState::default(),
            factory: FactoryOverrideState::default(),
        }
    }

    /// Create overrides that make `wait_process` return a custom exit code.
    pub fn with_wait_process_code(code: i32) -> Self {
        let mut overrides = Self::new();
        overrides.process.wait_process_code = Some(code);
        overrides
    }

    /// Create overrides that block `wait_process` until the gate is notified.
    pub fn with_wait_process_gate(gate: Arc<tokio::sync::Notify>) -> Self {
        let mut overrides = Self::new();
        overrides.process.wait_process_gate = Some(gate);
        overrides
    }

    /// Block every `wait_process` call with a durable lifecycle gate.
    ///
    /// Prefer this over [`Self::with_wait_process_gate`]: entries and releases
    /// are durable, so tests do not need to pre-arm `Notify` futures.
    pub fn set_wait_process_lifecycle_gate(&self, gate: MockLifecycleGate) {
        *self
            .process
            .wait_process_lifecycle_gate
            .lock_ignoring_poison() = Some(gate);
    }

    /// Remove the durable `wait_process` gate for future wait calls.
    ///
    /// Already-entered wait calls keep waiting on their cloned gate until the
    /// test releases it.
    pub fn clear_wait_process_lifecycle_gate(&self) {
        *self
            .process
            .wait_process_lifecycle_gate
            .lock_ignoring_poison() = None;
    }

    /// Create overrides that make `wait_process` return an error (simulating
    /// timeout or crash). The stdout channel sender is kept alive so the
    /// drain task blocks unless the caller aborts it.
    pub fn with_wait_process_error(msg: impl Into<String>) -> Self {
        let mut overrides = Self::new();
        overrides.process.wait_process_error = Some(msg.into());
        overrides
    }

    /// Queue a full `wait_process` exit applied to the next matching wait call.
    /// Consumed FIFO across all sandboxes; empty queue follows the existing
    /// default/override behavior.
    pub fn push_wait_process_exit(&self, exit: ProcessExit) {
        self.process
            .wait_process_exits
            .lock_ignoring_poison()
            .push_back(exit);
    }

    /// Register a pattern matcher consumed on first match.
    pub fn add_exec_matcher(&self, matcher: ExecMatcher) {
        self.exec
            .matchers
            .lock_ignoring_poison()
            .push(ExecMatcherResult {
                pattern: matcher.pattern,
                result: ExecResult {
                    termination: ExecTermination::Exited {
                        exit_code: matcher.exit_code,
                    },
                    stdout: matcher.stdout,
                    stderr: matcher.stderr,
                    diagnostic: String::new(),
                    stdout_truncated: false,
                    stderr_truncated: false,
                },
            });
    }

    /// Register a pattern matcher that returns the supplied full exec result.
    ///
    /// Use this when a test needs a non-ordinary terminal state such as timeout,
    /// cancel, start failure, or wait failure.
    pub fn add_exec_result_matcher(&self, pattern: impl Into<String>, result: ExecResult) {
        self.exec
            .matchers
            .lock_ignoring_poison()
            .push(ExecMatcherResult {
                pattern: pattern.into(),
                result,
            });
    }

    /// Return recorded exec calls across all sandboxes built from this
    /// override set.
    ///
    /// The returned vector is a cloned snapshot in recorded order. Each record
    /// is captured before exec matchers or queued exec results are consumed.
    pub fn exec_calls(&self) -> Vec<ExecCall> {
        self.exec.calls.lock_ignoring_poison().clone()
    }

    /// Return recorded write-file calls across all sandboxes built from this
    /// override set.
    ///
    /// The returned vector is a cloned snapshot in recorded order. Shared
    /// overrides observe these calls but do not provide a shared write-file
    /// result queue.
    pub fn write_file_calls(&self) -> Vec<WriteFileCall> {
        self.file.write_file_calls.lock_ignoring_poison().clone()
    }

    /// Return recorded write-files batch calls across all sandboxes built from
    /// this override set.
    pub fn write_files_calls(&self) -> Vec<WriteFilesCall> {
        self.file.write_files_calls.lock_ignoring_poison().clone()
    }

    /// Return recorded private write-file calls across all sandboxes built
    /// from this override set.
    pub fn private_write_file_calls(&self) -> Vec<WriteFileCall> {
        self.file
            .private_write_file_calls
            .lock_ignoring_poison()
            .clone()
    }

    /// Queue a write_private_file result applied to the next private write made
    /// through any sandbox built from these overrides after that sandbox's
    /// local private-write queue is empty.
    pub fn push_private_write_file_result(&self, result: Result<()>) {
        self.file
            .private_write_file_results
            .lock_ignoring_poison()
            .push_back(result);
    }

    /// Queue a read_file result applied to the next read made through any
    /// sandbox built from these overrides after that sandbox's local read queue
    /// is empty.
    pub fn push_read_file_result(&self, result: Result<Option<Vec<u8>>>) {
        self.file
            .read_file_results
            .lock_ignoring_poison()
            .push_back(result);
    }

    /// Queue a factory `create()` result applied to the next factory create
    /// call made through these overrides. Consumed FIFO across all factories;
    /// empty queue → default Ok(()).
    pub fn push_create_result(&self, result: Result<()>) {
        self.factory
            .create_results
            .lock_ignoring_poison()
            .push_back(result);
    }

    /// Return sandbox create configs observed by factories using this override
    /// set.
    ///
    /// The returned vector is a cloned snapshot in recorded order. A create
    /// config is recorded before factory-local or shared queued create errors
    /// are returned.
    pub fn create_configs(&self) -> Vec<SandboxConfig> {
        self.factory.create_configs.lock_ignoring_poison().clone()
    }

    /// Queue a `start()` result applied to the next factory-created sandbox.
    /// Consumed FIFO across all sandboxes; empty queue → default Ok(()).
    pub fn push_start_result(&self, result: Result<()>) {
        self.lifecycle
            .start_results
            .lock_ignoring_poison()
            .push_back(result);
    }

    /// Queue a `stop()` result applied to the next factory-created sandbox.
    /// Consumed FIFO across all sandboxes; empty queue → default Ok(()).
    pub fn push_stop_result(&self, result: Result<()>) {
        self.lifecycle.stop_behaviors.push_result(result);
    }

    /// Queue a `stop()` panic applied to the next factory-created sandbox.
    /// Used by runner tests to exercise panic-safe cleanup boundaries.
    pub fn push_stop_panic(&self, message: impl Into<String>) {
        self.lifecycle.stop_behaviors.push_panic(message);
    }

    /// Queue a `park()` result applied to the next factory-created sandbox.
    /// Consumed FIFO across all sandboxes; empty queue → default Ok(()).
    pub fn push_park_result(&self, result: Result<()>) {
        self.lifecycle.park_behaviors.push_result(result);
    }

    /// Queue a `park()` panic applied to the next factory-created sandbox.
    /// Used by runner tests to exercise panic-safe cleanup boundaries.
    pub fn push_park_panic(&self, message: impl Into<String>) {
        self.lifecycle.park_behaviors.push_panic(message);
    }

    /// Block every `park()` call with a durable lifecycle gate.
    ///
    /// Prefer this over [`Self::set_park_gate`]: entries and releases are
    /// durable, so tests do not need to pre-arm `Notify` futures.
    pub fn set_park_lifecycle_gate(&self, gate: MockLifecycleGate) {
        *self.lifecycle.park_gate.lock_ignoring_poison() = Some(BlockingGate::Lifecycle(gate));
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
        *self.lifecycle.park_gate.lock_ignoring_poison() =
            Some(BlockingGate::LegacyNotify { entered, release });
    }

    /// Queue an `unpark()` result applied to the next factory-created sandbox.
    /// Consumed FIFO across all sandboxes; empty queue → default Ok(()).
    pub fn push_unpark_result(&self, result: Result<()>) {
        self.lifecycle.unpark_behaviors.push_result(result);
    }

    /// Queue an `unpark()` panic applied to the next factory-created sandbox.
    /// Used by runner tests to exercise panic-safe cleanup boundaries.
    pub fn push_unpark_panic(&self, message: impl Into<String>) {
        self.lifecycle.unpark_behaviors.push_panic(message);
    }

    /// Block every factory `destroy()` call with a durable lifecycle gate.
    ///
    /// Prefer this over [`Self::set_destroy_gate`]: entries and releases are
    /// durable, so tests do not need to pre-arm `Notify` futures.
    pub fn set_destroy_lifecycle_gate(&self, gate: MockLifecycleGate) {
        *self.lifecycle.destroy_gate.lock_ignoring_poison() = Some(BlockingGate::Lifecycle(gate));
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
        *self.lifecycle.destroy_gate.lock_ignoring_poison() =
            Some(BlockingGate::LegacyNotify { entered, release });
    }

    /// Queue a factory `destroy()` panic applied to the next destroy call made
    /// through these overrides. Consumed FIFO across all factories.
    pub fn push_destroy_panic(&self, message: impl Into<String>) {
        self.lifecycle
            .destroy_behaviors
            .lock_ignoring_poison()
            .push_back(DestroyBehavior::Panic(message.into()));
    }

    /// Total `park()` calls across all sandboxes built from this override set.
    pub fn park_call_count(&self) -> u32 {
        *self.lifecycle.park_calls.lock_ignoring_poison()
    }

    /// Total `unpark()` calls across all sandboxes built from this override set.
    pub fn unpark_call_count(&self) -> u32 {
        *self.lifecycle.unpark_calls.lock_ignoring_poison()
    }

    /// Total factory `destroy()` calls across all factories built from this
    /// override set.
    pub fn destroy_call_count(&self) -> u32 {
        *self.lifecycle.destroy_calls.lock_ignoring_poison()
    }

    /// Return recorded start-process calls across all sandboxes built from this
    /// override set.
    ///
    /// The returned vector is a cloned snapshot in recorded order.
    pub fn start_process_calls(&self) -> Vec<StartProcessCall> {
        self.process
            .start_process_calls
            .lock_ignoring_poison()
            .clone()
    }

    /// Return recorded wait-process calls across all sandboxes built from this
    /// override set.
    ///
    /// The returned vector is a cloned snapshot in recorded order.
    pub fn wait_process_calls(&self) -> Vec<WaitProcessCall> {
        self.process
            .wait_process_calls
            .lock_ignoring_poison()
            .clone()
    }

    /// Return recorded copy-file calls across all sandboxes built from this
    /// override set.
    ///
    /// The returned vector is a cloned snapshot in recorded order.
    pub fn copy_file_calls(&self) -> Vec<CopyFileCall> {
        self.file.copy_file_calls.lock_ignoring_poison().clone()
    }

    /// Queue stdout chunks emitted by the next streaming `start_process` call.
    /// Consumed FIFO across all sandboxes; empty queue emits no chunks.
    pub fn push_start_process_stdout_chunks(&self, chunks: Vec<ProcessOutputChunk>) {
        self.process
            .start_process_stdout_chunks
            .lock_ignoring_poison()
            .push_back(chunks);
    }

    /// Configure `wait_process` to return an error while preserving any other
    /// overrides already set on this instance.
    pub fn set_wait_process_error(&mut self, msg: impl Into<String>) {
        self.process.wait_process_error = Some(msg.into());
    }

    /// Configure whether future `start_process` handles include a cancel handle.
    pub fn set_process_cancel_supported(&self, supported: bool) {
        *self.process.process_cancel_supported.lock_ignoring_poison() = supported;
    }

    /// Return recorded process-cancel calls across all sandboxes built from
    /// this override set.
    ///
    /// The returned vector is a cloned snapshot in recorded order. Cancel
    /// attempts are recorded before any queued cancel send error is returned.
    pub fn process_cancel_calls(&self) -> Vec<ProcessCancelCall> {
        self.process
            .process_cancel_calls
            .lock_ignoring_poison()
            .clone()
    }

    /// Return recorded process-control calls across all sandboxes built from
    /// this override set.
    ///
    /// The returned vector is a cloned snapshot in recorded order. Control
    /// attempts are recorded before any queued control send error is returned.
    pub fn process_control_calls(&self) -> Vec<ProcessControlCall> {
        self.process
            .process_control_calls
            .lock_ignoring_poison()
            .clone()
    }

    /// Wait until at least `expected` process cancel calls have been recorded.
    pub async fn wait_for_process_cancel_calls(&self, expected: usize, timeout: Duration) -> bool {
        tokio::time::timeout(timeout, async {
            loop {
                let notified = self.process.process_cancel_notify.notified();
                if self
                    .process
                    .process_cancel_calls
                    .lock_ignoring_poison()
                    .len()
                    >= expected
                {
                    return;
                }
                notified.await;
            }
        })
        .await
        .is_ok()
    }

    /// Wait until at least `expected` process-control calls have been recorded.
    pub async fn wait_for_process_control_calls(&self, expected: usize, timeout: Duration) -> bool {
        tokio::time::timeout(timeout, async {
            loop {
                let notified = self.process.process_control_notify.notified();
                if self
                    .process
                    .process_control_calls
                    .lock_ignoring_poison()
                    .len()
                    >= expected
                {
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
        self.process
            .process_cancel_errors
            .lock_ignoring_poison()
            .push_back(message.into());
    }

    /// Queue a process-control send error consumed by the next control handle.
    pub fn push_process_control_error(&self, message: impl Into<String>) {
        self.push_process_control_io_error(std::io::ErrorKind::Other, message);
    }

    /// Queue a process-control send error with a specific I/O kind.
    pub fn push_process_control_io_error(
        &self,
        kind: std::io::ErrorKind,
        message: impl Into<String>,
    ) {
        self.process
            .process_control_errors
            .lock_ignoring_poison()
            .push_back((kind, message.into()));
    }

    /// Configure whether successful process cancellation releases a configured
    /// `wait_process` gate.
    pub fn set_process_cancel_releases_wait_gate(&self, releases: bool) {
        *self
            .process
            .process_cancel_releases_wait_gate
            .lock_ignoring_poison() = releases;
    }

    pub(crate) async fn wait_for_wait_process_gate(&self) {
        let lifecycle_gate = {
            self.process
                .wait_process_lifecycle_gate
                .lock_ignoring_poison()
                .clone()
        };
        if let Some(gate) = lifecycle_gate {
            gate.enter_and_wait().await;
        } else if let Some(gate) = &self.process.wait_process_gate {
            gate.notified().await;
        }
    }

    pub(crate) fn release_wait_process_gate(&self) {
        if let Some(gate) = &self.process.wait_process_gate {
            gate.notify_one();
        }
        if let Some(gate) = self
            .process
            .wait_process_lifecycle_gate
            .lock_ignoring_poison()
            .clone()
        {
            gate.release_one();
        }
    }
}

impl Default for MockSandboxOverrides {
    fn default() -> Self {
        Self::new()
    }
}
