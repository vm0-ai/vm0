use std::process::{Child, ExitStatus};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use crate::process::{kill_and_reap_child, kill_process_tree};
use crate::threading::spawn_scoped_named;

/// After the child process exits, continue draining stdout/stderr for this
/// many seconds. If EOF is not received within this deadline, proceed to
/// the terminal exec result anyway to prevent indefinite hangs when orphaned
/// child processes hold pipe fds open.
pub(crate) const DRAIN_DEADLINE_SECS: u64 = 5;
const WATCHDOG_CANCEL_POLL_INTERVAL_MS: u64 = 50;
const THREAD_WAIT_WATCHDOG: &str = "vsock-wait-watchdog";

/// Outcome of child wait helpers.
pub(crate) enum WaitOutcome {
    /// Child exited with this status.
    Exited(ExitStatus),
    /// Child was killed after its timeout elapsed.
    TimedOut,
    /// Child was killed because its owning connection was cancelled.
    Cancelled,
    /// `wait()` itself failed; carries the error message.
    WaitFailed(String),
}

enum KillReason {
    Timeout,
    Cancelled,
}

struct WatchdogKill {
    reason: KillReason,
    killed: bool,
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
            Ok(status) => WaitOutcome::Exited(status),
            Err(e) => WaitOutcome::WaitFailed(e.to_string()),
        };
    }

    let cancel = AtomicBool::new(false);
    wait_with_kill_timeout_or_cancelled(child, timeout_ms, &cancel)
}

/// Wait for `child` to exit, killing and reaping it when either the configured
/// timeout expires or `cancel` is signalled.
///
/// `timeout_ms == 0` still means "no timeout"; cancellation remains active so
/// work tied to a disconnected host connection cannot outlive that connection
/// indefinitely.
pub(crate) fn wait_with_kill_timeout_or_cancelled(
    child: Child,
    timeout_ms: u32,
    cancel: &AtomicBool,
) -> WaitOutcome {
    wait_with_kill_timeout_or_cancelled_by(child, timeout_ms, || cancel.load(Ordering::Acquire))
}

/// Like [`wait_with_kill_timeout_or_cancelled`], but observes either cancel
/// flag. Exec operations have both connection-level cancellation and
/// request-level cancellation.
pub(crate) fn wait_with_kill_timeout_or_cancelled_either(
    child: Child,
    timeout_ms: u32,
    first_cancel: &AtomicBool,
    second_cancel: &AtomicBool,
) -> WaitOutcome {
    wait_with_kill_timeout_or_cancelled_by(child, timeout_ms, || {
        first_cancel.load(Ordering::Acquire) || second_cancel.load(Ordering::Acquire)
    })
}

fn wait_with_kill_timeout_or_cancelled_by(
    mut child: Child,
    timeout_ms: u32,
    is_cancelled: impl Fn() -> bool + Copy + Send + Sync,
) -> WaitOutcome {
    let child_id = child.id();
    let deadline = if timeout_ms > 0 {
        let now = Instant::now();
        Some(
            now.checked_add(Duration::from_millis(u64::from(timeout_ms)))
                .unwrap_or(now),
        )
    } else {
        None
    };

    thread::scope(|scope| {
        let (done_tx, done_rx) = mpsc::channel::<()>();
        let watchdog = match spawn_scoped_named(scope, THREAD_WAIT_WATCHDOG, move || {
            wait_for_done_timeout_or_cancelled(done_rx, deadline, is_cancelled, child_id)
        }) {
            Ok(watchdog) => watchdog,
            Err(e) => {
                // If the watchdog cannot be created, timeout/cancel can no
                // longer be enforced. Kill and reap the child instead of
                // letting it outlive the failed wait helper.
                kill_and_reap_child(child);
                return WaitOutcome::WaitFailed(format!("failed to spawn wait watchdog: {e}"));
            }
        };

        let status = child.wait();
        let _ = done_tx.send(());
        let watchdog_kill = match watchdog.join() {
            Ok(watchdog_kill) => watchdog_kill,
            Err(panic) => std::panic::resume_unwind(panic),
        };

        match status {
            Err(e) => WaitOutcome::WaitFailed(e.to_string()),
            Ok(status) => match watchdog_kill {
                Some(WatchdogKill {
                    reason,
                    killed: true,
                }) => match reason {
                    KillReason::Timeout => WaitOutcome::TimedOut,
                    KillReason::Cancelled => WaitOutcome::Cancelled,
                },
                _ => WaitOutcome::Exited(status),
            },
        }
    })
}

