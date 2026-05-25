//! Inject host-provided entropy and force kernel CRNG reseed.
//!
//! On ARM64 with Linux 6.1, VMGenID (which automatically reseeds the CRNG
//! after snapshot restore on x86_64) does not work because the kernel driver
//! only supports ACPI, and DeviceTree support requires kernel 6.10+.
//!
//! This binary is called by the runner executor immediately after snapshot
//! restore to inject fresh host entropy from stdin and force an immediate CRNG
//! reseed, ensuring each VM produces unique random output.
//!
//! Usage: guest-reseed < entropy-bytes
//!
//! Entropy is written to /dev/urandom, then the CRNG is force-reseeded via
//! RNDRESEEDCRNG ioctl. Requires CAP_SYS_ADMIN (run as root).

fn main() {
    std::process::exit(guest_reseed::run_cli(
        std::io::stdin().lock(),
        std::io::stderr().lock(),
        std::env::args_os().skip(1),
    ));
}
