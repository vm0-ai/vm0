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
/// - SIGCHLD: Use default handler (SIG_DFL) so waitpid() works correctly
///
/// NOTE: We intentionally do NOT set SIGCHLD to SIG_IGN because that causes
/// the kernel to auto-reap children, which can race with waitpid() calls in
/// vsock-guest and cause them to fail with ECHILD.
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

/// Reap all zombie child processes (non-blocking).
///
/// As PID 1, we are responsible for reaping orphaned child processes.
/// This function should be called periodically to prevent zombie accumulation.
///
/// Reaped exit statuses are stored via [`vsock_guest::store_reaped_status`] so
/// that `collect_output` can recover the correct exit code when it encounters
/// `ECHILD` (the child was already reaped by this function).
pub fn reap_zombies() {
    loop {
        let mut status: libc::c_int = 0;
        let result = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
        // result > 0: reaped a zombie, continue
        // result == 0: no more zombies ready to be reaped
        // result < 0: error (ECHILD = no children)
        if result <= 0 {
            break;
        }
        vsock_guest::store_reaped_status(result as u32, status);
    }
}
