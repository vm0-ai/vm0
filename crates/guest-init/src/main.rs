//! Guest init process for Firecracker.
//!
//! Runs as PID 1 inside a Firecracker VM. PID 1 signal handling and zombie
//! reaping follow the same patterns as [tini](https://github.com/krallin/tini).
//!
//! Unlike tini (which forks a single child and supervises it), guest-init runs
//! vsock-guest directly in the PID 1 process. This is intentional: the VM agent
//! receives and executes multiple commands over its lifetime, rather than
//! supervising a single program.
//!
//! Startup sequence:
//! 1. Initialize filesystem (mounts, overlayfs, pivot_root)
//! 2. Install PID 1 signal handlers (SIGTERM/SIGINT for shutdown, ignore SIGTTIN/SIGTTOU/SIGPIPE)
//! 3. Start background zombie reaper thread
//! 4. Run vsock-guest event loop for host-guest communication

mod init;
mod pid1;

use std::thread;
use std::time::Duration;

fn main() {
    eprintln!("[guest-init] Starting...");

    // Step 1: Initialize filesystem
    if let Err(e) = init::init_filesystem() {
        eprintln!("[guest-init] FATAL: Filesystem init failed: {}", e);
        std::process::exit(1);
    }

    // Step 2: Setup PID 1 signal handlers
    pid1::setup_signal_handlers();
    eprintln!("[guest-init] PID 1 signal handlers installed");

    // Step 3: Start background thread for zombie reaping
    // This runs continuously while vsock-guest handles messages
    thread::spawn(|| {
        loop {
            pid1::reap_zombies();

            // Check for shutdown signal
            if pid1::shutdown_requested() {
                eprintln!("[guest-init] Shutdown requested");
                std::process::exit(0);
            }

            thread::sleep(Duration::from_millis(100));
        }
    });

    // Step 4: Run vsock-guest (this is the main event loop)
    // The guest agent connects to host via vsock and handles commands
    if let Err(e) = vsock_guest::run(None) {
        vsock_guest::log("ERROR", &format!("Fatal: {}", e));
        std::process::exit(1);
    }
}
