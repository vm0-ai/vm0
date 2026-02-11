//! Vsock Guest binary for Firecracker VM host-guest communication.
//!
//! This is a standalone binary that runs inside a Firecracker VM.
//! For use as a library or embedding in other binaries, see the `vsock_guest` crate.

use std::env;

fn main() {
    let args: Vec<String> = env::args().collect();
    let unix_socket = args
        .iter()
        .position(|a| a == "--unix-socket")
        .and_then(|i| args.get(i + 1))
        .map(|s| s.as_str());

    if let Err(e) = vsock_guest::run(unix_socket) {
        vsock_guest::log("ERROR", &format!("Fatal: {}", e));
        std::process::exit(1);
    }
}
