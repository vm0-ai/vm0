use std::collections::HashMap;
use std::sync::Arc;

use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::idle_pool::ParkingGate;
use crate::ids::RunId;
use crate::status::RunnerMode;

/// Pre-registered signal streams.
///
/// Tokio's `signal()` installs the process-wide `sigaction` handler on its
/// first call per signal kind; before that call, the default disposition
/// (Term for all four of these) applies. If a drain SIGUSR1 arrives during
/// startup (e.g. `service install` immediately followed by `service drain`
/// while the runner is still warming factories), the default action kills
/// the process and systemd restarts the unit with no one to drain it —
/// the new PID stays `Running` forever. See issue #10416.
///
/// Registering all four streams at the top of `run_start` before any
/// slow work (config load, runtime/factory boot) closes the race: the
/// sigaction handler is in place and the listener exists, so signals
/// arriving at any point after registration are queued in the listener's
/// watch channel and observed by [`SignalController`] as soon as its task
/// is spawned.
pub(super) struct EarlySignals {
    sigterm: tokio::signal::unix::Signal,
    sigint: tokio::signal::unix::Signal,
    sigusr1: tokio::signal::unix::Signal,
    sigusr2: tokio::signal::unix::Signal,
}

impl EarlySignals {
    /// Register the four lifecycle signals (SIGTERM/SIGINT/SIGUSR1/SIGUSR2)
    /// so they don't fall to their default Term disposition during startup.
    ///
    /// Each `signal()` both installs the process-wide `sigaction` handler
    /// (idempotent via `OnceCell`) and subscribes a fresh watch receiver.
    /// Bind them via `let` rather than a struct literal so that if a later
    /// call fails with `?`, the already-subscribed earlier receivers are
    /// dropped (and unsubscribed) on the error path — obvious at a glance.
    pub(super) fn register() -> std::io::Result<Self> {
        use tokio::signal::unix::{SignalKind, signal};
        let sigterm = signal(SignalKind::terminate())?;
        let sigint = signal(SignalKind::interrupt())?;
        let sigusr1 = signal(SignalKind::user_defined1())?;
        let sigusr2 = signal(SignalKind::user_defined2())?;
        Ok(Self {
            sigterm,
            sigint,
            sigusr1,
            sigusr2,
        })
    }
}

/// Ordered lifecycle transition handle shared between signal handlers, tests,
/// and the main run loop's internal Draining -> Stopping transition.
///
/// Parking state is updated before publishing the externally visible mode so a
/// task that observes `Running` can also rely on parking already being open.
#[derive(Clone)]
pub(crate) struct LifecycleController {
    mode_tx: tokio::sync::watch::Sender<RunnerMode>,
    parking_gate: ParkingGate,
}

impl LifecycleController {
    pub(crate) fn new(
        mode_tx: tokio::sync::watch::Sender<RunnerMode>,
        parking_gate: ParkingGate,
    ) -> Self {
        Self {
            mode_tx,
            parking_gate,
        }
    }

    pub(crate) fn current_mode(&self) -> RunnerMode {
        *self.mode_tx.borrow()
    }

    #[cfg(test)]
    pub(crate) fn mode_tx(&self) -> &tokio::sync::watch::Sender<RunnerMode> {
        &self.mode_tx
    }

    pub(crate) fn enter_soft_drain(&self) -> bool {
        let gate = self.parking_gate.clone();
        let mut transitioned = false;
        let _ = self.mode_tx.send_if_modified(|mode| {
            if *mode == RunnerMode::Running && gate.soft_drain() {
                *mode = RunnerMode::Draining;
                transitioned = true;
                true
            } else {
                false
            }
        });
        transitioned
    }

    pub(crate) fn resume_from_soft_drain(&self) -> bool {
        let gate = self.parking_gate.clone();
        let mut transitioned = false;
        let _ = self.mode_tx.send_if_modified(|mode| {
            if *mode == RunnerMode::Draining && gate.open_after_soft_drain() {
                *mode = RunnerMode::Running;
                transitioned = true;
                true
            } else {
                false
            }
        });
        transitioned
    }

