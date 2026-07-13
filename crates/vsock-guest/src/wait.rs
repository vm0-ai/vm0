use std::io;
use std::process::{Child, ExitStatus};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use crate::process::{
    ProcessTreeKillTarget, kill_and_reap_child_with_target, kill_process_tree_target,
    process_signal_pid, process_tree_kill_target, refresh_process_tree_kill_target,
};
use crate::threading::spawn_scoped_named;

/// After the child process exits, continue draining stdout/stderr for this
/// many seconds. If EOF is not received within this deadline, proceed to
/// the terminal exec result anyway to prevent indefinite hangs when orphaned
/// child processes hold pipe fds open.
pub(crate) const DRAIN_DEADLINE_SECS: u64 = 5;
const WAIT_CANCEL_POLL_INTERVAL_MS: u64 = 50;
const THREAD_WAIT_OBSERVER: &str = "vsock-wait-observer";

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

struct ChildKill {
    reason: KillReason,
    killed: bool,
}

enum WaitDecision {
    Exited,
    Kill(KillReason),
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

/// Wait for `child` with an optional timeout, allowing the caller to request
/// process-tree cleanup after natural exit is observed but before the direct
/// child is reaped.
///
/// The callback returns `true` when a still-running descendant is holding a
/// resource that must be released by killing the tracked process tree.
pub(crate) fn wait_with_kill_timeout_and_pre_reap_cleanup(
    child: Child,
    timeout_ms: u32,
    pre_reap_cleanup: impl FnMut() -> bool,
) -> WaitOutcome {
    let kill_target = process_tree_kill_target(child.id());
    wait_with_kill_timeout_or_cancelled_by(
        child,
        kill_target,
        timeout_ms,
        || false,
        pre_reap_cleanup,
    )
}

/// Wait for `child` while observing either cancel flag and using a kill target
/// snapshotted before entering the wait path.
///
/// Exec operations have both connection-level cancellation and request-level
/// cancellation, and they snapshot process-tree targets before stdio setup can
/// introduce cleanup races.
pub(crate) fn wait_with_kill_timeout_or_cancelled_either_with_target(
    child: Child,
    kill_target: ProcessTreeKillTarget,
    timeout_ms: u32,
    first_cancel: &AtomicBool,
    second_cancel: &AtomicBool,
    pre_reap_cleanup: impl FnMut() -> bool,
) -> WaitOutcome {
    wait_with_kill_timeout_or_cancelled_by(
        child,
        kill_target,
        timeout_ms,
        || first_cancel.load(Ordering::Acquire) || second_cancel.load(Ordering::Acquire),
        pre_reap_cleanup,
    )
}

fn wait_with_kill_timeout_or_cancelled_by(
    mut child: Child,
    mut kill_target: ProcessTreeKillTarget,
    timeout_ms: u32,
    is_cancelled: impl Fn() -> bool,
    mut pre_reap_cleanup: impl FnMut() -> bool,
) -> WaitOutcome {
    let child_id = child.id();
    debug_assert_eq!(kill_target.child_id(), child_id);
    refresh_process_tree_kill_target(&mut kill_target);
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
        let (observed_tx, observed_rx) = mpsc::channel::<()>();
        let observer = match spawn_scoped_named(scope, THREAD_WAIT_OBSERVER, move || {
            let result = wait_for_child_exit_without_reap(child_id);
            let _ = observed_tx.send(());
            result
        }) {
            Ok(observer) => observer,
            Err(e) => {
                // Without a non-reaping observer, natural exit cannot be
                // distinguished safely from timeout/cancel before reap.
                kill_and_reap_child_with_target(child, kill_target);
                return WaitOutcome::WaitFailed(format!("failed to spawn wait observer: {e}"));
            }
        };

        let mut decision = wait_for_exit_timeout_or_cancelled(&observed_rx, deadline, is_cancelled);
        if matches!(&decision, WaitDecision::Kill(_)) {
            refresh_process_tree_kill_target(&mut kill_target);
            decision = apply_final_exit_priority(decision, &observed_rx);
        }

        match decision {
            WaitDecision::Exited => {
                let observed = match observer.join() {
                    Ok(observed) => observed,
                    Err(panic) => {
                        kill_and_reap_child_with_target(child, kill_target);
                        std::panic::resume_unwind(panic);
                    }
                };
                if let Err(e) = observed {
                    kill_and_reap_child_with_target(child, kill_target);
                    return WaitOutcome::WaitFailed(format!(
                        "failed to observe child exit without reaping: {e}"
                    ));
                }

                if pre_reap_cleanup() {
                    refresh_process_tree_kill_target(&mut kill_target);
                    // SAFETY: the exit observer used WNOWAIT, so this owner
                    // still holds the unreaped direct child identity.
                    let _ = unsafe { kill_process_tree_target(kill_target) };
                }

                match child.wait() {
                    Ok(status) => WaitOutcome::Exited(status),
                    Err(e) => WaitOutcome::WaitFailed(e.to_string()),
                }
            }
            WaitDecision::Kill(reason) => {
                let child_kill = kill_child(&mut child, kill_target, reason);
                let observed = observer.join();
                let status = child.wait();

                let observed = match observed {
                    Ok(observed) => observed,
                    Err(panic) => std::panic::resume_unwind(panic),
                };
                let status = match status {
                    Ok(status) => status,
                    Err(e) => return WaitOutcome::WaitFailed(e.to_string()),
                };
                if let Err(e) = observed {
                    return WaitOutcome::WaitFailed(format!(
                        "failed to observe child exit without reaping: {e}"
                    ));
                }
                if !child_kill.killed {
                    return WaitOutcome::Exited(status);
                }
                match child_kill.reason {
                    KillReason::Timeout => WaitOutcome::TimedOut,
                    KillReason::Cancelled => WaitOutcome::Cancelled,
                }
            }
        }
    })
}

