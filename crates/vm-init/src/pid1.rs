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
/// - SIGCHLD: Ignored (we reap zombies explicitly)
pub fn setup_signal_handlers() {
    unsafe {
        libc::signal(libc::SIGTERM, handle_shutdown_signal as *const () as usize);
        libc::signal(libc::SIGINT, handle_shutdown_signal as *const () as usize);
        // Ignore SIGCHLD - we handle zombies explicitly via reap_zombies()
        libc::signal(libc::SIGCHLD, libc::SIG_IGN);
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
