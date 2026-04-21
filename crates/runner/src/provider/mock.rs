//! Channel-driven mock [`JobProvider`] for integration testing.
//!
//! Reproduces the key concurrency properties of [`ApiProvider`]:
//!
//! - `discover()` holds a `tokio::sync::Mutex` for its entire duration
//!   (same as ApiProvider's discovery Mutex).
//! - `shutdown()` acquires the same Mutex (same as ApiProvider).
//! - `discover()` has an optional pre-channel delay simulating ApiProvider's
//!   poll timer that restarts from scratch when the future is cancelled.
//!
//! This lets integration tests catch:
//! - **#8783**: heartbeat cancelling and recreating `discover()` each tick —
//!   the poll delay restarts from scratch, so jobs are never discovered.
//! - **#8898**: `shutdown()` deadlocking because `discover_fut` still holds
//!   the Mutex when `provider.shutdown()` is called.

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use async_trait::async_trait;
use tokio::sync::{Mutex, Notify, mpsc};
use tokio_util::sync::CancellationToken;

use super::JobProvider;
use crate::ids::RunId;
use crate::types::{ExecutionContext, HeartbeatState, SandboxReuseResult};
use sandbox::SandboxId;

/// Recorded completion from [`JobProvider::complete`].
#[derive(Debug, Clone)]
pub struct Completion {
    pub run_id: RunId,
    pub exit_code: i32,
    pub error: Option<String>,
    pub sandbox_id: Option<SandboxId>,
    pub reuse_result: Option<SandboxReuseResult>,
}

/// Channel-driven mock provider.
///
/// `discover()` holds `discovery` Mutex for its entire duration, mirroring
/// `ApiProvider`. `shutdown()` acquires the same Mutex, so omitting the
/// `drop(discover_fut)` before `shutdown()` causes a real deadlock.
pub struct MockJobProvider {
    /// Held by `discover()` for its entire lifetime and acquired by
    /// `shutdown()`. Reproduces the ApiProvider discovery Mutex semantics.
    discovery: Mutex<mpsc::UnboundedReceiver<(RunId, String)>>,
    /// Optional delay before checking the channel, simulating ApiProvider's
    /// internal poll timer. If the future is cancelled and recreated (not
    /// pinned), this delay restarts from scratch — jobs pushed during the
    /// delay won't be discovered until it completes.
    poll_delay: Option<Duration>,
    claim_results: StdMutex<HashMap<RunId, Option<ExecutionContext>>>,
    completions: Arc<StdMutex<Vec<Completion>>>,
    heartbeats: Arc<StdMutex<Vec<HeartbeatState>>>,
    cancel: CancellationToken,
    /// Fired each time `discover()` has reached its inner `select!` await
    /// point (lock + optional `poll_delay` complete, about to park on
    /// `rx.recv()`). Tests that need to order actions against that state —
    /// e.g. a silent `send_if_modified` that must land *after* the main loop
    /// has entered its `discover_fut` select — await `notified()` instead of
    /// sleeping. `notify_one` queues a permit, so a test that waits after
    /// the signal fired still wakes immediately.
    discover_entered: Arc<Notify>,
    /// Fired by `complete()` after a completion is appended to `completions`.
    /// `wait_completion` subscribes to this before checking the vec, so any
    /// completion that lands between the check and the wake is still observed.
    /// Event-driven waiting eliminates the polling loop whose wall-clock
    /// deadline was racing coverage-CI slowdown (see #10146).
    completion_notify: Arc<Notify>,
}

/// Test-side handle for driving the mock provider.
pub struct MockProviderHandle {
    pub discover_tx: mpsc::UnboundedSender<(RunId, String)>,
    pub completions: Arc<StdMutex<Vec<Completion>>>,
    pub heartbeats: Arc<StdMutex<Vec<HeartbeatState>>>,
    /// See [`MockJobProvider::discover_entered`].
    pub discover_entered: Arc<Notify>,
    /// See [`MockJobProvider::completion_notify`].
    completion_notify: Arc<Notify>,
}

impl MockJobProvider {
    /// Create a new mock provider and its test-side handle.
    ///
    /// The `cancel` token should be shared with the `RunConfig` — when
    /// cancelled, `discover()` returns `None` to break the main loop.
    pub fn new(cancel: CancellationToken) -> (Arc<Self>, MockProviderHandle) {
        Self::with_poll_delay(cancel, None)
    }

