//! Direct guest file writer used by vsock-guest.
//!
//! Accepted syntax:
//!
//! ```text
//! guest-write-file [--private] [--append | --create-parents] [--] <path>
//! guest-write-file --batch [--private]
//! ```
//!
//! Content is read from stdin. Create mode truncates or creates the target.
//! Append mode creates the target file when its parent already exists, matching
//! shell `>>`, but does not create missing parents.
//! Create-parents mode creates missing parent directories before writing.
//! Private mode writes through the guest runtime private file helpers, ensuring
//! parent directories are private, creating missing parent directories even
//! with append mode, and rejecting symlinked parent components.
//! Batch mode reads a `vsock-proto` `write_files` payload from stdin and writes
//! every entry with create-parent and truncate semantics. Private batch mode
//! applies private runtime-file semantics to every entry.
//! Use `--` before a path that begins with `-`.
//!
//! The detailed canonical CLI contract is documented on
//! [`guest_write_file::run_cli`](fn.run_cli.html).

use std::io;

fn main() {
    let code = guest_write_file::run_cli(
        std::env::args().skip(1),
        io::stdin().lock(),
        io::stderr().lock(),
    );
    std::process::exit(code);
}
