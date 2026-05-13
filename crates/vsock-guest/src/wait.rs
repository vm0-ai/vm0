use std::process::{Child, ExitStatus};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use crate::drain::drain_into_vec_cancellable;
use crate::process::{extract_exit_code, kill_and_reap_child, kill_process_tree};
use crate::threading::{ThreadSpawner, spawn_scoped_named};

/// Exit code returned when command times out (same as bash/Python)
pub(crate) const EXIT_CODE_TIMEOUT: i32 = 124;

/// After the child process exits, continue draining stdout/stderr for this
/// many seconds. If EOF is not received within this deadline, proceed to
/// `send_process_exit()` anyway to prevent indefinite hangs when orphaned
/// child processes hold pipe fds open.
pub(crate) const DRAIN_DEADLINE_SECS: u64 = 5;
const WATCHDOG_CANCEL_POLL_INTERVAL_MS: u64 = 50;
const THREAD_WAIT_WATCHDOG: &str = "vsock-wait-watchdog";
pub(crate) const THREAD_DRAIN_STDOUT: &str = "vsock-drain-stdout";
const THREAD_DRAIN_STDERR: &str = "vsock-drain-stderr";

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
/// flag. Command operations have both connection-level cancellation and
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
pub(crate) fn wait_with_drain_and_timeout_or_cancelled_with_spawner<S>(
    mut child: Child,
    timeout_ms: u32,
    external_cancel: &AtomicBool,
    spawner: S,
) -> (WaitOutcome, Vec<u8>, Vec<u8>)
where
    S: ThreadSpawner,
{
    // Defensive: if either pipe is missing the caller broke the
    // `spawn_with_pipes` invariant. Reap the child before returning so we
    // don't leave a zombie — `Child`'s `Drop` doesn't wait.
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            kill_and_reap_child(child);
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
            kill_and_reap_child(child);
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
        let drain_cancel = cancel.clone();
        let tx = done_tx.clone();
        match spawner.spawn_vec(
            THREAD_DRAIN_STDOUT,
            Box::new(move || {
                let buf = drain_into_vec_cancellable(stdout, &drain_cancel);
                let _ = tx.send(());
                buf
            }),
        ) {
            Ok(handle) => handle,
            Err(e) => {
                cancel.store(true, Ordering::Release);
                drop(stderr);
                drop(done_tx);
                kill_and_reap_child(child);
                return (
                    WaitOutcome::WaitFailed(format!("failed to spawn stdout drain thread: {e}")),
                    Vec::new(),
                    Vec::new(),
                );
            }
        }
    };
    let stderr_handle = {
        let drain_cancel = cancel.clone();
        let tx = done_tx.clone();
        match spawner.spawn_vec(
            THREAD_DRAIN_STDERR,
            Box::new(move || {
                let buf = drain_into_vec_cancellable(stderr, &drain_cancel);
                let _ = tx.send(());
                buf
            }),
        ) {
            Ok(handle) => handle,
            Err(e) => {
                cancel.store(true, Ordering::Release);
                drop(done_tx);
                kill_and_reap_child(child);
                let _ = stdout_handle.join();
                return (
                    WaitOutcome::WaitFailed(format!("failed to spawn stderr drain thread: {e}")),
                    Vec::new(),
                    Vec::new(),
                );
            }
        }
    };
    drop(done_tx); // so recv returns Disconnected if both drain threads die

    let outcome = wait_with_kill_timeout_or_cancelled(child, timeout_ms, external_cancel);
    if matches!(outcome, WaitOutcome::Cancelled) || external_cancel.load(Ordering::Acquire) {
        cancel.store(true, Ordering::Release);
    }

    let _ = await_drain_deadline(&done_rx, 2, &cancel);

    let stdout_buf = stdout_handle.join().unwrap_or_default();
    let stderr_buf = stderr_handle.join().unwrap_or_default();

    (outcome, stdout_buf, stderr_buf)
}

/// Resolve a [`WaitOutcome`] + drained stderr into protocol exit fields.
/// Timeout overrides any drained stderr with the canonical "Timeout" body so
/// callers can disambiguate from a real exit-1.
pub(crate) fn finalize_wait_outcome(outcome: WaitOutcome, stderr_buf: Vec<u8>) -> (i32, Vec<u8>) {
    match outcome {
        WaitOutcome::TimedOut => (EXIT_CODE_TIMEOUT, b"Timeout".to_vec()),
        WaitOutcome::Cancelled => (1, b"Connection cancelled".to_vec()),
        WaitOutcome::Exited(s) => (extract_exit_code(s), stderr_buf),
        WaitOutcome::WaitFailed(msg) => (1, format!("Failed to wait: {msg}").into_bytes()),
    }
}

