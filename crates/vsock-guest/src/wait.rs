use std::cmp;
use std::io;
#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, OwnedFd};
#[cfg(test)]
use std::process::Child;
use std::process::ExitStatus;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
#[cfg(test)]
use std::thread;
use std::time::{Duration, Instant};

use crate::containment::CLEANUP_TIMEOUT;
use crate::process::ContainedChild;
#[cfg(test)]
use crate::process::{
    ProcessTreeKillTarget, kill_process_tree_target, process_tree_kill_target,
    refresh_process_tree_kill_target,
};

/// After the child process exits, continue draining stdout/stderr for this
/// many seconds. If EOF is not received within this deadline, proceed to
/// the terminal exec result anyway to prevent indefinite hangs when orphaned
/// child processes hold pipe fds open.
pub(crate) const DRAIN_DEADLINE_SECS: u64 = 5;
const WAIT_CANCEL_POLL_INTERVAL_MS: u64 = 50;

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
    /// Descendant cleanup could not be proven within the security deadline.
    Fatal(String),
}

enum KillReason {
    Timeout,
    Cancelled,
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

/// Wait for a debug/test child with the process-group fallback.
#[cfg(test)]
pub(crate) fn wait_with_kill_timeout_and_pre_reap_cleanup(
    child: Child,
    timeout_ms: u32,
    pre_reap_cleanup: impl FnMut() -> bool,
) -> WaitOutcome {
    let process = match ContainedChild::from_process_group(child) {
        Ok(process) => process,
        Err(error) => return WaitOutcome::WaitFailed(error.to_string()),
    };
    wait_with_kill_timeout_or_cancelled_by(process, timeout_ms, || false, pre_reap_cleanup)
}

/// Wait for a debug/test child with an already sampled process-group target.
#[cfg(test)]
pub(crate) fn wait_with_kill_timeout_or_cancelled_either_with_target(
    child: Child,
    kill_target: ProcessTreeKillTarget,
    timeout_ms: u32,
    first_cancel: &AtomicBool,
    second_cancel: &AtomicBool,
    pre_reap_cleanup: impl FnMut() -> bool,
) -> WaitOutcome {
    let process = match ContainedChild::from_process_group_target(child, kill_target) {
        Ok(process) => process,
        Err(error) => return WaitOutcome::WaitFailed(error.to_string()),
    };
    wait_with_kill_timeout_or_cancelled_by(
        process,
        timeout_ms,
        || first_cancel.load(Ordering::Acquire) || second_cancel.load(Ordering::Acquire),
        pre_reap_cleanup,
    )
}

pub(crate) fn wait_contained_with_timeout_or_cancelled(
    process: ContainedChild,
    timeout_ms: u32,
    first_cancel: &AtomicBool,
    second_cancel: &AtomicBool,
    pre_reap_cleanup: impl FnMut() -> bool,
) -> WaitOutcome {
    wait_with_kill_timeout_or_cancelled_by(
        process,
        timeout_ms,
        || first_cancel.load(Ordering::Acquire) || second_cancel.load(Ordering::Acquire),
        pre_reap_cleanup,
    )
}

pub(crate) fn wait_contained_with_timeout_and_pre_reap_cleanup(
    process: ContainedChild,
    timeout_ms: u32,
    pre_reap_cleanup: impl FnMut() -> bool,
) -> WaitOutcome {
    wait_with_kill_timeout_or_cancelled_by(process, timeout_ms, || false, pre_reap_cleanup)
}

pub(crate) fn terminate_contained_child(mut process: ContainedChild) -> io::Result<()> {
    kill_contained(&mut process)?;
    let status = wait_for_killed_process(&mut process)?;
    process.containment.remove()?;
    let _ = status;
    Ok(())
}

fn wait_with_kill_timeout_or_cancelled_by(
    mut process: ContainedChild,
    timeout_ms: u32,
    is_cancelled: impl Fn() -> bool,
    mut pre_reap_cleanup: impl FnMut() -> bool,
) -> WaitOutcome {
    let deadline = (timeout_ms > 0).then(|| {
        let now = Instant::now();
        now.checked_add(Duration::from_millis(u64::from(timeout_ms)))
            .unwrap_or(now)
    });

    let mut decision = match wait_for_exit_timeout_or_cancelled(&process, deadline, is_cancelled) {
        Ok(decision) => decision,
        Err(error) => return fatal_wait(error),
    };
    if matches!(decision, WaitDecision::Kill(_)) {
        match pidfd_ready(&process, Duration::ZERO) {
            Ok(true) => decision = WaitDecision::Exited,
            Ok(false) => {}
            Err(error) => return fatal_wait(error),
        }
    }

    match decision {
        WaitDecision::Exited => finish_natural_exit(process, &mut pre_reap_cleanup),
        WaitDecision::Kill(reason) => {
            let killed = match kill_contained(&mut process) {
                Ok(killed) => killed,
                Err(error) => return fatal_wait(error),
            };
            let status = match wait_for_killed_process(&mut process) {
                Ok(status) => status,
                Err(error) => return fatal_wait(error),
            };
            if let Err(error) = process.containment.remove() {
                return fatal_wait(error);
            }
            if !killed {
                return WaitOutcome::Exited(status);
            }
            match reason {
                KillReason::Timeout => WaitOutcome::TimedOut,
                KillReason::Cancelled => WaitOutcome::Cancelled,
            }
        }
    }
}

fn finish_natural_exit(
    mut process: ContainedChild,
    pre_reap_cleanup: &mut impl FnMut() -> bool,
) -> WaitOutcome {
    let requested_cleanup = pre_reap_cleanup();
    let populated = match process.containment.populated() {
        Ok(populated) => populated,
        Err(error) => return fatal_wait(error),
    };
    let should_kill = (process.containment.is_cgroup() && populated)
        || (!process.containment.is_cgroup() && requested_cleanup);
    if should_kill && let Err(error) = process.containment.kill() {
        return fatal_wait(error);
    }
    if process.containment.is_cgroup() {
        let deadline = Instant::now() + CLEANUP_TIMEOUT;
        match process.containment.wait_empty_until(deadline) {
            Ok(true) => {}
            Ok(false) => {
                return fatal_wait(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "timed out waiting for exec cgroup to become empty",
                ));
            }
            Err(error) => return fatal_wait(error),
        }
    }
    if let Err(error) = process.containment.remove() {
        return fatal_wait(error);
    }
    match process.child.wait() {
        Ok(status) => WaitOutcome::Exited(status),
        Err(error) => WaitOutcome::WaitFailed(error.to_string()),
    }
}

