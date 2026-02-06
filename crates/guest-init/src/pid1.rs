//! PID 1 responsibilities: signal handling and zombie reaping.
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
    unsafe {
        libc::signal(libc::SIGTERM, handle_shutdown_signal as *const () as usize);
        libc::signal(libc::SIGINT, handle_shutdown_signal as *const () as usize);
        // Ignore SIGTTIN/SIGTTOU to prevent blocking on TTY operations (like tini does)
        libc::signal(libc::SIGTTIN, libc::SIG_IGN);
        libc::signal(libc::SIGTTOU, libc::SIG_IGN);
        // Ignore SIGPIPE to prevent termination when writing to closed pipes
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
        // Keep SIGCHLD at SIG_DFL - reap_zombies() will handle orphaned processes
    }
}

/// Signal handler that sets the shutdown flag
extern "C" fn handle_shutdown_signal(_sig: libc::c_int) {
    SHUTDOWN_REQUESTED.store(true, Ordering::SeqCst);
}

/// Reap all zombie child processes (non-blocking).
///
/// As PID 1, we are responsible for reaping orphaned child processes.
/// This function should be called periodically to prevent zombie accumulation.
pub fn reap_zombies() {
    loop {
        let result = unsafe { libc::waitpid(-1, std::ptr::null_mut(), libc::WNOHANG) };
        // result > 0: reaped a zombie, continue
        // result == 0: no more zombies ready to be reaped
        // result < 0: error (ECHILD = no children)
        if result <= 0 {
            break;
        }
    }
}