    pub(crate) fn hard_stop(&self) -> bool {
        let gate = self.parking_gate.clone();
        let mut transitioned = false;
        let _ = self.mode_tx.send_if_modified(|mode| {
            if *mode != RunnerMode::Stopping {
                gate.close();
                *mode = RunnerMode::Stopping;
                transitioned = true;
                true
            } else {
                false
            }
        });
        transitioned
    }

    pub(crate) fn stop_after_natural_drain(&self) -> bool {
        let gate = self.parking_gate.clone();
        let mut transitioned = false;
        let _ = self.mode_tx.send_if_modified(|mode| {
            if *mode == RunnerMode::Draining {
                gate.close();
                *mode = RunnerMode::Stopping;
                transitioned = true;
                true
            } else {
                false
            }
        });
        transitioned
    }

    pub(crate) fn close_parking(&self) {
        self.parking_gate.close();
    }
}

/// Signal-driven mode channel shared between the signal handler task and
/// the main run loop.
pub(crate) struct SignalController {
    pub mode_rx: tokio::sync::watch::Receiver<RunnerMode>,
    pub lifecycle: LifecycleController,
    /// Spawned signal-handler task. `None` for test overrides where no real
    /// task was spawned. Teardown aborts and awaits this handle so the task
    /// releases its signal stream subscriptions before `run()` returns. If
    /// `run()` is externally cancelled before teardown, dropping this wrapper
    /// still aborts the task so it cannot outlive its runner.
    pub handler_task: Option<SignalHandlerTask>,
}

pub(crate) struct SignalHandlerTask {
    handle: Option<tokio::task::JoinHandle<()>>,
}

impl SignalHandlerTask {
    pub(crate) fn new(handle: tokio::task::JoinHandle<()>) -> Self {
        Self {
            handle: Some(handle),
        }
    }

    pub(super) async fn abort_and_wait(mut self) -> Result<(), tokio::task::JoinError> {
        let Some(handle) = self.handle.take() else {
            return Ok(());
        };
        handle.abort();
        handle.await
    }

    async fn wait(&mut self) -> Result<(), String> {
        match self.handle.as_mut() {
            Some(handle) => handle.await.map_err(|error| error.to_string()),
            None => Err("signal handler task handle missing".to_string()),
        }
    }
}

impl Drop for SignalHandlerTask {
    fn drop(&mut self) {
        if let Some(handle) = &self.handle {
            handle.abort();
        }
    }
}

impl SignalController {
    /// Spawn the signal-handler task and return a controller handle.
    ///
    /// Signal semantics:
    /// - **SIGUSR1** (drain): from `Running`, close parking for soft drain,
    ///   then send `Draining`. Ignored from any other state.
    /// - **SIGUSR2** (resume): from `Draining`, reopen parking, then send
    ///   `Running` (resume normal discovery). Ignored from `Running` /
    ///   `Stopping` / `Stopped`.
    /// - **SIGTERM / SIGINT** (hard): close parking, send `Stopping`, cancel
    ///   every in-flight job's token, cancel the discovery token. Bypasses the
    ///   soft drain so `systemctl stop` exits promptly rather than waiting up
    ///   to `JOB_TIMEOUT = 2h` for jobs to finish naturally.
    ///
    /// ## Race handling
    ///
    /// `handle_stopping_signal` closes parking and sends Stopping **before**
    /// locking `cancel_tokens`. This ordering lets the main loop close the
    /// TOCTOU window where a new job is claimed between the handler's
    /// iteration and its own token insert: the main loop re-reads `mode_rx`
    /// after insert and sees Stopping via watch's write/read fence.
    ///
    /// ## Lifetime
    ///
    /// The spawned task owns the registered signal streams and normally runs
    /// until `run()` teardown aborts and awaits `handler_task`. Test overrides
    /// construct a controller with no real handler task.
    pub(super) fn spawn(
        cancel: CancellationToken,
        cancel_tokens: Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>>,
        signals: EarlySignals,
        parking_gate: ParkingGate,
    ) -> Self {
        let (mode_tx, mode_rx) = tokio::sync::watch::channel(RunnerMode::Running);
        let lifecycle = LifecycleController::new(mode_tx, parking_gate);
        let lifecycle_for_task = lifecycle.clone();
        let EarlySignals {
            mut sigterm,
            mut sigint,
            mut sigusr1,
            mut sigusr2,
        } = signals;
        let handle = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = sigterm.recv() => {
                        handle_stopping_signal("SIGTERM", &cancel, &cancel_tokens, &lifecycle_for_task).await;
                    }
                    _ = sigint.recv() => {
                        handle_stopping_signal("SIGINT", &cancel, &cancel_tokens, &lifecycle_for_task).await;
                    }
                    _ = sigusr1.recv() => {
                        handle_drain_signal(&lifecycle_for_task);
                    }
                    _ = sigusr2.recv() => {
                        handle_resume_signal(&lifecycle_for_task);
                    }
                }
            }
        });
        Self {
            mode_rx,
            lifecycle,
            handler_task: Some(SignalHandlerTask::new(handle)),
        }
    }
}

