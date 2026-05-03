use std::process::{Child, ExitStatus};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use crate::drain::drain_into_vec_cancellable;
use crate::process::{extract_exit_code, kill_process_tree};

/// Exit code returned when command times out (same as bash/Python)
pub(crate) const EXIT_CODE_TIMEOUT: i32 = 124;

/// After the child process exits, continue draining stdout/stderr for this
/// many seconds. If EOF is not received within this deadline, proceed to
/// `send_process_exit()` anyway to prevent indefinite hangs when orphaned
/// child processes hold pipe fds open.
pub(crate) const DRAIN_DEADLINE_SECS: u64 = 5;

/// Outcome of [`wait_with_kill_timeout`].
pub(crate) enum WaitOutcome {
    /// Child exited with this status.
    Exited(ExitStatus),
    /// Child was killed by the timeout watchdog.
    TimedOut,
    /// `wait()` itself failed; carries the error message.
    WaitFailed(String),
}

/// Watchdog that kills a child process tree if it is not stood down before
/// `timeout` elapses.
#[must_use = "watchdogs must be stood down and joined so timeout verdicts are observed"]
pub(crate) struct KillWatchdog {
    done_tx: Option<mpsc::Sender<()>>,
    handle: thread::JoinHandle<bool>,
}

impl KillWatchdog {
    pub(crate) fn spawn(child_id: u32, timeout: Duration) -> Self {
        let (done_tx, done_rx) = mpsc::channel::<()>();
        let handle = thread::spawn(move || -> bool {
            if done_rx.recv_timeout(timeout).is_err() {
                // SAFETY: child_id is a valid PID from Command::spawn.
                return unsafe { kill_process_tree(child_id) };
            }
            false
        });

        Self {
            done_tx: Some(done_tx),
            handle,
        }
    }

    /// Stand the watchdog down without joining it yet.
    ///
    /// This lets callers preserve existing timing where the child has exited,
    /// the watchdog is disarmed immediately, and the join verdict is collected
    /// after other cleanup work.
    pub(crate) fn stand_down(&mut self) {
        if let Some(done_tx) = self.done_tx.take() {
            let _ = done_tx.send(());
        }
    }

    pub(crate) fn join(mut self) -> bool {
        self.stand_down();
        self.handle.join().unwrap_or(false)
    }
}

/// Wait for drain workers to complete within the shared drain deadline, then
/// cancel any laggards.
pub(crate) fn await_drain_deadline(
    done_rx: &mpsc::Receiver<()>,
    expected: usize,
    cancel: &AtomicBool,
) -> usize {
    let deadline = Instant::now() + Duration::from_secs(DRAIN_DEADLINE_SECS);
    let mut completed = 0usize;
    while completed < expected {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match done_rx.recv_timeout(remaining) {
            Ok(()) => completed += 1,
            Err(_) => break,
        }
    }
    cancel.store(true, Ordering::Release);
    completed
}

/// Wait for `child` to exit, optionally killing it after `timeout_ms`.
/// `timeout_ms == 0` means "no timeout".
///
/// This **does not touch stdout/stderr** — caller must take them off the
/// `Child` and drain them concurrently (see [`drain_until_eof_or_cancelled`]),
/// otherwise a child producing more than the kernel pipe buffer (~64 KB) will
/// deadlock on its next write while we wait.
pub(crate) fn wait_with_kill_timeout(mut child: Child, timeout_ms: u32) -> WaitOutcome {
    if timeout_ms == 0 {
        return match child.wait() {
            Ok(s) => WaitOutcome::Exited(s),
            Err(e) => WaitOutcome::WaitFailed(e.to_string()),
        };
    }

    let timeout = Duration::from_millis(u64::from(timeout_ms));
    let child_id = child.id();

    // Watchdog: kills the process tree if the child does not report exit
    // before the timeout. Its return value is the timeout verdict.
    let watchdog = KillWatchdog::spawn(child_id, timeout);
    let status = child.wait();
    let killed_by_timeout = watchdog.join();

    match status {
        Ok(_) if killed_by_timeout => WaitOutcome::TimedOut,
        Ok(s) => WaitOutcome::Exited(s),
        Err(e) => WaitOutcome::WaitFailed(e.to_string()),
    }
}

/// Coordinate child wait + concurrent stdout/stderr drain + timeout-driven kill.
///
/// Drain threads run in parallel with `wait()` so a chatty child cannot
/// deadlock on a full pipe buffer. After the child exits we wait up to
/// [`DRAIN_DEADLINE_SECS`] for both drain threads to finish naturally
/// — that's the grace window for in-flight bytes. If the deadline elapses
/// (typically because an orphaned grandchild still holds the pipe), we set
/// the cancel flag; drain threads observe it within ~100 ms and return,
/// which drops the read end of the pipe. The orphan's next write then sees
/// EPIPE / SIGPIPE, so neither kernel pipe buffers nor our heap accumulate
/// further bytes.
pub(crate) fn wait_with_drain_and_timeout(
    mut child: Child,
    timeout_ms: u32,
) -> (WaitOutcome, Vec<u8>, Vec<u8>) {
    // Defensive: if either pipe is missing the caller broke the
    // `spawn_with_pipes` invariant. Reap the child before returning so we
    // don't leave a zombie — `Child`'s `Drop` doesn't wait.
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return (
                WaitOutcome::WaitFailed("missing stdout pipe".to_string()),
                Vec::new(),
                Vec::new(),
            );
        }
    };
    let stderr = match child.stderr.take() {
        Some(s) => s,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return (
                WaitOutcome::WaitFailed("missing stderr pipe".to_string()),
                Vec::new(),
                Vec::new(),
            );
        }
    };

    let cancel = Arc::new(AtomicBool::new(false));
    let (done_tx, done_rx) = mpsc::channel::<()>();

    let stdout_handle = {
        let cancel = cancel.clone();
        let tx = done_tx.clone();
        thread::spawn(move || {
            let buf = drain_into_vec_cancellable(stdout, &cancel);
            let _ = tx.send(());
            buf
        })
    };
    let stderr_handle = {
        let cancel = cancel.clone();
        let tx = done_tx.clone();
        thread::spawn(move || {
            let buf = drain_into_vec_cancellable(stderr, &cancel);
            let _ = tx.send(());
            buf
        })
    };
    drop(done_tx); // so recv returns Disconnected if both drain threads die

    let outcome = wait_with_kill_timeout(child, timeout_ms);

    let _ = await_drain_deadline(&done_rx, 2, &cancel);

    let stdout_buf = stdout_handle.join().unwrap_or_default();
    let stderr_buf = stderr_handle.join().unwrap_or_default();

    (outcome, stdout_buf, stderr_buf)
}

/// Resolve a [`WaitOutcome`] + drained bytes into the `(exit_code, stdout, stderr)`
/// triple the protocol returns. Timeout overrides any drained stderr with the
/// canonical "Timeout" body so callers can disambiguate from a real exit-1.
pub(crate) fn finalize_buffered_result(
    outcome: WaitOutcome,
    stdout: Vec<u8>,
    stderr_buf: Vec<u8>,
) -> (i32, Vec<u8>, Vec<u8>) {
    let (exit_code, stderr) = match outcome {
        WaitOutcome::TimedOut => (EXIT_CODE_TIMEOUT, b"Timeout".to_vec()),
        WaitOutcome::Exited(s) => (extract_exit_code(s), stderr_buf),
        WaitOutcome::WaitFailed(msg) => (1, format!("Failed to wait: {msg}").into_bytes()),
    };
    (exit_code, stdout, stderr)
}