fn wait_for_done_timeout_or_cancelled(
    done_rx: mpsc::Receiver<()>,
    deadline: Option<Instant>,
    is_cancelled: impl Fn() -> bool,
    child_id: u32,
) -> Option<WatchdogKill> {
    let poll_interval = Duration::from_millis(WATCHDOG_CANCEL_POLL_INTERVAL_MS);

    loop {
        if wait_done(&done_rx) {
            return None;
        }

        let now = Instant::now();
        let wait_for = match deadline {
            Some(deadline) => {
                let remaining = deadline.saturating_duration_since(now);
                if remaining.is_zero() {
                    return kill_child_unless_done(&done_rx, child_id, KillReason::Timeout);
                }
                remaining.min(poll_interval)
            }
            None => poll_interval,
        };

        if is_cancelled() {
            return kill_child_unless_done(&done_rx, child_id, KillReason::Cancelled);
        }

        match done_rx.recv_timeout(wait_for) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => return None,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
}

fn wait_done(done_rx: &mpsc::Receiver<()>) -> bool {
    match done_rx.try_recv() {
        Ok(()) | Err(mpsc::TryRecvError::Disconnected) => true,
        Err(mpsc::TryRecvError::Empty) => false,
    }
}

fn kill_child_unless_done(
    done_rx: &mpsc::Receiver<()>,
    child_id: u32,
    reason: KillReason,
) -> Option<WatchdogKill> {
    if wait_done(done_rx) {
        None
    } else {
        Some(kill_child(child_id, reason))
    }
}

fn kill_child(child_id: u32, reason: KillReason) -> WatchdogKill {
    // SAFETY: child_id is a valid PID from Command::spawn.
    let killed = unsafe { kill_process_tree(child_id) }
        // SAFETY: child_id is a process id from Command::spawn.
        || unsafe { libc::kill(child_id as i32, libc::SIGKILL) == 0 };
    WatchdogKill { reason, killed }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::sync::Arc;

    #[test]
    fn fast_exit_wait_does_not_pay_cancel_poll_interval_per_child() {
        let iterations = 20u32;
        let mut baseline_total = Duration::default();
        let mut timed_total = Duration::default();

        fn wait_for_fast_child(timeout_ms: u32) -> Duration {
            let child = Command::new("true")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let start = Instant::now();
            let outcome = wait_with_kill_timeout(child, timeout_ms);
            let elapsed = start.elapsed();
            assert!(
                matches!(outcome, WaitOutcome::Exited(status) if status.success()),
                "unexpected wait outcome"
            );
            elapsed
        }

        for i in 0..iterations {
            if i % 2 == 0 {
                baseline_total += wait_for_fast_child(0);
                timed_total += wait_for_fast_child(30_000);
            } else {
                timed_total += wait_for_fast_child(30_000);
                baseline_total += wait_for_fast_child(0);
            }
        }

        let overhead = timed_total.saturating_sub(baseline_total);
        let allowed_overhead =
            Duration::from_millis(WATCHDOG_CANCEL_POLL_INTERVAL_MS * u64::from(iterations) / 2);
        assert!(
            overhead < allowed_overhead,
            "timed waits should not accumulate the {WATCHDOG_CANCEL_POLL_INTERVAL_MS}ms cancel \
             poll interval per child; {iterations} timed waits took {timed_total:?}, baseline \
             waits took {baseline_total:?}, overhead was {overhead:?}",
        );
    }

    #[test]
    fn timeout_zero_child_is_cancelled_by_external_cancel() {
        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_for_thread = Arc::clone(&cancel);
        let mut command = Command::new("sleep");
        command
            .arg("60")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let child = command.spawn().unwrap();

        let cancel_thread = thread::spawn(move || {
            cancel_for_thread.store(true, Ordering::Release);
        });

        let outcome = wait_with_kill_timeout_or_cancelled(child, 0, &cancel);
        cancel_thread.join().unwrap();

        assert!(matches!(outcome, WaitOutcome::Cancelled));
    }

    #[test]
    fn nonzero_timeout_child_is_cancelled_by_pre_signalled_cancel() {
        let cancel = AtomicBool::new(true);
        let mut command = Command::new("sleep");
        command
            .arg("60")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let child = command.spawn().unwrap();

        let outcome = wait_with_kill_timeout_or_cancelled(child, 30_000, &cancel);

        assert!(matches!(outcome, WaitOutcome::Cancelled));
    }

    #[test]
    fn watchdog_done_signal_wins_over_elapsed_deadline() {
        let cancel = AtomicBool::new(false);
        let (done_tx, done_rx) = mpsc::channel::<()>();
        done_tx.send(()).unwrap();

        let outcome = wait_for_done_timeout_or_cancelled(
            done_rx,
            Some(Instant::now()),
            || cancel.load(Ordering::Acquire),
            i32::MAX as u32,
        );

        assert!(outcome.is_none());
    }

    #[test]
    fn watchdog_done_signal_wins_over_pre_signalled_cancel() {
        let cancel = AtomicBool::new(true);
        let (done_tx, done_rx) = mpsc::channel::<()>();
        done_tx.send(()).unwrap();

        let outcome = wait_for_done_timeout_or_cancelled(
            done_rx,
            None,
            || cancel.load(Ordering::Acquire),
            i32::MAX as u32,
        );

        assert!(outcome.is_none());
    }
}