/// Await a signal-handler task, or pend forever when tests supply no task.
///
/// This mirrors the retry-task helper used by the main loop: keeping the
/// `Option` outside the future lets `tokio::select!` watch the task without
/// taking ownership unless it actually completes.
pub(super) async fn recv_handler_task(
    handler_task: &mut Option<SignalHandlerTask>,
) -> Result<(), String> {
    match handler_task {
        Some(task) => {
            let result = task.wait().await;
            *handler_task = None;
            result
        }
        None => std::future::pending().await,
    }
}

pub(super) fn handle_drain_signal(lifecycle: &LifecycleController) {
    let current = lifecycle.current_mode();
    if !lifecycle.enter_soft_drain() {
        warn!(mode = ?current, "SIGUSR1 ignored — only valid from Running");
        return;
    }
    info!("received SIGUSR1, entering Draining (soft drain)");
}

pub(super) fn handle_resume_signal(lifecycle: &LifecycleController) {
    let current = lifecycle.current_mode();
    if !lifecycle.resume_from_soft_drain() {
        warn!(mode = ?current, "SIGUSR2 ignored — only valid from Draining");
        return;
    }
    info!("received SIGUSR2, resuming to Running");
}

pub(super) async fn handle_stopping_signal(
    name: &str,
    cancel: &CancellationToken,
    cancel_tokens: &Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>>,
    lifecycle: &LifecycleController,
) {
    if lifecycle.current_mode() == RunnerMode::Stopping {
        lifecycle.close_parking();
        warn!(signal = name, "already Stopping, ignoring repeat");
        return;
    }
    info!(signal = name, "initiating hard shutdown");
    // Close parking and send Stopping *before* locking cancel_tokens so that
    // the main loop's
    // post-insert `mode_rx.borrow()` check catches any job claimed after
    // our iteration but before send would otherwise publish the state.
    lifecycle.hard_stop();
    let tokens = cancel_tokens.lock().await;
    let count = tokens.len();
    for (run_id, token) in tokens.iter() {
        info!(run_id = %run_id, "cancelling active job for hard shutdown");
        token.cancel();
    }
    drop(tokens);
    info!(active_jobs = count, "dispatched per-job cancellations");
    cancel.cancel();
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    /// Regression test for issue #10416: SIGUSR1 arriving between
    /// `EarlySignals::register()` and `SignalController::spawn` must still
    /// drive the mode transition. Previously the handler was registered
    /// inside the spawned task, so signals delivered during the startup
    /// window hit the default Term disposition and killed the process.
    ///
    /// Timing: raising SIGUSR1 before `spawn()` is deterministic in program
    /// order, and the outer `timeout(2s)` absorbs the
    /// `kernel → sigaction → pipe → driver → watch → recv` propagation
    /// regardless of scheduling — no artificial sleep is needed.
    ///
    /// This test raises SIGUSR1 process-wide. It is safe only because no
    /// other test subscribes to SIGUSR1 — all other tests use
    /// `SignalSource::Override` and never call `signal()`. If another
    /// signal-raising test is added, serialize them (e.g. with a
    /// `Mutex` shared via `OnceLock`) to avoid cross-talk.
    #[tokio::test]
    async fn signal_buffered_before_spawn_is_delivered() {
        let signals = EarlySignals::register().expect("register");

        nix::sys::signal::raise(nix::sys::signal::Signal::SIGUSR1).expect("raise");

        let controller = SignalController::spawn(
            CancellationToken::new(),
            Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            signals,
            ParkingGate::new_open(),
        );
        let mut mode_rx = controller.mode_rx;

        tokio::time::timeout(Duration::from_secs(2), mode_rx.changed())
            .await
            .expect("buffered SIGUSR1 should drive mode within 2s")
            .expect("mode channel closed");
        assert_eq!(*mode_rx.borrow(), RunnerMode::Draining);

        // Abort so the task releases its Signal stream subscriptions
        // and does not linger to consume signals raised by later tests.
        if let Some(handler_task) = controller.handler_task {
            let result = handler_task
                .abort_and_wait()
                .await
                .expect_err("signal handler should be cancelled");
            assert!(result.is_cancelled());
        }
    }

    #[tokio::test]
    async fn recv_handler_task_clears_completed_task() {
        let mut handler_task = Some(SignalHandlerTask::new(tokio::spawn(async {})));

        recv_handler_task(&mut handler_task)
            .await
            .expect("completed handler task");

        assert!(handler_task.is_none());
    }

    #[tokio::test]
    async fn recv_handler_task_reports_cancelled_task() {
        let task = tokio::spawn(std::future::pending::<()>());
        task.abort();
        let mut handler_task = Some(SignalHandlerTask::new(task));

        let result = recv_handler_task(&mut handler_task)
            .await
            .expect_err("cancelled handler task should be reported");

        assert!(result.contains("cancelled"));
        assert!(handler_task.is_none());
    }

    #[tokio::test]
    async fn dropping_handler_task_aborts_task() {
        struct NotifyOnDrop(Arc<tokio::sync::Notify>);

        impl Drop for NotifyOnDrop {
            fn drop(&mut self) {
                self.0.notify_one();
            }
        }

        let started = Arc::new(tokio::sync::Notify::new());
        let dropped = Arc::new(tokio::sync::Notify::new());
        let task = {
            let started = Arc::clone(&started);
            let dropped = Arc::clone(&dropped);
            tokio::spawn(async move {
                let _guard = NotifyOnDrop(dropped);
                started.notify_one();
                std::future::pending::<()>().await;
            })
        };
        let handler_task = SignalHandlerTask::new(task);
        tokio::time::timeout(Duration::from_secs(2), started.notified())
            .await
            .expect("signal handler test task should start");

        drop(handler_task);

        tokio::time::timeout(Duration::from_secs(2), dropped.notified())
            .await
            .expect("dropping signal handler task should abort the task");
    }

    /// `handle_drain_signal` state guard: SIGUSR1 is honored only from
    /// Running. Mirrors `handle_resume_signal`'s Draining-only guard.
    #[test]
    fn drain_signal_state_guards() {
        use crate::idle_pool::ParkingState;

        // Running → Draining (sanity: the one legal transition).
        let gate = ParkingGate::new_open();
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Running);
        let lifecycle = LifecycleController::new(tx, gate.clone());
        handle_drain_signal(&lifecycle);
        assert_eq!(lifecycle.current_mode(), RunnerMode::Draining);
        assert_eq!(gate.state(), ParkingState::SoftDraining);

        // Draining → ignored (no self-transition).
        let gate = ParkingGate::new_open();
        gate.soft_drain();
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Draining);
        let lifecycle = LifecycleController::new(tx, gate.clone());
        handle_drain_signal(&lifecycle);
        assert_eq!(lifecycle.current_mode(), RunnerMode::Draining);
        assert_eq!(gate.state(), ParkingState::SoftDraining);

        // Stopping → ignored (cannot reverse teardown).
        let gate = ParkingGate::new_open();
        gate.close();
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Stopping);
        let lifecycle = LifecycleController::new(tx, gate.clone());
        handle_drain_signal(&lifecycle);
        assert_eq!(lifecycle.current_mode(), RunnerMode::Stopping);
        assert_eq!(gate.state(), ParkingState::Closed);

        // Stopped → ignored (runner has exited its loop).
        let gate = ParkingGate::new_open();
        gate.close();
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Stopped);
        let lifecycle = LifecycleController::new(tx, gate.clone());
        handle_drain_signal(&lifecycle);
        assert_eq!(lifecycle.current_mode(), RunnerMode::Stopped);
        assert_eq!(gate.state(), ParkingState::Closed);
    }

    /// `handle_resume_signal` state guard: SIGUSR2 is honored only from
    /// Draining. The integration test `resume_after_stopping_is_ignored`
    /// covers the Stopping case; this pins the full matrix as a unit test.
    #[test]
    fn resume_signal_state_guards() {
        use crate::idle_pool::ParkingState;

        // Draining → Running (sanity: the one legal transition).
        let gate = ParkingGate::new_open();
        gate.soft_drain();
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Draining);
        let lifecycle = LifecycleController::new(tx, gate.clone());
        handle_resume_signal(&lifecycle);
        assert_eq!(lifecycle.current_mode(), RunnerMode::Running);
        assert_eq!(gate.state(), ParkingState::Open);

        // Running → ignored (nothing to resume from).
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Running);
        let gate = ParkingGate::new_open();
        let lifecycle = LifecycleController::new(tx, gate.clone());
        handle_resume_signal(&lifecycle);
        assert_eq!(lifecycle.current_mode(), RunnerMode::Running);
        assert_eq!(gate.state(), ParkingState::Open);

        // Stopping → ignored (too late).
        let gate = ParkingGate::new_open();
        gate.close();
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Stopping);
        let lifecycle = LifecycleController::new(tx, gate.clone());
        handle_resume_signal(&lifecycle);
        assert_eq!(lifecycle.current_mode(), RunnerMode::Stopping);
        assert_eq!(gate.state(), ParkingState::Closed);

        // Stopped → ignored.
        let gate = ParkingGate::new_open();
        gate.close();
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Stopped);
        let lifecycle = LifecycleController::new(tx, gate.clone());
        handle_resume_signal(&lifecycle);
        assert_eq!(lifecycle.current_mode(), RunnerMode::Stopped);
        assert_eq!(gate.state(), ParkingState::Closed);
    }

    /// `handle_stopping_signal` idempotency: a repeat invocation takes the
    /// "already Stopping" guard and returns without re-iterating
    /// `cancel_tokens` or re-cancelling `cancel`.
    #[tokio::test]
    async fn stopping_signal_repeat_is_idempotent() {
        use crate::idle_pool::ParkingState;

        let gate = ParkingGate::new_open();
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Running);
        let lifecycle = LifecycleController::new(tx, gate.clone());
        let cancel = CancellationToken::new();
        let tokens: Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>> =
            Arc::new(tokio::sync::Mutex::new(HashMap::new()));

        // First call: transitions, cancels main cancel.
        handle_stopping_signal("SIGTERM", &cancel, &tokens, &lifecycle).await;
        assert_eq!(lifecycle.current_mode(), RunnerMode::Stopping);
        assert_eq!(gate.state(), ParkingState::Closed);
        assert!(cancel.is_cancelled());

        // Insert a sentinel token *after* the first call so we can prove
        // the repeat did not re-iterate the map.
        let sentinel = CancellationToken::new();
        tokens
            .lock()
            .await
            .insert(RunId::new_v4(), sentinel.clone());

        // Repeat call: must early-return on the already-Stopping guard.
        handle_stopping_signal("SIGTERM", &cancel, &tokens, &lifecycle).await;
        assert_eq!(lifecycle.current_mode(), RunnerMode::Stopping);
        assert_eq!(gate.state(), ParkingState::Closed);
        assert!(
            !sentinel.is_cancelled(),
            "repeat must not re-iterate cancel_tokens and cancel late-inserted sentinel",
        );
    }
}