fn kill_contained(process: &mut ContainedChild) -> io::Result<bool> {
    let containment_result = process.containment.kill();
    let child_killed = process.child.kill().is_ok();
    let containment_killed = containment_result?;
    Ok(containment_killed || child_killed)
}

fn wait_for_killed_process(process: &mut ContainedChild) -> io::Result<ExitStatus> {
    let deadline = Instant::now() + CLEANUP_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "timed out waiting for contained child cleanup",
            ));
        }
        let exited = pidfd_ready(process, remaining.min(Duration::from_millis(10)))?;
        let empty = !process.containment.populated()?;
        if exited && empty {
            return process.child.wait();
        }
    }
}

fn wait_for_exit_timeout_or_cancelled(
    process: &ContainedChild,
    deadline: Option<Instant>,
    is_cancelled: impl Fn() -> bool,
) -> io::Result<WaitDecision> {
    let poll_interval = Duration::from_millis(WAIT_CANCEL_POLL_INTERVAL_MS);
    loop {
        if pidfd_ready(process, Duration::ZERO)? {
            return Ok(WaitDecision::Exited);
        }
        let now = Instant::now();
        let wait_for = match deadline {
            Some(deadline) => {
                let remaining = deadline.saturating_duration_since(now);
                if remaining.is_zero() {
                    return Ok(WaitDecision::Kill(KillReason::Timeout));
                }
                remaining.min(poll_interval)
            }
            None => poll_interval,
        };
        if is_cancelled() {
            return Ok(WaitDecision::Kill(KillReason::Cancelled));
        }
        if pidfd_ready(process, wait_for)? {
            return Ok(WaitDecision::Exited);
        }
    }
}

#[cfg(target_os = "linux")]
fn pidfd_ready(process: &ContainedChild, timeout: Duration) -> io::Result<bool> {
    poll_pidfd(&process.pidfd, timeout)
}

#[cfg(not(target_os = "linux"))]
fn pidfd_ready(_process: &ContainedChild, _timeout: Duration) -> io::Result<bool> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "pidfd readiness requires Linux",
    ))
}

#[cfg(target_os = "linux")]
fn poll_pidfd(pidfd: &OwnedFd, timeout: Duration) -> io::Result<bool> {
    let timeout_ms = if timeout.is_zero() {
        0
    } else {
        cmp::min(cmp::max(timeout.as_millis(), 1), libc::c_int::MAX as u128) as libc::c_int
    };
    loop {
        let mut pollfd = libc::pollfd {
            fd: pidfd.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: pollfd points to one initialized descriptor entry.
        let result = unsafe { libc::poll(&mut pollfd, 1, timeout_ms) };
        if result > 0 {
            if pollfd.revents & (libc::POLLERR | libc::POLLNVAL) != 0 {
                return Err(io::Error::other("pidfd became invalid while polling"));
            }
            return Ok(pollfd.revents & (libc::POLLIN | libc::POLLHUP) != 0);
        }
        if result == 0 {
            return Ok(false);
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

fn fatal_wait(error: io::Error) -> WaitOutcome {
    WaitOutcome::Fatal(format!("exec containment failed: {error}"))
}

#[cfg(test)]
fn kill_child(child: &mut Child, mut kill_target: ProcessTreeKillTarget) -> bool {
    refresh_process_tree_kill_target(&mut kill_target);
    // SAFETY: the test owner retains the unreaped child while signaling.
    let tree_killed = unsafe { kill_process_tree_target(kill_target) };
    let child_killed = child.kill().is_ok();
    tree_killed || child_killed
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
            let _ = kill_child(&mut child, target);
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
        let child_killed = kill_child(child.as_mut().unwrap(), refreshed_target);
        if !child_killed {
            kill_spawned_child(&mut child);
            kill_pidfd_and_wait(&child_pidfd)
                .unwrap_or_else(|e| panic!("failed to clean up setsid child pidfd: {e}"));
            panic!("owner kill should signal at least one process target");
        }
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
