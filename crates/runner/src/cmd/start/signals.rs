use std::collections::HashMap;
use std::sync::Arc;

use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

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

/// Signal-driven mode channel shared between the signal handler task and
/// the main run loop.
///
/// The `RunnerMode` enum is the single source of truth for runner lifecycle
/// state — `mode_tx` has two writers (the handler for external signals,
/// and the main loop for the internal Draining → Stopping transition when
/// `jobs.is_empty()`).
pub(crate) struct SignalController {
    pub mode_rx: tokio::sync::watch::Receiver<RunnerMode>,
    pub mode_tx: tokio::sync::watch::Sender<RunnerMode>,
    /// Abort handle for the spawned signal-handler task. `None` for test
    /// overrides where no task was spawned. Teardown calls `.abort()` to
    /// reap the task symmetrically with `mitm_retry.handle.abort()` — the
    /// handler otherwise would run until runtime drop, which is safe for
    /// the runner binary but leaks the task when `run()` is embedded in a
    /// longer-lived host runtime.
    pub handler_abort: Option<tokio::task::AbortHandle>,
}

impl SignalController {
    /// Spawn the signal-handler task and return a controller handle.
    ///
    /// Signal semantics:
    /// - **SIGUSR1** (drain): from `Running`, send `Draining` (soft,
    ///   resumable). Ignored from any other state.
    /// - **SIGUSR2** (resume): from `Draining`, send `Running` (resume normal
    ///   discovery). Ignored from `Running` / `Stopping` / `Stopped`.
    /// - **SIGTERM / SIGINT** (hard): send `Stopping`, cancel every in-flight
    ///   job's token, cancel the discovery token. Bypasses the soft drain
    ///   so `systemctl stop` exits promptly rather than waiting up to
    ///   `JOB_TIMEOUT = 2h` for jobs to finish naturally.
    ///
    /// ## Race handling
    ///
    /// `handle_stopping_signal` sends Stopping **before** locking
    /// `cancel_tokens`. This ordering lets the main loop close the TOCTOU
    /// window where a new job is claimed between the handler's iteration
    /// and its own token insert: the main loop re-reads `mode_rx` after
    /// insert and sees Stopping via watch's write/read fence.
    ///
    /// ## Lifetime
    ///
    /// The spawned task loops forever and is implicitly cancelled when the
    /// tokio runtime is dropped. Its `JoinHandle` is discarded — panics in
    /// the handler will be logged by tokio but not surfaced.
    pub(super) fn spawn(
        cancel: CancellationToken,
        cancel_tokens: Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>>,
        signals: EarlySignals,
    ) -> Self {
        let (mode_tx, mode_rx) = tokio::sync::watch::channel(RunnerMode::Running);
        let tx_for_task = mode_tx.clone();
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
                        handle_stopping_signal("SIGTERM", &cancel, &cancel_tokens, &tx_for_task).await;
                    }
                    _ = sigint.recv() => {
                        handle_stopping_signal("SIGINT", &cancel, &cancel_tokens, &tx_for_task).await;
                    }
                    _ = sigusr1.recv() => {
                        handle_drain_signal(&tx_for_task);
                    }
                    _ = sigusr2.recv() => {
                        handle_resume_signal(&tx_for_task);
                    }
                }
            }
        });
        Self {
            mode_rx,
            mode_tx,
            handler_abort: Some(handle.abort_handle()),
        }
    }
}

pub(super) fn handle_drain_signal(mode_tx: &tokio::sync::watch::Sender<RunnerMode>) {
    let current = *mode_tx.borrow();
    if current != RunnerMode::Running {
        warn!(mode = ?current, "SIGUSR1 ignored — only valid from Running");
        return;
    }
    info!("received SIGUSR1, entering Draining (soft drain)");
    let _ = mode_tx.send(RunnerMode::Draining);
}

pub(super) fn handle_resume_signal(mode_tx: &tokio::sync::watch::Sender<RunnerMode>) {
    let current = *mode_tx.borrow();
    if current != RunnerMode::Draining {
        warn!(mode = ?current, "SIGUSR2 ignored — only valid from Draining");
        return;
    }
    info!("received SIGUSR2, resuming to Running");
    let _ = mode_tx.send(RunnerMode::Running);
}

