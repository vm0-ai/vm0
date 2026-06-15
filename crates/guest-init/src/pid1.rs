//! PID 1 responsibilities: signal handling and zombie reaping.
//!
//! Based on [tini](https://github.com/krallin/tini) signal handling patterns.
//! Uses `sigaction` (not `signal`) for reliable, non-resetting handlers.
//!
//! When running as PID 1 (init process), we must:
//! 1. Handle signals properly (SIGTERM, SIGINT for graceful shutdown)
//! 2. Reap zombie child processes to prevent resource leaks

use std::sync::atomic::{AtomicBool, Ordering};

/// Flag indicating whether shutdown was requested via signal
static SHUTDOWN_REQUESTED: AtomicBool = AtomicBool::new(false);

/// Check if shutdown was requested via signal (SIGTERM or SIGINT)
pub fn shutdown_requested() -> bool {
    SHUTDOWN_REQUESTED.load(Ordering::SeqCst)
}

/// Install a `sigaction` handler for the given signal with `SA_RESTART`.
///
/// Unlike `signal()`, `sigaction()` does not reset the handler after first
/// invocation and has well-defined behavior across platforms.
fn set_handler(sig: libc::c_int, handler: libc::sighandler_t) {
    // SAFETY: zeroed sigaction is valid; we fill sa_handler and sa_flags.
    let mut sa: libc::sigaction = unsafe { std::mem::zeroed() };
    sa.sa_sigaction = handler;
    sa.sa_flags = libc::SA_RESTART;
    // SAFETY: sa is properly initialized, sig is a valid signal number.
    unsafe {
        libc::sigaction(sig, &sa, std::ptr::null_mut());
    }
}

/// Setup signal handlers for PID 1 operation.
///
/// - SIGTERM/SIGINT: Set shutdown flag for graceful exit
/// - SIGTTIN/SIGTTOU: Ignore to prevent blocking on TTY operations
/// - SIGPIPE: Ignore to prevent termination when writing to closed pipes
///
/// SIG_IGN dispositions survive both `fork()` and `exec()`, so the child
/// process inherits SIGTTIN/SIGTTOU/SIGPIPE as ignored. The child resets
/// SIGTERM/SIGINT to SIG_DFL after fork.
pub fn setup_signal_handlers() {
    set_handler(
        libc::SIGTERM,
        handle_shutdown_signal as *const () as libc::sighandler_t,
    );
    set_handler(
        libc::SIGINT,
        handle_shutdown_signal as *const () as libc::sighandler_t,
    );
    set_handler(libc::SIGTTIN, libc::SIG_IGN);
    set_handler(libc::SIGTTOU, libc::SIG_IGN);
    set_handler(libc::SIGPIPE, libc::SIG_IGN);
}

/// Signal handler that sets the shutdown flag
extern "C" fn handle_shutdown_signal(_sig: libc::c_int) {
    SHUTDOWN_REQUESTED.store(true, Ordering::SeqCst);
}

fn decode_wait_status(status: libc::c_int) -> i32 {
    // SAFETY: libc status macros are used only with a status produced by waitpid.
    if libc::WIFEXITED(status) {
        libc::WEXITSTATUS(status)
    } else if libc::WIFSIGNALED(status) {
        128 + libc::WTERMSIG(status)
    } else {
        1
    }
}

fn last_errno() -> libc::c_int {
    // SAFETY: __errno_location() is valid after a failed libc call.
    unsafe { *libc::__errno_location() }
}

fn wait_blocking_with<F>(pid: libc::pid_t, mut wait: F) -> i32
where
    F: FnMut(&mut libc::c_int) -> Result<libc::pid_t, libc::c_int>,
{
    loop {
        let mut status: libc::c_int = 0;
        match wait(&mut status) {
            Ok(result) if result == pid => return decode_wait_status(status),
            Ok(_) => return 1,
            Err(errno) if errno == libc::EINTR => {}
            Err(_) => return 1,
        }
    }
}

