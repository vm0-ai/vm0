//! Direct guest file writer used by vsock-guest.
//!
//! Usage: `guest-write-file [--create-parents] <path> | --batch [--create-parents]`.
//!
//! Content is read from stdin. Single-file mode truncates or creates the target.
//! Batch mode reads the vm0 write-files batch stream from stdin.

use std::io;

fn main() {
    let code = guest_write_file::run_cli(
        std::env::args().skip(1),
        io::stdin().lock(),
        io::stderr().lock(),
    );
    std::process::exit(code);
}