pub(super) async fn handle_stopping_signal(
    name: &str,
    cancel: &CancellationToken,
    cancel_tokens: &Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>>,
    mode_tx: &tokio::sync::watch::Sender<RunnerMode>,
) {
    if *mode_tx.borrow() == RunnerMode::Stopping {
        warn!(signal = name, "already Stopping, ignoring repeat");
        return;
    }
    info!(signal = name, "initiating hard shutdown");
    // Send Stopping *before* locking cancel_tokens so that the main loop's
    // post-insert `mode_rx.borrow()` check catches any job claimed after
    // our iteration but before send would otherwise publish the state.
    let _ = mode_tx.send(RunnerMode::Stopping);
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
        );
        let mut mode_rx = controller.mode_rx;

        tokio::time::timeout(Duration::from_secs(2), mode_rx.changed())
            .await
            .expect("buffered SIGUSR1 should drive mode within 2s")
            .expect("mode channel closed");
        assert_eq!(*mode_rx.borrow(), RunnerMode::Draining);

        // Abort so the task releases its Signal stream subscriptions
        // and does not linger to consume signals raised by later tests.
        if let Some(abort) = controller.handler_abort {
            abort.abort();
        }
    }

    /// `handle_drain_signal` state guard: SIGUSR1 is honored only from
    /// Running. Mirrors `handle_resume_signal`'s Draining-only guard.
    #[test]
    fn drain_signal_state_guards() {
        // Running → Draining (sanity: the one legal transition).
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Running);
        handle_drain_signal(&tx);
        assert_eq!(*tx.borrow(), RunnerMode::Draining);

        // Draining → ignored (no self-transition).
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Draining);
        handle_drain_signal(&tx);
        assert_eq!(*tx.borrow(), RunnerMode::Draining);

        // Stopping → ignored (cannot reverse teardown).
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Stopping);
        handle_drain_signal(&tx);
        assert_eq!(*tx.borrow(), RunnerMode::Stopping);

        // Stopped → ignored (runner has exited its loop).
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Stopped);
        handle_drain_signal(&tx);
        assert_eq!(*tx.borrow(), RunnerMode::Stopped);
    }

    /// `handle_resume_signal` state guard: SIGUSR2 is honored only from
    /// Draining. The integration test `resume_after_stopping_is_ignored`
    /// covers the Stopping case; this pins the full matrix as a unit test.
    #[test]
    fn resume_signal_state_guards() {
        // Draining → Running (sanity: the one legal transition).
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Draining);
        handle_resume_signal(&tx);
        assert_eq!(*tx.borrow(), RunnerMode::Running);

        // Running → ignored (nothing to resume from).
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Running);
        handle_resume_signal(&tx);
        assert_eq!(*tx.borrow(), RunnerMode::Running);

        // Stopping → ignored (too late).
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Stopping);
        handle_resume_signal(&tx);
        assert_eq!(*tx.borrow(), RunnerMode::Stopping);

        // Stopped → ignored.
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Stopped);
        handle_resume_signal(&tx);
        assert_eq!(*tx.borrow(), RunnerMode::Stopped);
    }

    /// `handle_stopping_signal` idempotency: a repeat invocation takes the
    /// "already Stopping" guard and returns without re-iterating
    /// `cancel_tokens` or re-cancelling `cancel`.
    #[tokio::test]
    async fn stopping_signal_repeat_is_idempotent() {
        let (tx, _rx) = tokio::sync::watch::channel(RunnerMode::Running);
        let cancel = CancellationToken::new();
        let tokens: Arc<tokio::sync::Mutex<HashMap<RunId, CancellationToken>>> =
            Arc::new(tokio::sync::Mutex::new(HashMap::new()));

        // First call: transitions, cancels main cancel.
        handle_stopping_signal("SIGTERM", &cancel, &tokens, &tx).await;
        assert_eq!(*tx.borrow(), RunnerMode::Stopping);
        assert!(cancel.is_cancelled());

        // Insert a sentinel token *after* the first call so we can prove
        // the repeat did not re-iterate the map.
        let sentinel = CancellationToken::new();
        tokens
            .lock()
            .await
            .insert(RunId::new_v4(), sentinel.clone());

        // Repeat call: must early-return on the already-Stopping guard.
        handle_stopping_signal("SIGTERM", &cancel, &tokens, &tx).await;
        assert_eq!(*tx.borrow(), RunnerMode::Stopping);
        assert!(
            !sentinel.is_cancelled(),
            "repeat must not re-iterate cancel_tokens and cancel late-inserted sentinel",
        );
    }
}
