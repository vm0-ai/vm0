//! VM init process for Firecracker.
//!
//! This binary runs as PID 1 inside a Firecracker VM and:
//! 1. Initializes the filesystem (mounts, overlayfs, pivot_root)
//! 2. Handles PID 1 responsibilities (signal forwarding, zombie reaping)
//! 3. Runs the vsock-guest for host-guest communication

mod init;
mod pid1;

use std::thread;
use std::time::Duration;

fn main() {
    eprintln!("[vm-init] Starting...");

    // Step 1: Initialize filesystem
    if let Err(e) = init::init_filesystem() {
        eprintln!("[vm-init] FATAL: Filesystem init failed: {}", e);
        std::process::exit(1);
    }

    // Step 2: Setup PID 1 signal handlers
    pid1::setup_signal_handlers();
    eprintln!("[vm-init] PID 1 signal handlers installed");

    // Step 3: Start background thread for zombie reaping
    // This runs continuously while vsock-guest handles messages
    thread::spawn(|| {
        loop {
            pid1::reap_zombies();

            // Check for shutdown signal
            if pid1::shutdown_requested() {
                eprintln!("[vm-init] Shutdown requested");
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
