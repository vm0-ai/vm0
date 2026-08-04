//! Process-preserving fallback to the published npm Zero CLI.

use std::ffi::OsString;
use std::io;
use std::os::unix::process::CommandExt as _;
use std::process::Command;

/// Replace the current process with `npx -p @vm0/cli zero`, preserving every
/// original OS argument and the inherited process environment and standard
/// streams.
///
/// This function returns only when `exec(2)` fails.
pub fn exec_npm_cli(args: &[OsString]) -> io::Error {
    Command::new("npx")
        .args(["-p", "@vm0/cli", "zero"])
        .args(args)
        .exec()
}
