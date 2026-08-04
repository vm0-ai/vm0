//! Process-preserving fallback to the commit-addressed npm Zero CLI package.

use std::ffi::OsString;
use std::io;
use std::os::unix::process::CommandExt as _;
use std::process::Command;

/// Replace the current process with the Zero CLI package selected by
/// `CLI_PKG_URL`, preserving every original OS argument and the inherited
/// process environment and standard streams.
///
/// This function returns only when the package URL is missing or `exec(2)`
/// fails.
pub fn exec_npm_cli(args: &[OsString]) -> io::Error {
    let Some(package_url) = std::env::var_os("CLI_PKG_URL").filter(|value| !value.is_empty())
    else {
        return io::Error::new(
            io::ErrorKind::InvalidInput,
            "CLI_PKG_URL is required for the npm Zero CLI fallback",
        );
    };
    let mut package_arg = OsString::from("--package=");
    package_arg.push(package_url);

    Command::new("npx")
        .arg("--yes")
        .arg(package_arg)
        .arg("zero")
        .args(args)
        .exec()
}
