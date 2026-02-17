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

/// Block until a specific child exits and return its exit code.
///
/// Uses `waitpid(pid, 0)` (blocking) which only returns `pid` on success
/// or `-1` on error. Retries on `EINTR`; returns 1 on unexpected errors.
pub fn wait_blocking(pid: i32) -> i32 {
    loop {
        let mut status: libc::c_int = 0;
        // SAFETY: pid is a valid child PID; status is written on success.
        let result = unsafe { libc::waitpid(pid, &mut status, 0) };
        if result == pid {
            return if libc::WIFEXITED(status) {
                libc::WEXITSTATUS(status)
            } else if libc::WIFSIGNALED(status) {
                128 + libc::WTERMSIG(status)
            } else {
                1
            };
        }
        // result == -1: EINTR → retry, anything else (ECHILD) → give up
        // SAFETY: __errno_location() is valid after a failed libc call.
        let errno = unsafe { *libc::__errno_location() };
        if errno != libc::EINTR {
            return 1;
        }
    }
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
            // SAFETY: libc macros on a valid wstatus from waitpid.
            return Some(if libc::WIFEXITED(status) {
                libc::WEXITSTATUS(status)
            } else if libc::WIFSIGNALED(status) {
                128 + libc::WTERMSIG(status)
            } else {
                1
            });
        }
        // Orphaned zombie — reaped and discarded
    }
    None
}
