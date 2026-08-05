//! Process-preserving fallback to the npm Zero CLI package.

use std::ffi::OsString;
use std::io;
use std::os::unix::process::CommandExt as _;
use std::process::Command;

/// Replace the current process with the commit-addressed package selected by
/// `CLI_PKG_URL`, or the published `@vm0/cli` package when the variable is not
/// set. Preserve every original OS argument and the inherited process
/// environment and standard streams.
///
/// This function returns only when `exec(2)` fails.
pub fn exec_npm_cli(args: &[OsString]) -> io::Error {
    let mut command = Command::new("npx");
    if let Some(package_url) = std::env::var_os("CLI_PKG_URL").filter(|value| !value.is_empty()) {
        let mut package_arg = OsString::from("--package=");
        package_arg.push(package_url);
        command.arg("--yes").arg(package_arg);
    } else {
        command.args(["-p", "@vm0/cli"]);
    }

    command.arg("zero").args(args).exec()
}