pub(crate) fn finalize_buffered_result(
    outcome: WaitOutcome,
    stdout: Vec<u8>,
    stderr_buf: Vec<u8>,
) -> (i32, Vec<u8>, Vec<u8>) {
    let (exit_code, stderr) = finalize_wait_outcome(outcome, stderr_buf);
    (exit_code, stdout, stderr)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::threading::test_support::FailingThreadSpawner;
    use std::process::{Command, Stdio};

    fn successful_status() -> ExitStatus {
        Command::new("true").status().unwrap()
    }

    fn pid_alive(pid: u32) -> bool {
        // SAFETY: kill(pid, 0) is the standard process-existence check.
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    fn spawn_sleeping_child_with_pipes() -> (Child, u32) {
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg("echo stdout-ready; sleep 60")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let child = command.spawn().unwrap();
        let pid = child.id();
        (child, pid)
    }

    #[test]
    fn fast_exit_wait_does_not_pay_cancel_poll_interval_per_child() {
        let iterations = 20;
        let start = Instant::now();

        for _ in 0..iterations {
            let child = Command::new("sleep")
                .arg("0.02")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let outcome = wait_with_kill_timeout(child, 30_000);
            assert!(
                matches!(outcome, WaitOutcome::Exited(status) if status.success()),
                "unexpected wait outcome"
            );
        }

        let elapsed = start.elapsed();
        assert!(
            elapsed < Duration::from_millis(900),
            "fast child exits should not accumulate the 50ms cancel poll interval per child; \
             {iterations} waits took {elapsed:?}",
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
            thread::sleep(Duration::from_millis(100));
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
    fn drain_spawn_failure_kills_and_reaps_child_after_first_drain_starts() {
        let cancel = AtomicBool::new(false);
        let (child, pid) = spawn_sleeping_child_with_pipes();

        let (outcome, stdout, stderr) = wait_with_drain_and_timeout_or_cancelled_with_spawner(
            child,
            0,
            &cancel,
            FailingThreadSpawner::fail_once(THREAD_DRAIN_STDERR),
        );

        assert!(
            matches!(outcome, WaitOutcome::WaitFailed(msg) if msg.contains("stderr drain thread")),
            "unexpected wait outcome"
        );
        assert!(stdout.is_empty());
        assert!(stderr.is_empty());
        assert!(!pid_alive(pid), "child pid {pid} should have been reaped");
    }

    #[test]
    fn drain_spawn_failure_kills_and_reaps_child_before_any_drain_starts() {
        let cancel = AtomicBool::new(false);
        let (child, pid) = spawn_sleeping_child_with_pipes();

        let (outcome, stdout, stderr) = wait_with_drain_and_timeout_or_cancelled_with_spawner(
            child,
            0,
            &cancel,
            FailingThreadSpawner::fail_once(THREAD_DRAIN_STDOUT),
        );

        assert!(
            matches!(outcome, WaitOutcome::WaitFailed(msg) if msg.contains("stdout drain thread")),
            "unexpected wait outcome"
        );
        assert!(stdout.is_empty());
        assert!(stderr.is_empty());
        assert!(!pid_alive(pid), "child pid {pid} should have been reaped");
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

    #[test]
    fn finalize_wait_outcome_preserves_exit_status_and_stderr() {
        let stderr = b"stderr bytes".to_vec();

        let (code, finalized_stderr) =
            finalize_wait_outcome(WaitOutcome::Exited(successful_status()), stderr.clone());

        assert_eq!(code, 0);
        assert_eq!(finalized_stderr, stderr);
    }

    #[test]
    fn finalize_wait_outcome_timeout_overrides_stderr() {
        let (code, stderr) = finalize_wait_outcome(WaitOutcome::TimedOut, b"real stderr".to_vec());

        assert_eq!(code, EXIT_CODE_TIMEOUT);
        assert_eq!(stderr, b"Timeout".to_vec());
    }

    #[test]
    fn finalize_wait_outcome_cancelled_reports_connection_cancelled() {
        let (code, stderr) = finalize_wait_outcome(WaitOutcome::Cancelled, b"real stderr".to_vec());

        assert_eq!(code, 1);
        assert_eq!(stderr, b"Connection cancelled".to_vec());
    }

    #[test]
    fn finalize_wait_outcome_preserves_wait_failed_message() {
        let (code, stderr) = finalize_wait_outcome(
            WaitOutcome::WaitFailed("wait failed".to_string()),
            b"ignored".to_vec(),
        );

        assert_eq!(code, 1);
        assert_eq!(stderr, b"Failed to wait: wait failed".to_vec());
    }

    #[test]
    fn finalize_buffered_result_timeout_preserves_stdout() {
        let (code, stdout, stderr) = finalize_buffered_result(
            WaitOutcome::TimedOut,
            b"partial stdout".to_vec(),
            b"real stderr".to_vec(),
        );

        assert_eq!(code, EXIT_CODE_TIMEOUT);
        assert_eq!(stdout, b"partial stdout".to_vec());
        assert_eq!(stderr, b"Timeout".to_vec());
    }
}
