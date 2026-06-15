//! Direct guest file writer used by vsock-guest.
//!
//! Usage: `guest-write-file [--append | --create-parents] <path>`.
//!
//! Content is read from stdin. Create mode truncates or creates the target.
//! Append mode creates the target file when its parent already exists, matching
//! shell `>>`, but does not create missing parents.

use std::io;

fn main() {
    let code = guest_write_file::run_cli(
        std::env::args().skip(1),
        io::stdin().lock(),
        io::stderr().lock(),
    );
    std::process::exit(code);
}