fn wait_for_exit_timeout_or_cancelled(
    observed_rx: &mpsc::Receiver<()>,
    deadline: Option<Instant>,
    is_cancelled: impl Fn() -> bool,
) -> WaitDecision {
    let poll_interval = Duration::from_millis(WAIT_CANCEL_POLL_INTERVAL_MS);

    loop {
        if exit_observed(observed_rx) {
            return WaitDecision::Exited;
        }

        let now = Instant::now();
        let wait_for = match deadline {
            Some(deadline) => {
                let remaining = deadline.saturating_duration_since(now);
                if remaining.is_zero() {
                    return WaitDecision::Kill(KillReason::Timeout);
                }
                remaining.min(poll_interval)
            }
            None => poll_interval,
        };

        if is_cancelled() {
            return WaitDecision::Kill(KillReason::Cancelled);
        }

        match observed_rx.recv_timeout(wait_for) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                return WaitDecision::Exited;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
}

fn exit_observed(observed_rx: &mpsc::Receiver<()>) -> bool {
    match observed_rx.try_recv() {
        Ok(()) | Err(mpsc::TryRecvError::Disconnected) => true,
        Err(mpsc::TryRecvError::Empty) => false,
    }
}

fn apply_final_exit_priority(
    decision: WaitDecision,
    observed_rx: &mpsc::Receiver<()>,
) -> WaitDecision {
    match decision {
        WaitDecision::Kill(_) if exit_observed(observed_rx) => WaitDecision::Exited,
        decision => decision,
    }
}

fn wait_for_child_exit_without_reap(child_id: u32) -> io::Result<()> {
    let child_id = process_signal_pid(child_id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid child pid"))?;
    // SAFETY: zeroed siginfo_t is valid for waitid to fill.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    loop {
        // SAFETY: child_id belongs to a direct child owned by this process.
        // WNOWAIT observes its terminal state without releasing its PID.
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                child_id as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOWAIT,
            )
        };
        if result == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

fn kill_child(
    child: &mut Child,
    kill_target: ProcessTreeKillTarget,
    reason: KillReason,
) -> ChildKill {
    // SAFETY: this owner has not reaped child, so its PID/process group cannot
    // have been reused since the owner refreshed kill_target.
    let tree_killed = unsafe { kill_process_tree_target(kill_target) };
    let child_killed = child.kill().is_ok();
    let killed = tree_killed || child_killed;
    ChildKill { reason, killed }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "linux")]
    use std::io::Write;
    #[cfg(target_os = "linux")]
    use std::os::unix::fs::PermissionsExt;
    #[cfg(target_os = "linux")]
    use std::os::unix::process::CommandExt;
    #[cfg(target_os = "linux")]
    use std::path::{Path, PathBuf};
    #[cfg(target_os = "linux")]
    use std::process::Child;
    use std::process::{Command, Stdio};
    use std::sync::Arc;
    #[cfg(target_os = "linux")]
    use std::time::{SystemTime, UNIX_EPOCH};

    #[cfg(target_os = "linux")]
    use crate::test_support::{kill_pidfd_and_wait, open_pidfd, wait_for_pidfd_exit};

    #[cfg(target_os = "linux")]
    struct TempDirGuard(PathBuf);

    #[cfg(target_os = "linux")]
    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(target_os = "linux")]
    fn temp_dir(label: &str) -> (PathBuf, TempDirGuard) {
        let dir = std::env::temp_dir().join(format!(
            "vsock-guest-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let guard = TempDirGuard(dir.clone());
        (dir, guard)
    }

    #[cfg(target_os = "linux")]
    fn wait_for_path(path: &Path, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if path.exists() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        path.exists()
    }

    #[cfg(target_os = "linux")]
    fn read_pid_file<T: std::str::FromStr>(path: &Path) -> Option<T> {
        std::fs::read_to_string(path).ok()?.trim().parse().ok()
    }

    #[cfg(target_os = "linux")]
    fn wait_for_pid_file<T: std::str::FromStr>(path: &Path, timeout: Duration) -> Option<T> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if let Some(pid) = read_pid_file(path) {
                return Some(pid);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        read_pid_file(path)
    }

    #[cfg(target_os = "linux")]
    fn kill_spawned_child(child: &mut Option<Child>) {
        if let Some(mut child) = child.take() {
            let mut target = process_tree_kill_target(child.id());
            refresh_process_tree_kill_target(&mut target);
            let _ = kill_child(&mut child, target, KillReason::Cancelled);
            let _ = child.wait();
        }
    }

    #[test]
    fn fast_exit_wait_does_not_pay_cancel_poll_interval_per_child() {
        let iterations = 20u32;
        let mut baseline_total = Duration::default();
        let mut timed_total = Duration::default();

        fn wait_for_fast_child(timeout_ms: u32) -> Duration {
            let mut child = Command::new("true")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let start = Instant::now();
            let outcome = if timeout_ms == 0 {
                match child.wait() {
                    Ok(status) => WaitOutcome::Exited(status),
                    Err(e) => WaitOutcome::WaitFailed(e.to_string()),
                }
            } else {
                wait_with_kill_timeout_and_pre_reap_cleanup(child, timeout_ms, || false)
            };
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
            Duration::from_millis(WAIT_CANCEL_POLL_INTERVAL_MS * u64::from(iterations) / 2);
        assert!(
            overhead < allowed_overhead,
            "timed waits should not accumulate the {WAIT_CANCEL_POLL_INTERVAL_MS}ms cancel \
             poll interval per child; {iterations} timed waits took {timed_total:?}, baseline \
             waits took {baseline_total:?}, overhead was {overhead:?}",
        );
    }

    #[test]
    fn timeout_zero_child_is_cancelled_by_external_cancel() {
        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_for_thread = Arc::clone(&cancel);
        let other_cancel = AtomicBool::new(false);
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
        let kill_target = process_tree_kill_target(child.id());

        let cancel_thread = thread::spawn(move || {
            cancel_for_thread.store(true, Ordering::Release);
        });

        let outcome = wait_with_kill_timeout_or_cancelled_either_with_target(
            child,
            kill_target,
            0,
            &cancel,
            &other_cancel,
            || false,
        );
        cancel_thread.join().unwrap();

        assert!(matches!(outcome, WaitOutcome::Cancelled));
    }

    #[test]
    fn nonzero_timeout_child_is_cancelled_by_pre_signalled_cancel() {
        let cancel = AtomicBool::new(true);
        let other_cancel = AtomicBool::new(false);
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
        let kill_target = process_tree_kill_target(child.id());

        let outcome = wait_with_kill_timeout_or_cancelled_either_with_target(
            child,
            kill_target,
            30_000,
            &cancel,
            &other_cancel,
            || false,
        );

        assert!(matches!(outcome, WaitOutcome::Cancelled));
    }

    #[test]
    fn observed_exit_wins_over_elapsed_deadline() {
        let cancel = AtomicBool::new(false);
        let (observed_tx, observed_rx) = mpsc::channel::<()>();
        observed_tx.send(()).unwrap();

        let decision =
            wait_for_exit_timeout_or_cancelled(&observed_rx, Some(Instant::now()), || {
                cancel.load(Ordering::Acquire)
            });

        assert!(matches!(decision, WaitDecision::Exited));
    }

    #[test]
    fn observed_exit_wins_over_pre_signalled_cancel() {
        let cancel = AtomicBool::new(true);
        let (observed_tx, observed_rx) = mpsc::channel::<()>();
        observed_tx.send(()).unwrap();

        let decision = wait_for_exit_timeout_or_cancelled(&observed_rx, None, || {
            cancel.load(Ordering::Acquire)
        });

        assert!(matches!(decision, WaitDecision::Exited));
    }

    #[test]
    fn final_observed_exit_wins_over_pending_kill_decision() {
        let (observed_tx, observed_rx) = mpsc::channel::<()>();
        observed_tx.send(()).unwrap();

        let decision =
            apply_final_exit_priority(WaitDecision::Kill(KillReason::Timeout), &observed_rx);

        assert!(matches!(decision, WaitDecision::Exited));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn natural_exit_cleanup_runs_before_direct_child_is_reaped() {
        let mut command = Command::new("true");
        command.stdout(Stdio::null()).stderr(Stdio::null());
        command.process_group(0);
        let child = command.spawn().unwrap();
        let child_id = child.id();
        let mut cleanup_called = false;

        let outcome = wait_with_kill_timeout_and_pre_reap_cleanup(child, 30_000, || {
            cleanup_called = true;
            let stat = std::fs::read_to_string(format!("/proc/{child_id}/stat"))
                .expect("unreaped direct child should remain visible in procfs");
            let state = stat
                .rsplit_once(") ")
                .and_then(|(_, fields)| fields.chars().next());
            assert_eq!(state, Some('Z'), "observed child should be waitable");
            false
        });

        assert!(cleanup_called);
        assert!(matches!(outcome, WaitOutcome::Exited(status) if status.success()));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn owner_kill_refreshes_stale_process_tree_target_before_signal() {
        let (dir, _guard) = temp_dir("owner-kill-refresh");
        let fifo = dir.join("parent-fifo");
        let ready = dir.join("ready");
        let child_pid_path = dir.join("setsid-child-pid");

        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg(
                "mkfifo \"$FIFO\"; \
                 exec 3<> \"$FIFO\"; \
                 : > \"$READY\"; \
                 read _ <&3; \
                 exec 3>&-; \
                 setsid sh -c 'printf %s \"$$\" > \"$CHILD_PID\"; sleep 60' & \
                 wait",
            )
            .env("FIFO", &fifo)
            .env("READY", &ready)
            .env("CHILD_PID", &child_pid_path)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command.process_group(0);

        let mut child = Some(command.spawn().unwrap());
        if !wait_for_path(&ready, Duration::from_secs(2)) {
            kill_spawned_child(&mut child);
            panic!("parent should block before spawning the setsid child");
        }

        let stale_target = process_tree_kill_target(child.as_ref().unwrap().id());
        {
            let mut fifo_writer = match std::fs::OpenOptions::new().write(true).open(&fifo) {
                Ok(writer) => writer,
                Err(e) => {
                    kill_spawned_child(&mut child);
                    panic!("failed to open parent fifo: {e}");
                }
            };
            if let Err(e) = writeln!(fifo_writer, "go") {
                kill_spawned_child(&mut child);
                panic!("failed to write parent fifo: {e}");
            }
        }

        let child_pid: libc::pid_t =
            match wait_for_pid_file(&child_pid_path, Duration::from_secs(2)) {
                Some(pid) => pid,
                None => {
                    let child_pid_text =
                        std::fs::read_to_string(&child_pid_path).unwrap_or_default();
                    kill_spawned_child(&mut child);
                    panic!("failed to parse setsid child pid {child_pid_text:?}");
                }
            };
        if child_pid <= 0 {
            kill_spawned_child(&mut child);
            panic!("setsid child pid should be positive, got {child_pid}");
        }
        let child_pidfd = match open_pidfd(child_pid) {
            Ok(pidfd) => pidfd,
            Err(e) => {
                kill_spawned_child(&mut child);
                // SAFETY: best-effort cleanup of a test-owned process.
                let _ = unsafe { libc::kill(child_pid, libc::SIGKILL) };
                panic!("failed to open pidfd for setsid child pid {child_pid}: {e}");
            }
        };

        let mut refreshed_target = stale_target;
        refresh_process_tree_kill_target(&mut refreshed_target);
        let child_kill = kill_child(
            child.as_mut().unwrap(),
            refreshed_target,
            KillReason::Timeout,
        );
        if !child_kill.killed {
            kill_spawned_child(&mut child);
            kill_pidfd_and_wait(&child_pidfd)
                .unwrap_or_else(|e| panic!("failed to clean up setsid child pidfd: {e}"));
            panic!("owner kill should signal at least one process target");
        }
        assert!(matches!(child_kill.reason, KillReason::Timeout));
        let _ = child.take().unwrap().wait().unwrap();

        match wait_for_pidfd_exit(&child_pidfd, Duration::from_secs(2)) {
            Ok(true) => {}
            Ok(false) => {
                kill_pidfd_and_wait(&child_pidfd)
                    .unwrap_or_else(|e| panic!("failed to clean up setsid child pidfd: {e}"));
                panic!(
                    "owner kill should terminate delayed setsid child pid {child_pid} after refreshing stale target"
                );
            }
            Err(e) => {
                let cleanup = kill_pidfd_and_wait(&child_pidfd);
                panic!(
                    "failed to wait for delayed setsid child pid {child_pid} exit: {e}; cleanup={cleanup:?}"
                );
            }
        }
    }
}
