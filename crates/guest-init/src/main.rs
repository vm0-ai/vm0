//! Guest init process for Firecracker.
//!
//! Runs as PID 1 inside a Firecracker VM. PID 1 signal handling and zombie
//! reaping follow the same patterns as [tini](https://github.com/krallin/tini).
//!
//! Like tini, guest-init forks a child process (PID 2) to run vsock-guest.
//! PID 1 then enters a reap loop, waiting for the child to exit while also
//! reaping orphaned zombie processes.
//!
//! This architecture cleanly separates concerns:
//! - PID 1 only calls `waitpid(-1)`, which reaps any zombie (orphans + the child)
//! - PID 2 (vsock-guest) calls `waitpid(pid)` for the commands it spawns
//! - Since PID 2's children are not visible to PID 1's `waitpid(-1)` (they are
//!   PID 2's children, not PID 1's), there is no ECHILD race condition.
//!
//! Startup sequence:
//! 1. Initialize filesystem (mounts, overlayfs, pivot_root)
//! 2. Install PID 1 signal handlers (SIGTERM/SIGINT for shutdown, ignore SIGTTIN/SIGTTOU/SIGPIPE)
//! 3. Fork child process
//! 4. Child (PID 2): reset signal handlers to default, run vsock-guest
//! 5. Parent (PID 1): reap loop until child exits or shutdown signal received

mod init;
mod pid1;

use std::thread;
use std::time::Duration;

/// Number of 100ms iterations to wait after SIGTERM before escalating to SIGKILL (= 1 second).
const SHUTDOWN_GRACE_ITERATIONS: u32 = 10;

fn main() {
    eprintln!("[guest-init] Starting...");

    // Step 1: Initialize filesystem
    if let Err(e) = init::init_filesystem() {
        eprintln!("[guest-init] FATAL: Filesystem init failed: {}", e);
        std::process::exit(1);
    }

    // Step 2: Setup PID 1 signal handlers (before fork — child inherits SIG_IGN)
    pid1::setup_signal_handlers();
    eprintln!("[guest-init] PID 1 signal handlers installed");

    // Step 3: Fork child process for vsock-guest
    // SAFETY: fork() is called before any threads are spawned, so it is safe.
    // The child will run vsock-guest; the parent stays as PID 1 reaper.
    let child_pid = unsafe { libc::fork() };
    if child_pid < 0 {
        eprintln!("[guest-init] FATAL: fork() failed");
        std::process::exit(1);
    }

    if child_pid == 0 {
        // Step 4: Child (PID 2) — reset signal handlers and run vsock-guest
        // Reset SIGTERM/SIGINT to default so vsock-guest can be killed normally.
        // SIG_IGN for SIGTTIN/SIGTTOU/SIGPIPE survives fork, which is fine.
        // SAFETY: SIG_DFL is a valid handler constant.
        unsafe {
            libc::signal(libc::SIGTERM, libc::SIG_DFL);
            libc::signal(libc::SIGINT, libc::SIG_DFL);
        }

        let code = match vsock_guest::run(None) {
            Ok(()) => 0,
            Err(e) => {
                vsock_guest::log("ERROR", &format!("Fatal: {e}"));
                1
            }
        };

        // SAFETY: _exit() is the correct way to terminate a forked child.
        // Using std::process::exit() would run atexit handlers and flush
        // shared stdio buffers, potentially corrupting parent output.
        unsafe {
            libc::_exit(code);
        }
    }

    // === Parent process (PID 1) ===
    eprintln!("[guest-init] vsock-guest forked as pid={child_pid}");

    // Step 5: Reap loop — wait for child to exit while reaping orphans
    loop {
        if let Some(exit_code) = pid1::reap_zombies(child_pid) {
            eprintln!("[guest-init] vsock-guest exited with code {exit_code}");
            std::process::exit(exit_code);
        }

        if pid1::shutdown_requested() {
            eprintln!("[guest-init] Shutdown requested, sending SIGTERM to vsock-guest");
            // SAFETY: child_pid is a valid PID from fork().
            unsafe {
                libc::kill(child_pid, libc::SIGTERM);
            }
            // Wait up to 1s for graceful exit, then escalate to SIGKILL
            for _ in 0..SHUTDOWN_GRACE_ITERATIONS {
                thread::sleep(Duration::from_millis(100));
                if let Some(exit_code) = pid1::reap_zombies(child_pid) {
                    eprintln!(
                        "[guest-init] vsock-guest exited with code {exit_code} after SIGTERM"
                    );
                    std::process::exit(exit_code);
                }
            }
            eprintln!("[guest-init] vsock-guest did not exit after SIGTERM, sending SIGKILL");
            // SAFETY: child_pid is a valid PID from fork().
            unsafe {
                libc::kill(child_pid, libc::SIGKILL);
            }
            // Block until the child is reaped. SIGKILL is unconditional
            // (except for uninterruptible sleep), so this won't hang.
            let exit_code = pid1::wait_blocking(child_pid);
            std::process::exit(exit_code);
        }

        thread::sleep(Duration::from_millis(100));
    }
}