    /// Create a mock provider with an explicit poll delay.
    ///
    /// When set, `discover()` sleeps for this duration before checking the
    /// channel. This simulates ApiProvider's HTTP poll timer — if the main
    /// loop cancels and recreates `discover()` (e.g. not pinned), the sleep
    /// restarts from scratch and jobs are never discovered.
    pub fn with_poll_delay(
        cancel: CancellationToken,
        poll_delay: Option<Duration>,
    ) -> (Arc<Self>, MockProviderHandle) {
        let (tx, rx) = mpsc::unbounded_channel();
        let completions = Arc::new(StdMutex::new(Vec::new()));
        let heartbeats = Arc::new(StdMutex::new(Vec::new()));
        let discover_entered = Arc::new(Notify::new());
        let completion_notify = Arc::new(Notify::new());
        let provider = Arc::new(Self {
            discovery: Mutex::new(rx),
            poll_delay,
            claim_results: StdMutex::new(HashMap::new()),
            completions: Arc::clone(&completions),
            heartbeats: Arc::clone(&heartbeats),
            cancel,
            discover_entered: Arc::clone(&discover_entered),
            completion_notify: Arc::clone(&completion_notify),
        });
        let handle = MockProviderHandle {
            discover_tx: tx,
            completions,
            heartbeats,
            discover_entered,
            completion_notify,
        };
        (provider, handle)
    }

    /// Pre-configure the result for a future `claim(run_id)` call.
    /// Pass `Some(ctx)` for success, `None` to simulate a 409 conflict.
    pub fn set_claim_result(&self, run_id: RunId, result: Option<ExecutionContext>) {
        self.claim_results
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(run_id, result);
    }
}

impl MockProviderHandle {
    /// Wait for a specific run's completion to appear, with timeout.
    ///
    /// Event-driven — see [`MockJobProvider::completion_notify`] for the
    /// full rationale. `timeout` is a diagnostic cap for genuine hangs,
    /// not a wall-clock work budget.
    pub async fn wait_completion(&self, run_id: RunId, timeout: Duration) -> Option<Completion> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let notified = self.completion_notify.notified();
            tokio::pin!(notified);
            // Register interest before checking the vec — any notify_waiters
            // fired after this enable() will wake this future.
            notified.as_mut().enable();

            {
                let comps = self.completions.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(c) = comps.iter().find(|c| c.run_id == run_id) {
                    return Some(c.clone());
                }
            }

            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return None;
            }
            if tokio::time::timeout(remaining, notified).await.is_err() {
                return None;
            }
        }
    }

    /// Return the number of heartbeats recorded so far.
    pub fn heartbeat_count(&self) -> usize {
        self.heartbeats
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len()
    }
}

#[async_trait]
impl JobProvider for MockJobProvider {
    /// Block until a job is pushed or the token is cancelled.
    ///
    /// Holds `self.discovery` Mutex for the entire call — same as
    /// `ApiProvider::discover()`. This is critical for regression tests:
    ///
    /// - If `poll_delay` is set, the delay must complete before checking
    ///   the channel. Without pinning (#8783), heartbeat ticks cancel and
    ///   recreate this future, restarting the delay from scratch.
    /// - If the caller fails to drop this future before `shutdown()` (#8898),
    ///   the Mutex deadlocks — exactly reproducing the production bug.
    async fn discover(&self) -> Option<(RunId, String)> {
        let mut rx = self.discovery.lock().await;
        if let Some(delay) = self.poll_delay {
            tokio::time::sleep(delay).await;
        }
        // Signal tests that the future has reached its await point — the
        // main loop has polled `discover_fut`, the discovery Mutex is held,
        // and we are about to park on `rx.recv()`. Tests ordering actions
        // against this state use `handle.discover_entered.notified()`.
        self.discover_entered.notify_one();
        tokio::select! {
            result = rx.recv() => result,
            () = self.cancel.cancelled() => None,
        }
    }

    async fn claim(&self, run_id: RunId) -> Option<ExecutionContext> {
        self.claim_results
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&run_id)
            .flatten()
    }

    async fn complete(
        &self,
        run_id: RunId,
        exit_code: i32,
        error: Option<&str>,
        sandbox_id: Option<SandboxId>,
        reuse_result: Option<SandboxReuseResult>,
    ) {
        self.completions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(Completion {
                run_id,
                exit_code,
                error: error.map(String::from),
                sandbox_id,
                reuse_result,
            });
        // Wake all pending `wait_completion` waiters — they re-scan the vec
        // and return if their run_id is now present.
        self.completion_notify.notify_waiters();
    }

    async fn heartbeat(&self, state: &HeartbeatState) {
        self.heartbeats
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(state.clone());
    }

    /// Acquire the discovery Mutex — same as `ApiProvider::shutdown()`.
    ///
    /// If `discover()` is still alive and holding the Mutex, this deadlocks.
    /// The main loop must `drop(discover_fut)` before calling this.
    async fn shutdown(&self) {
        let _lock = self.discovery.lock().await;
    }
}
