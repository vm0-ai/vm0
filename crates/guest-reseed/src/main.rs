//! Inject host-provided entropy and force kernel CRNG reseed.
//!
//! On ARM64 with Linux 6.1, VMGenID (which automatically reseeds the CRNG
//! after snapshot restore on x86_64) does not work — the kernel driver only
//! supports ACPI, and DeviceTree support requires kernel 6.10+.
//!
//! This binary is called by the runner executor immediately after snapshot
//! restore to inject fresh host entropy and force an immediate CRNG reseed,
//! ensuring each VM produces unique random output.
//!
//! Usage: guest-reseed <hex-encoded-entropy>
//!
//! The hex string is decoded, written to /dev/urandom (mixing into the input
//! pool), then the CRNG is force-reseeded via RNDRESEEDCRNG ioctl.
//! Requires CAP_SYS_ADMIN (run as root).

use std::fs;
use std::os::unix::io::AsRawFd;

/// ioctl request code for RNDRESEEDCRNG.
///
/// Forces an immediate reseed of the kernel CRNG from the input pool.
/// Requires CAP_SYS_ADMIN.
///
/// See `include/uapi/linux/random.h` in the kernel source.
const RNDRESEEDCRNG: libc::Ioctl = 0x5207;

fn main() {
    let hex_str = match std::env::args().nth(1) {
        Some(h) => h,
        None => {
            eprintln!("usage: guest-reseed <hex-encoded-entropy>");
            std::process::exit(1);
        }
    };

    let entropy = match hex::decode(&hex_str) {
        Ok(data) if !data.is_empty() => data,
        Ok(_) => {
            eprintln!("guest-reseed: empty entropy");
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!("guest-reseed: invalid hex: {e}");
            std::process::exit(1);
        }
    };

    // Mix host entropy into kernel input pool
    if let Err(e) = fs::write("/dev/urandom", &entropy) {
        eprintln!("guest-reseed: write /dev/urandom: {e}");
        std::process::exit(1);
    }

    // Force CRNG reseed from input pool
    let f = match fs::File::open("/dev/urandom") {
        Ok(f) => f,
        Err(e) => {
            eprintln!("guest-reseed: open /dev/urandom: {e}");
            std::process::exit(1);
        }
    };

    // SAFETY: fd is a valid open file descriptor for /dev/urandom.
    let ret = unsafe { libc::ioctl(f.as_raw_fd(), RNDRESEEDCRNG) };
    if ret < 0 {
        let err = std::io::Error::last_os_error();
        eprintln!("guest-reseed: RNDRESEEDCRNG failed: {err}");
        std::process::exit(1);
    }
}
