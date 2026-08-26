//! Inject host-provided entropy and force kernel CRNG reseed.
//!
//! On ARM64 with Linux 6.1, VMGenID (which automatically reseeds the CRNG
//! after snapshot restore on x86_64) does not work because the kernel driver
//! only supports ACPI, and DeviceTree support requires kernel 6.10+.
//!
//! This binary is called by the fixed guest-state operation immediately after
//! snapshot restore. Its explicit restore mode repairs the frozen realtime
//! clock, injects fresh host entropy, forces an immediate CRNG reseed, and then
//! optionally applies the guest timezone.
//!
//! Usage: guest-reseed < entropy-bytes
//!        guest-reseed --restore-state <seconds> <nanoseconds>
//!          <none|best-effort|required> [timezone] < entropy-bytes
//!
//! Entropy-only mode accepts no arguments and reads 1 through 65,536 raw bytes
//! from stdin. Restore mode reads exactly 256 raw bytes.
//!
//! Entropy is written to /dev/urandom, then the CRNG is force-reseeded via the
//! RNDRESEEDCRNG ioctl. Restore mode also needs permission to set realtime and
//! update `/etc`. The command returns 0 on success and 1 for argument, input,
//! clock, reseed, or required-timezone failures; stderr receives diagnostics.

fn main() {
    std::process::exit(guest_reseed::run_cli(
        std::io::stdin().lock(),
        std::io::stderr().lock(),
        std::env::args_os().skip(1),
    ));
}