/// Block until a specific child exits and return its exit code.
///
/// Uses `waitpid(pid, 0)` (blocking) which only returns `pid` on success
/// or `-1` on error. Retries on `EINTR`; returns 1 on unexpected errors.
pub fn wait_blocking(pid: i32) -> i32 {
    wait_blocking_with(pid, |status| {
        // SAFETY: pid is a valid child PID; status is written on success.
        let result = unsafe { libc::waitpid(pid, status, 0) };
        if result == -1 {
            Err(last_errno())
        } else {
            Ok(result)
        }
    })
}

/// Reap zombie child processes (non-blocking) and detect watched child exit.
///
/// Calls `waitpid(-1, WNOHANG)` in a loop to reap all available zombies.
/// If `watched_pid` is reaped, returns its exit code. Orphaned processes
/// are silently reaped and discarded.
///
/// Returns `Some(exit_code)` if the watched child was reaped, `None` otherwise.
pub fn reap_zombies(watched_pid: i32) -> Option<i32> {
    loop {
        let mut status: libc::c_int = 0;
        // SAFETY: waitpid(-1) is valid; status is initialized before use on success.
        let result = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
        // result > 0: reaped a zombie, continue loop
        // result == 0: no more zombies ready to be reaped
        // result < 0: error (ECHILD = no children)
        if result <= 0 {
            break;
        }
        if result == watched_pid {
            return Some(decode_wait_status(status));
        }
        // Orphaned zombie — reaped and discarded
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::sync::Mutex;

    static PID1_TEST_LOCK: Mutex<()> = Mutex::new(());

    struct ChildGuard {
        pid: libc::pid_t,
        reaped: bool,
    }

    impl ChildGuard {
        fn new(pid: libc::pid_t) -> Self {
            Self { pid, reaped: false }
        }

        fn pid(&self) -> libc::pid_t {
            self.pid
        }

        fn disarm(&mut self) {
            self.reaped = true;
        }
    }

    impl Drop for ChildGuard {
        fn drop(&mut self) {
            if self.reaped {
                return;
            }
            // SAFETY: pid belongs to a child created by this test helper. Cleanup
            // is best-effort and handles already-exited or already-reaped children.
            unsafe {
                let _ = libc::kill(self.pid, libc::SIGKILL);
                let mut status: libc::c_int = 0;
                loop {
                    let result = libc::waitpid(self.pid, &mut status, 0);
                    if result == self.pid {
                        break;
                    }
                    if result == -1 && last_errno() == libc::EINTR {
                        continue;
                    }
                    break;
                }
            }
        }
    }

    fn fork_exiting_child(exit_code: libc::c_int) -> ChildGuard {
        // SAFETY: the child calls only _exit after fork.
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0, "fork failed with errno {}", last_errno());
        if pid == 0 {
            // SAFETY: _exit is async-signal-safe and avoids running Rust destructors
            // in the forked child.
            unsafe {
                libc::_exit(exit_code);
            }
        }
        ChildGuard::new(pid)
    }

    fn fork_paused_child() -> ChildGuard {
        let mut fds = [0; 2];
        // SAFETY: fds points to two valid integers for pipe to initialize.
        let pipe_result = unsafe { libc::pipe(fds.as_mut_ptr()) };
        assert_eq!(pipe_result, 0, "pipe failed with errno {}", last_errno());

        // SAFETY: the child uses only async-signal-safe libc calls before _exit.
        let pid = unsafe { libc::fork() };
        if pid < 0 {
            // SAFETY: both fds were initialized by pipe above.
            unsafe {
                libc::close(fds[0]);
                libc::close(fds[1]);
            }
            panic!("fork failed with errno {}", last_errno());
        }

        if pid == 0 {
            // SAFETY: this is the forked child path. It uses raw libc calls and
            // exits through _exit to avoid running Rust destructors.
            unsafe {
                libc::close(fds[0]);
                let ready = [1_u8];
                let written = libc::write(fds[1], ready.as_ptr().cast(), ready.len());
                libc::close(fds[1]);
                if written != 1 {
                    libc::_exit(125);
                }
                loop {
                    libc::pause();
                }
            }
        }

        // SAFETY: parent owns both raw fds after fork; close the unused write end.
        unsafe {
            libc::close(fds[1]);
        }
        // SAFETY: parent still owns the read fd and transfers it to OwnedFd.
        let read_fd = unsafe { OwnedFd::from_raw_fd(fds[0]) };
        wait_for_child_ready(&read_fd);
        ChildGuard::new(pid)
    }

    fn wait_for_child_ready(read_fd: &OwnedFd) {
        let mut ready = [0_u8];
        // SAFETY: read_fd is a valid pipe read end and ready points to writable memory.
        let result =
            unsafe { libc::read(read_fd.as_raw_fd(), ready.as_mut_ptr().cast(), ready.len()) };
        assert_eq!(result, 1, "read failed with errno {}", last_errno());
    }

    fn wait_until_waitable(pid: libc::pid_t) {
        // SAFETY: zeroed siginfo_t is valid for waitid to fill.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        // SAFETY: pid is a child created by this test. WNOWAIT observes its
        // waitable status without reaping it.
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOWAIT,
            )
        };
        assert_eq!(result, 0, "waitid failed with errno {}", last_errno());
    }

    #[derive(Debug, PartialEq, Eq)]
    enum ReapCheck {
        AlreadyReaped,
        ReapedDuringCheck,
        StillPresent,
    }

    fn check_child_reaped(pid: libc::pid_t) -> ReapCheck {
        let mut status: libc::c_int = 0;
        // SAFETY: pid was created by this test. WNOHANG prevents blocking if a
        // regression leaves the child unreaped.
        let result = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
        if result == -1 && last_errno() == libc::ECHILD {
            ReapCheck::AlreadyReaped
        } else if result == pid {
            ReapCheck::ReapedDuringCheck
        } else {
            ReapCheck::StillPresent
        }
    }

    #[test]
    fn wait_loop_retries_after_eintr() {
        let _guard = PID1_TEST_LOCK.lock().unwrap();
        let mut calls = 0;

        let exit_code = wait_blocking_with(123, |status| {
            calls += 1;
            if calls == 1 {
                Err(libc::EINTR)
            } else {
                *status = 0;
                Ok(123)
            }
        });

        assert_eq!(exit_code, 0);
        assert_eq!(calls, 2);
    }

    #[test]
    fn wait_loop_returns_one_for_non_eintr_error() {
        let _guard = PID1_TEST_LOCK.lock().unwrap();

        let exit_code = wait_blocking_with(123, |_status| Err(libc::ECHILD));

        assert_eq!(exit_code, 1);
    }

    #[test]
    fn wait_blocking_returns_normal_child_exit_code() {
        let _guard = PID1_TEST_LOCK.lock().unwrap();
        let mut child = fork_exiting_child(42);

        let exit_code = wait_blocking(child.pid());
        child.disarm();

        assert_eq!(exit_code, 42);
    }

    #[test]
    fn wait_blocking_maps_signal_exit_code() {
        let _guard = PID1_TEST_LOCK.lock().unwrap();
        let mut child = fork_paused_child();
        // SAFETY: pid belongs to the paused child created by this test.
        let kill_result = unsafe { libc::kill(child.pid(), libc::SIGKILL) };
        assert_eq!(kill_result, 0, "kill failed with errno {}", last_errno());

        let exit_code = wait_blocking(child.pid());
        child.disarm();

        assert_eq!(exit_code, 128 + libc::SIGKILL);
    }

    #[test]
    fn reap_zombies_reaps_unrelated_child_without_watched_result() {
        let _guard = PID1_TEST_LOCK.lock().unwrap();
        let watched = fork_paused_child();
        let mut unrelated = fork_exiting_child(17);
        wait_until_waitable(unrelated.pid());

        let result = reap_zombies(watched.pid());
        let unrelated_state = check_child_reaped(unrelated.pid());
        if unrelated_state != ReapCheck::StillPresent {
            unrelated.disarm();
        }

        assert_eq!(result, None);
        assert_eq!(unrelated_state, ReapCheck::AlreadyReaped);
    }

    #[test]
    fn reap_zombies_returns_watched_child_exit_code() {
        let _guard = PID1_TEST_LOCK.lock().unwrap();
        let mut watched = fork_exiting_child(23);
        wait_until_waitable(watched.pid());

        let result = reap_zombies(watched.pid());
        watched.disarm();

        assert_eq!(result, Some(23));
    }
}
